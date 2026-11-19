import { isDeepStrictEqual } from 'node:util';
import { readReview, selectedReviewFeedback, ReviewReadError, type ReviewReadRunner } from './review-read.ts';
import { DIRECTION_CORRECTION_SPEC, DirectionError, directionPostIdentity } from './direction.ts';
/** Human correction capture through Review's read-only feedback CLI. */
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { lstatSync } from './check-reads.ts';
import { asArray, checkProject, collectSignoffs, isObject, type Finding } from './check.ts';
import { CORRECTIONS_SPEC, CORRECTION_SPEC, CORRECTION_STAGES, CorrectionError, checkCorrections, correctionApplied, correctionCheckCoverage, correctionApprovalFindings, feedbackPackageInput, correctionBinding, correctionBytes, correctionFinding, correctionHash, correctionIsLive, correctionJson, correctionsAdopted, draftPartBinding, meshDeltaKey, validatePartImageArtifact, validateCorrectionIdentity, versionRecord } from './corrections.ts';
import { readProject } from './feedback.ts';
import { checkReviewPackages } from './review-package.ts';
import { reviewActVerdict, type MeshReviewVerdictAct } from './review-act.ts';
import { readVerbatim } from './record-input.ts';
import { collectReopens, liveSignoff } from './reopen.ts';
import { refuse, USAGE_EXIT } from './refusal.ts';
import { baselineOf, newFindings } from './refusal-baseline.ts';
import { applyMeshEdits, type MeshEditAct, type MeshEditEntry, type MeshEditPaths, type MeshEditResult } from './mesh-edit.ts';
import type { JsonObject } from './templates.ts';

export const CORRECTION_HELP = `correction --adopt [<dir>]
correction record [<dir>] --id <id> --path described|made --stage <review-stage>
  (--version <n> | --draft <id> | --parts-file <inventory JSON>) [--model-file <post output>]
  --by <human|agent> [--verbatim-file <UTF-8 file>] [--source <text>] [--resolves <id>]
  made: (--patch-file <review package> | --feedback-file <review package>) --item <id> | --part-image-file <after.png> --part <name> --mask-file <mask.png> --tool <text> [--before-file <before.png>]
correction resolve <id> [<dir>]
  (--version <n> | --draft <id> | --parts-file <inventory JSON>) [--model-file <post output>]
  --by agent --reasoning-file <file> [--applied-feedback <review package> --feedback-id <id>]
  described direction-review: --version binds the authored direction and compiled model.
  --json prints the recorded object. No command executes a patch or producer.
  Config patches come only from the selected applied item through Review feedback.`;
