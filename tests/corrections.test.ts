import { syntheticReviewRunner } from './review-read-fixture.ts';
import { afterEach, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CorrectionError, correctionApprovalFindings, correctionHash, validateCorrectionPatch } from '../src/corrections.ts';
import { fixture as projectFixture } from './fixtures.ts';
import { recordPartsReceipt } from './parts-receipt-fixture.ts';
import { withPartsCheck } from './parts-check-fixture.ts';
import { Refusal } from '../src/refusal.ts';
import { selectAnswerHashes } from '../src/signoff-answers.ts';
import { hasStageOrder, LEGACY_STAGE_VALUES } from '../src/stages.ts';
import { stepHash } from '../src/step-hash.ts';
import type { JsonObject } from '../src/templates.ts';
import { correctionFixture, correctionCommentsFixture, commentsReviewRunner, COMMENTS_APPLY_ID } from './correction-fixture.ts';
import { advanceCommand, checkCorrections, checkProject, assertCorrectionApproval, correctionCommand, diffClassesCommand, draftRigCommand, reopenCommand, signoffCommand, testClock } from './clock.ts';
import { clockedCli } from './helpers.ts';

const requireCore = createRequire(import.meta.url);
const { encodePng } = requireCore('@rig-c/core/plate') as { encodePng: (width: number, height: number, data: Uint8Array) => Buffer };
const roots:string[]=[];
afterEach(()=>{testClock.reset();for(const d of roots.splice(0))rmSync(d,{recursive:true,force:true});});
function fixture(kind:'post'|'rig'|'parts'='post'){const dir=mkdtempSync(join(tmpdir(),'correction-'));roots.push(dir);return{dir,...correctionFixture(dir,kind)};}
const load=(d:string):JsonObject=>JSON.parse(readFileSync(join(d,'project.json'),'utf8'));
function check(d:string,p=load(d)){const ctx={dir:d,project:p,refusals:[] as {code:string}[],warnings:[] as {code:string}[]};checkCorrections(ctx as Parameters<typeof checkCorrections>[0]);return ctx;}
function rejected(d:string,code:string,run:()=>unknown){const before=readFileSync(join(d,'project.json'));let caught='';try{run();}catch(e){if(!(e instanceof Refusal))throw e;caught=e.code;}expect(caught).toBe(code);expect(readFileSync(join(d,'project.json'))).toEqual(before);}
function record(d:string,args:string[],path='described',extra:string[]=[]){testClock.set(new Date('2026-11-04T09:10:00Z'));return correctionCommand(['record',d,'--id','fix','--path',path,'--stage',args.includes('--parts-file')?'parts-review':args.includes('--model-file')?'direction-review':'rig-review','--by',path==='made'?'user':'reviewer',...args,...((extra.includes('--feedback-file')||extra.includes('--patch-file'))?[]:['--verbatim-file',join(d,'words.txt')]),...extra],syntheticReviewRunner);}
function close(d:string,args:string[],extra:string[]=[]){testClock.set(new Date('2026-11-04T10:00:00Z'));return correctionCommand(['resolve','fix',d,'--by','agent','--reasoning-file',join(d,'reasoning.txt'),...args,...extra],syntheticReviewRunner);}

test('described post correction preserves exact words, requires explicit output and closes once',()=>{
 const f=fixture();record(f.dir,f.args);let p=load(f.dir);let r=(p.corrections as JsonObject[])[0]!;expect(r.verbatim).toBe('Keep the precise words.  \r\n');expect(check(f.dir).warnings.map(w=>w.code)).toEqual(['CORRECTION_OPEN']);expect(correctionApprovalFindings(p,'direction-review').map(x=>x.code)).toEqual(['CORRECTION_PENDING']);close(f.dir,f.outcome);expect(check(f.dir).refusals).toEqual([]);expect(check(f.dir).warnings).toEqual([]);r=(load(f.dir).corrections as JsonObject[])[0]!;expect((r.closure as JsonObject).by).toBe('agent');rejected(f.dir,'CORRECTION_OUTCOME',()=>close(f.dir,f.outcome));
});
test('explicit adoption is idempotent and malformed contracts cannot become legacy',()=>{const f=fixture();const bytes=readFileSync(join(f.dir,'project.json'));correctionCommand(['--adopt',f.dir]);expect(readFileSync(join(f.dir,'project.json'))).toEqual(bytes);const p=load(f.dir);p.corrections_contract={schema:'unknown',adopted_at:'bad'};expect(check(f.dir,p).refusals.map(f=>f.code)).toContain('CORRECTION_CONTRACT_INVALID');delete p.corrections_contract;expect(check(f.dir,p).warnings.map(f=>f.code)).toEqual(['CORRECTION_PATH_LEGACY']);});
test('stage-1 parts corrections exist before a version and approved parts must match outcome',()=>{const f=fixture('parts');record(f.dir,f.args);close(f.dir,f.outcome);expect(load(f.dir).versions).toEqual([]);expect(check(f.dir).refusals).toEqual([]);expect(correctionApprovalFindings(load(f.dir),'parts-review',{draft_id:'wrong'}).map(x=>x.code)).toEqual(['CORRECTION_OUTCOME']);});
test('synthetic shape-only applied-and-checked binds retained session and outcome; no producer gate proof',()=>{const f=fixture('rig');record(f.dir,f.args,'made',['--feedback-file','evidence/feedback.json','--item','synthetic-apply']);close(f.dir,f.outcome);expect(check(f.dir)).toMatchObject({refusals:[],warnings:[]});});
test('API patch capture preserves the producer patchSha256 claim',()=>{const f=fixture('rig');record(f.dir,f.args,'made',['--patch-file','synthetic-review','--item','synthetic-apply']);close(f.dir,f.outcome,['--applied-feedback','evidence/feedback.json','--feedback-id','synthetic-apply']);expect(check(f.dir).refusals).toEqual([]);});
test('mismatched applied patch refuses closure byte-identically',()=>{const f=fixture('rig');record(f.dir,f.args,'made',['--patch-file','synthetic-review','--item','synthetic-apply']);const s=JSON.parse(readFileSync(join(f.dir,'evidence/feedback.json'),'utf8'));s.feedback[0].context.applied.patch.ops[0].value='different';writeFileSync(join(f.dir,'evidence/feedback.json'),JSON.stringify(s));rejected(f.dir,'CORRECTION_APPLIED_INVALID',()=>close(f.dir,f.outcome,['--applied-feedback','evidence/feedback.json','--feedback-id','synthetic-apply']));});

