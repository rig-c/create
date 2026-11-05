import { afterEach, expect, setSystemTime, test } from 'bun:test';
import { readFileSync, writeFileSync, symlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { checkProject, collectItems } from '../src/check.ts';
import { interviewOptionsCommand, interviewAnswerCommand, interviewDecisionCommand } from '../src/choice-writers.ts';
import { intakeCommand, intakeReportCommand, intakeWarnings, intakeItem, intakeContext } from '../src/intake.ts';
import { OPTIONS_SPEC, sha256 } from '../src/choices.ts';
import { signoffCommand } from '../src/signoff.ts';
import { handoff } from '../src/review.ts';
import { recordVerdict } from '../src/feedback.ts';
import { Refusal } from '../src/refusal.ts';
import type { Json, JsonObject } from '../src/templates.ts';
import { fixture, obj, arr } from './fixtures.ts';
import { EXAMPLE_DIFF_REPORT } from './diff-fixture.ts';
import { EXAMPLE_VERDICT } from './parts-package.ts';

const raw = readFileSync(join(import.meta.dir,'fixtures/intake/preflight.json'));
const load=(dir:string):JsonObject=>JSON.parse(readFileSync(join(dir,'project.json'),'utf8'));
const save=(dir:string,p:JsonObject)=>writeFileSync(join(dir,'project.json'),JSON.stringify(p,null,2)+'\n');
const codes=(dir:string)=>intakeWarnings(dir,load(dir)).map(w=>w.code);
afterEach(()=>setSystemTime());
function outcome(action:()=>unknown):string { try {action();return 'OK';}catch(e){if(e instanceof Refusal)return e.code;throw e;} }
function setup(hit=true) {
  setSystemTime(new Date('2026-11-20T10:00:00Z'));
  const dir=fixture(p=>{p.stage='parts';},'example-project.json');
  const report=JSON.parse(raw.toString()) as JsonObject;
  if(!hit)obj(obj(arr(report.layers)[0]).sides).left_px=0;
  const bytes=hit?raw:Buffer.from(JSON.stringify(report)+'\n');
  writeFileSync(join(dir,'evidence/intake.json'),bytes);
  const args=[dir,'--id','crop-one','--report','evidence/intake.json','--sha256',sha256(bytes),'--parts-version','2.16.0','--by','agent'];
  intakeReportCommand(args);
  return {dir,args};
}
function offer(dir:string) {
  const p=load(dir);const set:JsonObject={schema:OPTIONS_SPEC,id:'crop-choice',question:'intake_suitability',stage:'parts',drafted_by:'agent',drafted_at:new Date().toISOString(),context:intakeContext(p,Date.now()),assembly:{rule:'single'},asks:[{id:'intake_suitability',prompt:'How do you want to continue?',options:[{id:'proceed',kind:'value',label:'Proceed',effect:'Keep the painting',fragment:'proceed',recommended:true,reason:'Advice only'},{id:'another',kind:'value',label:'Choose another',effect:'Record intent to choose another',fragment:'choose-another',recommended:false},{id:'other',kind:'other',label:'Other',effect:'Record exact words',recommended:false},{id:'auto',kind:'auto',label:'Delegate',effect:'Agent decides explicitly',recommended:false}]}]};
  const bytes=JSON.stringify(set);writeFileSync(join(dir,'evidence/intake-options.json'),bytes);interviewOptionsCommand(['intake_suitability',dir,'--file','evidence/intake-options.json']);return sha256(Buffer.from(bytes));
}
function choose(dir:string,state:string) {
  const hash=offer(dir); const option=state.startsWith('auto')?'auto':state.startsWith('other')?'other':state;
  const args=['intake_suitability',dir,'--set','evidence/intake-options.json','--sha256',hash,'--by','user','--pick',`intake_suitability=${option}`];
  writeFileSync(join(dir,'words.txt'),'  Exact words\r\n e\u0301\n');
  if(option==='other'){args.push('--other',`intake_suitability=${join(dir,'words.txt')}`);if(state==='other-fragment'){writeFileSync(join(dir,'fragment.json'),JSON.stringify('custom'));args.push('--other-fragment',`intake_suitability=${join(dir,'fragment.json')}`);}}
  interviewAnswerCommand(args);
  if(state==='auto-decided'){writeFileSync(join(dir,'fragment.json'),JSON.stringify('proceed'));interviewDecisionCommand(['intake_suitability',dir,'--by','agent','--reasoning-file',join(dir,'words.txt'),'--fragment',`intake_suitability=${join(dir,'fragment.json')}`]);}
}

test('HIT-only pending warning: HIT asks explicitly, zero sides with bottom has no risk or pending warning',()=>{
  const h=setup();expect(codes(h.dir)).toEqual(['INTAKE_HEAD_CROP_RISK','INTAKE_CHOICE_PENDING']);
  const z=setup(false);expect(codes(z.dir)).toEqual([]);
  const entry=obj(arr(obj(load(h.dir).intake).reports)[0]);expect(entry.prediction).toBe('hit');expect(entry.measurement).toEqual(JSON.parse(raw.toString()));expect(obj(entry.report).sha256).toBe(sha256(raw));expect(entry.parts_version).toBe('2.16.0');
  expect(obj(entry.measurement).parts_version).toBeUndefined();
});

test('ignored report paths refuse before writing with project bytes identical',()=>{
  const {dir,args}=setup(); const before=readFileSync(join(dir,'project.json'));
  for(const root of ['derived','outputs','scratch','node_modules']){
    mkdirSync(join(dir,root),{recursive:true});writeFileSync(join(dir,root,'preflight.json'),raw);
    const attempt=[...args];attempt[attempt.indexOf('--id')+1]='ignored';attempt[attempt.indexOf('--report')+1]=`${root}/preflight.json`;
    expect(outcome(()=>intakeReportCommand(attempt))).toBe('INTAKE_REPORT_INVALID');
    expect(readFileSync(join(dir,'project.json'))).toEqual(before);
  }
});
test('pending warning ends after parts while the HIT risk remains',()=>{
  const {dir}=setup();expect(codes(dir)).toContain('INTAKE_CHOICE_PENDING');
  const p=load(dir);p.stage='rigging-interview';save(dir,p);
  expect(codes(dir)).not.toContain('INTAKE_CHOICE_PENDING');expect(codes(dir)).toContain('INTAKE_HEAD_CROP_RISK');
});
test('pending remedy names choice adoption for a project without choices',()=>{
  const {dir}=setup();const p=load(dir);obj(obj(p.interview).order).spec='rig-create/stage-order@1';save(dir,p);
  const pending=intakeWarnings(dir,p).find(w=>w.code==='INTAKE_CHOICE_PENDING');expect(pending?.code).toBe('INTAKE_CHOICE_PENDING');
  expect(pending?.message).toContain('interview-options --adopt');
});

test('each #90 choice state stays advisory; exact words and explicit delegation survive',()=>{
  for(const state of ['proceed','another','other-fragment','other-pending','auto-pending','auto-decided']){
    const {dir}=setup();choose(dir,state);
    expect(codes(dir)).not.toContain('INTAKE_CHOICE_INVALID');
    expect(codes(dir).includes('INTAKE_CHOICE_PENDING')).toBe(['other-pending','auto-pending'].includes(state));
    expect(collectItems(load(dir),{collection:null}).some(i=>i.id==='intake_suitability')).toBe(false);
    if(state.startsWith('other'))expect(String(obj(intakeItem(load(dir))?.raw).verbatim)).toContain('  Exact words\r\n e\u0301\n');
    if(state==='auto-pending')expect(obj(intakeItem(load(dir))?.raw).delegated).toBe(true);
  }
});
test('report writer rejects malformed bindings byte-identically, never runs producer and appends immutable history',()=>{
  const {dir,args}=setup();const before=readFileSync(join(dir,'project.json'));
  for(const edit of [(a:string[])=>{a[a.indexOf('--sha256')+1]='0'.repeat(64);},(a:string[])=>{a[a.indexOf('--report')+1]='../outside.json';},(a:string[])=>{a[a.indexOf('--supersedes')+1]='absent';}]){
    const a=[...args,'--supersedes','crop-one'];a[a.indexOf('--id')+1]='fresh';edit(a);expect(outcome(()=>intakeReportCommand(a))).toBe('INTAKE_REPORT_INVALID');expect(readFileSync(join(dir,'project.json'))).toEqual(before);
  }
  const next=[...args];next[next.indexOf('--id')+1]='crop-two';intakeReportCommand([...next,'--supersedes','crop-one']);
  const reports=arr(obj(load(dir).intake).reports);expect(reports).toHaveLength(2);expect(obj(reports[1]).supersedes).toBe('crop-one');expect(reports[0]).toEqual(arr(obj(JSON.parse(before.toString()).intake).reports)[0]);
});
test('malformed persisted intake stays warnings-only, no outcome label inferred and no inherited choice',()=>{
  const {dir}=setup();const baseline=checkProject(dir).refusals;
  for(const intake of [null,{}, {spec:'bad',reports:[]}, {spec:'rig-create/intake@1',reports:[null]}, {...obj(load(dir).intake),choice:{answer:{basis:'inherited'},history:[]}}]){
    const p=load(dir);p.intake=intake as Json;save(dir,p);expect(checkProject(dir).refusals).toEqual(baseline);expect(codes(dir).some(c=>c.endsWith('INVALID'))).toBe(true);
  }
  expect(intakeCommand([dir])).not.toContain('"label":"negative"');
});
test('sha/spec/geometry and instrument mismatches warn; a symlink is not retained producer bytes',()=>{
  for(const mutate of [(p:JsonObject)=>{p.spec='unknown';},(p:JsonObject)=>{p.drawn_alpha_above=128;},(p:JsonObject)=>{p.head_box=[1,2,0,3];}]){
    const {dir}=setup();const p=JSON.parse(raw.toString());mutate(p);writeFileSync(join(dir,'evidence/intake.json'),JSON.stringify(p));const project=load(dir);obj(arr(obj(project.intake).reports)[0]).report={path:'evidence/intake.json',sha256:sha256(Buffer.from(JSON.stringify(p)))};save(dir,project);expect(codes(dir)).toContain('INTAKE_REPORT_INVALID');
  }
  const {dir,args}=setup();symlinkSync(join(dir,'evidence/intake.json'),join(dir,'evidence/link.json'));const before=readFileSync(join(dir,'project.json'));args[args.indexOf('--id')+1]='next';args[args.indexOf('--report')+1]='evidence/link.json';expect(outcome(()=>intakeReportCommand(args))).toBe('INTAKE_REPORT_INVALID');expect(readFileSync(join(dir,'project.json'))).toEqual(before);
});
test('report replacement requires fresh context; prior human choice cannot resolve a new HIT',()=>{
  const {dir,args}=setup();choose(dir,'proceed');setSystemTime(new Date('2026-11-20T10:01:00Z'));args[args.indexOf('--id')+1]='new-report';intakeReportCommand(args);expect(codes(dir)).toContain('INTAKE_CHOICE_PENDING');expect(codes(dir)).not.toContain('INTAKE_CHOICE_INVALID');
  expect(outcome(()=>interviewOptionsCommand(['intake_suitability',dir,'--file','evidence/intake-options.json']))).toBe('INTERVIEW_OPTIONS_STALE');
});
test('intake is only offered in parts; later approval does not make Other pending invalid',()=>{
  const {dir}=setup();choose(dir,'other-pending');const p=load(dir);p.stage='accepted';save(dir,p);expect(codes(dir)).not.toContain('INTAKE_CHOICE_INVALID');expect(outcome(()=>offer(dir))).toBe('INTERVIEW_OPTIONS_USAGE');
});

const states=['pending','proceed','another','other-fragment','other-pending','auto-pending','auto-decided','malformed','no-risk'];
for(const state of states)test(`approval readers ignore optional intake: ${state}`,()=>{
  const {dir}=setup(state!=='no-risk');if(!['pending','malformed','no-risk'].includes(state))choose(dir,state);
  const p=load(dir);p.stage='accepted';if(state==='malformed')p.intake={spec:'wrong',reports:[null]};
  const intake=p.intake;delete p.intake;save(dir,p);writeFileSync(join(dir,'words.txt'),'Explicit approval');
  const actions=[
    ()=>signoffCommand(['plan-approved',dir,'--by','user','--verbatim-file',join(dir,'words.txt')]),
    ()=>signoffCommand(['rigging-interview',dir,'--by','user','--verbatim-file',join(dir,'words.txt')]),
    ()=>{setSystemTime(new Date('2026-11-11T10:20:00Z'));return signoffCommand(['parts-review',dir,'--by','user','--verbatim-file',join(dir,'words.txt'),'--evidence',EXAMPLE_VERDICT,'--diff-report',EXAMPLE_DIFF_REPORT,'--component','p10-n3=in-painting:synthetic source','--component','p1000-n3=in-painting:synthetic source','--draft','example','--structure-file','evidence/structure-decisions.json']);},
    ()=>signoffCommand(['direction-review',dir,'--by','user','--verbatim-file',join(dir,'words.txt')]),
    ()=>recordVerdict(dir,{version:2,review:'rig-review',verdict:'accepted',by:'user',verbatim:'Approved',source:'review',items:[],quotes:{},values:{}}),
    ()=>recordVerdict(dir,{version:4,review:'direction-review',verdict:'accepted',by:'user',verbatim:'Approved',source:'review',items:[],quotes:{},values:{}}),
    ()=>handoff(dir,null),
  ];
  for(const action of actions){save(dir,p);const without=outcome(action);expect(without).toBe('OK');save(dir,{...p,intake:intake!});const withIntake=outcome(action);expect(withIntake).toBe(without);}
  save(dir,p);const before=checkProject(dir).refusals;save(dir,{...p,intake:intake!});expect(checkProject(dir).refusals).toEqual(before);
});