const common = ['--version', '--draft', '--parts-file', '--model-file', '--by'];
function usage(why: string): never { refuse('CORRECTION_USAGE', `corrections: ${why}; ${CORRECTION_HELP}`, USAGE_EXIT); }
function objects(v: JsonObject[string]): JsonObject[] { return asArray(v).filter(isObject); }
function identity(dir: string, project: JsonObject, opts: Record<string, string>, stage: string, partImage = false): JsonObject {
  if (['--version', '--draft', '--parts-file'].filter(f => opts[f] !== undefined).length !== 1) usage('select exactly one version/draft/parts identity');
  let value: JsonObject;
  if (opts['--parts-file']) {
    if (opts['--model-file']) usage('--model-file is post-only');
    value = correctionJson(correctionBytes(dir, opts['--parts-file']));
  } else if (opts['--draft']) {
    if (opts['--model-file']) usage('--model-file is post-only');
    const draft = objects(project.drafts).find(d => d.id === opts['--draft']);
    if (!draft || !isObject(draft.parts)) throw new CorrectionError('CORRECTION_SOURCE', 'unknown draft');
    const draftParts = draft.parts;
    const model = objects(draft.files).filter(f => String(f.path).endsWith('/skeleton.model.json'));
    const manifest = objects(draftParts.files).find(f => f.path === `${String(draftParts.path)}/parts.json`);
    // A part-image edit is of one part file; it binds the parts inventory and no compiled model.
    if (!manifest || !partImage && model.length !== 1) throw new CorrectionError('CORRECTION_SOURCE', partImage ? 'draft needs a retained parts manifest' : 'draft needs one retained compiled model and parts manifest');
    value = { kind: 'draft', id: draft.id as string, config: draft.config as JsonObject, parts: {manifest,files:objects(draftParts.files).sort((a,b)=>String(a.path)<String(b.path)?-1:1)}, model:partImage ? null : model[0] as JsonObject };
  } else {
    const n = Number(opts['--version']?.replace(/^v/, ''));
    const version = versionRecord(project, n);
    if (!isObject(version.provenance) || !isObject(version.provenance.config)) throw new CorrectionError('CORRECTION_SOURCE', 'version needs retained provenance config');
    const kind = version.kind;
    if (kind !== 'rig' && kind !== 'post') throw new CorrectionError('CORRECTION_SOURCE', 'unknown version kind');
    if (kind === 'post' && !opts['--model-file']) usage('post identity requires --model-file naming a declared retained output');
    if (kind === 'rig' && opts['--model-file']) usage('--model-file is post-only');
    const model = kind === 'post' ? correctionBinding(dir, opts['--model-file'] as string) : correctionBinding(dir, `derived/review/v${n}/out/check/build/skeleton.model.json`);
    value = {kind,n,config:version.provenance.config,model};
  }
  validateCorrectionIdentity(dir,project,value,stage,false,partImage);
  return structuredClone(value);
}
function localValidation(dir: string, project: JsonObject, now: number): Finding[] {
  const refusals: Finding[] = []; checkCorrections({dir,project,refusals,warnings:[]},now); return refusals;
}
/** Like choice ingestion, tolerate unrelated pre-existing holes but never a new finding or this record's own invalidity. */
function save(dir: string, file: string, beforeBytes: string, original: JsonObject, next: JsonObject, now: number): void {
  const own = localValidation(dir,next,now)[0]; if (own) refuse(own.code,own.message);
  const fresh = newFindings(baselineOf(checkProject(dir,original,{now})),checkProject(dir,next,{now}).refusals)[0];
  if (fresh) refuse(fresh.code,fresh.message);
  // Refuse concurrent record replacement rather than overwriting another writer.
  if (correctionBytes(dir,'project.json').toString('utf8') !== beforeBytes) refuse('CORRECTION_SOURCE','project.json: changed during capture; retry against the current record');
  const tmp = join(dirname(file),`.correction-${process.pid}-${crypto.randomUUID()}.tmp`);
  try { writeFileSync(tmp,`${JSON.stringify(next,null,2)}\n`,{flag:'wx'});renameSync(tmp,file); }
  finally { rmSync(tmp,{force:true}); }
}
function openStage(project: JsonObject, stage: string): void {
  const reopens=collectReopens(project,[]);
  if (collectSignoffs(project,[]).some(s=>s.stage===stage&&s.checkpoint===null&&liveSignoff(reopens,stage,s.at)) || objects(project.versions).some(v=>objects(v.verdicts).some(d=>d.review===stage&&d.verdict==='accepted'&&liveSignoff(reopens,stage,Date.parse(String(d.at)))))) throw new CorrectionError('CORRECTION_SOURCE',`approval for ${stage} is still live; reopen before changing its corrections`);
}

/** The finalized act projection needed to bind its displayed rig. The live fetch owns decoding and authorization. */
export type MeshDeltaCorrectionAct = Omit<MeshEditAct, 'source' | 'value'> & {
  readonly at: string;
  readonly source: MeshEditAct['source'] & {
    readonly selector: { readonly kind: 'rig'; readonly version: number };
    readonly model: { readonly path: string; readonly sha256: string };
  };
  readonly value: Omit<MeshEditAct['value'], 'comments'> & { readonly comments?: readonly { readonly text: string }[] };
};

export type MeshDeltaCorrectionResult =
  | { status: 'applied'; code: null; object: null; correction: JsonObject }
  | { status: 'replayed'; code: null; object: null }
  | { status: 'superseded'; code: string; object: string; detail: string };