test('session/2 replacement Apply with changed patch bytes refuses closure and preserves project and first stdout', () => {
  const dir = mkdtempSync(join(tmpdir(), 'correction-comments-patch-'));
  roots.push(dir);
  const f = correctionCommentsFixture(dir);
  testClock.set(new Date('2026-11-04T09:10:00Z'));
  expect(correctionCommand(['record', dir, '--id', 'fix', '--path', 'made', '--stage', 'rig-review', '--version', '1',
    '--by', 'user', '--feedback-file', 'evidence/feedback.json', '--item', COMMENTS_APPLY_ID], commentsReviewRunner).exit).toBe(0);
  const original = readFileSync(join(dir, String(f.read.file.path)));
  const changed = structuredClone(f.session);
  const entry = (changed.comments as JsonObject[]).find(comment => (comment.anchor as JsonObject | undefined)?.id === COMMENTS_APPLY_ID)!;
  const applied = ((entry.anchor as JsonObject).context as JsonObject).applied as JsonObject;
  ((applied.patch as JsonObject).ops as JsonObject[])[0]!.value = 'different';
  // This is a new producer claim, not a request for Create to recompute patchSha256.
  applied.patchSha256 = 'c'.repeat(64);
  writeFileSync(join(dir, 'evidence/feedback.json'), JSON.stringify(changed, null, 3) + '\n');
  testClock.set(new Date('2026-11-04T10:00:00Z'));
  rejected(dir, 'CORRECTION_APPLIED_INVALID', () => correctionCommand(['resolve', 'fix', dir, '--version', '2', '--by', 'agent',
    '--reasoning-file', join(dir, 'reasoning.txt'), '--applied-feedback', 'evidence/feedback.json', '--feedback-id', COMMENTS_APPLY_ID], commentsReviewRunner));
  expect(readFileSync(join(dir, String(f.read.file.path)))).toEqual(original);
  expect(original).toEqual(f.stdout);
  expect(check(dir)).toMatchObject({ refusals: [], warnings: [{ code: 'CORRECTION_OPEN' }] });
});
for(const field of ['pass','gate','exitCode'])test(`failed ${field} cannot claim checked completion`,()=>{const f=fixture('rig');const s=JSON.parse(readFileSync(join(f.dir,'evidence/feedback.json'),'utf8'));s.feedback[0].context.applied.check[field]=field==='exitCode'?1:false;writeFileSync(join(f.dir,'evidence/feedback.json'),JSON.stringify(s));const p=load(f.dir);((p.versions as JsonObject[])[1]!.review_origin as JsonObject).feedback={path:'evidence/feedback.json',sha256:'0'.repeat(64)};writeFileSync(join(f.dir,'project.json'),JSON.stringify(p));record(f.dir,f.args,'made',['--feedback-file','evidence/feedback.json','--item','synthetic-apply']);rejected(f.dir,'CORRECTION_APPLIED_INVALID',()=>close(f.dir,f.outcome));});
test('mesh delta records as unsupported and cannot be closed',()=>{const f=fixture('rig');const s=JSON.parse(readFileSync(join(f.dir,'evidence/feedback.json'),'utf8'));s.feedback[0].context.applied.schema='rig-review-applied/3';writeFileSync(join(f.dir,'evidence/feedback.json'),JSON.stringify(s));record(f.dir,f.args,'made',['--feedback-file','evidence/feedback.json','--item','synthetic-apply']);expect(check(f.dir).warnings.map(x=>x.code)).toEqual(['CORRECTION_UNSUPPORTED']);rejected(f.dir,'CORRECTION_UNSUPPORTED_OUTCOME',()=>close(f.dir,f.outcome));});
test('changed retained bytes refuse and do not alter the project',()=>{const f=fixture();record(f.dir,f.args);writeFileSync(join(f.dir,'evidence/source.model.json'),'changed');rejected(f.dir,'CORRECTION_HASH',()=>close(f.dir,f.outcome));});
test('unchanged output is not a response',()=>{const f=fixture();record(f.dir,f.args);const p=load(f.dir);const v=p.versions as JsonObject[];v[1]!.outputs=v[0]!.outputs;writeFileSync(join(f.dir,'project.json'),JSON.stringify(p));rejected(f.dir,'CORRECTION_OUTCOME',()=>close(f.dir,['--version','2','--model-file','evidence/source.model.json']));});
test('patch grammar is closed and refuses path flags, unknown keys and malformed pointers',()=>{const f=fixture('rig');const p=JSON.parse(readFileSync(join(f.dir,'evidence/preview.json'),'utf8'));for(const change of [(x:JsonObject)=>{x.extra=true},(x:JsonObject)=>{(x.op as JsonObject).args=['--out','secret']},(x:JsonObject)=>{(x.ops as JsonObject[])[0]!.path='/bad~2'}]){const v=structuredClone(p);change(v);let code='';try{validateCorrectionPatch(v);}catch(e){if(!(e instanceof CorrectionError))throw e;code=e.code;}expect(code).toBe('CORRECTION_PATCH_INVALID');}});

