import { DIRECTION_CORRECTION_SPEC, DirectionError, directionPostIdentity, validateDirectionOutcome } from './direction.ts';
/** Human capture and declared outcome writers. No producer or review process is launched. */
import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { asArray, checkProject, collectSignoffs, isObject, type Finding } from './check.ts';
import { CORRECTIONS_SPEC, CORRECTION_SPEC, CORRECTION_STAGES, CorrectionError, checkCorrections, correctionApplied, correctionCheckCoverage, correctionApprovalFindings, correctionBinding, correctionBytes, correctionFinding, correctionIsLive, correctionJson, correctionsAdopted, validateCorrectionIdentity, versionRecord } from './corrections.ts';
import { readProject } from './feedback.ts';
import { readVerbatim } from './record-input.ts';
import { collectReopens, liveSignoff } from './reopen.ts';
import { refuse, USAGE_EXIT } from './refusal.ts';
import type { JsonObject } from './templates.ts';

export const CORRECTION_HELP = `correction --adopt [<dir>]
correction record [<dir>] --id <id> --path described|made --stage <review-stage>
  (--version <n> | --draft <id> | --parts-file <inventory JSON>) [--model-file <post output>]
  --by <human> [--verbatim-file <UTF-8 file>] [--source <text>] [--resolves <id>]
  made: --direction-patch-file <retained direction patch> (post@2) | --patch-file <retained patch> | --feedback-file <retained session> --item <id>
correction resolve <id> [<dir>]
  (--version <n> | --draft <id> | --parts-file <inventory JSON>) [--model-file <post output>]
  --by agent --reasoning-file <file> [--applied-feedback <session> --feedback-id <id>]
  described direction-review: --version binds the authored direction and compiled model.
  --json prints the recorded object. No command executes a patch or producer.
  A preview patch hash is independent of review's retained patchSha256 claim.`;