function meshDeltaRefusal(detail: string): never {
  const finding = correctionFinding('CORRECTION_MESH_DELTA_INVALID', 'corrections', detail);
  return refuse(finding.code, finding.message);
}

function meshDeltaArtifact(act: MeshDeltaCorrectionAct, entry: MeshEditEntry): JsonObject {
  const { skin, slot, attachment } = entry.edit;
  return { kind: 'mesh-delta', actId: act.actId, sourceHash: act.source.sourceHash, payloadSha256: entry.sha256, skin, slot, attachment };
}

function meshDeltaSource(dir: string, project: JsonObject, act: MeshDeltaCorrectionAct, now: number): JsonObject {
  if (!correctionsAdopted(project)) refuse('CORRECTION_CONTRACT_INVALID', 'corrections_contract: adopt corrections explicitly first');
  if (act.schema !== 'rig-review/act@8' || act.kind !== 'review-verdict' || act.value.stage !== 'rig-review'
    || act.value.verdict !== 'changes-requested' || act.source.selector.kind !== 'rig' || !act.value.meshEdits.length
    || !Number.isFinite(Date.parse(act.at)) || Date.parse(act.at) > now) {
    return meshDeltaRefusal('expected a finalized act@8 mesh edit for a retained rig-review source');
  }
  const on = identity(dir, project, { '--version': String(act.source.selector.version) }, 'rig-review');
  if (!isDeepStrictEqual(on.model, act.source.model)) return meshDeltaRefusal('the displayed act model differs from the retained source rig');
  return on;
}

function meshDeltaEntries(act: MeshDeltaCorrectionAct): Map<string, MeshEditEntry> {
  const entries = new Map<string, MeshEditEntry>();
  for (const entry of act.value.meshEdits) {
    const key = meshDeltaKey(meshDeltaArtifact(act, entry));
    const existing = entries.get(key);
    if (existing && !isDeepStrictEqual(existing, entry)) return meshDeltaRefusal('the same act and attachment carry conflicting mesh edits');
    entries.set(key, entry);
  }
  return entries;
}