test('valid reopen supersedes pending corrections; a narrower later reopen never resurrects them',()=>{
 const f=fixture();record(f.dir,f.args);const p=load(f.dir);p.reopens=[{stage:'rig-review',from_stage:'direction-review',by:'reviewer',at:'2026-11-04T09:20:00Z',verbatim:'Review again',steps_before:[]},{stage:'direction-review',from_stage:'direction-review',by:'reviewer',at:'2026-11-04T09:21:00Z',verbatim:'Review the post too',steps_before:[]}];expect(check(f.dir,p).warnings).toEqual([]);expect(correctionApprovalFindings(p,'direction-review')).toEqual([]);writeFileSync(join(f.dir,'project.json'),JSON.stringify(p));rejected(f.dir,'CORRECTION_SOURCE',()=>close(f.dir,f.outcome));
});
test('malformed reopen supersedes nothing and does not clear a pending correction',()=>{const f=fixture();record(f.dir,f.args);const p=load(f.dir);p.reopens=[{stage:'direction-review',from_stage:'direction-review',by:'agent',at:'2026-11-04T09:20:00Z',verbatim:'bad',steps_before:[]}];expect(correctionApprovalFindings(p,'direction-review').map(f=>f.code)).toEqual(['CORRECTION_PENDING']);});
test('a live approval blocks new capture until the human reopens it',()=>{const f=fixture();const p=load(f.dir);p.signoffs=[{stage:'direction-review',checkpoint:null,by:'reviewer',at:'2026-11-04T09:05:00Z',verbatim:'approved'}];writeFileSync(join(f.dir,'project.json'),JSON.stringify(p));rejected(f.dir,'CORRECTION_SOURCE',()=>record(f.dir,f.args));});
test('pending corrections gate direct signoff/acceptance checks, and preclosure approval stays invalid',()=>{const f=fixture();record(f.dir,f.args);const p=load(f.dir);p.signoffs=[{stage:'direction-review',checkpoint:null,by:'reviewer',at:'2026-11-04T09:15:00Z',verbatim:'approved too early'}];expect(check(f.dir,p).refusals.map(f=>f.code)).toContain('CORRECTION_PENDING');close(f.dir,f.outcome);const closed=load(f.dir);closed.signoffs=p.signoffs;expect(check(f.dir,closed).refusals.map(f=>f.code)).toContain('CORRECTION_PENDING');});
test('replacement appends history and cannot erase an obligation while itself pending',()=>{const f=fixture();record(f.dir,f.args);testClock.set(new Date('2026-11-04T09:11:00Z'));correctionCommand(['record',f.dir,'--id','replacement','--resolves','fix','--path','described','--stage','direction-review','--by','reviewer','--verbatim-file',join(f.dir,'words.txt'),...f.args]);expect((load(f.dir).corrections as JsonObject[]).map(r=>r.id)).toEqual(['fix','replacement']);expect(correctionApprovalFindings(load(f.dir),'direction-review').map(f=>f.code)).toEqual(['CORRECTION_PENDING','CORRECTION_PENDING']);testClock.set(new Date('2026-11-04T10:00:00Z'));correctionCommand(['resolve','replacement',f.dir,...f.outcome,'--by','agent','--reasoning-file',join(f.dir,'reasoning.txt')]);expect(correctionApprovalFindings(load(f.dir),'direction-review')).toEqual([]);});
test('capture cannot predate the version the person names',()=>{const f=fixture();rejected(f.dir,'CORRECTION_SOURCE',()=>record(f.dir,f.outcome));});
test('missing source, duplicate ids, wrong stage and unknown flags are named byte-preserving refusals',()=>{const f=fixture();rejected(f.dir,'CORRECTION_SOURCE',()=>record(f.dir,['--version','9','--model-file','evidence/source.model.json']));rejected(f.dir,'CORRECTION_USAGE',()=>record(f.dir,f.args,'described',['--correction-file','evidence/feedback.json']));record(f.dir,f.args);rejected(f.dir,'CORRECTION_MALFORMED',()=>record(f.dir,f.args));});
test('source feedback hashes and selected item are validated; no fake checked output identity',()=>{const f=fixture('rig');record(f.dir,f.args,'made',['--feedback-file','evidence/feedback.json','--item','synthetic-apply']);const p=load(f.dir);const r=(p.corrections as JsonObject[])[0]!;const a=r.artifact as JsonObject;((a.feedback as JsonObject).file as JsonObject).sha256='0'.repeat(64);expect(check(f.dir,p).refusals.map(f=>f.code)).toContain('REVIEW_READ_INVALID');const p2=load(f.dir);(((p2.corrections as JsonObject[])[0]!.artifact as JsonObject).feedback as JsonObject).item_id='missing';expect(check(f.dir,p2).refusals.map(f=>f.code)).toContain('CORRECTION_APPLIED_INVALID');close(f.dir,f.outcome);const p3=load(f.dir);((p3.corrections as JsonObject[])[0]!.outcome as JsonObject).model={path:'evidence/source.model.json',sha256:((p3.versions as JsonObject[])[0]!.outputs as JsonObject[])[0]!.sha256 as string};expect(check(f.dir,p3).refusals.map(f=>f.code)).toContain('CORRECTION_OUTCOME');});
test('a parts manifest inventory cannot omit a retained part',()=>{const f=fixture('parts');const path=join(f.dir,'evidence/source/inventory.json');const inv=JSON.parse(readFileSync(path,'utf8'));inv.files.pop();writeFileSync(path,JSON.stringify(inv));rejected(f.dir,'CORRECTION_SOURCE',()=>record(f.dir,f.args));});

test('contained symlinks and traversal are refused before capture',()=>{const f=fixture();symlinkSync(join(f.dir,'evidence/source.model.json'),join(f.dir,'evidence/link.json'));rejected(f.dir,'CORRECTION_FILE',()=>record(f.dir,['--version','1','--model-file','evidence/link.json']));rejected(f.dir,'CORRECTION_FILE',()=>record(f.dir,['--version','1','--model-file','evidence/../evidence/source.model.json']));});

