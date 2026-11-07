import { SceneError, readScene, validateSceneCurrent } from './scene.ts';
import { fixedNotApplicableCamera } from './direction-citation.ts';
/** Create owns these authored camera/timing bytes. No renderer or external producer runs here. */
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { isDeepStrictEqual as equal } from 'node:util';
import { asArray, collectItems, collectSignoffs, isDecision, isObject, loadCollection, type Ctx, type Finding } from './check.ts';
import { optionFile, selection, validateChoice } from './choices.ts';
import { checkEntry } from './provenance.ts';
import { collectReopens, liveSignoff } from './reopen.ts';
import { refuse } from './refusal.ts';
import { latestAccepted, readVersions } from './review.ts';
import { stepHash } from './step-hash.ts';
import { structurePathIsIgnored } from './structure.ts';
import type { Json, JsonObject } from './templates.ts';

export const DIRECTION_SPEC = 'rig-create/direction@1';
export const DIRECTION_SCENE_SPEC = 'rig-create/direction@2';
/** Landing day at 00:00Z; earlier direction@1 posts WARN. */
export const DIRECTION_SCENE_SINCE = '2026-11-08T00:00:00Z';
export const DIRECTION_CONTRACT = 'rig-create/direction-contract@1';
export const DIRECTION_PATCH_SPEC = 'rig-review-direction-patch/1';
export const DIRECTION_CORRECTION_SPEC = 'rig-create/correction@2';
export const directionHash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
export const directionPath = (n: number): string => `evidence/direction/v${n}.json`;
export const objects = (v: Json | undefined): JsonObject[] => asArray(v).filter(isObject);
export const hex = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
export const closed = (v: unknown, required: string[], optional: string[] = []): v is JsonObject => isObject(v as Json) && required.every(k => k in (v as JsonObject)) && Object.keys(v as JsonObject).every(k => required.includes(k) || optional.includes(k));
const positiveInt = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
export class DirectionError extends Error { constructor(readonly code: string, readonly path: string, why: string) { super(`${path}: ${why}; retain the source bytes, correct this record and retry direction check`); } }
export function directionFail(code: string, path: string, why: string): never { throw new DirectionError(code, path, why); }
export function directionFinding(e: DirectionError): Finding { return { code: e.code, path: e.path, message: e.message }; }
export function directionBytes(dir: string, path: string): Buffer {
  try {
    if (isAbsolute(path) || path.includes('\\') || path.split('/').some(p => !p || p === '.' || p === '..') || structurePathIsIgnored(dir, path) && !/^derived\/review\/v[1-9][0-9]*\/out\/check\/build\/skeleton\.model\.json$/.test(path)) throw Error('literal retained POSIX path required');
    let current = realpathSync(dir);
    for (const [i, segment] of path.split('/').entries()) {
      current = join(current, segment); const stat = lstatSync(current);
      if (stat.isSymbolicLink() || (i === path.split('/').length - 1 ? !stat.isFile() : !stat.isDirectory())) throw Error('symlink or nonregular file');
    }
    return readFileSync(current);
  } catch (e) { return directionFail('DIRECTION_FILE', path, e instanceof Error ? e.message : String(e)); }
}
export function directionBinding(dir: string, path: string): JsonObject { return { path, sha256: directionHash(directionBytes(dir, path)) }; }
export function boundDirectionBytes(dir: string, binding: Json | undefined): Buffer {
  if (!closed(binding, ['path', 'sha256']) || typeof binding.path !== 'string' || !hex(binding.sha256)) directionFail('DIRECTION_SCHEMA', 'direction.binding', 'expected {path,sha256}');
  const bytes = directionBytes(dir, binding.path as string);
  if (directionHash(bytes) !== binding.sha256) directionFail('DIRECTION_HASH', String(binding.path), 'bytes differ from declared SHA256');
  return bytes;
}
export function directionJson(bytes: Uint8Array, path: string): JsonObject {
  try { const v: Json = JSON.parse(Buffer.from(bytes).toString('utf8')); if (!isObject(v)) throw Error('object required'); return v; }
  catch { return directionFail('DIRECTION_SCHEMA', path, 'JSON object required'); }
}
export function directionVersion(project: JsonObject, n: Json | undefined): JsonObject {
  const found = objects(project.versions).filter(v => v.n === n);
  if (!positiveInt(n) || found.length !== 1) directionFail('DIRECTION_VERSION', 'versions', 'post version must exist uniquely');
  return found[0] as JsonObject;
}
export function directionContract(project: JsonObject, now: number): JsonObject | null {
  const value = project.direction_contract;
  if (value === undefined) return null;
  if (!closed(value, ['schema', 'adopted_at', 'grandfathered_posts']) || value.schema !== DIRECTION_CONTRACT || typeof value.adopted_at !== 'string' || !/Z$/.test(value.adopted_at) || !Number.isFinite(Date.parse(value.adopted_at)) || Date.parse(value.adopted_at) > now || !Array.isArray(value.grandfathered_posts) || value.grandfathered_posts.some((n,i,a) => !positiveInt(n) || i > 0 && Number(a[i-1]) >= Number(n))) directionFail('DIRECTION_CONTRACT_INVALID', 'direction_contract', 'invalid explicit adoption');
  for (const n of value.grandfathered_posts as Json[]) {
    const v = objects(project.versions).filter(v => v.n === n);
    if (v.length !== 1 || v[0]?.kind !== 'post' || typeof v[0].at !== 'string' || Date.parse(v[0].at) > Date.parse(String(value.adopted_at))) directionFail('DIRECTION_CONTRACT_INVALID', 'direction_contract.grandfathered_posts', 'grandfathered posts must be existing pre-adoption posts');
  }
  return value;
}
export function validateDirectionShape(doc: JsonObject, path = 'direction'): void {
  const bad = (why: string): never => directionFail('DIRECTION_SCHEMA', path, why);
  const scene = doc.schema === DIRECTION_SCENE_SPEC;
  if (!closed(doc, ['schema','rig','take','camera','timing','citations', ...(scene ? ['scene'] : [])]) || ![DIRECTION_SPEC, DIRECTION_SCENE_SPEC].includes(String(doc.schema))) bad('expected closed direction@1 or direction@2');
  if (scene && (!closed(doc.scene, ['n', 'path', 'sha256']) || !positiveInt(doc.scene.n) || typeof doc.scene.path !== 'string' || !hex(doc.scene.sha256))) bad('scene requires n, path and raw-byte sha256');
  if (!closed(doc.rig, ['version','model']) || !positiveInt(doc.rig.version) || !closed(doc.rig.model,['path','sha256']) || typeof doc.rig.model.path !== 'string' || !hex(doc.rig.model.sha256)) bad('rig needs version and model file binding');
  if (!closed(doc.take,['duration','loop']) || !finite(doc.take.duration) || doc.take.duration <= 0 || typeof doc.take.loop !== 'boolean') bad('take duration must be positive finite seconds and loop boolean');
  const duration = (doc.take as JsonObject).duration as number;
  for (const section of ['camera','timing'] as const) {
    const value = doc[section];
    if (!closed(value, section === 'camera' ? ['space','keys'] : ['keys']) || section === 'camera' && value.space !== 'rig-world-y-up' || !Array.isArray(value.keys) || value.keys.length < (section === 'camera' ? 1 : 2) || value.keys.length > 256) bad(`${section}: invalid space/keys count`);
    const keys = (value as JsonObject).keys as Json[];
    let previous = -Infinity; let source = -Infinity;
    for (const [i, key] of keys.entries()) {
      if (!closed(key, section === 'camera' ? ['time','box','easing'] : ['time','source_time','easing']) || !finite(key.time) || !['linear','hold','smoothstep'].includes(String(key.easing))) bad(`${section}.keys[${i}]: invalid typed key/easing`);
      const k = key as JsonObject; const t = k.time as number;
      if (t < 0 || t > duration || i === 0 && t !== 0 || section === 'timing' && i === keys.length - 1 && t !== duration) directionFail('DIRECTION_KEY_OUTSIDE_TAKE', `${path}.${section}.keys[${i}]`, 'keys must start at zero, stay inside take; timing ends at duration');
      if (t <= previous) directionFail('DIRECTION_TIME_NON_MONOTONIC', `${path}.${section}.keys[${i}]`, 'take times must strictly increase');
      previous = t;
      if (section === 'camera') {
        const box = k.box;
        if (!closed(box,['x','y','width','height']) || !Object.values(box).every(finite) || Number(box.width) <= 0 || Number(box.height) <= 0) bad('box needs finite x/y and positive width/height');
      } else {
        if (!finite(k.source_time) || k.source_time < 0) bad('source_time must be finite nonnegative seconds');
        if (Number(k.source_time) < source) directionFail('DIRECTION_TIME_NON_MONOTONIC', `${path}.timing.keys[${i}]`, 'source times cannot decrease');
        source = Number(k.source_time);
      }
    }
  }
  if (!closed(doc.citations,['camera','timing'])) bad('citations requires camera/timing');
  for (const [section, guide] of [['camera','camera_depth'],['timing','post_timing']]) {
    const citation = (doc.citations as JsonObject)[section as string];
    if (!(closed(citation,['guide','asks','quote']) && typeof citation.quote === 'string' && citation.quote.length > 0 || closed(citation,['guide','asks','delegated']) && citation.delegated === true) || citation.guide !== guide || !equal(citation.asks,[guide])) bad('citation needs exact guide/ask and quote or delegated:true');
  }
}
/** Validate citations through the existing provenance reader, including history and inheritance. */
export function validateDirectionCitations(dir: string, project: JsonObject, doc: JsonObject, current = false): void {
  const collection = loadCollection(dir); const items = collectItems(project,{collection});
  const refusals: Finding[] = []; const ctx: Ctx = { dir,project,collection,items,refusals,warnings:[],signoffs:[],steps:[],stage:String(project.stage),effectiveStage:String(project.stage),predatesPartsReview:null };
  for (const section of ['camera','timing']) {
    const citation = (doc.citations as JsonObject)[section] as JsonObject;
    const item = items.find(i => i.id === citation.guide);
    const fixedNotApplicable = fixedNotApplicableCamera(section, item, citation, doc);
    if (!fixedNotApplicable) checkEntry(ctx,'post',`direction.citations.${section}`,citation);
    const currentAnswer=item && (item.state.state==='user'||item.state.state==='delegated')?item.state.answer:null;
    if(current && currentAnswer && objects(currentAnswer.asks).some(a=>a.state==='other-pending' || a.state==='delegated' && !isDecision(currentAnswer.agent_decision))) directionFail('DIRECTION_CITATION',`direction.citations.${section}`,'current per-ask selection is pending');
    if(current && item && (item.state.state === 'user' || item.state.state === 'delegated') && item.state.answer.choice !== undefined){
      try{
        validateChoice(dir,project,item,item.state.answer);
        const choice=item.state.answer.choice as JsonObject;const set=optionFile(dir,choice.set).set;const selected=selection(set,choice);
        if(selected.pending.length || selected.autos.length && !isObject(item.state.answer.agent_decision))throw Error('per-ask response is pending');
      }catch(e){directionFail('DIRECTION_CITATION',`direction.citations.${section}`,e instanceof Error?e.message:String(e));}
    }
    if (current && item && (item.state.state === 'delegated' && !item.state.decided || !['user','delegated'].includes(item.state.state) && !fixedNotApplicable)) directionFail('DIRECTION_CITATION', `direction.citations.${section}`, 'answer is not a current user or decided delegation');
  }
  if (refusals[0]) directionFail('DIRECTION_CITATION',refusals[0].path,refusals[0].message);
  if (!current) return;
  const reopens = collectReopens(project,[]);
  const steps = objects(isObject(project.plan) ? project.plan.steps : undefined);
  for (const id of ['camera','timing']) {
    const matches = steps.filter(s => s.id === id && s.phase === 'post');
    const state=items.find(i=>i.id===(id==='camera'?'camera_depth':'post_timing'))?.state;
    const answer=state&&(state.state==='user'||state.state==='delegated'||state.state==='not_applicable')?state.answer:null;
    const times=answer?[answer.at,isObject(answer.agent_decision)?answer.agent_decision.at:undefined,...objects(answer.additions).map(a=>a.at)].filter((v):v is string=>typeof v==='string').map(Date.parse):[];
    if (matches.length !== 1 || !collectSignoffs(project,[]).some(s => s.stage === 'post-interview' && s.checkpoint === null && liveSignoff(reopens,s.stage,s.at) && (s.steps === null || s.steps.includes(id)) && isObject(s.record.step_hashes) && s.record.step_hashes[id] === stepHash(matches[0] as JsonObject) && times.every(t=>Number.isFinite(t)&&t<=s.at))) directionFail('DIRECTION_CITATION',`plan.steps[${id}]`,'live post-interview approval and matching step hash required');
  }
}
export function validateDirectionRig(dir: string, project: JsonObject, doc: JsonObject, current: boolean): void {
  const binding = doc.rig as JsonObject;
  const found = objects(project.versions).filter(v => v.n === binding.version && v.kind === 'rig');
  const v = found[0]; const pkg = v?.review_package;
  const model = binding.model as JsonObject;
  const target = `derived/review/v${String(binding.version)}/out/check/build/skeleton.model.json`;
  if (found.length !== 1 || !isObject(pkg) || !objects(pkg.files).some(f => f.path === 'out/check/build/skeleton.model.json' && f.sha256 === model.sha256) || model.path !== target) directionFail('DIRECTION_RIG_UNKNOWN','direction.rig','unknown review-package compiled model identity');
  boundDirectionBytes(dir,model);
  const versions = readVersions(project); const accepted = latestAccepted(versions);
  const source = versions.rigs.find(r => r.n === binding.version);
  if (!source?.accepted || current && (accepted?.n !== binding.version || versions.rigs.some(r => r.live && r.n > Number(binding.version)))) directionFail('DIRECTION_RIG_STALE','direction.rig','current authoring requires latest accepted live rig');
}
/** Currentness is shared with scene authoring; historical documents retain their seals. */
export function validateDirectionScene(dir: string, project: JsonObject, doc: JsonObject, current = false, snapshots?: Map<string, Buffer>): void {
  if (doc.schema !== DIRECTION_SCENE_SPEC) return;
  try {
    const reference = doc.scene as JsonObject;
    const scene = readScene(dir, project, reference, snapshots);
    const rig = doc.rig as JsonObject;
    const sceneRig = scene.rig as JsonObject;
    if (rig.version !== sceneRig.version || !equal(rig.model, sceneRig.model)) directionFail('DIRECTION_SCENE_MISMATCH', 'direction.scene', 'direction rig and model must equal the scene rig and model');
    validateSceneCurrent(project, sceneRig, current, reference);
  } catch (error) {
    if (error instanceof SceneError) directionFail(error.code, error.path, error.message);
    throw error;
  }
}
export function requireDirectionScene(doc: JsonObject, at: number, path: string): void {
  if (at >= Date.parse(DIRECTION_SCENE_SINCE) && doc.schema !== DIRECTION_SCENE_SPEC) directionFail('DIRECTION_SCENE_REQUIRED', path, 'run scene write and bind that scene in a direction@2 document');
}
export function readDirection(dir: string, project: JsonObject, n: Json | undefined, current = false): JsonObject {
  const v = directionVersion(project,n); const prov = v.provenance;
  if (v.kind !== 'post') directionFail('DIRECTION_VERSION',`versions[v${String(n)}]`,'direction belongs to a post version');
  if (!isObject(prov) || !isObject(prov.direction)) directionFail('DIRECTION_DOCUMENT_REQUIRED',`versions[v${String(n)}].provenance.direction`,'retain a direction document for this post');
  const binding = prov.direction;
  if (binding.path !== directionPath(Number(n))) directionFail('DIRECTION_VERSION',`versions[v${String(n)}].provenance.direction`,'document path must name its post version');
  const doc = directionJson(boundDirectionBytes(dir,binding),String(binding.path)); validateDirectionShape(doc,String(binding.path));
  if (!equal(prov.config,binding) || !objects(v.outputs).some(o=>equal(o,binding))) directionFail('DIRECTION_VERSION',`versions[v${String(n)}].provenance`,'config and declared output must bind the direction document');
  if ((doc.rig as JsonObject).version !== v.rig_version) directionFail('DIRECTION_RIG_STALE',`versions[v${String(n)}].rig_version`,'document and post bind different rigs');
  if (!isObject(prov.sections) || !['camera','timing'].every(section => {const entries=objects((prov.sections as JsonObject)[section]);return entries.length === 1 && equal(entries[0],{entry:section,...((doc.citations as JsonObject)[section] as JsonObject)});})) directionFail('DIRECTION_CITATION',`versions[v${String(n)}].provenance.sections`,'version citations must match authored document citations');
  requireDirectionScene(doc, Date.parse(String(v.at)), `versions[v${String(n)}].provenance.direction`);
  validateDirectionScene(dir, project, doc, current);
  validateDirectionRig(dir,project,doc,current); validateDirectionCitations(dir,project,doc,current);
  return doc;
}
export function checkDirections(ctx: {dir:string;project:JsonObject;refusals:Finding[];warnings?:Finding[]}, now: number, selected?: number, currentOverride?: boolean): void {
  try {
    const contract = directionContract(ctx.project, now);
    const posts = objects(ctx.project.versions).filter(v=>v.kind==='post');
    const reopens = collectReopens(ctx.project,[]);
    const latest = Math.max(0,...posts.filter(v=>liveSignoff(reopens,'post',Date.parse(String(v.at)))).map(v=>Number(v.n)));
    for (const v of posts) {
      if (selected !== undefined && v.n !== selected) continue;
      const explicit = isObject(v.provenance) && v.provenance.direction !== undefined;
      if (contract && (contract.grandfathered_posts as Json[]).includes(v.n as number)) continue;
      if (!explicit && !contract && Date.parse(String(v.at)) < Date.parse(DIRECTION_SCENE_SINCE)) continue;
      try {
        if (!explicit && Date.parse(String(v.at)) >= Date.parse(DIRECTION_SCENE_SINCE)) directionFail('DIRECTION_SCENE_REQUIRED', `versions[v${String(v.n)}].provenance.direction`, 'run scene write and retain a direction@2 document');
        const doc = readDirection(ctx.dir,ctx.project,v.n,currentOverride ?? v.n===latest);
        if (doc.schema === DIRECTION_SPEC) ctx.warnings?.push({code:'DIRECTION_SCENE_REQUIRED',path:`versions[v${String(v.n)}].provenance.direction`,message:`versions[v${String(v.n)}].provenance.direction: historical direction@1 predates ${DIRECTION_SCENE_SINCE}; run scene write and author direction@2 for the next post`});
      }
      catch(e) { if (!(e instanceof DirectionError)) throw e; ctx.refusals.push(directionFinding(e)); }
    }
  } catch(e) { if (!(e instanceof DirectionError)) throw e; ctx.refusals.push(directionFinding(e)); }
}
export function assertDirectionApproval(dir:string,project:JsonObject,stage:string,now:number,n?:number):void {
  if(stage!=='direction-review')return;
  const latestPost=Math.max(0,...objects(project.versions).filter(v=>v.kind==='post' && liveSignoff(collectReopens(project,[]),'post',Date.parse(String(v.at)))).map(v=>Number(v.n)));
  const refusals:Finding[]=[];checkDirections({dir,project,refusals},now,n??latestPost,true);
  const first=refusals[0];if(first)refuse(first.code,first.message);
  if(n!==undefined){const latest=Math.max(0,...objects(project.versions).filter(v=>v.kind==='post' && liveSignoff(collectReopens(project,[]),'post',Date.parse(String(v.at)))).map(v=>Number(v.n)));if(n!==latest && (project.direction_contract!==undefined || objects(project.versions).some(v=>isObject(v.provenance)&&v.provenance.direction!==undefined)))refuse('DIRECTION_VERSION','versions: accept only the current post version; select the current post');}
}
export function directionPostIdentity(dir:string,project:JsonObject,n:Json|undefined):JsonObject {
  const doc=readDirection(dir,project,n);const v=directionVersion(project,n);const prov=v.provenance as JsonObject;
  const scene = doc.scene as JsonObject | undefined;
  return {kind:'post',n:n as number,config:prov.config as JsonObject,model:(doc.rig as JsonObject).model as JsonObject,direction:prov.direction as JsonObject,...(scene ? {scene:{path:scene.path!,sha256:scene.sha256!}} : {})};
}
export function validateDirectionIdentity(dir:string,project:JsonObject,identity:JsonObject):void {
  if(!closed(identity,['kind','n','config','model','direction'],['scene']) || identity.kind!=='post' || !equal(identity,directionPostIdentity(dir,project,identity.n)))directionFail('DIRECTION_CORRECTION_OUTCOME','corrections.identity','expected exact bound direction post identity');
}
export function patchDirection(project:JsonObject,source:JsonObject,patch:JsonObject):JsonObject {
  if(!closed(patch,['schema','source_post','rig_model_sha256','direction_sha256','replace']) || patch.schema!==DIRECTION_PATCH_SPEC || !positiveInt(patch.source_post) || !hex(patch.rig_model_sha256) || !hex(patch.direction_sha256) || !closed(patch.replace,[],['camera','timing','take']) || Object.keys(patch.replace).length===0)directionFail('DIRECTION_PATCH','direction.patch','expected closed direction-patch/1 and typed whole replacements');
  const v=directionVersion(project,patch.source_post);const prov=v.provenance;
  if(v.kind!=='post' || !isObject(prov) || !isObject(prov.direction) || prov.direction.sha256!==patch.direction_sha256 || ((source.rig as JsonObject).model as JsonObject).sha256!==patch.rig_model_sha256)directionFail('DIRECTION_PATCH','direction.patch','patch base post/document/model do not match');
  const result=structuredClone(source);for(const[k,value]of Object.entries(patch.replace))result[k]=value;
  validateDirectionShape(result);
  if(equal(result,source))directionFail('DIRECTION_PATCH','direction.patch','no-op replacements are refused');
  return result;
}
/** Closure revalidates create-owned authoring, never an external producer measurement. */
export function validateDirectionOutcome(dir:string,project:JsonObject,record:JsonObject,artifact:JsonObject):void {
  if(!closed(artifact,['kind','patch','state','result']) || artifact.kind!=='direction-patch' || !['preview/pending','applied-and-checked'].includes(String(artifact.state)))directionFail('DIRECTION_CORRECTION_OUTCOME','corrections.artifact','invalid direction artifact');
  if(!isObject(record.on))directionFail('DIRECTION_CORRECTION_OUTCOME','corrections.on','post identity required');
  validateDirectionIdentity(dir,project,record.on);
  const patch=directionJson(boundDirectionBytes(dir,artifact.patch),'direction.patch');
  if(patch.source_post!==record.on.n)directionFail('DIRECTION_PATCH','corrections.on','patch source differs from captured post');
  const source=readDirection(dir,project,record.on.n);const expected=patchDirection(project,source,patch);
  if(record.outcome===null){if(artifact.state!=='preview/pending' || artifact.result!==null)directionFail('DIRECTION_CORRECTION_OUTCOME','corrections.artifact','pending record cannot claim a result');return;}
  if(!isObject(record.outcome) || artifact.state!=='applied-and-checked')directionFail('DIRECTION_CORRECTION_OUTCOME','corrections.outcome','closure requires a checked direction result');
  validateDirectionIdentity(dir,project,record.outcome);
  const outcome=record.outcome;const v=directionVersion(project,outcome.n);const origin=v.direction_origin;
  if(Number(outcome.n)<=Number(record.on.n) || !equal(outcome.scene,record.on.scene) || !equal(outcome.model,record.on.model) || !equal(artifact.result,outcome.direction) || equal(record.on.direction,outcome.direction) || !closed(origin,['source_post','patch','result']) || origin.source_post!==record.on.n || !equal(origin.patch,artifact.patch) || !equal(origin.result,artifact.result) || !equal(readDirection(dir,project,outcome.n),expected))directionFail('DIRECTION_CORRECTION_OUTCOME','corrections.outcome','result must be produced from this exact patch/base on the same rig');
}