function collectMeshDeltaCorrections(
  dir: string, project: JsonObject, act: MeshDeltaCorrectionAct, on: JsonObject,
  results: readonly MeshEditResult[], now: number, review?: MeshReviewVerdictAct,
): { appended: JsonObject[]; returned: MeshDeltaCorrectionResult[] } {
  const entries = [...meshDeltaEntries(act).values()];
  if (results.length !== entries.length) return meshDeltaRefusal('expected one ordered Parts result for each unique act attachment');
  const records = objects(project.corrections);
  const known = new Map(records.filter(r => isObject(r.artifact) && r.artifact.kind === 'mesh-delta')
    .map(r => [meshDeltaKey(r.artifact as JsonObject), r]));
  const appended: JsonObject[] = [];
  const returned: MeshDeltaCorrectionResult[] = [];
  const verdict = review ? reviewActVerdict(review) : null;
  const comment = verdict ? String(verdict.verbatim) : act.value.comments?.map(item => item.text).join('\n\n');
  let chainedRig: string | undefined;
  for (const [index, result] of results.entries()) {
    const entry = entries[index]!;
    const artifact = meshDeltaArtifact(act, entry);
    const key = meshDeltaKey(artifact);
    const { input } = result;
    const rig = resolve(input.rig);
    if (input.actId !== act.actId || input.actSourceHash !== act.source.sourceHash || input.payloadSha256 !== entry.sha256
      || input.part !== entry.edit.attachment || !isDeepStrictEqual(input.edit, entry.edit) || chainedRig !== undefined && rig !== chainedRig) {
      return meshDeltaRefusal('Parts result does not follow the act and the current revision chain');
    }
    const prior = known.get(key);
    if (prior && (!isDeepStrictEqual(prior.artifact, artifact) || !isDeepStrictEqual(prior.on, on))) {
      return meshDeltaRefusal('completed act and attachment have a different source or payload binding');
    }
    chainedRig = rig;
    if (result.status === 'superseded') {
      if (result.problem.code !== 'REMESH_DELTA_ACT_SUPERSEDED') return meshDeltaRefusal('expected the Parts superseded result');
      returned.push({ status: 'superseded', ...result.problem });
      continue;
    }
    const request = result.provenance.request;
    if (result.provenance.spec !== 'rig-parts-remesh/1' || !isObject(request) || request.act_id !== act.actId
      || request.act_source_hash !== act.source.sourceHash || request.payload_sha256 !== entry.sha256
      || request.part !== entry.edit.attachment || !isDeepStrictEqual(request.edit, entry.edit)) {
      return meshDeltaRefusal('Parts result provenance differs from the finalized act and attachment');
    }
    if (result.status === 'replayed') {
      if (result.written.length || prior && (!isObject(prior.outcome) || !isDeepStrictEqual(prior.outcome.provenance, result.provenance))) {
        return meshDeltaRefusal('exact replay differs from its recorded Parts result');
      }
      returned.push({ status: 'replayed', code: null, object: null });
      continue;
    }
    if (prior) return meshDeltaRefusal('Parts reported a new write for an already completed act attachment; replay from the recorded revision');
    const out = resolve(input.out);
    chainedRig = out;
    const revision = relative(dir, out).split(sep).join('/');
    if (!revision || revision === '..' || revision.startsWith('../')) return meshDeltaRefusal('Parts must return a retained project-relative revision');
    const written = result.written.map(path => {
      if (posix.isAbsolute(path) || path.split('/').some(piece => !piece || piece === '.' || piece === '..')) {
        return meshDeltaRefusal('Parts written paths must be literal paths relative to the revision');
      }
      return correctionBinding(dir, `${revision}/${path}`);
    });
    const record: JsonObject = {
      schema: CORRECTION_SPEC, id: `mesh-${correctionHash(Buffer.from(key)).slice(0, 59)}`, path: 'made',
      by: verdict?.by ?? 'user', at: act.at, verbatim: comment?.trim() ? comment : null, stage: 'rig-review', on, artifact,
      ...(verdict ? { source: verdict.source } : {}),
      resolves: null, closure: { by: 'agent', at: new Date(now).toISOString(), reasoning: 'Applied the finalized Review mesh edit through Parts.' },
      outcome: { kind: 'mesh-delta', revision, code: null, object: null, provenance: structuredClone(result.provenance), written },
    };
    appended.push(record);
    returned.push({ status: 'applied', code: null, object: null, correction: record });
  }
  if (appended.length) {
    openStage(project, 'rig-review');
    if (appended.some(record => !correctionIsLive(project, record))) return meshDeltaRefusal('the act predates the live rig-review');
  }
  return { appended, returned };
}

function rethrowCorrectionError(error: unknown): never {
  if (error instanceof CorrectionError) {
    const finding = correctionFinding(error.code, 'corrections', error.message);
    refuse(finding.code, finding.message);
  }
  throw error;
}

/** Atomically append the completed outcomes from one already-applied act. */
export function recordMeshDeltaCorrections(
  projectDir: string, act: MeshDeltaCorrectionAct, results: readonly MeshEditResult[], now: number,
): readonly MeshDeltaCorrectionResult[] {
  const dir = resolve(projectDir);
  try {
    const before = correctionBytes(dir, 'project.json');
    const project = correctionJson(before);
    const on = meshDeltaSource(dir, project, act, now);
    const { appended, returned } = collectMeshDeltaCorrections(dir, project, act, on, results, now);
    if (appended.length) save(dir, join(dir, 'project.json'), before.toString('utf8'), project,
      { ...project, corrections: [...asArray(project.corrections), ...appended] }, now);
    return returned;
  } catch (error) { return rethrowCorrectionError(error); }
}