test('stage-1 described drafts use public draft inventory and bind the corrected approval draft',()=>{
 const dir=projectFixture();roots.push(join(dir,'..'));testClock.set(new Date('2026-12-01T07:00:00Z'));writeFileSync(join(dir,'words.txt'),'Refine the draft mesh.');writeFileSync(join(dir,'reasoning.txt'),'Declared corrected draft, not a measured build.');reopenCommand(['parts-review',dir,'--by','reviewer','--verbatim-file',join(dir,'words.txt')]);correctionCommand(['--adopt',dir]);
 const draft=(id:string,hour:string)=>{const root=`derived/drafts/${id}`;mkdirSync(join(dir,root,'input/parts'),{recursive:true});mkdirSync(join(dir,root,'out'),{recursive:true});for(const[path,bytes]of Object.entries({'config.json':'{}','input/parts.json':'{}','input/recomposite_rig.png':'synthetic stack bytes','input/parts/piece.png':'synthetic bytes','out/rig.json':'{}','out/motion.json':'{}','out/mesh_report.json':'{}','out/skeleton.model.json':JSON.stringify({synthetic:id})}))writeFileSync(join(dir,root,path),bytes);testClock.set(new Date(`2026-12-01T${hour}:00:00Z`));draftRigCommand([id,dir,'--config',`${root}/config.json`,'--from',`${root}/out`,'--parts',`${root}/input`]);};
 draft('before','08');testClock.set(new Date('2026-12-01T09:00:00Z'));correctionCommand(['record',dir,'--id','draft-fix','--path','described','--stage','parts-review','--draft','before','--by','reviewer','--verbatim-file',join(dir,'words.txt')]);draft('after','10');testClock.set(new Date('2026-12-01T11:00:00Z'));correctionCommand(['resolve','draft-fix',dir,'--draft','after','--by','agent','--reasoning-file',join(dir,'reasoning.txt')]);const p=load(dir);expect(check(dir).refusals).toEqual([]);expect(correctionApprovalFindings(p,'parts-review',{draft_id:'before',at:'2026-12-01T12:00:00Z'}).map(f=>f.code)).toEqual(['CORRECTION_OUTCOME']);expect(correctionApprovalFindings(p,'parts-review',{draft_id:'after',at:'2026-12-01T12:00:00Z'})).toEqual([]);
});

test('ordinary correction may name the historical version actually inspected',()=>{const f=fixture();testClock.set(new Date('2026-11-04T10:00:00Z'));correctionCommand(['record',f.dir,'--id','historical','--path','described','--stage','direction-review','--by','reviewer','--verbatim-file',join(f.dir,'words.txt'),...f.args]);expect(check(f.dir).refusals).toEqual([]);});
test('replacement must name the latest source at capture while ordinary history remains valid',()=>{const f=fixture();record(f.dir,f.args);testClock.set(new Date('2026-11-04T10:00:00Z'));const base=['record',f.dir,'--id','new','--resolves','fix','--path','described','--stage','direction-review','--by','reviewer','--verbatim-file',join(f.dir,'words.txt')];rejected(f.dir,'CORRECTION_SOURCE',()=>correctionCommand([...base,...f.args]));correctionCommand([...base,...f.outcome]);expect(check(f.dir).refusals).toEqual([]);});


/** Synthetic retained draft/parts bytes, recorded through the public writers; no producer is run. */
function mixedStageOne(source:'parts'|'draft', target:'parts'|'draft', partsChanged:boolean, modelChanged:boolean) {
  const dir=projectFixture();roots.push(join(dir,'..'));
  testClock.set(new Date('2026-12-01T07:00:00Z'));
  writeFileSync(join(dir,'words.txt'),'Correct the reviewed parts or mesh.');
  writeFileSync(join(dir,'reasoning.txt'),'Declare the corrected output.');
  reopenCommand(['parts-review',dir,'--by','reviewer','--verbatim-file',join(dir,'words.txt')]);
  correctionCommand(['--adopt',dir]);
  const draft=(id:string,hour:string,part:string,model:string)=>{
    const root=`derived/drafts/${id}`;
    mkdirSync(join(dir,root,'input/parts'),{recursive:true});mkdirSync(join(dir,root,'out'),{recursive:true});
    const files={'config.json':'{}','input/parts.json':'{}','input/recomposite_rig.png':'synthetic stack bytes','input/parts/piece.png':part,'out/rig.json':'{}','out/motion.json':'{}','out/mesh_report.json':'{}','out/skeleton.model.json':model};
    for(const[path,bytes]of Object.entries(files))writeFileSync(join(dir,root,path),bytes);
    testClock.set(new Date(`2026-12-01T${hour}:00:00Z`));
    draftRigCommand([id,dir,'--config',`${root}/config.json`,'--from',`${root}/out`,'--parts',`${root}/input`]);
    const entry=(load(dir).drafts as JsonObject[]).find(d=>d.id===id)!;
    const parts=entry.parts as JsonObject;
    const inventory=(parts.files as JsonObject[]).slice();
    const manifest=inventory.find(f=>String(f.path).endsWith('/parts.json'))!;
    // Writer validation requires codepoint order, independent of locale.
    inventory.sort((a,b)=>String(a.path)<String(b.path)?-1:1);
    const path=`evidence/${id}-inventory.json`;
    writeFileSync(join(dir,path),JSON.stringify({kind:'parts',manifest,files:inventory}));
    return path;
  };
  const before=draft('before','08','synthetic original part','{"synthetic":"original model"}');
  testClock.set(new Date('2026-12-01T09:00:00Z'));
  correctionCommand(['record',dir,'--id','mixed-fix','--path','described','--stage','parts-review','--by','reviewer','--verbatim-file',join(dir,'words.txt'),...(source==='parts'?['--parts-file',before]:['--draft','before'])]);
  const after=draft('after','10',partsChanged?'synthetic changed part':'synthetic original part',modelChanged?'{}':'{"synthetic":"original model"}');
  const resolve=()=>{testClock.set(new Date('2026-12-01T11:00:00Z'));return correctionCommand(['resolve','mixed-fix',dir,'--by','agent','--reasoning-file',join(dir,'reasoning.txt'),...(target==='parts'?['--parts-file',after]:['--draft','after'])]);};
  return{dir,resolve};
}

