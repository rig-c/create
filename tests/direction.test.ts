import { sceneFixture } from './scene-fixture.ts';
import { reviewPackageHash } from '../src/signoff-target.ts';
import { currentScene, sceneReference } from '../src/scene.ts';
import { DIRECTION_SCENE_SPEC } from '../src/direction.ts';
import { plantLegacyReopen, retainSignoffs } from './fixtures.ts';
import { resignAfterChange } from './fixtures.ts';
import { afterEach, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { attachCreateJobForClose } from '../src/job-close.ts';
import { readHostActsAndAsks } from '../src/job-acts.ts';
import { jobHostStateRoot, pendingPublications, readAcknowledgedPublication, readWriterBinding } from '../src/job-outbox.ts';
import { jobRuntimeExecArgv } from '../src/job-writer.ts';
import { isDeepStrictEqual as equal } from 'node:util';
import { checkProject as checkProjectRaw, type Finding } from '../src/check.ts';
import { DIRECTION_CONTRACT, DIRECTION_PATCH_SINCE, DirectionError, directionHash, directionPostIdentity, objects, readDirection, validateDirectionCitations, validateDirectionIdentity, validateDirectionShape } from '../src/direction.ts';
import { reviewPackageCommand } from '../src/review-package.ts';
import type { JsonObject } from '../src/templates.ts';
import { directionFixture } from './direction-fixture.ts';
import { clockedCli, tempDir } from './helpers.ts';
import { TEST_NOW, checkProject, correctionCommand, checkCorrections, assertDirectionApproval, checkDirections, advanceCommand, directionCommand, planCommand, recordVerdict, handoff, sceneCommand, signoffCommand, testClock } from './clock.ts';

afterEach(()=>testClock.reset());
/** A reopen of the filled example to post or post-interview voids its direction-review sign-off and acceptance (#220). */
const POST_LAPSES=[['REOPEN_SIGNOFF_LAPSED','signoffs[10]'],['REOPEN_VERDICT_LAPSED','versions[v4].verdicts[0]']];
const frozenDirection = join(import.meta.dir, '../templates/example-numbered/example-direction');
function setup(){const dir=join(tempDir(),'tiny');const f=directionFixture(dir);return{dir,...f};}
function write(dir:string,n=2){return directionCommand(['write',String(n),dir,'--file','evidence/input.json','--rig','1']);}
function refuses(code:string,fn:()=>unknown){try{fn();throw Error(`expected ${code}`);}catch(e){expect((e as {code:string}).code).toBe(code);}}
function checked(dir:string,p?:JsonObject){const ctx={dir,project:p??JSON.parse(readFileSync(join(dir,'project.json'),'utf8')),refusals:[] as Finding[]};checkDirections(ctx);return ctx.refusals.map(f=>f.code);}
function recordDescribed(f:ReturnType<typeof setup>){testClock.set(new Date('2026-11-04T09:10:00Z'));correctionCommand(['record',f.dir,'--id','frame','--path','described','--stage','direction-review','--version','2','--by','user','--verbatim-file',join(f.dir,'words.txt')]);}

test('direction and correction writers replay a described closure on the frozen probe build', () => {
  const dir = join(tempDir(), 'direction-probe');
  cpSync(frozenDirection, dir, { recursive: true });
  const projectPath = join(dir, 'project.json');
  const frozen = readFileSync(projectPath);
  const project = JSON.parse(frozen.toString('utf8')) as JsonObject;
  project.versions = objects(project.versions).filter(version => version.kind === 'rig');
  project.corrections = [];
  writeFileSync(projectPath, `${JSON.stringify(project, null, 2)}\n`);
  rmSync(join(dir, 'evidence/direction'), { recursive: true });

  testClock.set('2026-11-04T09:10:00Z');
  expect(write(dir).exit).toBe(0);
  testClock.set('2026-11-04T09:20:00Z');
  expect(correctionCommand(['record', dir, '--id', 'frame', '--stage', 'direction-review', '--path', 'described',
    '--version', '2', '--by', 'user', '--verbatim-file', join(dir, 'words.txt')]).exit).toBe(0);
  testClock.set('2026-11-04T09:30:00Z');
  expect(directionCommand(['write', '3', dir, '--file', 'evidence/revised-input.json', '--rig', '1']).exit).toBe(0);
  testClock.set('2026-11-04T09:40:00Z');
  expect(correctionCommand(['resolve', 'frame', dir, '--version', '3', '--by', 'agent',
    '--reasoning-file', join(dir, 'reasoning.txt')]).exit).toBe(0);

  const written = readFileSync(projectPath);
  expect(written).toEqual(frozen);
  for (const path of ['evidence/direction/v2.json', 'evidence/direction/v3.json']) {
    expect(readFileSync(join(dir, path))).toEqual(readFileSync(join(frozenDirection, path)));
  }
  const result = JSON.parse(written.toString('utf8')) as JsonObject;
  const correction = objects(result.corrections)[0]!;
  expect(correction.schema).toBe('rig-create/correction@2');
  expect((correction.artifact as JsonObject).kind).toBe('description');
  const on = correction.on as JsonObject;
  const outcome = correction.outcome as JsonObject;
  expect(on.model).toEqual(outcome.model);
  expect((on.direction as JsonObject).sha256).not.toBe((outcome.direction as JsonObject).sha256);
});
test('writer publishes exact input bytes and record points to them, check CLI succeeds',()=>{const f=setup();write(f.dir);expect(readFileSync(join(f.dir,'evidence/input.json'))).toEqual(readFileSync(join(f.dir,'evidence/direction/v2.json')));expect(checked(f.dir)).toEqual([]);expect(JSON.parse(directionCommand(['check','2',f.dir,'--json']).stdout).post).toBe(2);});
test('#690 direction publication updates an open page with its direction verdict ask', async () => {
  const root = join(tempDir(), 'direction-job');
  const example = join(import.meta.dir, '../templates/example-chain');
  const exampleRig = objects((JSON.parse(readFileSync(join(example, 'project.json'), 'utf8')) as JsonObject).versions)
    .find(version => version.n === 1)!;
  const pkg = exampleRig.review_package as JsonObject;
  const configPath = String((pkg.config as JsonObject).path);
  const modelPath = 'derived/review/v1/out/check/build/skeleton.model.json';
  const f = directionFixture(root, {
    model: readFileSync(join(example, modelPath)),
    config: readFileSync(join(example, configPath)),
    still: readFileSync(join(example, 'inputs/painting.png')),
  });
  for (const path of ['derived/review/v1', String(pkg.from), configPath]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    cpSync(join(example, path), join(root, path), { recursive: true });
  }
  const seed = f.load();
  objects(seed.versions)[0]!.review_package = pkg;
  f.save({ ...seed, inputs: [] });
  const projectPath = join(root, 'project.json');
  const directionPath = join(root, 'evidence/direction/v2.json');
  expect(write(root).exit).toBe(0);
  const published = f.load();
  f.save({ ...published, stage: 'direction-review' });
  const command = [process.execPath, ...jobRuntimeExecArgv(), ...clockedCli()];
  const proc = Bun.spawn([...command, 'job', 'open', root, '--rig', '2', '--reviewer', 'synthetic-owner', '--role', 'owner'], {
    stdout: 'pipe', stderr: 'pipe',
  });
  const output = proc.stdout.getReader();
  const errors = proc.stderr.getReader();
  const startupError = errors.read().then(chunk => {
    if (!chunk.done) throw Error(new TextDecoder().decode(chunk.value));
  });
  try {
    const decoder = new TextDecoder();
    let opening = '';
    while (opening.split('\n').filter(Boolean).length < 3 || !opening.endsWith('\n')) {
      const chunk = await Promise.race([output.read(), startupError]);
      if (!chunk || chunk.done) throw Error('Synthetic job host exited before opening its page');
      opening += decoder.decode(chunk.value, { stream: true });
    }
    const [url, ...lines] = opening.trim().split('\n');
    expect((await fetch(url!)).ok).toBe(true);
    const binding = readWriterBinding(root)!;
    const jobState = async () => {
      const host = await attachCreateJobForClose(root, binding);
      try {
        return { status: host.session.status(), ...await readHostActsAndAsks(host) };
      } finally {
        host.stop();
      }
    };
    const beforeJob = await jobState();
    const receipt = readAcknowledgedPublication(root, binding.jobId, beforeJob.status.publication!.publicationId);
    expect(receipt).not.toBeNull();
    expect(lines).toEqual([`job: post v2 published (publication ${receipt!.publicationId})`, 'job: asked review-verdict direction-review']);
    expect(beforeJob.asks).toHaveLength(1);
    expect(beforeJob.acts).toEqual([]);

    // Restore a pre-write synthetic record while keeping the external page on post v2.
    const opened = f.load();
    f.save({ ...opened, stage: 'post', versions: objects(opened.versions).filter(version => version.n !== 2) });
    rmSync(directionPath);
    const beforeProject = readFileSync(projectPath);
    const run = (n: number) => Bun.spawnSync([...command, 'direction', 'write', String(n), root,
      '--file', 'evidence/input.json', '--rig', '1'], { stdout: 'pipe', stderr: 'pipe' });
    const other = run(3);
    expect(other.exitCode).toBe(1);
    expect(other.stderr.toString()).toContain('JOB_ASK_PENDING:');
    expect(readFileSync(projectPath)).toEqual(beforeProject);
    expect(existsSync(join(root, 'evidence/direction/v3.json'))).toBe(false);
    expect(await jobState()).toEqual(beforeJob);

    const same = run(2);
    const afterJob = await jobState();
    expect(same.exitCode).toBe(0);
    expect(same.stderr.toString()).toBe('');
    expect(objects(f.load().versions).at(-1)).toMatchObject({ n: 2, kind: 'post', rig_version: 1 });
    expect(readFileSync(directionPath)).toEqual(readFileSync(join(root, 'evidence/input.json')));
    expect(afterJob.status.generation).toBeGreaterThan(beforeJob.status.generation);
    const publicationId = afterJob.status.publication!.publicationId;
    expect(publicationId).not.toBe(beforeJob.status.publication!.publicationId);
    expect(afterJob.asks).toHaveLength(1);
    expect(afterJob.asks[0]).toMatchObject({ publicationId, subject: { kind: 'review-verdict', stage: 'direction-review' } });
    expect(afterJob.acts).toEqual([]);
    expect(pendingPublications(root)).toEqual([]);
    expect(same.stdout.toString()).toContain('review-verdict direction-review');
    expect(same.stdout.toString()).toContain(publicationId);
  } finally {
    proc.kill();
    await proc.exited;
    await output.cancel();
    await errors.cancel();
    rmSync(jobHostStateRoot(root), { recursive: true, force: true });
    rmSync(dirname(root), { recursive: true, force: true });
  }
}, 15_000);

test('legacy state and grandfathered posts do not acquire warnings; adoption idempotent',()=>{const f=setup();const before=readFileSync(join(f.dir,'project.json'));directionCommand(['--adopt',f.dir]);expect(readFileSync(join(f.dir,'project.json'))).toEqual(before);let p=f.load();delete p.direction_contract;expect(checked(f.dir,p)).toEqual([]);p.versions=[...objects(p.versions),{n:2,kind:'post',rig_version:1,at:'2026-11-04T08:40:00Z'}];f.save(p);directionCommand(['--adopt',f.dir]);expect((f.load().direction_contract as JsonObject).grandfathered_posts).toEqual([2]);expect(checked(f.dir)).toEqual([]);});
test('malformed present adoption never becomes legacy',()=>{const f=setup();const p=f.load();p.direction_contract={schema:DIRECTION_CONTRACT,adopted_at:'bad',grandfathered_posts:[]};expect(checked(f.dir,p)).toEqual(['DIRECTION_CONTRACT_INVALID']);});
test('new adopted post without direction refuses checker and both direct approval gates',()=>{const f=setup();const p=f.load();p.versions=[...objects(p.versions),{n:2,kind:'post',rig_version:1,at:new Date(testClock.now()).toISOString()}];f.save(p);expect(checked(f.dir)).toEqual(['DIRECTION_DOCUMENT_REQUIRED']);refuses('DIRECTION_DOCUMENT_REQUIRED',()=>assertDirectionApproval(f.dir,p,'direction-review',2));refuses('DIRECTION_DOCUMENT_REQUIRED',()=>signoffCommand(['direction-review',f.dir,'--by','user','--verbatim-file',join(f.dir,'words.txt')]));});

for(const [name,code,mutate] of [
 ['unknown field','DIRECTION_SCHEMA',(d:JsonObject)=>{d.extra=true;}],
 ['unknown easing','DIRECTION_SCHEMA',(d:JsonObject)=>{objects((d.camera as JsonObject).keys)[0]!.easing='elastic';}],
 ['bad box','DIRECTION_SCHEMA',(d:JsonObject)=>{(objects((d.camera as JsonObject).keys)[0]!.box as JsonObject).width=0;}],
 ['bad duration','DIRECTION_SCHEMA',(d:JsonObject)=>{(d.take as JsonObject).duration=0;}],
 ['outside take','DIRECTION_KEY_OUTSIDE_TAKE',(d:JsonObject)=>{objects((d.camera as JsonObject).keys)[1]!.time=5;}],
 ['first endpoint','DIRECTION_KEY_OUTSIDE_TAKE',(d:JsonObject)=>{objects((d.camera as JsonObject).keys)[0]!.time=1;}],
 ['last timing endpoint','DIRECTION_KEY_OUTSIDE_TAKE',(d:JsonObject)=>{objects((d.timing as JsonObject).keys)[1]!.time=3;}],
 ['duplicate time','DIRECTION_TIME_NON_MONOTONIC',(d:JsonObject)=>{objects((d.camera as JsonObject).keys)[1]!.time=0;}],
 ['decreasing source','DIRECTION_TIME_NON_MONOTONIC',(d:JsonObject)=>{objects((d.timing as JsonObject).keys)[0]!.source_time=5;}],
 ['wrong citation text','DIRECTION_CITATION',(d:JsonObject)=>{((d.citations as JsonObject).camera as JsonObject).quote='not given';}],
 ['unknown rig','DIRECTION_RIG_UNKNOWN',(d:JsonObject)=>{((d.rig as JsonObject).model as JsonObject).sha256='b'.repeat(64);}],
] as const){test(`${name} refuses before changing the record or publishing a document`,()=>{const f=setup();const d=structuredClone(f.doc);mutate(d);writeFileSync(join(f.dir,'evidence/input.json'),JSON.stringify(d));const before=readFileSync(join(f.dir,'project.json'));refuses(code,()=>write(f.dir));expect(readFileSync(join(f.dir,'project.json'))).toEqual(before);expect(existsSync(join(f.dir,'evidence/direction/v2.json'))).toBe(false);});}

test('key bounds accept last camera hold, timing holds, positive finite world coordinates',()=>{const f=setup();(f.doc.camera as JsonObject).keys=[{time:0,box:{x:-1e5,y:1e5,width:1,height:2},easing:'hold'}];objects((f.doc.timing as JsonObject).keys)[1]!.source_time=0;validateDirectionShape(f.doc);});
test('invalid flags all use frozen usage code',()=>{const f=setup();for(const args of [['write','2',f.dir,'--file'],['--adopt',f.dir,'--rig','1'],['check','2',f.dir,'--rig','1'],['check','2',f.dir,'--json','--json'],['write','NaN',f.dir,'--file','x','--rig','1']])refuses('DIRECTION_USAGE',()=>directionCommand(args));});
test('document missing vs changed bytes differ; explicit legacy document is still checked',()=>{const f=setup();write(f.dir);let p=f.load();delete p.direction_contract;expect(checked(f.dir,p)).toEqual([]);writeFileSync(join(f.dir,'evidence/direction/v2.json'),'{}');expect(checked(f.dir,p)).toEqual(['DIRECTION_HASH']);rmSync(join(f.dir,'evidence/direction/v2.json'));expect(checked(f.dir,p)).toEqual(['DIRECTION_FILE']);});
test('literal inputs reject absolute paths, ignored files, symlinks and traversals',()=>{const f=setup();symlinkSync(join(f.dir,'evidence/input.json'),join(f.dir,'evidence/link.json'));for(const path of [join(f.dir,'evidence/input.json'),'evidence/../evidence/input.json','evidence/link.json','node_modules/input.json'])refuses('DIRECTION_FILE',()=>directionCommand(['write','2',f.dir,'--file',path,'--rig','1']));});
test('new version required and existing destination never overwritten',()=>{const f=setup();refuses('DIRECTION_VERSION',()=>write(f.dir,1));mkdirSync(join(f.dir,'evidence/direction'));writeFileSync(join(f.dir,'evidence/direction/v2.json'),'retain');refuses('DIRECTION_SOURCE_CHANGED',()=>write(f.dir));expect(readFileSync(join(f.dir,'evidence/direction/v2.json'),'utf8')).toBe('retain');});
test('fault after document publication rolls back only new file, retains original project',()=>{const f=setup();const before=readFileSync(join(f.dir,'project.json'));expect(()=>directionCommand(['write','2',f.dir,'--file','evidence/input.json','--rig','1'],{beforeCommit:()=>{throw Error('synthetic fault');}})).toThrow('synthetic fault');expect(readFileSync(join(f.dir,'project.json'))).toEqual(before);expect(existsSync(join(f.dir,'evidence/direction/v2.json'))).toBe(false);expect(existsSync(join(f.dir,'.direction.lock'))).toBe(false);});
test('concurrent input replacement refuses and rolls back new document',()=>{const f=setup();refuses('DIRECTION_SOURCE_CHANGED',()=>directionCommand(['write','2',f.dir,'--file','evidence/input.json','--rig','1'],{beforeCommit:()=>writeFileSync(join(f.dir,'evidence/input.json'),'{}')}));expect(existsSync(join(f.dir,'evidence/direction/v2.json'))).toBe(false);});
test('binding must agree with post rig_version',()=>{const f=setup();write(f.dir);const p=f.load();objects(p.versions)[1]!.rig_version=99;expect(checked(f.dir,p)).toEqual(['DIRECTION_RIG_STALE']);});
test('rig model unavailable or mismatched is not regenerated',()=>{const f=setup();write(f.dir);const model=join(f.dir,'derived/review/v1/out/check/build/skeleton.model.json');writeFileSync(model,'changed');expect(checked(f.dir)).toEqual(['DIRECTION_HASH']);rmSync(model);expect(checked(f.dir)).toEqual(['DIRECTION_FILE']);});
test('stale rig refuses current post but historical reading remains possible',()=>{const f=setup();write(f.dir);const p=f.load();const rig=structuredClone(objects(p.versions)[0]!);rig.n=3;p.versions=[...objects(p.versions),rig];f.save(p);expect(checked(f.dir)).toEqual(['DIRECTION_RIG_STALE']);expect(readDirection(f.dir,p,2,false).schema).toBe('rig-create/direction@1');});
test('handoff bootstraps direction without demanding a future document',()=>{const f=setup();expect(handoff(f.dir,1).rig_version).toBe(1);});
test('direction writer accepts a handoff without a historical still', () => {
  const f = setup();
  const project = f.load();
  objects(project.versions)[0]!.evidence = [];
  f.save(project);
  expect(write(f.dir).exit).toBe(0);
  expect(checked(f.dir)).toEqual([]);
});
test('review-package keeps post refusal instead of creating a rig package',()=>{const f=setup();write(f.dir);refuses('REVIEW_PACKAGE_VERSION_INVALID',()=>reviewPackageCommand(['2',f.dir,'--config','evidence/input.json','--from','evidence']));});
test('live approval must still bind current step hashes',()=>{const f=setup();const p=f.load();objects((p.plan as JsonObject).steps)[0]!.does='changed';f.save(p);refuses('DIRECTION_CITATION',()=>write(f.dir));});
test('pending described correction warns and blocks both approval paths',()=>{const f=setup();write(f.dir);recordDescribed(f);const p=f.load();const ctx={dir:f.dir,project:p,refusals:[] as Finding[],warnings:[] as Finding[]};checkCorrections(ctx);expect(ctx.refusals).toEqual([]);expect(ctx.warnings.map(w=>w.code)).toEqual(['CORRECTION_OPEN']);refuses('CORRECTION_PENDING',()=>signoffCommand(['direction-review',f.dir,'--by','user','--verbatim-file',join(f.dir,'words.txt')]));refuses('CORRECTION_PENDING',()=>recordVerdict(f.dir,{version:2,review:'direction-review',verdict:'accepted',by:'user',verbatim:'accept',source:'synthetic',items:[],quotes:{},values:{}}));});
test('removed direction patch flags refuse byte-identically and point to direction write --answers',()=>{
  const f=setup();write(f.dir);const before=readFileSync(join(f.dir,'project.json'));
  expect(()=>correctionCommand(['record',f.dir,'--id','frame','--path','made','--stage','direction-review','--version','2','--direction-patch-file','evidence/patch.json','--by','user','--verbatim-file',join(f.dir,'words.txt')])).toThrow(expect.objectContaining({code:'CORRECTION_DIRECTION_PATCH_FILE_REMOVED',exitCode:2,message:expect.stringContaining('direction write')}));
  expect(()=>directionCommand(['patch','3',f.dir,'--patch-file','evidence/patch.json'])).toThrow(expect.objectContaining({code:'DIRECTION_PATCH_FILE_REMOVED',exitCode:2,message:expect.stringContaining('--answers')}));
  expect(()=>directionCommand(['write','3',f.dir,'--file','evidence/input.json','--rig','1','--patch-file','evidence/patch.json'])).toThrow(expect.objectContaining({code:'DIRECTION_PATCH_FILE_REMOVED',exitCode:2,message:expect.stringContaining('--answers')}));
  expect(readFileSync(join(f.dir,'project.json'))).toEqual(before);
  expect(existsSync(join(f.dir,'evidence/direction/v3.json'))).toBe(false);
});
test('legacy direction_origin.patch and correction patch bindings warn under DIRECTION_PATCH_SINCE without reopening the old file',()=>{
  const f=setup();write(f.dir);const identity=directionPostIdentity(f.dir,f.load(),2);
  const baseline=checkProjectRaw(f.dir,undefined,{now:TEST_NOW,readOnly:true}).refusals;
  const p=f.load();
  objects(p.versions).find(v=>v.n===2)!.direction_origin={source_post:1,patch:{path:'evidence/missing-patch.json',sha256:'a'.repeat(64)},result:identity.direction!};
  p.corrections=[{schema:'rig-create/correction@2',id:'frame',path:'made',by:'user',at:'2026-11-04T09:10:00Z',verbatim:'Tighten framing',stage:'direction-review',on:identity,artifact:{kind:'direction-patch',patch:{path:'evidence/missing-patch.json',sha256:'a'.repeat(64)},state:'preview/pending',result:null},outcome:null,resolves:null}];
  f.save(p);
  const before=readFileSync(join(f.dir,'project.json'));
  expect(()=>correctionCommand(['resolve','frame',f.dir,'--version','2','--by','agent','--reasoning-file',join(f.dir,'reasoning.txt')])).toThrow(expect.objectContaining({code:'CORRECTION_DIRECTION_PATCH_FILE_REMOVED',exitCode:2}));
  expect(readFileSync(join(f.dir,'project.json'))).toEqual(before);
  const dirCtx={dir:f.dir,project:p,refusals:[] as Finding[],warnings:[] as Finding[]};
  checkDirections(dirCtx);checkCorrections(dirCtx);
  expect(dirCtx.refusals).toEqual([]);
  const report=checkProjectRaw(f.dir,undefined,{now:TEST_NOW,readOnly:true,recordReads:true});
  expect(report.refusals).toEqual(baseline);
  const patchWarnings=report.warnings.filter(w=>w.code==='DIRECTION_PATCH_LEGACY');
  expect(patchWarnings.map(w=>w.path)).toEqual(['corrections[0].artifact.patch','versions[v2].direction_origin.patch']);
  for(const w of patchWarnings)expect(w.message).toContain(DIRECTION_PATCH_SINCE);
  expect(report.reads!.some(r=>r.path.includes('missing-patch.json'))).toBe(false);
});
for(const kind of ['rig','draft','parts'] as const){test(`direction identity cannot be ${kind}`,()=>{const f=setup();write(f.dir);const identity=directionPostIdentity(f.dir,f.load(),2);identity.kind=kind;refuses('DIRECTION_CORRECTION_OUTCOME',()=>validateDirectionIdentity(f.dir,f.load(),identity));});}
test('current citation refuses pending delegation; decided delegation validates through provenance',()=>{const f=setup();const p=f.load();const item=objects(((p.interview as JsonObject).post as JsonObject).items)[0]!;item.guide={delegated:true,by:'user',at:'2026-11-04T08:00:00Z',verbatim:'You choose',asks:[{id:'camera_depth',state:'delegated'}]};(f.doc.citations as JsonObject).camera={guide:'camera_depth',asks:['camera_depth'],delegated:true};refuses('DIRECTION_CITATION',()=>validateDirectionCitations(f.dir,p,f.doc,true));(item.guide as JsonObject).agent_decision={by:'agent',at:'2026-11-04T08:10:00Z',reasoning:'Fixed frame',value:{camera:'fixed'}};validateDirectionCitations(f.dir,p,f.doc,true);});
test('historical direction adds its named scene warning to the legacy warnings',()=>{const f=setup();const before=checkProject(f.dir).warnings.map(f=>f.code);write(f.dir);expect(checkProject(f.dir).warnings.map(f=>f.code)).toEqual([...before,'DIRECTION_SCENE_REQUIRED']);});

test('new post dates after setup contract still do not invent parts requirements',()=>{const f=setup();testClock.set(new Date('2026-11-07T09:00:00Z'));write(f.dir);expect(checked(f.dir)).toEqual([]);expect(checkProject(f.dir).refusals.filter(r=>r.path.includes('versions[v2]') && r.code.startsWith('SETUP_PAINTING'))).toEqual([]);});
test('reopen releases closed review; adopted empty post list stays valid',()=>{const f=setup();const p=f.load();p.signoffs=[...objects(p.signoffs),{stage:'direction-review',checkpoint:null,by:'user',at:'2026-11-04T08:50:00Z',verbatim:'Accept'}];p.reopens=[{stage:'direction-review',from_stage:'direction-review',by:'user',at:'2026-11-04T08:55:00Z',verbatim:'Redo camera',steps_before:[]}];f.save(p);write(f.dir);expect(checked(f.dir)).toEqual([]);});
test('post → rig / post → draft / post → parts outcomes cannot close direction artifact', () => {
  const dir = join(tempDir(), 'direction-probe');
  cpSync(frozenDirection, dir, { recursive: true });
  const record = readFileSync(join(dir, 'project.json'), 'utf8');
  for (const kind of ['rig', 'draft', 'parts']) {
    const project = JSON.parse(record) as JsonObject;
    const correction = objects(project.corrections)[0]!;
    (correction.outcome as JsonObject).kind = kind;
    const ctx = { dir, project, refusals: [] as Finding[], warnings: [] as Finding[] };
    checkCorrections(ctx);
    expect(ctx.refusals.map(f => f.code)).toContain('DIRECTION_CORRECTION_OUTCOME');
  }
});
test('valid direction cannot be accepted through direct reader after document hash changes',()=>{const f=setup();write(f.dir);writeFileSync(join(f.dir,'evidence/direction/v2.json'),'{}');const before=readFileSync(join(f.dir,'project.json'));refuses('DIRECTION_HASH',()=>recordVerdict(f.dir,{version:2,review:'direction-review',verdict:'accepted',by:'user',verbatim:'accept',source:'synthetic',items:[],quotes:{},values:{}}));expect(readFileSync(join(f.dir,'project.json'))).toEqual(before);});
test('all post items N/A permits skipping without a document; no authoring from silence',()=>{const f=setup();const p=f.load();for(const item of objects(((p.interview as JsonObject).post as JsonObject).items))item.guide={not_applicable:true,because:'No take requested'};f.save(p);expect(checked(f.dir)).toEqual([]);refuses('DIRECTION_CITATION',()=>write(f.dir));});
test('API correction bytes reproduce through writers while legacy fixtures remain retained',async()=>{const {generateCorrectionFixture}=await import('../scripts/generate-correction-fixture.ts');const files=generateCorrectionFixture(join(tempDir(),'legacy'));for(const[path,bytes]of Object.entries(files))expect(readFileSync(join(import.meta.dir,'fixtures/correction-api-path',path)).equals(bytes)).toBe(true);});
test('unadopted direction writer refuses and immutable input never changes',()=>{const f=setup();const p=f.load();delete p.direction_contract;f.save(p);refuses('DIRECTION_CONTRACT_INVALID',()=>write(f.dir));expect(readFileSync(join(f.dir,'evidence/input.json'),'utf8')).toContain('rig-create/direction@1');});
test('world-space data is never rendered or coerced to frame indices',()=>{const f=setup();objects((f.doc.timing as JsonObject).keys)[1]!.source_time=123.456;writeFileSync(join(f.dir,'evidence/input.json'),JSON.stringify(f.doc));write(f.dir);expect(objects((readDirection(f.dir,f.load(),2).timing as JsonObject).keys)[1]!.source_time).toBe(123.456);});

test('current inherited answers and their historical words retain provenance semantics',()=>{const root=tempDir();const dir=join(root,'members','synthetic-member');const f=directionFixture(dir);const p=f.load();const items=objects(((p.interview as JsonObject).post as JsonObject).items);const camera=items[0]!;const original=camera.guide as JsonObject;writeFileSync(join(root,'collection.json'),JSON.stringify({schema:'rig-create/collection@0',name:'synthetic-collection',interview:{post:{items:[{id:'camera_depth',guide:{...original,verbatim:'A later request',value:{camera:'fixed'}},history:[original]}]}}}));camera.guide={basis:'inherited',from:{collection:'synthetic-collection',question:'camera_depth'}};validateDirectionCitations(dir,p,f.doc,false);});
test('not-applicable camera can be fixed, but a moving camera cannot use the exception',()=>{const f=setup();const p=f.load();const item=objects(((p.interview as JsonObject).post as JsonObject).items)[0]!;item.guide={not_applicable:true,because:'No camera move',verbatim:'Keep the view fixed.'};(f.doc.citations as JsonObject).camera={guide:'camera_depth',asks:['camera_depth'],quote:'Keep the view fixed.'};const camera=f.doc.camera as JsonObject;camera.keys=[objects(camera.keys)[0]!];validateDirectionCitations(f.dir,p,f.doc,true);(camera.keys as JsonObject[]).push({time:4,box:{x:0,y:0,width:10,height:10},easing:'hold'});refuses('DIRECTION_CITATION',()=>validateDirectionCitations(f.dir,p,f.doc,true));});
test('pending Other cannot borrow a historical quote for current authoring',()=>{const f=setup();const p=f.load();const item=objects(((p.interview as JsonObject).post as JsonObject).items)[0]!;item.history=[item.guide as JsonObject];item.guide={delegated:false,by:'user',at:'2026-11-04T08:00:00Z',verbatim:'Something else',value:null,asks:[{id:'camera_depth',state:'other-pending'}]};refuses('DIRECTION_CITATION',()=>validateDirectionCitations(f.dir,p,f.doc,true));});

test('current per-ask Other with fragment and auto decided pass; their pending counterparts refuse',async()=>{
  const {fixture}=await import('./fixtures.ts');const {collectItems}=await import('../src/check.ts');const {choiceVerbatim,selection}=await import('../src/choices.ts');
  for(const mode of ['other-pending','other-complete','auto-pending','auto-decided']){
    const dir=fixture(()=>{},'example-numbered/example-project.json');const p=JSON.parse(readFileSync(join(dir,'project.json'),'utf8')) as JsonObject;
    const item=collectItems(p,{collection:null}).find(i=>i.id==='camera_depth')!;const answer=item.raw as JsonObject;const choice=answer.choice as JsonObject;const setBinding=choice.set as JsonObject;const set=JSON.parse(readFileSync(join(dir,String(setBinding.path)),'utf8')) as JsonObject;
    const option=objects(objects(set.asks)[0]!.options).find(o=>o.id===(mode.startsWith('auto')?'auto':'other'))!;
    const pick:JsonObject={ask:'camera_depth',option_id:option.id as string,shown:{label:option.label as string,effect:option.effect as string}};
    if(mode.startsWith('other')){pick.other_text='Keep a small fixed frame.';if(mode==='other-complete')pick.other_fragment={camera:'fixed',depth:false};}
    choice.picks=[pick];const selected=selection(set,choice);answer.delegated=selected.delegated;answer.asks=selected.asks;answer.verbatim=choiceVerbatim([pick]);if(selected.value===undefined)delete answer.value;else answer.value=selected.value;
    if(mode==='auto-decided')answer.agent_decision={by:'agent',at:answer.at as string,reasoning:'Choose a fixed synthetic frame',covers:'camera_depth',value:{camera:'fixed',depth:false},fragments:[{ask:'camera_depth',fragment:{camera:'fixed',depth:false}}]};else delete answer.agent_decision;
    const base=setup();const doc=structuredClone(base.doc);(doc.citations as JsonObject).camera=mode.startsWith('auto')?{guide:'camera_depth',asks:['camera_depth'],delegated:true}:{guide:'camera_depth',asks:['camera_depth'],quote:answer.verbatim as string};(doc.citations as JsonObject).timing={guide:'post_timing',asks:['post_timing'],quote:'Eight seconds, looping.'};
    if(mode.endsWith('pending'))refuses('DIRECTION_CITATION',()=>validateDirectionCitations(dir,p,doc,true));else validateDirectionCitations(dir,p,doc,true);
  }
});

test('authored document integrates into filled project with no refusals and packaging cannot rebind its model',async()=>{
  const {fixture}=await import('./fixtures.ts');const {collectItems}=await import('../src/check.ts');
  const dir=fixture(()=>{},'example-numbered/example-project.json');
  testClock.set(TEST_NOW);
  writeFileSync(join(dir,'words.txt'),'Revisit the synthetic post.');
  plantLegacyReopen(dir, 'post', { by: 'user', wordsFile: join(dir,'words.txt') });
  testClock.set(TEST_NOW + 60 * 60_000);directionCommand(['--adopt',dir]);
  const p=JSON.parse(readFileSync(join(dir,'project.json'),'utf8')) as JsonObject;const f=setup();testClock.set(TEST_NOW + 70 * 60_000);
  const doc=f.doc;doc.rig={version:2,model:{path:'derived/review/v2/out/check/build/skeleton.model.json',sha256:directionHash(readFileSync(join(dir,'derived/review/v2/out/check/build/skeleton.model.json')))}};
  doc.schema=DIRECTION_SCENE_SPEC;doc.scene=sceneReference(currentScene(p)!);
  const items=collectItems(p,{collection:null});for(const[section,id]of [['camera','camera_depth'],['timing','post_timing']]){const item=items.find(i=>i.id===id)!;(doc.citations as JsonObject)[section!]={guide:id!,asks:[id!],quote:(item.raw as JsonObject).verbatim as string};}
  writeFileSync(join(dir,'evidence/input-direction.json'),JSON.stringify(doc));directionCommand(['write','5',dir,'--file','evidence/input-direction.json','--rig','2']);
  const report=checkProject(dir);expect(report.refusals).toEqual([]);expect(report.warnings.map(w=>[w.code,w.path])).toEqual(POST_LAPSES);
  expect(reviewPackageCommand(['2',dir,'--config','evidence/v2/review-config.json','--from','outputs/v2/out']).exit).toBe(0);
  writeFileSync(join(dir,'outputs/v2/out/check/build/skeleton.model.json'),'changed compiled input');const before=readFileSync(join(dir,'project.json'));refuses('DIRECTION_RIG_STALE',()=>reviewPackageCommand(['2',dir,'--config','evidence/v2/review-config.json','--from','outputs/v2/out']));expect(readFileSync(join(dir,'project.json'))).toEqual(before);
});

test('direct authoring and approval readers refuse an answer decided after its approval',()=>{const f=setup();const p=f.load();const item=objects(((p.interview as JsonObject).post as JsonObject).items)[0]!;(item.guide as JsonObject).at='2026-11-04T09:10:00Z';f.save(p);refuses('DIRECTION_CITATION',()=>write(f.dir));});
test('direction check on a current stale take refuses instead of blessing it as historical',()=>{const f=setup();write(f.dir);const p=f.load();const rig=structuredClone(objects(p.versions)[0]!);rig.n=3;p.versions=[...objects(p.versions),rig];f.save(p);refuses('DIRECTION_RIG_STALE',()=>directionCommand(['check','2',f.dir]));});

test('N/A fixed camera publishes through direction write and checkProject; two keys refuse the writer',async()=>{
  const {fixture}=await import('./fixtures.ts');const {collectItems}=await import('../src/check.ts');
  const dir=fixture(()=>{},'example-numbered/example-project.json');
  testClock.set(TEST_NOW);
  writeFileSync(join(dir,'words.txt'),'Revisit the synthetic post answers.');
  plantLegacyReopen(dir, 'post-interview', { by: 'user', wordsFile: join(dir,'words.txt') });
  const changed=JSON.parse(readFileSync(join(dir,'project.json'),'utf8')) as JsonObject;
  const camera=objects(((changed.interview as JsonObject).post as JsonObject).items).find(i=>i.id==='camera_depth')!;
  camera.history=[...objects(camera.history),camera.guide as JsonObject];
  camera.guide={not_applicable:true,because:'No camera motion requested',verbatim:'Keep the view fixed.',by:'user',at:new Date(TEST_NOW + 60 * 60_000).toISOString()};
  writeFileSync(join(dir,'project.json'),JSON.stringify(changed));
  const plan = changed.plan as JsonObject;
  const step = objects(plan.steps).find(candidate => candidate.id === 'camera')!;
  testClock.set(TEST_NOW + 60 * 60_000 + 1_000);
  expect(planCommand(['remove', 'camera', dir, '--by', 'agent']).exit).toBe(0);
  testClock.set(testClock.now() + 1_000);
  expect(planCommand(['add', 'camera', dir, '--by', 'agent', '--phase', String(step.phase), '--order', String(step.order),
    '--does', String(step.does), '--produces', String(step.produces), '--rests-on', (step.rests_on as string[]).join(','),
    '--bar', String(step.bar), '--checkpoint-proposed', String(step.checkpoint_proposed)]).exit).toBe(0);
  const replaced = (JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject).plan as JsonObject;
  expect(replaced.replaced).toEqual([...objects(plan.replaced), expect.objectContaining({ step, action: 'removed' })]);
  testClock.set(TEST_NOW + 24 * 60 * 60_000);
  signoffCommand(['post-interview',dir,'--by','user','--verbatim-file',join(dir,'words.txt')]);
  advanceCommand(['post',dir]);
  testClock.set(TEST_NOW + 48 * 60 * 60_000);directionCommand(['--adopt',dir]);
  const p=JSON.parse(readFileSync(join(dir,'project.json'),'utf8')) as JsonObject;
  const f=setup();testClock.set(TEST_NOW + 48 * 60 * 60_000 + 10 * 60_000);const doc=f.doc;
  doc.rig={version:2,model:{path:'derived/review/v2/out/check/build/skeleton.model.json',sha256:directionHash(readFileSync(join(dir,'derived/review/v2/out/check/build/skeleton.model.json')))}};
  (doc.camera as JsonObject).keys=[objects((doc.camera as JsonObject).keys)[0]!];
  doc.schema=DIRECTION_SCENE_SPEC;doc.scene=sceneReference(currentScene(p)!);
  const items=collectItems(p,{collection:null});for(const[section,id]of [['camera','camera_depth'],['timing','post_timing']]){const item=items.find(i=>i.id===id)!;(doc.citations as JsonObject)[section!]={guide:id!,asks:[id!],quote:(item.raw as JsonObject).verbatim as string};}
  const input=join(dir,'evidence/input-direction.json');writeFileSync(input,JSON.stringify(doc));
  expect(directionCommand(['write','5',dir,'--file','evidence/input-direction.json','--rig','2']).exit).toBe(0);
  expect(existsSync(join(dir,'evidence/direction/v5.json'))).toBe(true);
  const report=checkProject(dir);expect(report.refusals).toEqual([]);expect(report.ok).toBe(true);expect(report.warnings.map(w=>[w.code,w.path])).toEqual(POST_LAPSES);
  const original=readFileSync(join(dir,'project.json'));
  ((doc.camera as JsonObject).keys as JsonObject[]).push({time:4,box:{x:0,y:0,width:10,height:10},easing:'hold'});writeFileSync(input,JSON.stringify(doc));
  refuses('DIRECTION_CITATION',()=>directionCommand(['write','6',dir,'--file','evidence/input-direction.json','--rig','2']));
  expect(readFileSync(join(dir,'project.json'))).toEqual(original);expect(existsSync(join(dir,'evidence/direction/v6.json'))).toBe(false);
});
test('the writer is refused on a record whose stage check stopped early',()=>{const f=setup();const p=f.load();p.stage='no-such-stage';f.save(p);expect(checkProject(f.dir).refusals.map(r=>r.code)).toEqual(['STAGE_UNKNOWN']);const before=readFileSync(join(f.dir,'project.json'));refuses('STAGE_UNKNOWN',()=>write(f.dir));expect(readFileSync(join(f.dir,'project.json'))).toEqual(before);expect(existsSync(join(f.dir,'evidence/direction/v2.json'))).toBe(false);});


test('legacy rig direction acceptances remain byte-identical while a later rig authors direction',()=>{
  const f=sceneFixture();const p=f.load();
  const legacy={...objects(p.versions)[0]!,n:3,at:'2026-11-02T08:00:00Z',verdicts:[{review:'direction-review',verdict:'accepted',by:'user',at:'2026-11-02T09:00:00Z',verbatim:'Accept the synthetic legacy rig'}]};
  const laterLegacy=structuredClone(legacy);laterLegacy.n=5;laterLegacy.at='2026-11-03T08:00:00Z';laterLegacy.verdicts[0]!.at='2026-11-03T09:00:00Z';
  const rig=structuredClone(objects(p.versions)[0]!);rig.n=15;
  p.versions=[legacy,laterLegacy,rig];
  const approval=objects(p.signoffs).find(v=>v.stage==='rig-review')!;approval.target={version:15,verdict:'versions[2].verdicts[0]',review_package:{path:'versions[2].review_package',sha256:reviewPackageHash(rig.review_package as JsonObject)}};f.save(p);
  // Capture the literal retained verdict rows, including their whitespace.
  const rows=(record:string,n:number):Buffer=>{
    const start=record.indexOf('"verdicts": [',record.indexOf(`"n": ${n},`));
    const end=record.indexOf('\n      ]',start);expect(start).toBeGreaterThan(-1);expect(end).toBeGreaterThan(start);
    return Buffer.from(record.slice(start,end+8));
  };
  const before=readFileSync(join(f.dir,'project.json'),'utf8');
  cpSync(join(f.dir,'derived/review/v1'),join(f.dir,'derived/review/v15'),{recursive:true});
  const sceneArgs=f.args();sceneArgs[sceneArgs.indexOf('--rig')+1]='15';
  expect(sceneCommand(sceneArgs).exit).toBe(0);
  f.doc.schema=DIRECTION_SCENE_SPEC;f.doc.scene=sceneReference(currentScene(f.load())!);
  (f.doc.rig as JsonObject).model={...f.modelBinding,path:'derived/review/v15/out/check/build/skeleton.model.json'};(f.doc.rig as JsonObject).version=15;writeFileSync(join(f.dir,'evidence/input.json'),JSON.stringify(f.doc));
  expect(directionCommand(['write','16',f.dir,'--file','evidence/input.json','--rig','15']).exit).toBe(0);
  const after=readFileSync(join(f.dir,'project.json'),'utf8');
  for(const n of [3,5])expect(rows(after,n)).toEqual(rows(before,n));
  expect(objects(f.load().versions).slice(0,3)).toEqual([legacy,laterLegacy,rig]);
});

test('#981 an accepted post direction takes a new direction version without a reopen',()=>{
  const f=setup();write(f.dir);const p=f.load();p.stage='direction-review';
  objects(p.versions).find(v=>v.n===2)!.verdicts=[{review:'direction-review',verdict:'accepted',by:'user',at:'2026-11-04T09:01:00Z',verbatim:'Accept the synthetic post'}];f.save(p);
  expect(write(f.dir,3).exit).toBe(0);
  expect(existsSync(join(f.dir,'evidence/direction/v3.json'))).toBe(true);
  expect(f.load().reopens).toBeUndefined();
});