function stageMeshDeltaCorrections(
  dir: string, original: JsonObject, act: MeshDeltaCorrectionAct, paths: Omit<MeshEditPaths, 'out'>,
  now: number, review?: MeshReviewVerdictAct,
): { appended: JsonObject[]; returned: MeshDeltaCorrectionResult[]; discard: () => void } {
  const on = meshDeltaSource(dir, original, act, now);
  meshDeltaEntries(act);
  const derived = join(dir, 'derived');
  if (!lstatSync(derived).isDirectory()) return meshDeltaRefusal('derived must be a retained project directory');
  const root = mkdtempSync(join(derived, 'mesh-delta-'));
  const discard = () => rmSync(root, { force: true, recursive: true });
  try {
    const results = applyMeshEdits(dir, act, (_entry, prior) => ({
      rig: resolve(dir, paths.rig), config: resolve(dir, paths.config), parts: resolve(dir, paths.parts),
      out: join(root, String(prior.length + 1)),
    }));
    const collected = collectMeshDeltaCorrections(dir, original, act, on, results, now, review);
    if (!collected.appended.length) discard();
    return { ...collected, discard };
  } catch (error) { discard(); throw error; }
}

/** Apply against the displayed package and stage the correction records in the verdict's pending write. */
export function stageReviewMeshDeltaCorrections(
  dir: string, original: JsonObject, next: JsonObject, act: MeshReviewVerdictAct, now: number,
): () => void {
  try {
    const invalid = localValidation(dir, original, now)[0];
    if (invalid) refuse(invalid.code, invalid.message);
    const version = versionRecord(original, act.source.selector.version);
    const packageCheck: Parameters<typeof checkReviewPackages>[0] = { dir, project: { ...original, versions: [version] }, refusals: [], warnings: [] };
    checkReviewPackages(packageCheck);
    const packageProblem = packageCheck.refusals[0];
    if (packageProblem) refuse(packageProblem.code, packageProblem.message);
    openStage(original, 'rig-review');
    const root = `derived/review/v${act.source.selector.version}`;
    const prior = objects(original.corrections).findLast(record => isObject(record.on) && record.on.n === version.n
      && isObject(record.outcome) && record.outcome.kind === 'mesh-delta');
    const paths = { rig: prior ? String((prior.outcome as JsonObject).revision) : `${root}/out/rig`,
      config: `${root}/config.json`, parts: dirname(act.source.parts.manifest.path) };
    const { appended, discard } = stageMeshDeltaCorrections(dir, original, act, paths, now, act);
    next.corrections = [...asArray(original.corrections), ...appended];
    return discard;
  } catch (error) { return rethrowCorrectionError(error); }
}

/** Apply a finalized act using fresh owned destinations, then record only after the whole batch succeeds. */
export function applyMeshDeltaCorrections(
  projectDir: string, act: MeshDeltaCorrectionAct, paths: Omit<MeshEditPaths, 'out'>, now: number,
): readonly MeshDeltaCorrectionResult[] {
  const dir = resolve(projectDir);
  const before = correctionBytes(dir, 'project.json');
  const project = correctionJson(before);
  const { appended, returned, discard } = stageMeshDeltaCorrections(dir, project, act, paths, now);
  try {
    if (appended.length) save(dir, join(dir, 'project.json'), before.toString('utf8'), project,
      { ...project, corrections: [...asArray(project.corrections), ...appended] }, now);
  } catch (error) { discard(); return rethrowCorrectionError(error); }
  return returned;
}