test.each([['parts','draft'],['draft','parts']] as const)('%s → %s with identical inventories refuses closure and leaves approval pending',(source,target)=>{
  const f=mixedStageOne(source,target,false,true);
  rejected(f.dir,'CORRECTION_OUTCOME',f.resolve);
  rejected(f.dir,'CORRECTION_PENDING',()=>assertCorrectionApproval(f.dir,load(f.dir),'parts-review',{draft_id:'after',at:'2026-12-01T12:00:00Z'}));
});
test.each([['parts','draft'],['draft','parts']] as const)('%s → %s with a changed part closes',(source,target)=>{
  const f=mixedStageOne(source,target,true,false);f.resolve();expect(check(f.dir).refusals).toEqual([]);
});
test('draft → draft with identical model and parts refuses closure',()=>{const f=mixedStageOne('draft','draft',false,false);rejected(f.dir,'CORRECTION_OUTCOME',f.resolve);});
test('draft → draft with a different model closes',()=>{const f=mixedStageOne('draft','draft',false,true);f.resolve();expect(check(f.dir).refusals).toEqual([]);});
test('draft → draft with unchanged model but changed parts closes',()=>{const f=mixedStageOne('draft','draft',true,false);f.resolve();expect(check(f.dir).refusals).toEqual([]);});
test('capture is refused on a record whose stage check stopped early',()=>{const f=fixture();const p=load(f.dir);p.stage='no-such-stage';writeFileSync(join(f.dir,'project.json'),JSON.stringify(p));const before=readFileSync(join(f.dir,'project.json'));let caught:unknown;try{record(f.dir,f.args);}catch(e){caught=e;}expect(caught).toBeInstanceOf(Refusal);expect((caught as Refusal).code).toBe('STAGE_UNKNOWN');expect(readFileSync(join(f.dir,'project.json'))).toEqual(before);});

function syntheticPartPngs() {
  const w = 4, h = 4;
  const beforeData = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (y < 2 && x < 2) { beforeData[i] = 200; beforeData[i + 1] = 100; beforeData[i + 2] = 80; beforeData[i + 3] = 255; }
      else if (y < 2) { beforeData[i] = 120; beforeData[i + 1] = 60; beforeData[i + 2] = 40; beforeData[i + 3] = 128; }
    }
  }
  const maskData = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) maskData[i * 4 + 3] = 255;
  for (const x of [0, 1, 2]) {
    const i = x * 4;
    maskData[i] = 255; maskData[i + 1] = 255; maskData[i + 2] = 255; maskData[i + 3] = 255;
  }
  const afterData = new Uint8Array(beforeData);
  afterData[0] = 90; afterData[1] = 110; afterData[2] = 140; afterData[3] = 255;
  afterData[4] = 95; afterData[5] = 115; afterData[6] = 145; afterData[7] = 255;
  afterData[8 + 3] = 100; // decreased alpha inside mask is permitted
  const outsideData = new Uint8Array(afterData);
  const outIdx = (1 * w + 0) * 4; // (0,1) is outside the mask
  outsideData[outIdx] = 50;
  const addedAlphaData = new Uint8Array(afterData);
  addedAlphaData[8 + 3] = 200; // (2,0) inside mask had alpha 128 -> 200 (added alpha)
  const wrongBeforeData = new Uint8Array(beforeData);
  wrongBeforeData[0] = 10;
  return {
    before: encodePng(w, h, beforeData),
    mask: encodePng(w, h, maskData),
    after: encodePng(w, h, afterData),
    outside: encodePng(w, h, outsideData),
    addedAlpha: encodePng(w, h, addedAlphaData),
    wrongBefore: encodePng(w, h, wrongBeforeData),
    wrongSizeMask: encodePng(3, 4, new Uint8Array(3 * 4 * 4)),
  };
}

function partImageFixture(opts: { modelless?: boolean; legacyOrder?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'part-image-')));
  roots.push(root);
  const dir = join(root, 'project');
  cpSync(join(import.meta.dir, '../templates/example-chain/checkpoints/1-parts-verdict'), dir, { recursive: true });
  if (opts.legacyOrder) {
    const legacy = load(dir);
    const interview = legacy.interview as JsonObject;
    delete interview.order;
    legacy.stage_values = [...LEGACY_STAGE_VALUES];
    for (const raw of interview.waypoints as JsonObject[]) {
      if (raw.guide === null) raw.guide = { not_applicable: true, because: 'synthetic legacy-order fixture' };
    }
    const signoffs = legacy.signoffs as JsonObject[];
    const stepHashes = signoffs[1]!.step_hashes as JsonObject;
    for (const step of (legacy.plan as JsonObject).steps as JsonObject[]) {
      if (step.phase !== 'rig') continue;
      if (step.checkpoint === null) step.checkpoint = { delegated: false, by: 'user', at: signoffs[1]!.at, verbatim: signoffs[1]!.verbatim, value: step.checkpoint_proposed };
      stepHashes[String(step.id)] = stepHash(step);
    }
    delete signoffs[1]!.steps;
    signoffs[0]!.answer_hashes = selectAnswerHashes(dir, legacy, signoffs[0]!)!;
    signoffs[1]!.answer_hashes = selectAnswerHashes(dir, legacy, signoffs[1]!)!;
    writeFileSync(join(dir, 'project.json'), `${JSON.stringify(legacy, null, 2)}\n`);
  }
  testClock.set(new Date('2026-11-06T01:02:05Z'));
  advanceCommand(['parts-review', dir, ...withPartsCheck(dir, 'derived/drafts/chain/input')]);
  const diffReport = JSON.parse(readFileSync(join(import.meta.dir, '../templates/example-chain/evidence/diff-components.json'), 'utf8')) as JsonObject;
  (diffReport.stack as JsonObject).sha256 = correctionHash(readFileSync(join(dir, 'derived/drafts/chain/input/recomposite_rig.png')));
  writeFileSync(join(dir, 'evidence/diff-components.json'), `${JSON.stringify(diffReport, null, 2)}\n`);
  const initial = load(dir);
  initial.drafts = [];
  writeFileSync(join(dir, 'project.json'), `${JSON.stringify(initial, null, 2)}\n`);
  const pngs = syntheticPartPngs();
  mkdirSync(join(dir, 'evidence/repaint'), { recursive: true });
  writeFileSync(join(dir, 'evidence/repaint/after.png'), pngs.after);
  writeFileSync(join(dir, 'evidence/repaint/mask.png'), pngs.mask);
  writeFileSync(join(dir, 'evidence/repaint/outside.png'), pngs.outside);
  writeFileSync(join(dir, 'evidence/repaint/added-alpha.png'), pngs.addedAlpha);
  writeFileSync(join(dir, 'evidence/repaint/wrong-before.png'), pngs.wrongBefore);
  writeFileSync(join(dir, 'evidence/repaint/wrong-size-mask.png'), pngs.wrongSizeMask);
  // A modelless draft is shaped like `parts rig` output: rig, motion, mesh_report, images and run.json, and no check/build compiled model.
  const stageDraft = (id: string, hour: string, topwearBytes: Uint8Array): string[] => {
    const draftRoot = `derived/drafts/${id}`;
    cpSync(join(dir, 'derived/drafts/chain'), join(dir, draftRoot), { recursive: true });
    if (opts.modelless) rmSync(join(dir, draftRoot, 'out/check'), { recursive: true, force: true });
    writeFileSync(join(dir, draftRoot, 'input/parts/torso.png'), topwearBytes);
    testClock.set(new Date(`2026-11-06T${hour}:00:00Z`));
    return [id, dir, '--config', `${draftRoot}/config.json`, '--from', `${draftRoot}/out`, '--parts', `${draftRoot}/input`];
  };
  const writeDraft = (id: string, hour: string, topwearBytes: Uint8Array) => draftRigCommand(stageDraft(id, hour, topwearBytes));
  writeDraft('parent', '02', pngs.before);
  return { dir, pngs, writeDraft, stageDraft };
}