const common = ['--version', '--draft', '--parts-file', '--model-file', '--by'];
function usage(why: string): never { refuse('CORRECTION_USAGE', `corrections: ${why}; ${CORRECTION_HELP}`, USAGE_EXIT); }
function objects(v: JsonObject[string]): JsonObject[] { return asArray(v).filter(isObject); }
function identity(dir: string, project: JsonObject, opts: Record<string, string>, stage: string, direction = false): JsonObject {
  if (direction) {
    if (!opts["--version"] || opts["--model-file"] || opts["--draft"] || opts["--parts-file"] || stage !== "direction-review") usage("direction-patch requires direction-review and only --version");
    return directionPostIdentity(dir,project,Number(opts["--version"]?.replace(/^v/,"")));
  }
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
    if (model.length !== 1 || !manifest) throw new CorrectionError('CORRECTION_SOURCE', 'draft needs one retained compiled model and parts manifest');
    value = { kind: 'draft', id: draft.id as string, config: draft.config as JsonObject, parts: {manifest,files:objects(draftParts.files).sort((a,b)=>String(a.path)<String(b.path)?-1:1)}, model:model[0] as JsonObject };
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
  validateCorrectionIdentity(dir,project,value,stage);
  return structuredClone(value);
}
function localValidation(dir: string, project: JsonObject): Finding[] {
  const refusals: Finding[] = []; checkCorrections({dir,project,refusals,warnings:[]}); return refusals;
}
/** Like choice ingestion, tolerate unrelated pre-existing holes but never a new finding or this record's own invalidity. */
function save(dir: string, file: string, beforeBytes: string, original: JsonObject, next: JsonObject): void {
  const own = localValidation(dir,next)[0]; if (own) refuse(own.code,own.message);
  const baseline = checkProject(dir,original).refusals;
  const counts = new Map<string,number>();
  for (const f of baseline) { const k=`${f.code}:${f.path}`; counts.set(k,(counts.get(k)??0)+1); }
  for (const f of checkProject(dir,next).refusals) { const k=`${f.code}:${f.path}`;const n=counts.get(k)??0;if (!n) refuse(f.code,f.message);counts.set(k,n-1); }
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
export function correctionCommand(args: string[]): {stdout:string;exit:number} {
  try { return command(args); } catch(e) { if(e instanceof DirectionError) refuse(e.code,e.message); if(e instanceof CorrectionError) { const f=correctionFinding(e.code,'corrections',e.message);refuse(f.code,f.message); } throw e; }
}
function command(args:string[]): {stdout:string;exit:number} {
  const action=args[0];const opts:Record<string,string>={};const positional:string[]=[];let json=false;
  const allowed=action==='record'?[...common,'--id','--path','--stage','--verbatim-file','--source','--resolves','--patch-file','--direction-patch-file','--feedback-file','--item']:action==='resolve'?[...common,'--reasoning-file','--applied-feedback','--feedback-id']:[];
  for(let i=1;i<args.length;i++) {const arg=args[i] as string;if(arg==='--json'){if(json)usage('duplicate --json');json=true;}else if(allowed.includes(arg)){const value=args[++i];if(!value||value.startsWith('--')||opts[arg]!==undefined)usage(`${arg} requires one value`);opts[arg]=value;}else if(arg.startsWith('-'))usage(`unknown ${arg}`);else positional.push(arg);}
  if(!['--adopt','record','resolve'].includes(action??'')||positional.length>(action==='resolve'?2:1))usage('invalid action or directory count');
  if(action==='resolve'&&!positional[0])usage('resolve requires correction id');
  const dir=resolve(positional[action==='resolve'?1:0]??process.cwd());const {file,project}=readProject(dir);const originalBytes=correctionBytes(dir,'project.json').toString('utf8');const next=structuredClone(project);const at=new Date().toISOString();
  if(action==='--adopt') {
    if (next.corrections_contract !== undefined) {
      const invalid=localValidation(dir,next)[0];if(invalid)refuse(invalid.code,invalid.message);
      if(correctionsAdopted(next))return{stdout:'correction: already adopted; original adoption preserved',exit:0};
    }
    next.corrections_contract={schema:CORRECTIONS_SPEC,adopted_at:at};next.corrections=next.corrections??[];
    save(dir,file,originalBytes,project,next);return{stdout:json?JSON.stringify(next.corrections_contract):'correction: adopted; historical records preserved',exit:0};
  }
  if(!correctionsAdopted(next))throw new CorrectionError('CORRECTION_CONTRACT_INVALID','adopt corrections explicitly first');
  const records=objects(next.corrections);
  let record:JsonObject;
  let coverage = '';
  if(action==='record') {
    const stage=opts['--stage'];const path=opts['--path'];
    if(!opts['--id']||!stage||!CORRECTION_STAGES.includes(stage)||!['described','made'].includes(path??'')||!opts['--by'])usage('record requires id/path/stage/by');
    openStage(next,stage);
    const direction=Boolean(opts['--direction-patch-file']);
    if(direction && path!=='made')usage('direction-patch-file is made-only');
    const version = path === 'described' && stage === 'direction-review' && opts['--version'] && !opts['--draft'] && !opts['--parts-file']
      ? versionRecord(next, Number(opts['--version'].replace(/^v/, ''))) : null;
    const describedDirection = path === 'described' && stage === 'direction-review' && version?.kind === 'post' && isObject(version.provenance) && isObject(version.provenance.direction);
    let on: JsonObject;
    if (describedDirection) {
      if (opts['--draft'] || opts['--parts-file']) usage('select only --version for a direction description');
      on = directionPostIdentity(dir, next, version.n);
      if (opts['--model-file'] && opts['--model-file'] !== (on.model as JsonObject).path) throw new CorrectionError('CORRECTION_SOURCE', '--model-file must name the direction source compiled model');
    } else on = identity(dir,next,opts,stage,direction);
    let artifact:JsonObject;let verbatim:string;
    if(path==='described') {
      if(opts['--patch-file']||opts['--feedback-file']||opts['--item']||!opts['--verbatim-file'])usage('described requires only verbatim text, not producer artifact flags');
      artifact={kind:'description'};verbatim=readVerbatim(opts['--verbatim-file']);
    }else {
      if(opts['--by']!=='user')throw new CorrectionError('CORRECTION_MALFORMED','made requires --by user');
      if(Number(Boolean(opts['--patch-file']))+Number(Boolean(opts['--feedback-file']))+Number(direction)!==1)usage('made requires exactly one patch-file or feedback-file');
      if(direction) {
        if(opts['--item'] || !opts['--verbatim-file'])usage('direction capture needs verbatim-file and no item');
        artifact={kind:'direction-patch',patch:correctionBinding(dir,opts['--direction-patch-file'] as string),state:'preview/pending',result:null};verbatim=readVerbatim(opts['--verbatim-file']);
      }else if(opts['--patch-file']) {
        if(opts['--item']||!opts['--verbatim-file'])usage('patch-only capture needs verbatim-file and no item');
        artifact={kind:'config-patch',patch:correctionBinding(dir,opts['--patch-file']),state:'preview/pending',feedback:null};verbatim=readVerbatim(opts['--verbatim-file']);
      }else {
        if(!opts['--item']||opts['--verbatim-file'])usage('session capture requires item and uses its summary verbatim');
        const binding=correctionBinding(dir,opts['--feedback-file'] as string);const feedback=correctionJson(correctionBytes(dir,opts['--feedback-file'] as string));
        const items=objects(feedback.feedback).filter(i=>i.id===opts['--item']);const item=items[0];
        if(feedback.schema!=='rig-review-session/1'||items.length!==1||!item||typeof item.summary!=='string'||!isObject(item.context)||!isObject(item.context.applied))throw new CorrectionError('CORRECTION_APPLIED_INVALID','session needs exactly one applied item');
        verbatim=item.summary;const applied=item.context.applied;
        if(applied.schema==='rig-review-applied/2' && on.kind!=='post') artifact={kind:'config-patch',state:'preview/pending',feedback:{file:binding,item_id:opts['--item']}};
        else artifact={kind:'unsupported',operation:applied.schema==='rig-review-applied/3'?'mesh-delta':String(applied.op).includes('retarget')?'retarget':String(applied.op).includes('key')?'keyed-animation':'other',reason:'No checked create adapter for this producer-owned operation',files:[binding],producer_schema:String(applied.schema)};
      }
    }
    record={schema:direction || describedDirection?DIRECTION_CORRECTION_SPEC:CORRECTION_SPEC,id:opts['--id'],path:path as string,by:opts['--by'],at,verbatim,stage,on,artifact,outcome:null,resolves:opts['--resolves']??null};
    if(opts['--source']!==undefined)record.source=opts['--source'];
    next.corrections=[...asArray(next.corrections),record];
  } else {
    const matches=records.filter(r=>r.id===positional[0]);
    if(matches.length!==1)throw new CorrectionError('CORRECTION_SOURCE','resolve requires one existing correction');
    record=matches[0] as JsonObject;
    if(record.outcome!==null)throw new CorrectionError('CORRECTION_OUTCOME','closure is write-once');
    if(!correctionIsLive(next,record))throw new CorrectionError('CORRECTION_SOURCE','superseded correction cannot close a current review');
    if(opts['--by']!=='agent'||!opts['--reasoning-file'])usage('resolve requires --by agent --reasoning-file');
    openStage(next,String(record.stage));
    const artifact=record.artifact as JsonObject;
    if(artifact.kind==='unsupported')throw new CorrectionError('CORRECTION_UNSUPPORTED_OUTCOME','unsupported operation cannot claim checked completion');
    if((opts['--applied-feedback']===undefined)!==(opts['--feedback-id']===undefined))usage('applied-feedback and feedback-id are paired');
    if(artifact.kind==='description'&&(opts['--applied-feedback']||opts['--feedback-id']))usage('described closure takes no Apply flags');
    if(artifact.kind==='config-patch') {
      if(opts['--applied-feedback'])artifact.feedback={file:correctionBinding(dir,opts['--applied-feedback']),item_id:opts['--feedback-id'] as string};
      const {item, applied}=correctionApplied(dir,artifact);
      if (isObject(applied.check) && isObject(applied.check.bars)) coverage = correctionCheckCoverage(applied.check);
      // A preview's human words cannot silently change when an Apply is attached.
      if(record.verbatim!==item.summary)throw new CorrectionError('CORRECTION_APPLIED_INVALID','selected feedback summary differs from retained human correction');
      artifact.state='applied-and-checked';
    }
    const direction=artifact.kind==='direction-patch';
    if (record.schema === DIRECTION_CORRECTION_SPEC && artifact.kind === 'description') {
      if (!opts['--version'] || opts['--draft'] || opts['--parts-file']) usage('direction description closure requires only --version and optional --model-file');
      record.outcome = directionPostIdentity(dir, next, Number(opts['--version'].replace(/^v/, '')));
      if (opts['--model-file'] && opts['--model-file'] !== (record.outcome.model as JsonObject).path) throw new CorrectionError('CORRECTION_SOURCE', '--model-file must name the direction source compiled model');
    } else {
      record.outcome=identity(dir,next,opts,String(record.stage),direction);
      if (artifact.kind === 'description' && record.outcome.kind === 'post') {
        const version = versionRecord(next, record.outcome.n);
        if (isObject(version.provenance) && isObject(version.provenance.direction) && (record.outcome.model as JsonObject).path === version.provenance.direction.path) throw new CorrectionError('CORRECTION_SOURCE', '--model-file must not name the authored direction document; capture a new correction@2 description');
      }
    }
    if(direction){
      if(opts['--applied-feedback']||opts['--feedback-id'])usage('direction closure does not ingest review applied reports');
      artifact.result=(record.outcome as JsonObject).direction as JsonObject;artifact.state='applied-and-checked';validateDirectionOutcome(dir,next,record,artifact);
    }record.closure={by:'agent',at,reasoning:readVerbatim(opts['--reasoning-file']) + (coverage ? `\n${coverage}` : '')};
  }
  save(dir,file,originalBytes,project,next);
  return{stdout:json?JSON.stringify(record,null,2):`correction: ${action==='record'?'recorded':'resolved'} ${String(record.id)}; stage unchanged${coverage ? `\n${coverage}` : ''}`,exit:0};
}

/** Public approval paths that do not run checkProject still share the correction validator. */
export function assertCorrectionApproval(dir:string,project:JsonObject,stage:string,signoff?:JsonObject):void {
  const invalid=localValidation(dir,project)[0]??correctionApprovalFindings(project,stage,signoff)[0];if(invalid)refuse(invalid.code,invalid.message);
}