export function correctionCommand(args: string[], now: number, runner?: ReviewReadRunner): {stdout:string;exit:number} {
  try { return command(args,now,runner); } catch(e) { if(e instanceof ReviewReadError) refuse(e.code,e.message); if(e instanceof DirectionError) refuse(e.code,e.message); if(e instanceof CorrectionError) { const f=correctionFinding(e.code,'corrections',e.message);refuse(f.code,f.message); } throw e; }
}
function command(args:string[],now:number,runner?:ReviewReadRunner): {stdout:string;exit:number} {
  if(args.some(arg=>arg==='--direction-patch-file'||arg.startsWith('--direction-patch-file=')))refuse('CORRECTION_DIRECTION_PATCH_FILE_REMOVED','project.json.corrections: --direction-patch-file was removed; record direction feedback as a review verdict and publish the revised post with direction write <N> --file <direction.json> --rig <R> --answers <version>:<verdict>',USAGE_EXIT);
  const action=args[0];const opts:Record<string,string>={};const positional:string[]=[];let json=false;
  const allowed=action==='record'?[...common,'--id','--path','--stage','--verbatim-file','--source','--resolves','--patch-file','--feedback-file','--item','--part-image-file','--part','--mask-file','--tool','--before-file']:action==='resolve'?[...common,'--reasoning-file','--applied-feedback','--feedback-id']:[];
  for(let i=1;i<args.length;i++) {const arg=args[i] as string;if(arg==='--json'){if(json)usage('duplicate --json');json=true;}else if(allowed.includes(arg)){const value=args[++i];if(!value||value.startsWith('--')||opts[arg]!==undefined)usage(`${arg} requires one value`);opts[arg]=value;}else if(arg.startsWith('-'))usage(`unknown ${arg}`);else positional.push(arg);}
  if(!['--adopt','record','resolve'].includes(action??'')||positional.length>(action==='resolve'?2:1))usage('invalid action or directory count');
  if(action==='resolve'&&!positional[0])usage('resolve requires correction id');
  const dir=resolve(positional[action==='resolve'?1:0]??process.cwd());const {file,project}=readProject(dir);const originalBytes=correctionBytes(dir,'project.json').toString('utf8');const next=structuredClone(project);const at=new Date(now).toISOString();
  if(action==='--adopt') {
    if (next.corrections_contract !== undefined) {
      const invalid=localValidation(dir,next,now)[0];if(invalid)refuse(invalid.code,invalid.message);
      if(correctionsAdopted(next))return{stdout:'correction: already adopted; original adoption preserved',exit:0};
    }
    next.corrections_contract={schema:CORRECTIONS_SPEC,adopted_at:at};next.corrections=next.corrections??[];
    save(dir,file,originalBytes,project,next,now);return{stdout:json?JSON.stringify(next.corrections_contract):'correction: adopted; historical records preserved',exit:0};
  }
  if(!correctionsAdopted(next))throw new CorrectionError('CORRECTION_CONTRACT_INVALID','adopt corrections explicitly first');
  const records=objects(next.corrections);
  let record:JsonObject;
  let coverage = '';
  if(action==='record') {
    const stage=opts['--stage'];const path=opts['--path'];
    const partImage=['--part-image-file','--part','--mask-file','--tool','--before-file'].some(f=>opts[f]!==undefined);
    const by=partImage ? (opts['--by']??'agent') : opts['--by'];
    if(!opts['--id']||!stage||!CORRECTION_STAGES.includes(stage)||!['described','made'].includes(path??'')||!by)usage('record requires id/path/stage/by');
    openStage(next,stage);
    if(partImage && (path!=='made'||stage!=='parts-review'||!opts['--draft']||opts['--version']||opts['--parts-file']||opts['--model-file']||!opts['--part-image-file']||!opts['--part']||!opts['--mask-file']||!opts['--tool']||opts['--patch-file']||opts['--feedback-file']||opts['--item']||opts['--verbatim-file']))usage('part-image requires made at parts-review with --draft, --part, --part-image-file, --mask-file and --tool');
    const version = path === 'described' && stage === 'direction-review' && opts['--version'] && !opts['--draft'] && !opts['--parts-file']
      ? versionRecord(next, Number(opts['--version'].replace(/^v/, ''))) : null;
    const describedDirection = path === 'described' && stage === 'direction-review' && version?.kind === 'post' && isObject(version.provenance) && isObject(version.provenance.direction);
    let on: JsonObject;
    if (describedDirection) {
      if (opts['--draft'] || opts['--parts-file']) usage('select only --version for a direction description');
      on = directionPostIdentity(dir, next, version.n);
      if (opts['--model-file'] && opts['--model-file'] !== (on.model as JsonObject).path) throw new CorrectionError('CORRECTION_SOURCE', '--model-file must name the direction source compiled model');
    } else on = identity(dir,next,opts,stage,partImage);
    let artifact:JsonObject;let verbatim:string|null;
    if(path==='described') {
      if(opts['--patch-file']||opts['--feedback-file']||opts['--item']||!opts['--verbatim-file'])usage('described requires only verbatim text, not producer artifact flags');
      artifact={kind:'description'};verbatim=readVerbatim(opts['--verbatim-file']);
    } else if (partImage) {
      if(by!=='agent')throw new CorrectionError('CORRECTION_MALFORMED','part-image requires --by agent');
      const parentDraft=objects(next.drafts).find(d=>d.id===opts['--draft']);
      const beforeBinding=opts['--before-file']?correctionBinding(dir,opts['--before-file']):parentDraft?draftPartBinding(parentDraft,opts['--part'] as string):null;
      if(!beforeBinding)throw new CorrectionError('CORRECTION_PART_IMAGE_BEFORE',`parent draft ${String(opts['--draft'])} has no bound part ${String(opts['--part'])}`);
      artifact={kind:'part-image',draft:String(on.id),part:opts['--part'] as string,before:structuredClone(beforeBinding),after:correctionBinding(dir,opts['--part-image-file'] as string),mask:correctionBinding(dir,opts['--mask-file'] as string),tool:(opts['--tool'] as string).trim()};
      verbatim=null;
    }else {
      if(by!=='user')throw new CorrectionError('CORRECTION_MALFORMED','made requires --by user');
      if(Number(Boolean(opts['--patch-file']))+Number(Boolean(opts['--feedback-file']))!==1)usage('made requires exactly one patch-file or feedback-file');
      if(!opts['--item']||opts['--verbatim-file'])usage('API capture requires item and uses its summary verbatim');
      const input = feedbackPackageInput(dir, (opts['--feedback-file'] ?? opts['--patch-file']) as string, on.kind === 'draft');
      const read = readReview(dir,input,runner);
      const feedback=read.value;
      const items=selectedReviewFeedback(feedback,opts['--item'] as string);const item=items[0];
      if(items.length!==1||!item||typeof item.summary!=='string'||!isObject(item.context)||!isObject(item.context.applied))throw new CorrectionError('CORRECTION_APPLIED_INVALID','session needs exactly one applied item');
      verbatim=item.summary;const applied=item.context.applied;
      if(opts['--patch-file'] && applied.schema!=='rig-review-applied/2')throw new CorrectionError('CORRECTION_APPLIED_INVALID','patch-file requires a config patch applied through Review');
      if(applied.schema==='rig-review-applied/2' && on.kind!=='post') artifact={kind:'config-patch',state:'preview/pending',feedback:{file:read.file,item_id:opts['--item']},review_read:read.receipt};
      else artifact={kind:'unsupported',operation:applied.schema==='rig-review-applied/3'?'mesh-delta':String(applied.op).includes('retarget')?'retarget':String(applied.op).includes('key')?'keyed-animation':'other',reason:'No checked create adapter for this producer-owned operation',files:[read.file],producer_schema:String(applied.schema),review_read:read.receipt};
    }
    record={schema:describedDirection?DIRECTION_CORRECTION_SPEC:CORRECTION_SPEC,id:opts['--id'],path:path as string,by,at,verbatim,stage,on,artifact,outcome:null,resolves:opts['--resolves']??null};
    if(partImage)artifact.added_alpha_texels=validatePartImageArtifact(dir,next,record,artifact,on);
    if(opts['--source']!==undefined)record.source=opts['--source'];
    next.corrections=[...asArray(next.corrections),record];
  } else {
    const matches=records.filter(r=>r.id===positional[0]);
    if(matches.length!==1)throw new CorrectionError('CORRECTION_SOURCE','resolve requires one existing correction');
    record=matches[0] as JsonObject;
    if(isObject(record.artifact)&&record.artifact.kind==='direction-patch')refuse('CORRECTION_DIRECTION_PATCH_FILE_REMOVED','project.json.corrections: --direction-patch-file was removed; record direction feedback as a review verdict and publish the revised post with direction write <N> --file <direction.json> --rig <R> --answers <version>:<verdict>',USAGE_EXIT);
    if(record.outcome!==null)throw new CorrectionError('CORRECTION_OUTCOME','closure is write-once');
    if(!correctionIsLive(next,record))throw new CorrectionError('CORRECTION_SOURCE','superseded correction cannot close a current review');
    if(opts['--by']!=='agent'||!opts['--reasoning-file'])usage('resolve requires --by agent --reasoning-file');
    openStage(next,String(record.stage));
    const artifact=record.artifact as JsonObject;
    if(artifact.kind==='unsupported')throw new CorrectionError('CORRECTION_UNSUPPORTED_OUTCOME','unsupported operation cannot claim checked completion');
    if((opts['--applied-feedback']===undefined)!==(opts['--feedback-id']===undefined))usage('applied-feedback and feedback-id are paired');
    if((artifact.kind==='description'||artifact.kind==='part-image')&&(opts['--applied-feedback']||opts['--feedback-id']))usage('described and part-image closures take no Apply flags');
    if(artifact.kind==='config-patch') {
      if(opts['--applied-feedback']) {
        const previousPatch = artifact.review_read === undefined ? undefined : correctionApplied(dir,artifact).applied.patch;
        const read=readReview(dir,feedbackPackageInput(dir,opts['--applied-feedback'],isObject(record.on)&&record.on.kind==='draft'),runner);
        const selected=selectedReviewFeedback(read.value,opts['--feedback-id'] as string);
        const selectedApplied=selected.length===1 && isObject(selected[0]?.context) ? selected[0].context.applied : undefined;
        if(previousPatch !== undefined && (!isObject(selectedApplied) || !isDeepStrictEqual(previousPatch,selectedApplied.patch)))throw new CorrectionError('CORRECTION_APPLIED_INVALID','selected Apply patch differs from the captured correction');
        artifact.feedback={file:read.file,item_id:opts['--feedback-id'] as string};
        artifact.review_read=read.receipt;
      }
      const {item, applied}=correctionApplied(dir,artifact);
      if (isObject(applied.check) && isObject(applied.check.bars)) coverage = correctionCheckCoverage(applied.check);
      // A preview's human words cannot silently change when an Apply is attached.
      if(record.verbatim!==item.summary)throw new CorrectionError('CORRECTION_APPLIED_INVALID','selected feedback summary differs from retained human correction');
      artifact.state='applied-and-checked';
    }
    if (record.schema === DIRECTION_CORRECTION_SPEC && artifact.kind === 'description') {
      if (!opts['--version'] || opts['--draft'] || opts['--parts-file']) usage('direction description closure requires only --version and optional --model-file');
      record.outcome = directionPostIdentity(dir, next, Number(opts['--version'].replace(/^v/, '')));
      if (opts['--model-file'] && opts['--model-file'] !== (record.outcome.model as JsonObject).path) throw new CorrectionError('CORRECTION_SOURCE', '--model-file must name the direction source compiled model');
    } else {
      record.outcome=identity(dir,next,opts,String(record.stage),artifact.kind==='part-image');
      if (artifact.kind === 'description' && record.outcome.kind === 'post') {
        const version = versionRecord(next, record.outcome.n);
        if (isObject(version.provenance) && isObject(version.provenance.direction) && (record.outcome.model as JsonObject).path === version.provenance.direction.path) throw new CorrectionError('CORRECTION_SOURCE', '--model-file must not name the authored direction document; capture a new correction@2 description');
      }
    }
    record.closure={by:'agent',at,reasoning:readVerbatim(opts['--reasoning-file']) + (coverage ? `\n${coverage}` : '')};
  }
  save(dir,file,originalBytes,project,next,now);
  const alphaReport = isObject(record.artifact) && record.artifact.kind === 'part-image' ? `; added-alpha texels: ${String(record.artifact.added_alpha_texels ?? 0)}` : '';
  return{stdout:json?JSON.stringify(record,null,2):`correction: ${action==='record'?'recorded':'resolved'} ${String(record.id)}; stage unchanged${alphaReport}${coverage ? `\n${coverage}` : ''}`,exit:0};
}

/** Public approval paths that do not run checkProject still share the correction validator. */
export function assertCorrectionApproval(dir:string,project:JsonObject,stage:string,now:number,signoff?:JsonObject):void {
  const invalid=localValidation(dir,project,now)[0]??correctionApprovalFindings(project,stage,signoff)[0];if(invalid)refuse(invalid.code,invalid.message);
}