test('part-image positive control and round trip: masked repaint records, resolves via the new draft, and checks clean (0 refusals, 0 warnings)', () => {
  const { dir, pngs, writeDraft } = partImageFixture();
  expect(checkProject(dir)).toMatchObject({ refusals: [], warnings: [] });
  testClock.set(new Date('2026-11-06T02:30:00Z'));
  const res = correctionCommand([
    'record', dir, '--id', 'repaint-torso', '--path', 'made', '--stage', 'parts-review',
    '--draft', 'parent', '--part', 'torso',
    '--part-image-file', 'evidence/repaint/after.png',
    '--mask-file', 'evidence/repaint/mask.png',
    '--tool', 'gemini-image-probe r5 + mask composite with tone match',
    '--json',
  ]);
  expect(res.exit).toBe(0);
  const recorded = JSON.parse(res.stdout) as JsonObject;
  expect(recorded).toMatchObject({
    schema: 'rig-create/correction@1',
    id: 'repaint-torso',
    path: 'made',
    by: 'agent',
    verbatim: null,
    stage: 'parts-review',
    artifact: {
      kind: 'part-image',
      draft: 'parent',
      part: 'torso',
      before: { path: 'derived/drafts/parent/input/parts/torso.png', sha256: correctionHash(pngs.before) },
      after: { path: 'evidence/repaint/after.png', sha256: correctionHash(pngs.after) },
      mask: { path: 'evidence/repaint/mask.png', sha256: correctionHash(pngs.mask) },
      tool: 'gemini-image-probe r5 + mask composite with tone match',
    },
  });
  // The writer binds no model; a record captured before that, binding the parent draft's own model, is still read.
  expect((recorded.on as JsonObject).model).toBeNull();
  const withModel = load(dir);
  const parentModel = ((withModel.drafts as JsonObject[])[0]!.files as JsonObject[]).find(f => String(f.path).endsWith('/skeleton.model.json'))!;
  ((withModel.corrections as JsonObject[])[0]!.on as JsonObject).model = structuredClone(parentModel);
  expect(check(dir, withModel).refusals).toEqual([]);
  // Before the new draft is registered, the correction is open (WARN) and blocks approval of the parent draft.
  expect(checkProject(dir).refusals).toEqual([]);
  expect(checkProject(dir).warnings.map(w => w.code)).toEqual(['CORRECTION_OPEN']);
  expect(correctionApprovalFindings(load(dir), 'parts-review', { draft_id: 'parent', at: '2026-11-06T02:45:00Z' }).map(f => f.code)).toEqual(['CORRECTION_PENDING']);
  // A later draft that does not bind the repainted after bytes refuses check as CORRECTION_PENDING.
  rejected(dir, 'CORRECTION_PENDING', () => writeDraft('unfixed', '03', pngs.before));

  // Registering the new draft with the repainted part resolves the correction and makes check clean (0 refusals, 0 warnings).
  writeDraft('repainted', '03', pngs.after);
  const report = checkProject(dir);
  expect(report.refusals).toEqual([]);
  expect(report.warnings).toEqual([]);
  expect(correctionApprovalFindings(load(dir), 'parts-review', { draft_id: 'parent', at: '2026-11-06T03:30:00Z' }).map(f => f.code)).toEqual(['CORRECTION_OUTCOME']);
  expect(correctionApprovalFindings(load(dir), 'parts-review', { draft_id: 'repainted', at: '2026-11-06T03:30:00Z' })).toEqual([]);

  // Explicit correction resolve also succeeds on the resolving draft and refuses a non-resolving draft.
  writeFileSync(join(dir, 'reasoning.txt'), 'Applied masked repaint to torso and rebuilt draft.');
  rejected(dir, 'CORRECTION_OUTCOME', () => {
    testClock.set(new Date('2026-11-06T03:10:00Z'));
    correctionCommand(['resolve', 'repaint-torso', dir, '--draft', 'parent', '--by', 'agent', '--reasoning-file', join(dir, 'reasoning.txt')]);
  });
  testClock.set(new Date('2026-11-06T03:10:00Z'));
  expect(correctionCommand(['resolve', 'repaint-torso', dir, '--draft', 'repainted', '--by', 'agent', '--reasoning-file', join(dir, 'reasoning.txt')]).exit).toBe(0);
  expect(checkProject(dir)).toMatchObject({ refusals: [], warnings: [] });
});

const cli = (dir: string, args: string[]) => {
  const r = Bun.spawnSync([process.execPath, ...clockedCli(), ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
  return { exit: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
};

test('part-image on a draft with no compiled model (parts rig output): records through the CLI with model null, a later draft-rig resolves it, check is 0/0; described still needs the model', () => {
  const { dir, pngs, stageDraft } = partImageFixture({ modelless: true });
  const parent = (load(dir).drafts as JsonObject[])[0]!;
  expect((parent.files as JsonObject[]).some(f => String(f.path).endsWith('/skeleton.model.json'))).toBe(false);
  expect(checkProject(dir)).toMatchObject({ refusals: [], warnings: [] });

  testClock.set(new Date('2026-11-06T02:30:00Z'));
  const recorded = cli(dir, ['correction', 'record', dir, '--id', 'repaint-torso', '--path', 'made', '--stage', 'parts-review',
    '--draft', 'parent', '--part', 'torso', '--part-image-file', 'evidence/repaint/after.png',
    '--mask-file', 'evidence/repaint/mask.png', '--tool', 'hand pass', '--json']);
  expect(recorded.stderr).toBe('');
  expect(recorded.exit).toBe(0);
  const on = (JSON.parse(recorded.stdout) as JsonObject).on as JsonObject;
  expect(on).toMatchObject({ kind: 'draft', id: 'parent', model: null });
  expect(((on.parts as JsonObject).manifest as JsonObject).path).toBe('derived/drafts/parent/input/parts.json');
  expect(checkProject(dir).refusals).toEqual([]);
  expect(checkProject(dir).warnings.map(w => w.code)).toEqual(['CORRECTION_OPEN']);

  // A described correction on the same model-less draft is refused as before: it binds the draft's compiled model.
  writeFileSync(join(dir, 'words.txt'), 'Smooth the torso edge.');
  rejected(dir, 'CORRECTION_SOURCE', () => correctionCommand(['record', dir, '--id', 'described-torso', '--path', 'described', '--stage', 'parts-review', '--draft', 'parent', '--by', 'reviewer', '--verbatim-file', join(dir, 'words.txt')]));
  // A described record carrying that model-null identity is refused by check, which shares the writer's validator.
  const planted = load(dir);
  planted.corrections = [...(planted.corrections as JsonObject[]), { schema: 'rig-create/correction@1', id: 'described-planted', path: 'described', by: 'reviewer', at: '2026-11-06T02:30:00Z', verbatim: 'Smooth the torso edge.', stage: 'parts-review', on: structuredClone(on), artifact: { kind: 'description' }, outcome: null, resolves: null }];
  expect(check(dir, planted).refusals.map(f => f.code)).toEqual(['CORRECTION_MALFORMED']);

  // The rebuilt draft, recorded by the draft-rig CLI, binds the after bytes and resolves the correction.
  const drafted = cli(dir, ['draft-rig', ...stageDraft('repainted', '03', pngs.after)]);
  expect(drafted.stderr).toBe('');
  expect(drafted.exit).toBe(0);
  expect(checkProject(dir)).toMatchObject({ refusals: [], warnings: [] });
  const checked = cli(dir, ['interview', '--check', dir]);
  expect(checked.exit).toBe(0);
  expect(correctionApprovalFindings(load(dir), 'parts-review', { draft_id: 'repainted', at: '2026-11-06T03:30:00Z' })).toEqual([]);

  // An explicit resolve writes a model-null outcome; check still reads it as changed and stays 0/0.
  writeFileSync(join(dir, 'reasoning.txt'), 'Rebuilt draft binds the masked repaint.');
  testClock.set(new Date('2026-11-06T03:10:00Z'));
  rejected(dir, 'CORRECTION_OUTCOME', () => correctionCommand(['resolve', 'repaint-torso', dir, '--draft', 'parent', '--by', 'agent', '--reasoning-file', join(dir, 'reasoning.txt')]));
  const resolved = cli(dir, ['correction', 'resolve', 'repaint-torso', dir, '--draft', 'repainted', '--by', 'agent', '--reasoning-file', join(dir, 'reasoning.txt')]);
  expect(resolved.stderr).toBe('');
  expect(resolved.exit).toBe(0);
  expect(((load(dir).corrections as JsonObject[])[0]!.outcome as JsonObject)).toMatchObject({ kind: 'draft', id: 'repainted', model: null });
  expect(checkProject(dir)).toMatchObject({ refusals: [], warnings: [] });
});

test('part-image plants: edit outside mask, added alpha, wrong before, wrong mask size, and human --by refuse and preserve project.json', () => {
  const { dir } = partImageFixture();
  const baseArgs = ['record', dir, '--id', 'bad-repaint', '--path', 'made', '--stage', 'parts-review', '--draft', 'parent', '--part', 'torso', '--mask-file', 'evidence/repaint/mask.png', '--tool', 'hand pass'];
  testClock.set(new Date('2026-11-06T02:30:00Z'));
  // Plant 1: edit outside the mask refuses
  rejected(dir, 'CORRECTION_PART_IMAGE_OUTSIDE_MASK', () => correctionCommand([...baseArgs, '--part-image-file', 'evidence/repaint/outside.png']));
  // Plant 2: added alpha refuses
  rejected(dir, 'CORRECTION_PART_IMAGE_ADDED_ALPHA', () => correctionCommand([...baseArgs, '--part-image-file', 'evidence/repaint/added-alpha.png']));
  // Plant 3: wrong before refuses (via --before-file, unknown part, or identical after)
  rejected(dir, 'CORRECTION_PART_IMAGE_BEFORE', () => correctionCommand([...baseArgs, '--part-image-file', 'evidence/repaint/after.png', '--before-file', 'evidence/repaint/wrong-before.png']));
  rejected(dir, 'CORRECTION_PART_IMAGE_BEFORE', () => correctionCommand(['record', dir, '--id', 'bad-part', '--path', 'made', '--stage', 'parts-review', '--draft', 'parent', '--part', 'no_such_part', '--part-image-file', 'evidence/repaint/after.png', '--mask-file', 'evidence/repaint/mask.png', '--tool', 'hand pass']));
  rejected(dir, 'CORRECTION_PART_IMAGE_BEFORE', () => correctionCommand([...baseArgs, '--part-image-file', 'derived/drafts/parent/input/parts/torso.png']));
  // Mask size mismatch refuses
  rejected(dir, 'CORRECTION_PART_IMAGE_MASK_SIZE', () => correctionCommand(['record', dir, '--id', 'bad-mask', '--path', 'made', '--stage', 'parts-review', '--draft', 'parent', '--part', 'torso', '--part-image-file', 'evidence/repaint/after.png', '--mask-file', 'evidence/repaint/wrong-size-mask.png', '--tool', 'hand pass']));
  // Routing a human act (--by user) through part-image refuses
  rejected(dir, 'CORRECTION_MALFORMED', () => correctionCommand([...baseArgs, '--part-image-file', 'evidence/repaint/after.png', '--by', 'user']));
});

test('part-image negative control and plant: ordinary producer rebuilds with no part-image correction pass, while a draft binding withdrawn/superseded/post-dated part-image after bytes refuses as DRAFT_PART_REPAINT_UNRECORDED', () => {
  // Negative control: two drafts with different part PNG bytes and no part-image correction at all (ordinary producer rebuild) -> 0 refusals.
  const { dir, pngs, writeDraft } = partImageFixture();
  expect(writeDraft('rebuilt-by-parts', '03', pngs.after).exit).toBe(0);
  expect(checkProject(dir)).toMatchObject({ refusals: [], warnings: [] });

  // Plant: a draft binding the after bytes of a withdrawn, superseded, or post-dated part-image correction -> refuses DRAFT_PART_REPAINT_UNRECORDED.
  const { dir: dir2, pngs: pngs2, writeDraft: writeDraft2 } = partImageFixture();
  testClock.set(new Date('2026-11-06T02:30:00Z'));
  expect(correctionCommand([
    'record', dir2, '--id', 'repaint-torso', '--path', 'made', '--stage', 'parts-review',
    '--draft', 'parent', '--part', 'torso',
    '--part-image-file', 'evidence/repaint/after.png',
    '--mask-file', 'evidence/repaint/mask.png',
    '--tool', 'hand pass',
  ]).exit).toBe(0);
  const withdrawnProject = load(dir2);
  ((withdrawnProject.corrections as JsonObject[])[0] as JsonObject).verdict = 'withdrawn';
  writeFileSync(join(dir2, 'project.json'), `${JSON.stringify(withdrawnProject, null, 2)}\n`);
  // Writer refuses to record a draft that still binds the withdrawn correction's after bytes.
  rejected(dir2, 'DRAFT_PART_REPAINT_UNRECORDED', () => writeDraft2('uses-withdrawn-after', '03', pngs2.after));

  // And if a draft was recorded before the correction was withdrawn or before the correction timestamp, checkProject refuses by name.
  const restoredProject = load(dir2);
  delete ((restoredProject.corrections as JsonObject[])[0] as JsonObject).verdict;
  writeFileSync(join(dir2, 'project.json'), `${JSON.stringify(restoredProject, null, 2)}\n`);
  expect(writeDraft2('repainted', '03', pngs2.after).exit).toBe(0);
  expect(checkProject(dir2).refusals).toEqual([]);

  // Reopening parts-review after a repaint is resolved does not retroactively uncover the resolving draft or refuse the reopen.
  writeFileSync(join(dir2, 'reopen-words.txt'), 'Revisit parts-review after repaint.\n');
  testClock.set(new Date('2026-11-06T04:00:00Z'));
  expect(reopenCommand(['parts-review', dir2, '--by', 'reviewer', '--verbatim-file', join(dir2, 'reopen-words.txt')]).exit).toBe(0);
  expect(checkProject(dir2).refusals.filter(f => f.code === 'DRAFT_PART_REPAINT_UNRECORDED')).toEqual([]);
  expect(checkProject(dir2).refusals).toEqual([]);

  // And if a correction was withdrawn, checkProject still refuses by name.
  const postWithdrawn = load(dir2);
  ((postWithdrawn.corrections as JsonObject[])[0] as JsonObject).verdict = 'withdrawn';
  writeFileSync(join(dir2, 'project.json'), `${JSON.stringify(postWithdrawn, null, 2)}\n`);
  expect(checkProject(dir2).refusals.map(f => [f.code, f.path])).toEqual([['DRAFT_PART_REPAINT_UNRECORDED', 'drafts[1].parts.files']]);
});

test('legacy-order project with a resolved part-image correction on a model-less draft signs parts-review with --draft alone and passes check', () => {
  const { dir, pngs, stageDraft } = partImageFixture({ modelless: true, legacyOrder: true });
  expect(hasStageOrder(load(dir))).toBe(false);
  testClock.set(new Date('2026-11-06T02:30:00Z'));
  expect(correctionCommand([
    'record', dir, '--id', 'repaint-torso', '--path', 'made', '--stage', 'parts-review',
    '--draft', 'parent', '--part', 'torso',
    '--part-image-file', 'evidence/repaint/after.png',
    '--mask-file', 'evidence/repaint/mask.png',
    '--tool', 'hand pass',
  ]).exit).toBe(0);
  expect(cli(dir, ['draft-rig', ...stageDraft('repainted', '03', pngs.after)]).exit).toBe(0);
  recordPartsReceipt(dir, 'parent', Date.parse('2026-11-06T02:15:00Z'));
  recordPartsReceipt(dir, 'repainted', Date.parse('2026-11-06T03:15:00Z'));
  writeFileSync(join(dir, 'words.txt'), 'Approve the repainted parts.\n');
  testClock.set(new Date('2026-11-06T03:30:00Z'));
  diffClassesCommand([dir, '--diff-report', 'evidence/diff-components.json', '--by', 'agent']);
  // Plant: signing the unfixed parent draft without --structure-file refuses CORRECTION_OUTCOME and preserves project.json.
  rejected(dir, 'CORRECTION_OUTCOME', () => signoffCommand([
    'parts-review', dir, '--by', 'user', '--draft', 'parent',
    '--verbatim-file', join(dir, 'words.txt'),
  ]));
  // Signing the resolving draft with --draft alone (no --structure-file) records draft_id and passes check.
  const signed = cli(dir, [
    'signoff', 'parts-review', dir, '--by', 'user', '--draft', 'repainted',
    '--verbatim-file', join(dir, 'words.txt'), '--json',
  ]);
  expect(signed.stderr).toBe('');
  expect(signed.exit).toBe(0);
  const record = JSON.parse(signed.stdout) as JsonObject;
  expect(record.draft_id).toBe('repainted');
  expect(record.structure).toBeUndefined();
  expect(checkProject(dir).refusals).toEqual([]);
});
