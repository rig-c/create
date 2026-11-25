import { reviewStdout } from './review-read-fixture.ts';

import { plantLegacyReopen, retainSignoffs } from './fixtures.ts';
import { resignAfterChange } from './fixtures.ts';
import { afterEach, expect, test } from 'bun:test';
import { readFileSync, writeFileSync, symlinkSync, mkdirSync, rmSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { collectItems, isObject, asArray, type Finding } from '../src/check.ts';
import { CHOICE_SPEC, CHOICE_ORDER_SPEC, sha256, optionContext, validateSet, assembleFragments, checkChoiceConstraints, type ChoiceError } from '../src/choices.ts';
import { FRAMING_IDS } from '../src/waypoints.ts';
import { GUIDE_INTERVIEW, hasStageOrder, stageIndex } from '../src/stages.ts';
import { currentJobIdentity, readRecordPublished, type RecordPlanContext } from '../src/job-publication.ts';
import { JOB_BINDING_FILE, jobHash, writePrivateJson } from '../src/job-outbox.ts';
import { realpathSync } from 'node:fs';
import { interviewAnswerCommand as rawInterviewAnswer } from '../src/choice-writers.ts';
import { decodeReviewResponse, fetchReviewAct, REVIEW_ACT_ACTOR_SINCE, reviewActFindings } from '../src/review-act.ts';
import { partsReviewCommand } from '../src/parts-review.ts';
import { PARTS_CLI_RECEIPT, partsReadFindings } from '../src/parts-verdict-record.ts';
import { Refusal } from '../src/refusal.ts';
import { nextProject } from '../src/next.ts';
import { assertPlanSignoffCandidate, signoffCommand as rawSignoff } from '../src/signoff.ts';
import { fixture, obj, arr, waypoint, framing } from './fixtures.ts';
import type { Json, JsonObject } from '../src/templates.ts';
import { EXAMPLE_ANCHOR } from '../scripts/example-time.ts';

afterEach(()=>testClock.reset());
// Fresh test acts follow the complete generated narrative (at most two minutes).
const sourceDraftAt=EXAMPLE_ANCHOR+3*60_000;
const riggingDraftAt=sourceDraftAt+60_000;
const load=(dir:string):JsonObject=>JSON.parse(readFileSync(join(dir,'project.json'),'utf8'));
const save=(dir:string,p:JsonObject):void=>writeFileSync(join(dir,'project.json'),JSON.stringify(p,null,2)+'\n');
const current=(p:JsonObject,q:string)=>collectItems(p,{collection:null}).find(i=>i.id===q)!;
function code(action:()=>unknown):string {try{action();return 'NO_REFUSAL';}catch(e){return (e as Refusal|ChoiceError).code;}}
function working(question='motion'): {dir:string;set:JsonObject;path:string;hash:string} {
  const source=['rig_type','reference','assemble','seethrough'].includes(question);
  const dir=fixture(p=>{
    p.stage=source?'interview':'rigging-interview';p.versions=[];p.scenes=[];delete p.direction_contract;
    retainSignoffs(p, s => stageIndex(String(obj(s).stage))<(source?stageIndex('interview'):stageIndex('rigging-interview')));
    for(const s of arr(obj(p.plan).steps).map(obj))if(source||!['seethrough','assemble'].includes(String(s.id)))s.status='pending';
    for(const item of arr(obj(obj(p.interview).post).items).map(obj))item.guide=null;
    if(source)for(const id of ['bones','meshes','constraints','turn','motion'])waypoint(p,id).guide=null;
  },'example-project.json');
  return registerReask(dir, question, `test-${question}`, source ? sourceDraftAt : riggingDraftAt);
}
function registerReask(dir: string, question: string, id: string, draftedAt: number) {
  const p=load(dir);const item=current(p,question);const original=obj(obj(item.raw).choice).set as JsonObject;
  const set=JSON.parse(readFileSync(join(dir,String(original.path)),'utf8')) as JsonObject;
  set.id=id;set.drafted_at=new Date(draftedAt).toISOString();
  set.context=optionContext(p,String(set.stage),Date.parse(set.drafted_at as string));
  const path=`evidence/interview/${id}.json`;const bytes=JSON.stringify(set,null,2)+'\n';writeFileSync(join(dir,path),bytes);
  testClock.set(draftedAt+1_000);
  interviewOptionsCommand([question,dir,'--file',path]);
  return{dir,set,path,hash:sha256(Buffer.from(bytes))};
}
function answer(w:ReturnType<typeof working>, picks?:string[]):string {
  return interviewAnswerCommand([String(w.set.question),w.dir,'--set',w.path,'--sha256',w.hash,'--by','user',...(picks??arr(w.set.asks).map(a=>`${String(obj(a).id)}=keep`)).flatMap(p=>['--pick',p])]);
}
function rewriteSet(w:ReturnType<typeof working>,edit:(s:JsonObject)=>void):void{
  edit(w.set);const bytes=JSON.stringify(w.set,null,2)+'\n';writeFileSync(join(w.dir,w.path),bytes);w.hash=sha256(Buffer.from(bytes));
  const p=load(w.dir);current(p,String(w.set.question)).record.pending_options={path:w.path,sha256:w.hash};save(w.dir,p);
}

/** Synthetic finalized acts enter through the injected job fetch adapter. */
function bindReview(w: {dir:string}): void {
  const project=load(w.dir);const jobId='synthetic-interview-job';
  const origin='http://127.0.0.1:43123';
  const identity=currentJobIdentity({root:w.dir,stateDir:'unused-private-state',fingerprint:'synthetic',reviewer:{id:'synthetic-owner',role:'owner'}},w.dir);
  writePrivateJson(join(realpathSync(w.dir),JOB_BINDING_FILE),{schema:'rig-create/job-binding@1',identity,jobId,origin,fetchCapability:'synthetic-read-grant'},true);
  project.review_job={jobId,origin};save(w.dir,project);
}
function reviewAnswer(w: {dir:string;path:string;hash:string}, payload: JsonObject, extra: string[] = [], editAct?: (act: JsonObject) => void): string {
  bindReview(w);
  const set=JSON.parse(readFileSync(join(w.dir,w.path),'utf8')) as JsonObject;
  const jobId='synthetic-interview-job',actId=`pick-${String(set.id)}`;
  const act={schema:'rig-review/act@2',kind:'interview-picks',jobId,actId,askId:'synthetic-ask',publicationId:'synthetic-publication',at:payload.at,
    authority:{actor:'human',channel:'review-ui',reviewer:{id:'synthetic-owner',role:'owner'}},
    source:{sourceHash:'1'.repeat(64),projectHash:'2'.repeat(64),package:{id:'synthetic-package',revision:'one'},
      parts:{enumeratorVersion:'2.30.1'},optionSet:{id:set.id,sha256:obj(payload.set).sha256}},
    value:{questionId:set.question,selections:arr(payload.picks).map(raw=>({itemId:obj(raw).ask,optionId:obj(raw).option_id,otherText:obj(raw).other_text??null})),note:payload.note??''}};
  editAct?.(act as JsonObject);
  return rawInterviewAnswer([String(set.question),realpathSync(w.dir),'--from-review',actId,...extra],testClock.now(),{fetch:transport=>{
    expect(transport.jobId).toBe(jobId);expect(transport.actId).toBe(actId);expect(transport.kind).toBe('interview-picks');
    return {bytes:JSON.stringify(act)};
  }});
}

test('every framing id explicitly belongs to the source interview',()=>{for(const id of FRAMING_IDS)expect(GUIDE_INTERVIEW[id]).toBe('interview');});
test('active writer-generated fixture is 0/0, and @1 still has split semantics',()=>{
  const r=checkProject(fixture(()=>{},'example-project.json'));expect(r.refusals).toEqual([]);expect(r.warnings).toEqual([]);
  expect(hasStageOrder({interview:{order:{spec:'rig-create/stage-order@1'}}})).toBe(true);
});

test('#670 next names every current-stage set and offers one grouped question page before signoff', () => {
  const w = working('reference');
  const { dir } = w;
  const priorValue = obj(current(load(dir), 'reference').raw).value;
  answer(w, ['reference=auto']);
  const fragment = join(dir, 'reference-fragment.json');
  const reasoning = join(dir, 'reference-reasoning.txt');
  writeFileSync(fragment, JSON.stringify(priorValue));
  writeFileSync(reasoning, 'Keep the previous source choice.');
  testClock.set(testClock.now() + 1_000);
  interviewDecisionCommand(['reference', dir, '--by', 'agent', '--reasoning-file', reasoning, '--fragment', `reference=${fragment}`]);
  expect(current(load(dir), 'reference').state).toMatchObject({ state: 'delegated', decided: true });
  registerReask(dir, 'reference', 'test-reference-reask', testClock.now());
  registerReask(dir, 'seethrough', 'test-seethrough', testClock.now());
  expect(obj(obj(current(load(dir), 'seethrough').raw).agent_decision).reasoning).toBeTruthy();
  const report = nextProject(dir, testClock.now());
  expect(report.moves.filter(move => move.review_act?.kind === 'interview-picks')).toEqual([
    expect.objectContaining({ role: 'human', command: null, field: 'interview.framing[reference].pending_options',
      awaits: 'interview.framing[reference].answer', review_act: { kind: 'interview-picks', stage: 'interview', question_id: 'reference', option_set_id: 'test-reference-reask' } }),
    expect.objectContaining({ role: 'human', command: null, field: 'interview.waypoints[seethrough].pending_options',
      awaits: 'interview.waypoints[seethrough].guide', review_act: { kind: 'interview-picks', stage: 'interview', question_id: 'seethrough', option_set_id: 'test-seethrough' } }),
  ]);
  const opens = report.moves.filter(move => move.command?.startsWith('rig-create job open '));
  expect(opens).toHaveLength(1);
  expect(opens[0]!.command).toEndWith(" --questions --reviewer '<reviewer>' --role owner");
  expect(report.awaits).not.toContain('signoffs[stage=interview]');
  expect(report.moves.some(move => move.review_act?.kind === 'signoff' && move.review_act.stage === 'interview')).toBe(false);
  expect(report.moves.some(move => move.command?.startsWith('rig-create signoff interview '))).toBe(false);
});

test('#670 interview check warns on a decided answer and clears after a Review pick of the same option', () => {
  const w = working('reference');
  const initial = current(load(w.dir), 'reference');
  expect(initial.state.state).toBe('user');
  const result = interviewCommand(['--check', w.dir, '--json']);
  const { refusals, warnings } = JSON.parse(result.stdout) as ReturnType<typeof checkProject>;
  expect(result.exit).toBe(0);
  expect(refusals).toEqual([]);
  expect(warnings.filter(warning => warning.code === 'INTERVIEW_REASK_PENDING')).toEqual([
    expect.objectContaining({ path: 'interview.framing[reference].pending_options', message: expect.stringContaining('reference') }),
  ]);
  testClock.set(testClock.now() + 1_000);
  const pick = JSON.parse(reviewAnswer(w, { set: { path: w.path, sha256: w.hash },
    picks: [{ ask: 'reference', option_id: 'keep' }], at: testClock.iso() }));
  expect(pick.value).toEqual(obj(initial.raw).value);
  const cleared = current(load(w.dir), 'reference');
  expect(cleared.record.pending_options).toBeUndefined();
  expect(arr(cleared.record.history).at(-1)).toEqual(initial.raw);
  expect(checkProject(w.dir).warnings.some(warning => warning.code === 'INTERVIEW_REASK_PENDING')).toBe(false);
  expect(nextProject(w.dir, testClock.now()).moves.some(move => move.review_act?.kind === 'signoff' && move.review_act.stage === 'interview')).toBe(true);
});

test('#670 an earlier-stage set does not block the current rigging interview signoff', () => {
  const w = working('motion');
  registerReask(w.dir, 'reference', 'test-reference-earlier-stage', testClock.now());
  const next = () => nextProject(w.dir, testClock.now());
  const wordsFile = join(w.dir, 'approval.txt');
  writeFileSync(wordsFile, 'I approve the rigging interview.');
  const sign = () => signoffCommand(['rigging-interview', w.dir, '--by', 'user', ...ownerChatArgs(wordsFile)]);
  expect(next().moves.filter(move => move.review_act?.kind === 'interview-picks').map(move => move.review_act?.question_id)).toEqual(['motion']);
  expect(code(sign)).toBe('SIGNOFF_REASK_PENDING');

  answer(w);
  expect(planCommand(['revise', 'motion', w.dir, '--by', 'agent',
    '--reason', 'The motion definition still fits the recorded rigging-interview choice.']).exit).toBe(0);
  expect(current(load(w.dir), 'reference').record.pending_options).toBeDefined();
  expect(next().moves.some(move => move.review_act?.kind === 'signoff' && move.review_act.stage === 'rigging-interview')).toBe(true);
  expect(sign().exit).toBe(0);
});

test.each(['review', 'owner-chat'] as const)('#670 %s signoff refuses with identical bytes and succeeds after picks', route => {
  const w = working('reference');
  const words = 'I approve the interview.';
  const wordsFile = join(w.dir, 'approval.txt');
  writeFileSync(wordsFile, words);
  bindReview(w);
  const actId = 'sign-reask-interview';
  let actAt = testClock.iso();
  const sign = () => route === 'owner-chat'
    ? signoffCommand(['interview', w.dir, '--by', 'user', ...ownerChatArgs(wordsFile)])
    : rawSignoff(['interview', realpathSync(w.dir), '--from-review', actId], testClock.now(), { fetch: transport => {
      expect(transport.kind).toBe('signoff');
      return { bytes: JSON.stringify({
        schema: 'rig-review/act@2', kind: 'signoff', jobId: transport.jobId, actId, askId: 'synthetic-ask', publicationId: 'synthetic-publication',
        at: actAt, authority: { actor: 'human', channel: 'review-ui', reviewer: { id: 'synthetic-owner', role: 'owner' } },
        source: { sourceHash: '1'.repeat(64), projectHash: '2'.repeat(64), package: { id: 'synthetic-package', revision: 'one' },
          selector: null, model: null, direction: null, optionSet: null, appliedResult: null, plan: null, parts: { enumeratorVersion: '2.45.0' } },
        value: { stage: 'interview', decision: 'approved', words },
      }) };
    } });
  const file = join(w.dir, 'project.json');
  const before = readFileSync(file);
  const refusal = code(sign);
  expect({ code: refusal, unchanged: readFileSync(file).equals(before) }).toEqual({ code: 'SIGNOFF_REASK_PENDING', unchanged: true });
  expect(() => assertPlanSignoffCandidate(w.dir, load(w.dir), 'interview', testClock.now())).not.toThrow();
  expect(readFileSync(file)).toEqual(before);

  testClock.set(testClock.now() + 1_000);
  reviewAnswer(w, { set: { path: w.path, sha256: w.hash }, picks: [{ ask: 'reference', option_id: 'keep' }], at: testClock.iso() });
  expect(current(load(w.dir), 'reference').record.pending_options).toBeUndefined();
  actAt = testClock.iso();
  expect(sign().exit).toBe(0);
  const signed = obj(arr(load(w.dir).signoffs).at(-1));
  expect(signed).toMatchObject({ stage: 'interview', verbatim: words });
  expect(obj(signed.answer_hashes).reference).toBeString();
  if (route === 'review') {
    registerReask(w.dir, 'reference', 'test-reference-again', testClock.now());
    const replayRecord = readFileSync(file);
    expect(sign().exit).toBe(0);
    expect(readFileSync(file)).toEqual(replayRecord);
  }
});
test('single leaves a framing scalar unchanged; concat and merge are mechanical',()=>{
  const w=working('rig_type');const selected=JSON.parse(answer(w));expect(selected.value).toBe('character.idle');
  expect(assembleFragments('concat',[[1],[2,3]])).toEqual([1,2,3]);expect(assembleFragments('merge',[{a:1},{b:2}])).toEqual({a:1,b:2});
  expect(code(()=>assembleFragments('merge',[{a:1},{a:2}]))).toBe('INTERVIEW_CHOICE_INVALID');
  expect(code(()=>assembleFragments('arbitrary',[]))).toBe('INTERVIEW_OPTIONS_INVALID');
});
test('per-ask cardinality, recommendation, special options, applicable asks and single are closed',()=>{
  const w=working();const p=load(w.dir);const item=current(p,'motion');
  const mutations:((s:JsonObject)=>void)[]=[s=>{s.assembly={rule:'single'};},s=>{arr(s.asks).pop();},s=>{obj(arr(s.asks)[0]).id='unknown';},s=>{obj(arr(obj(arr(s.asks)[0]).options)[1]).recommended=true;},s=>{obj(arr(obj(arr(s.asks)[0]).options)[0]).reason='';},s=>{arr(obj(arr(s.asks)[0]).options).pop();},s=>{obj(arr(obj(arr(s.asks)[0]).options)[1]).id='keep';}];
  for(const mutate of mutations){const s=structuredClone(w.set);mutate(s);expect(code(()=>validateSet(p,item,s))).toBe('INTERVIEW_OPTIONS_INVALID');}
});
test('#699 option id format refuses with INTERVIEW_OPTION_ID_INVALID and missing fields name only missing fields',()=>{
  const w=working('reference');const p=load(w.dir);const item=current(p,'reference');const before=readFileSync(join(w.dir,'project.json'));
  const badId=structuredClone(w.set);obj(arr(obj(arr(badId.asks)[0]).options)[1]).id='3.3s';
  expect(()=>validateSet(p,item,badId)).toThrow(expect.objectContaining({
    code:'INTERVIEW_OPTION_ID_INVALID',
    message:'options[1].id ("3.3s") must match /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/',
  }));
  const badIdPath=join(w.dir,'evidence/interview/bad-id.json');writeFileSync(badIdPath,JSON.stringify(badId,null,2)+'\n');
  expect(()=>interviewOptionsCommand(['reference',w.dir,'--file','evidence/interview/bad-id.json'])).toThrow(expect.objectContaining({
    code:'INTERVIEW_OPTION_ID_INVALID',
    message:expect.stringContaining('options[1].id ("3.3s") must match /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/'),
  }));
  expect(readFileSync(join(w.dir,'project.json'))).toEqual(before);

  const missingRecommended=structuredClone(w.set);delete obj(arr(obj(arr(missingRecommended.asks)[0]).options)[0]).recommended;
  expect(()=>validateSet(p,item,missingRecommended)).toThrow(expect.objectContaining({
    code:'INTERVIEW_OPTIONS_INVALID',
    message:'options[0] needs explicit recommended boolean',
  }));
  const missingTwo=structuredClone(w.set);delete obj(arr(obj(arr(missingTwo.asks)[0]).options)[1]).id;obj(arr(obj(arr(missingTwo.asks)[0]).options)[1]).label='   ';
  expect(()=>validateSet(p,item,missingTwo)).toThrow(expect.objectContaining({
    code:'INTERVIEW_OPTIONS_INVALID',
    message:'options[1] needs id, label',
  }));

  const valid4s=structuredClone(w.set);valid4s.id='test-reference-4s';valid4s.drafted_at=new Date(sourceDraftAt+2_000).toISOString();
  obj(arr(obj(arr(valid4s.asks)[0]).options)[1]).id='4s';
  expect(code(()=>validateSet(p,item,valid4s))).toBe('NO_REFUSAL');
  const validPath='evidence/interview/test-reference-4s.json';const validBytes=JSON.stringify(valid4s,null,2)+'\n';
  writeFileSync(join(w.dir,validPath),validBytes);testClock.set(sourceDraftAt+3_000);
  expect(code(()=>interviewOptionsCommand(['reference',w.dir,'--file',validPath]))).toBe('NO_REFUSAL');
  const picked=JSON.parse(interviewAnswerCommand(['reference',w.dir,'--set',validPath,'--sha256',sha256(Buffer.from(validBytes)),'--by','user','--pick','reference=4s']));
  expect(obj(arr(obj(picked.choice).picks)[0]).option_id).toBe('4s');
  expect(checkProject(w.dir).refusals).toEqual([]);
});
test('missing/duplicate picks and unknown options refuse without changing project bytes',()=>{
  const w=working();const before=readFileSync(join(w.dir,'project.json'));
  expect(code(()=>answer(w,['tracks=keep']))).toBe('INTERVIEW_CHOICE_INVALID');
  expect(code(()=>answer(w,arr(w.set.asks).map(a=>`${String(obj(a).id)}=bad`)))).toBe('INTERVIEW_CHOICE_INVALID');
  expect(code(()=>answer(w,['tracks=keep','tracks=keep']))).toBe('INTERVIEW_OPTIONS_USAGE');expect(readFileSync(join(w.dir,'project.json'))).toEqual(before);
});
test('job picks round trip equals flags byte for byte, including exact Unicode note',()=>{
  const a=working('reference'),b=working('reference');const note='끝 줄\n e\u0301  \n';writeFileSync(join(a.dir,'note.txt'),note);
  const at=new Date(testClock.now()).toISOString();const payload={schema:'rig-review/interview-picks@1',set:{path:b.path,sha256:b.hash},picks:[{ask:'reference',option_id:'keep'}],note,by:'user',at};
  const left=interviewAnswerCommand(['reference',a.dir,'--set',a.path,'--sha256',a.hash,'--by','user','--pick','reference=keep','--note-file',join(a.dir,'note.txt')]);
  const right=reviewAnswer(b,payload);
  expect(right).toBe(left);expect(obj(JSON.parse(right)).verbatim).toBe(String(obj(arr(obj(arr(b.set.asks)[0]).options)[0]).label)+'\n'+String(obj(arr(obj(arr(b.set.asks)[0]).options)[0]).effect)+'\n'+note);
});
test('removed picks file route refuses without changing project bytes',()=>{
  const w=working('reference');const before=readFileSync(join(w.dir,'project.json'));
  for(const flags of [['--picks-file','missing.json'],['--picks-file','missing.json','--pick','reference=keep']]) {
    expect(code(()=>interviewAnswerCommand(['reference',w.dir,...flags]))).toBe('INTERVIEW_PICKS_FILE_REMOVED');
    expect(readFileSync(join(w.dir,'project.json'))).toEqual(before);
  }
});
test('stale, invalid, duplicate and conflicting job selections refuse byte-identically',()=>{
  const w=working('reference');bindReview(w);
  const payload:JsonObject={set:{path:w.path,sha256:w.hash},picks:[{ask:'reference',option_id:'keep'}],at:new Date(testClock.now()).toISOString()};
  const cases:[string,(p:JsonObject)=>void][]=[
    ['INTERVIEW_OPTIONS_STALE',p=>{obj(p.set).sha256='0'.repeat(64);}],
    ['INTERVIEW_CHOICE_INVALID',p=>{obj(arr(p.picks)[0]).option_id='missing';}],
    ['REVIEW_ACT_INVALID',p=>{arr(p.picks).push(structuredClone(arr(p.picks)[0]));}],
    ['REVIEW_ACT_INVALID',p=>{p.at='2099-01-01T00:00:00Z';}],
  ];
  for(const [expected,mutate] of cases){
    const value=structuredClone(payload);mutate(value);const before=readFileSync(join(w.dir,'project.json'));
    expect(code(()=>reviewAnswer(w,value))).toBe(expected);expect(readFileSync(join(w.dir,'project.json'))).toEqual(before);
  }
  const before=readFileSync(join(w.dir,'project.json'));
  expect(code(()=>reviewAnswer(w,payload,['--pick','reference=keep']))).toBe('INTERVIEW_OPTIONS_USAGE');
  expect(readFileSync(join(w.dir,'project.json'))).toEqual(before);
});
test('job receipt binds API bytes and supports identical replay',()=>{
  const w=working('reference');const payload:JsonObject={set:{path:w.path,sha256:w.hash},picks:[{ask:'reference',option_id:'keep'}],at:new Date(testClock.now()).toISOString()};
  const answer=reviewAnswer(w,payload);const before=readFileSync(join(w.dir,'project.json'));
  const receipt=obj(arr(load(w.dir).review_acts).find(entry=>obj(entry).kind==='interview-picks'));expect(receipt.sha256).toBe(sha256(Buffer.from(String(receipt.bytes))));
  expect(reviewActFindings(load(w.dir))).toEqual([]);
  const changed=load(w.dir);obj(arr(changed.review_acts).find(entry=>obj(entry).kind==='interview-picks')).question='missing';
  expect(reviewActFindings(changed).map(f=>f.code)).toEqual(['REVIEW_ACT_LEDGER_INVALID']);
  expect(reviewAnswer(w,payload)).toBe(answer);expect(readFileSync(join(w.dir,'project.json'))).toEqual(before);
  payload.note='changed';expect(code(()=>reviewAnswer(w,payload))).toBe('REVIEW_ACT_REPLAY_CONFLICT');
  expect(readFileSync(join(w.dir,'project.json'))).toEqual(before);
});
test('interview transport consumes the JSON job API response through its fetch adapter',async()=>{
  const w=working('reference');const payload:JsonObject={set:{path:w.path,sha256:w.hash},picks:[{ask:'reference',option_id:'keep'}],at:new Date(testClock.now()).toISOString()};
  reviewAnswer(w,payload);const receipt=obj(arr(load(w.dir).review_acts).find(entry=>obj(entry).kind==='interview-picks'));const act=JSON.parse(String(receipt.bytes));
  const calls:string[]=[];
  const adapter=(async(input: string | URL | Request, init?:RequestInit)=>{
    calls.push(String(input));const request=JSON.parse(String(init?.body));
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer synthetic-read-grant');
    expect(new Headers(init?.headers).get('accept')).toBe('application/json');
    expect(request.verb).toBe('fetch-act');expect(request.actId).toBe(act.actId);
    return Response.json({schema:'rig-review/job-api@2',verb:'fetch-act',ok:true,jobId:act.jobId,requestId:request.requestId,value:act});
  }) as typeof fetch;
  const result=await fetchReviewAct({origin:'http://127.0.0.1:43123',jobId:act.jobId,actId:act.actId,fetchCapability:'synthetic-read-grant',kind:'interview-picks'},adapter);
  expect(result.bytes).toBe(String(receipt.bytes));expect(result.act.kind).toBe('interview-picks');expect(calls).toHaveLength(1);
  expect(code(()=>decodeReviewResponse(JSON.stringify({schema:'rig-review/job-api@2',verb:'fetch-act',ok:true,jobId:act.jobId,requestId:'wrong',value:act}),act.jobId,act.actId,'request','interview-picks'))).toBe('REVIEW_ACT_INVALID');
});
test('malformed API acts preserve the interview record',()=>{
  const w=working('reference');bindReview(w);
  const payload:JsonObject={set:{path:w.path,sha256:w.hash},picks:[{ask:'reference',option_id:'keep'}],at:new Date(testClock.now()).toISOString()};
  const cases:[string,(act:JsonObject)=>void][]=[
    ['REVIEW_ACT_INVALID',act=>{act.jobId='other-job';}],
    ['REVIEW_ACT_INVALID',act=>{obj(act.value).questionId='other-question';}],
    ['REVIEW_ACT_KIND_MISMATCH',act=>{act.kind='parts-verdict';}],
    ['REVIEW_ACT_INVALID',act=>{obj(act.authority).channel='agent';}],
    ['REVIEW_ACT_INVALID',act=>{obj(act.value).note=null;}],
    ['INTERVIEW_OPTIONS_STALE',act=>{obj(obj(act.source).optionSet).id='other-set';}],
  ];
  for(const [expected,edit] of cases){
    const before=readFileSync(join(w.dir,'project.json'));expect(code(()=>reviewAnswer(w,payload,[],edit))).toBe(expected);
    expect(readFileSync(join(w.dir,'project.json'))).toEqual(before);
  }
});
test('interview ledger validates optional intake answers through the same branch',()=>{
  const w=working('reference');const payload:JsonObject={set:{path:w.path,sha256:w.hash},picks:[{ask:'reference',option_id:'keep'}],at:new Date(testClock.now()).toISOString()};
  const answer=JSON.parse(reviewAnswer(w,payload));const project=load(w.dir);
  const receipt=obj(arr(project.review_acts).find(entry=>obj(entry).kind==='interview-picks'));const act=JSON.parse(String(receipt.bytes));
  act.value.questionId='intake_suitability';receipt.question='intake_suitability';
  receipt.bytes=JSON.stringify(act);receipt.sha256=sha256(Buffer.from(String(receipt.bytes)));
  project.intake={choice:{answer}};expect(reviewActFindings(project)).toEqual([]);
  obj(obj(project.intake).choice).answer=null;
  expect(reviewActFindings(project).map(f=>f.code)).toEqual(['REVIEW_ACT_LEDGER_INVALID']);
});
test('job selections preserve Other text and delegate authority and replay history',()=>{
  const w=working('reference');const words='  Exact Other words\n끝  ';
  const payload:JsonObject={set:{path:w.path,sha256:w.hash},picks:[{ask:'reference',option_id:'other',other_text:words}],note:'  note\n',at:new Date(testClock.now()).toISOString()};
  const delegate=(act:JsonObject):void=>{obj(obj(act.authority).reviewer).role='delegate';};
  const first=reviewAnswer(w,payload,[],delegate);const selected=JSON.parse(first);
  expect(selected.by).toBe('delegate');expect(selected.choice.picks[0].other_text).toBe(words);expect(selected.choice.note).toBe(payload.note);
  interviewOptionsCommand(['reference',w.dir,'--file',w.path]);answer(w,['reference=keep']);
  const before=readFileSync(join(w.dir,'project.json'));expect(reviewAnswer(w,payload,[],delegate)).toBe(first);
  expect(readFileSync(join(w.dir,'project.json'))).toEqual(before);expect(reviewActFindings(load(w.dir))).toEqual([]);
});
test('merged ledger records picks after a parts CLI receipt and runs the picks branch',()=>{
  const w=working('reference');const root=realpathSync(w.dir);
  const draft=obj(arr(load(root).drafts)[0]);const parts=obj(draft.parts);
  const value={schema:'rig-review-parts-verdict/2',tool:{name:'@rig-c/review',version:'2.5.0'},
    source:{sha256:'a'.repeat(64),files:arr(parts.files).map(raw=>({sha256:obj(raw).sha256,path:'opaque/frame'}))},
    status:'approved',parts:{'synthetic part':{outcome:'clean',note:''}}};
  const recorded=partsReviewCommand([root,'--draft',String(draft.id),'--from-review-cli','--by','user','--json','--','opaque/input','--verdict','never-created.json'],testClock.now(),{
    runCli:reviewStdout(JSON.stringify(value)),
  });
  expect(recorded.exit).toBe(0);expect(obj(arr(load(root).review_acts)[0]).schema).toBe(PARTS_CLI_RECEIPT);
  expect(partsReadFindings(root,load(root))).toEqual([]);
  const payload:JsonObject={set:{path:w.path,sha256:w.hash},picks:[{ask:'reference',option_id:'keep'}],at:new Date(testClock.now()).toISOString()};
  reviewAnswer(w,payload);const project=load(root);
  expect(arr(project.review_acts)).toHaveLength(3);expect(reviewActFindings(project)).toEqual([]);
  expect(partsReadFindings(root,project)).toEqual([]);
  obj(arr(project.review_acts).find(entry=>obj(entry).kind==='interview-picks')).question='missing';
  const findings=reviewActFindings(project);
  expect(findings.map(f=>f.code)).toEqual(['REVIEW_ACT_LEDGER_INVALID']);
  expect(findings[0].path).toBe('review_acts[2]');expect(findings[0].message).toContain('recorded interview answer differs');
});

test('Other with multiline Unicode and explicit fragment preserves text; unresolved Other is pending until a fresh explicit pick',()=>{
  const w=working('reference');const words='첫 줄\nSecond line  \ne\u0301';writeFileSync(join(w.dir,'other.txt'),words);writeFileSync(join(w.dir,'fragment.json'),JSON.stringify('custom'));
  const other=JSON.parse(interviewAnswerCommand(['reference',w.dir,'--set',w.path,'--sha256',w.hash,'--by','user','--pick','reference=other','--other',`reference=${join(w.dir,'other.txt')}`]));
  expect(other.value).toBeNull();expect(other.asks).toEqual([{id:'reference',state:'other-pending'}]);expect(other.choice.picks[0].other_text).toBe(words);
  const before=readFileSync(join(w.dir,'project.json'));testClock.set(sourceDraftAt+30_000);const snapshot=readFileSync(join(w.dir,'project.json'));writeFileSync(join(w.dir,'yes.txt'),'Approve');
  expect(code(()=>signoffCommand(['interview',w.dir,'--by','user','--verbatim-file',join(w.dir,'yes.txt')]))).toBe('INTERVIEW_CHOICE_REQUIRED');expect(readFileSync(join(w.dir,'project.json'))).toEqual(snapshot);
  // A new tailored option preserves the pending record as history; its date is not rewritten.
  const next=structuredClone(w.set);next.id='resolved-reference';next.drafted_at=new Date(sourceDraftAt+2_000).toISOString();obj(arr(obj(arr(next.asks)[0]).options)[0]).label=words;obj(arr(obj(arr(next.asks)[0]).options)[0]).fragment='custom';obj(arr(obj(arr(next.asks)[0]).options)[0]).effect=`As answered on ${String(other.at)} in review questionnaire`;
  const path='evidence/interview/resolved-reference.json';const bytes=JSON.stringify(next);writeFileSync(join(w.dir,path),bytes);testClock.set(sourceDraftAt+3_000);interviewOptionsCommand(['reference',w.dir,'--file',path]);
  const resolved=JSON.parse(interviewAnswerCommand(['reference',w.dir,'--set',path,'--sha256',sha256(Buffer.from(bytes)),'--by','user','--pick','reference=keep']));expect(resolved.value).toBe('custom');expect(arr(current(load(w.dir),'reference').record.history)).toContainEqual(other);expect(before.length).toBeGreaterThan(0);
});
test('mixed auto needs exact ordered fragments/covers and blocks approval until decided',()=>{
  const w=working('meshes');const selected=JSON.parse(answer(w,['bend=keep','rigid=keep','density=auto']));expect(selected.delegated).toBe(false);expect(selected.agent_decision).toEqual({covers:'density'});
  // Review the step against the recorded pick before isolating the unresolved delegation gate.
  expect(planCommand(['revise', 'meshes', w.dir, '--by', 'agent',
    '--reason', 'The mesh definition still covers the recorded choices and pending density decision.']).exit).toBe(0);
  writeFileSync(join(w.dir,'yes.txt'),'Approve');const before=readFileSync(join(w.dir,'project.json'));
  expect(code(()=>signoffCommand(['rigging-interview',w.dir,'--by','user','--verbatim-file',join(w.dir,'yes.txt')]))).toBe('DELEGATION_UNDECIDED');expect(readFileSync(join(w.dir,'project.json'))).toEqual(before);
  writeFileSync(join(w.dir,'density.json'),JSON.stringify({density:'synthetic density on the approved parts'}));writeFileSync(join(w.dir,'reason.txt'),'Use the offered density.');
  const decision=JSON.parse(interviewDecisionCommand(['meshes',w.dir,'--by','agent','--reasoning-file',join(w.dir,'reason.txt'),'--fragment',`density=${join(w.dir,'density.json')}`]));expect(decision.covers).toBe('density');expect(decision.fragments).toEqual([{ask:'density',fragment:{density:'synthetic density on the approved parts'}}]);
  expect(checkProject(w.dir).refusals).toEqual([]);
});
test('constraint tuples check ordinary, Other and landed auto contributions without silent adjustment',()=>{
  const w=working('assemble');const bad=['projection=keep','ground=alternative',...arr(w.set.asks).slice(2).map(a=>`${String(obj(a).id)}=keep`)];const before=readFileSync(join(w.dir,'project.json'));
  expect(code(()=>answer(w,bad))).toBe('INTERVIEW_CHOICE_CONSTRAINT');expect(readFileSync(join(w.dir,'project.json'))).toEqual(before);
  answer(w,['projection=alternative','ground=alternative',...bad.slice(2)]);expect(obj(obj(current(load(w.dir),'assemble').raw).value).ground).toBe('busy');
  const choice:JsonObject={spec:CHOICE_SPEC,set:{path:w.path,sha256:w.hash},picks:arr(w.set.asks).map(a=>({ask:obj(a).id as Json,option_id:obj(a).id==='ground'?'other':'keep',shown:{label:'',effect:''}}))};
  const fragments=new Map<string,Json>([['projection',{project:'core'}],['ground',{ground:'novel'}]]);
  expect(code(()=>checkChoiceConstraints(w.set,choice,fragments))).toBe('INTERVIEW_CHOICE_CONSTRAINT');
});
test('retained bytes, shown text, value, coverage and note tampering are named refusals',()=>{
  const edits:((a:JsonObject)=>void)[]=[a=>{a.value={wrong:true};},a=>{obj(obj(arr(obj(a.choice).picks)[0]).shown).label='changed';},a=>{a.verbatim='paraphrase';},a=>{a.asks=[];},a=>{obj(a.choice).note='not in verbatim';}];
  for(const edit of edits){const w=working('reference');answer(w);const p=load(w.dir);edit(obj(current(p,'reference').raw));save(w.dir,p);expect(checkProject(w.dir).refusals.map(f=>f.code)).toContain('INTERVIEW_CHOICE_INVALID');}
  const w=working('reference');answer(w);writeFileSync(join(w.dir,w.path),JSON.stringify(w.set));expect(checkProject(w.dir).refusals.map(f=>f.code)).toContain('INTERVIEW_OPTIONS_FILE');
});
test('changed context bytes, reopened context and unavailable viewed draft refuse a new selection',()=>{
  const w=working();const before=readFileSync(join(w.dir,'project.json'));const parts=obj(obj(w.set.context).parts);const image=obj(arr(parts.files).find(f=>String(obj(f).path).endsWith('.png')));writeFileSync(join(w.dir,String(image.path)),'changed');
  expect(code(()=>answer(w))).toBe('INTERVIEW_OPTIONS_STALE');expect(readFileSync(join(w.dir,'project.json'))).toEqual(before);
  const missing=working();rmSync(join(missing.dir,'derived/drafts'),{recursive:true});expect(code(()=>answer(missing))).toBe('INTERVIEW_OPTIONS_STALE');
});
test('future-dated unadopted answers stay legacy; explicit adoption preserves answer bytes',()=>{
  const dir=fixture(p=>{obj(obj(p.interview).order).spec='rig-create/stage-order@1';delete obj(obj(p.interview).order).choices_adopted_at;framing(p,'reference').answer={delegated:false,by:'user',at:'2026-11-22T00:00:00Z',verbatim:'None.',value:'none',source:'chat'};},'example-project.json');
  const before=JSON.stringify(current(load(dir),'reference').raw);testClock.set(new Date('2026-12-01T00:00:00Z'));interviewOptionsCommand(['--adopt',dir]);
  expect(obj(obj(load(dir).interview).order).spec).toBe(CHOICE_ORDER_SPEC);expect(JSON.stringify(current(load(dir),'reference').raw)).toBe(before);resignAfterChange(dir);expect(checkProject(dir).refusals).toEqual([]);expect(checkProject(dir).warnings.map(f=>f.code)).toContain('CHOICE_ANSWERS_LEGACY');
});

test('constrained auto validates its own landed fragment before approval and refuses novel values byte-identically',()=>{
  const w=working('assemble');const picks=arr(w.set.asks).map(a=>`${String(obj(a).id)}=${obj(a).id==='projection'?'auto':'keep'}`);answer(w,picks);
  writeFileSync(join(w.dir,'reason.txt'),'Use the offered projection.');writeFileSync(join(w.dir,'projection.json'),JSON.stringify({project:'novel'}));const before=readFileSync(join(w.dir,'project.json'));
  const decide=()=>interviewDecisionCommand(['assemble',w.dir,'--by','agent','--reasoning-file',join(w.dir,'reason.txt'),'--fragment',`projection=${join(w.dir,'projection.json')}`]);
  expect(code(decide)).toBe('INTERVIEW_CHOICE_CONSTRAINT');expect(readFileSync(join(w.dir,'project.json'))).toEqual(before);
  writeFileSync(join(w.dir,'projection.json'),JSON.stringify({project:'core'}));expect(JSON.parse(decide()).value).toEqual({project:'core'});expect(checkProject(w.dir).refusals).toEqual([]);
});

test('landed constrained Other is checked even when another constrained ask is still auto',()=>{
  const w=working('assemble');const choice:JsonObject={spec:CHOICE_SPEC,picks:arr(w.set.asks).map(a=>({ask:obj(a).id as Json,option_id:obj(a).id==='projection'?'auto':obj(a).id==='ground'?'other':'keep',shown:{label:'',effect:''}}))};
  expect(code(()=>checkChoiceConstraints(w.set,choice,new Map([['ground',{ground:'novel'}]])))).toBe('INTERVIEW_CHOICE_CONSTRAINT');
  rewriteSet(w,s=>{const options=arr(obj(arr(s.asks)[1]).options);obj(options[1]).fragment={ground:'plain'};});
  expect(code(()=>checkChoiceConstraints(w.set,choice,new Map([['ground',{ground:'plain'}]])))).toBe('INTERVIEW_CHOICE_CONSTRAINT');
});
test('a later reopen preserves the historical choice but refuses selecting its stale set again',()=>{
  const w=working();answer(w);testClock.set(riggingDraftAt+2_000);writeFileSync(join(w.dir,'words.txt'),'Review parts again.');
  plantLegacyReopen(w.dir, 'parts', { by: 'user', wordsFile: join(w.dir,'words.txt') });expect(checkProject(w.dir).refusals).toEqual([]);
  const before=readFileSync(join(w.dir,'project.json'));expect(code(()=>interviewOptionsCommand(['motion',w.dir,'--file',w.path]))).toBe('INTERVIEW_OPTIONS_STALE');expect(readFileSync(join(w.dir,'project.json'))).toEqual(before);
});

test('later append-only source declarations keep historical selections readable and stale a new writer',()=>{
  const w=working('reference');answer(w);const p=load(w.dir);const bytes='later immutable input';writeFileSync(join(w.dir,'inputs/later.txt'),bytes);arr(p.inputs).push({path:'inputs/later.txt',sha256:sha256(Buffer.from(bytes)),origin:'synthetic later source'});save(w.dir,p);
  expect(checkProject(w.dir).refusals).toEqual([]);const before=readFileSync(join(w.dir,'project.json'));expect(code(()=>interviewOptionsCommand(['reference',w.dir,'--file',w.path]))).toBe('INTERVIEW_OPTIONS_STALE');expect(readFileSync(join(w.dir,'project.json'))).toEqual(before);
});

test('Other with an explicit fragment uses the normal value and coverage validators',()=>{
  const w=working('reference');writeFileSync(join(w.dir,'other.txt'),'별도 참조\n');writeFileSync(join(w.dir,'fragment.json'),JSON.stringify('custom'));
  const selected=JSON.parse(interviewAnswerCommand(['reference',w.dir,'--set',w.path,'--sha256',w.hash,'--by','user','--pick','reference=other','--other',`reference=${join(w.dir,'other.txt')}`,'--other-fragment',`reference=${join(w.dir,'fragment.json')}`]));expect(selected.value).toBe('custom');expect(selected.asks).toEqual([{id:'reference',state:'user'}]);expect(selected.choice.picks[0].other_text).toBe('별도 참조\n');
});

test('multiple auto asks retain per-ask fragments and concatenate in set order',()=>{
  const w=working();rewriteSet(w,s=>{s.assembly={rule:'concat'};for(const a of arr(s.asks).map(obj))for(const o of arr(a.options).map(obj))if(o.kind==='value')o.fragment=[{ask:a.id as Json,variant:o.id as Json}];});
  const chosen=JSON.parse(answer(w,arr(w.set.asks).map(a=>`${String(obj(a).id)}=auto`)));expect(chosen.delegated).toBe(true);expect('value'in chosen).toBe(false);
  const flags:string[]=[];const expected:Json[]=[];for(const a of arr(w.set.asks).map(obj)){const fragment=[{ask:a.id as Json,variant:'keep'}];const path=join(w.dir,`fragment-${String(a.id)}.json`);writeFileSync(path,JSON.stringify(fragment));flags.push('--fragment',`${String(a.id)}=${path}`);expected.push(...fragment);}
  writeFileSync(join(w.dir,'reason.txt'),'Use the offered contributions.');const decision=JSON.parse(interviewDecisionCommand(['motion',w.dir,'--by','agent','--reasoning-file',join(w.dir,'reason.txt'),...flags]));expect(decision.value).toEqual(expected);expect(decision.covers).toBe(arr(w.set.asks).map(a=>obj(a).id).join(','));
  expect(planCommand(['revise', 'motion', w.dir, '--by', 'agent',
    '--reason', 'The motion definition still fits the recorded delegation and assembled contributions.']).exit).toBe(0);
  expect(checkProject(w.dir).refusals).toEqual([]);
});
test('a mixed decision cannot overwrite a user fragment through merge',()=>{
  const w=working('meshes');answer(w,['bend=keep','rigid=keep','density=auto']);writeFileSync(join(w.dir,'density.json'),JSON.stringify({bend:'overwrite'}));writeFileSync(join(w.dir,'reason.txt'),'This is a planted collision.');const before=readFileSync(join(w.dir,'project.json'));
  expect(code(()=>interviewDecisionCommand(['meshes',w.dir,'--by','agent','--reasoning-file',join(w.dir,'reason.txt'),'--fragment',`density=${join(w.dir,'density.json')}`]))).toBe('INTERVIEW_CHOICE_INVALID');expect(readFileSync(join(w.dir,'project.json'))).toEqual(before);
});

import { generateExampleChoices } from '../scripts/generate-example-choices.ts';
import { tempDir, ownerChatArgs } from './helpers.ts';
import { advanceCommand, checkProject, interviewAnswerCommand, interviewOptionsCommand, interviewDecisionCommand, interviewCommand, planCommand, signoffCommand, testClock } from './clock.ts';
test('the public-writer consumer fixture and raw option files reproduce exactly',()=>{
  const outputs=generateExampleChoices(join(tempDir(),'choice-generation'));
  for(const[path,bytes]of Object.entries(outputs))expect(readFileSync(join(import.meta.dir,'../templates',path),'utf8')).toBe(bytes);
  const entry=JSON.parse(outputs['example-interview-choice.json'] as string);expect(entry.scenarios.find((s:{name:string})=>s.name==='constraint').refused).toBe('INTERVIEW_CHOICE_CONSTRAINT');expect(entry.scenarios.find((s:{name:string})=>s.name==='other-pending-picks-file').approval_refusal).toBe('INTERVIEW_CHOICE_REQUIRED');expect(entry.scenarios.find((s:{name:string})=>s.name==='fullscreen-gates').refusals.length).toBeGreaterThan(0);expect(entry.scenarios.find((s:{name:string})=>s.name==='character-gates').cg_refusals).toEqual([]);
}, 30_000);

test('member-local choices preserve the inherited words and never write the parent collection',()=>{
  const w=working('reference');const root=tempDir();const members=join(root,'members');mkdirSync(members);const member=join(members,'example');renameSync(w.dir,member);w.dir=member;
  const prior={delegated:false,by:'user',at:'2026-11-09T00:00:00Z',verbatim:'A previous reference decision.',value:'none',source:'collection interview'};
  const parent={schema:'rig-create/collection@0',name:'synthetic',interview:{framing:[{id:'reference',answer:prior,history:[]}]}};const parentFile=join(root,'collection.json');writeFileSync(parentFile,JSON.stringify(parent));const before=readFileSync(parentFile);
  const p=load(member);framing(p,'reference').answer={basis:'inherited',from:{collection:'synthetic',question:'reference'},by:'rig-create',at:'2026-11-10T14:00:00Z'};save(member,p);
  const why='This member needs a separate reference.  \ne\u0301\n';const reason=join(member,'why.txt');writeFileSync(reason,why);
  const selected=JSON.parse(interviewAnswerCommand(['reference',member,'--set',w.path,'--sha256',w.hash,'--by','user','--pick','reference=keep','--why-file',reason]));
  expect(selected.basis).toBe('overridden');expect(selected.overrides).toEqual({collection:'synthetic',question:'reference',collection_answer_at:prior.at});expect(selected.why_verbatim).toBe(why);
  expect(arr(framing(load(member),'reference').history)).toContainEqual(prior);expect(readFileSync(parentFile)).toEqual(before);expect(checkProject(member).refusals).toEqual([]);
});

test('pending Other is legal for rig_type and a projection-bearing guide until question approval',()=>{
  for(const question of ['rig_type','assemble']){
    const w=working(question);writeFileSync(join(w.dir,'words.txt'),'A different choice.');const ask=question==='assemble'?'cut':'rig_type';
    const flags=arr(w.set.asks).flatMap(a=>['--pick',`${String(obj(a).id)}=${obj(a).id===ask?'other':'keep'}`]);
    const selected=JSON.parse(interviewAnswerCommand([question,w.dir,'--set',w.path,'--sha256',w.hash,'--by','user',...flags,'--other',`${ask}=${join(w.dir,'words.txt')}`]));expect(selected.value).toBeNull();expect(checkProject(w.dir).refusals).toEqual([]);
    testClock.set(sourceDraftAt+30_000);const before=readFileSync(join(w.dir,'project.json'));expect(code(()=>signoffCommand(['interview',w.dir,'--by','user','--verbatim-file',join(w.dir,'words.txt')]))).toBe('INTERVIEW_CHOICE_REQUIRED');expect(readFileSync(join(w.dir,'project.json'))).toEqual(before);
  }
});

test('an inherited game-logic rig_type chooses state asks instead of character tracks',()=>{
  const w=working();const root=tempDir();mkdirSync(join(root,'members'));const member=join(root,'members','example');renameSync(w.dir,member);w.dir=member;
  const p=load(member);framing(p,'rig_type').answer={basis:'inherited',from:{collection:'synthetic',question:'rig_type'},by:'rig-create',at:'2026-11-10T00:00:00Z'};save(member,p);
  const collection:JsonObject={name:'synthetic',interview:{framing:[{id:'rig_type',answer:{delegated:false,by:'user',at:'2026-11-09T00:00:00Z',verbatim:'Game states.',value:'fullscreen.game_logic'}}]}};writeFileSync(join(root,'collection.json'),JSON.stringify(collection));
  const item=current(p,'motion');expect(code(()=>validateSet(p,item,w.set,collection))).toBe('INTERVIEW_OPTIONS_INVALID');
  const asks=arr(w.set.asks).map(obj);const tracks=asks[0]!;tracks.id='states';const transitions=structuredClone(tracks);transitions.id='transitions';w.set.asks=[tracks,transitions,...asks.filter(a=>!['states','blink'].includes(String(a.id)))];
  expect(code(()=>validateSet(p,item,w.set,collection))).toBe('NO_REFUSAL');
});

test.each(['plain','busy'])('visible config accepts pending auto ground, blocks approval, and validates landed %s or missing ground',ground=>{
  const w=working('assemble');rewriteSet(w,s=>{delete s.constraints;});
  expect(checkProject(w.dir).refusals).toEqual([]);
  const picks=arr(w.set.asks).map(a=>`${String(obj(a).id)}=${obj(a).id==='projection'?'alternative':obj(a).id==='ground'?'auto':'keep'}`);
  const selected=JSON.parse(answer(w,picks));expect(selected.asks).toContainEqual({id:'ground',state:'delegated'});
  writeFileSync(join(w.dir,'config.json'),JSON.stringify({assemble:{project:'visible',ground}}));
  expect(checkProject(w.dir).refusals).toEqual([]);
  writeFileSync(join(w.dir,'words.txt'),'Approve this direction.');testClock.set(sourceDraftAt+30_000);
  signoffCommand(['interview',w.dir,'--by','user','--verbatim-file',join(w.dir,'words.txt')]);
  expect(checkProject(w.dir).refusals).toEqual([]);
  advanceCommand(['plan-approved',w.dir]);
  const beforeApproval=readFileSync(join(w.dir,'project.json'));
  expect(code(()=>signoffCommand(['plan-approved',w.dir,'--by','user','--verbatim-file',join(w.dir,'words.txt')]))).toBe('DELEGATION_UNDECIDED');
  expect(readFileSync(join(w.dir,'project.json'))).toEqual(beforeApproval);
  writeFileSync(join(w.dir,'reason.txt'),'Use the explicitly selected ground decision.');
  const fragment=join(w.dir,'ground-fragment.json');writeFileSync(fragment,JSON.stringify({unrelated:'no ground value'}));
  const decide=()=>interviewDecisionCommand(['assemble',w.dir,'--by','agent','--reasoning-file',join(w.dir,'reason.txt'),'--fragment',`ground=${fragment}`]);
  expect(code(decide)).toBe('ASSEMBLE_GROUND_UNANSWERED');expect(readFileSync(join(w.dir,'project.json'))).toEqual(beforeApproval);
  writeFileSync(fragment,JSON.stringify({ground}));expect(JSON.parse(decide()).value).toEqual({ground});expect(checkProject(w.dir).refusals).toEqual([]);
  signoffCommand(['plan-approved',w.dir,'--by','user','--verbatim-file',join(w.dir,'words.txt')]);
  expect(checkProject(w.dir).refusals).toEqual([]);
  advanceCommand(['parts',w.dir]);
  expect(checkProject(w.dir).refusals).toEqual([]);
});

function inheritedWorking(): ReturnType<typeof working> & {parentFile:string; parent:JsonObject; why:string; reason:string} {
  const w=working('reference'); const root=tempDir(); mkdirSync(join(root,'members')); const member=join(root,'members/example');renameSync(w.dir,member);w.dir=member;
  const source={delegated:false,by:'user',at:'2026-11-09T00:00:00Z',verbatim:'A collection reference.',value:'none',source:'collection interview'};
  const parent:JsonObject={schema:'rig-create/collection@0',name:'synthetic',interview:{framing:[{id:'reference',answer:source,history:[]}]}};
  const parentFile=join(root,'collection.json');writeFileSync(parentFile,JSON.stringify(parent));
  const p=load(member);framing(p,'reference').answer={basis:'inherited',from:{collection:'synthetic',question:'reference'},by:'interviewer',at:'2026-11-10T14:00:00Z'};save(member,p);
  const why='A separate reference for this member.  \ne\u0301\n';const reason=join(member,'why.txt');writeFileSync(reason,why);
  return {...w,parentFile,parent,why,reason};
}
function overrideAnswer(w:ReturnType<typeof inheritedWorking>, extra:string[]=[]):string {
  return interviewAnswerCommand(['reference',w.dir,'--set',w.path,'--sha256',w.hash,'--by','user','--pick','reference=keep',...extra]);
}
test('OVERRIDE_REASON_MISSING writer guard refuses missing/blank reasons byte-identically, never inferring a note',()=>{
  const w=inheritedWorking();const before=readFileSync(join(w.dir,'project.json'));const parent=readFileSync(w.parentFile);
  expect(code(()=>overrideAnswer(w))).toBe('OVERRIDE_REASON_MISSING');
  expect(code(()=>overrideAnswer(w,['--note-file',w.reason]))).toBe('OVERRIDE_REASON_MISSING');
  writeFileSync(w.reason,' \n\t');expect(code(()=>overrideAnswer(w,['--why-file',w.reason]))).toBe('OVERRIDE_REASON_MISSING');
  writeFileSync(w.reason,Buffer.from([0xff,0xfe]));expect(code(()=>overrideAnswer(w,['--why-file',w.reason]))).toBe('OVERRIDE_REASON_MISSING');
  expect(readFileSync(join(w.dir,'project.json'))).toEqual(before);expect(readFileSync(w.parentFile)).toEqual(parent);
});
test('override job picks and fresh replacement require exact reasons, preserve the old collection reference and check at 0/0',()=>{
  const w=inheritedWorking();const parent=readFileSync(w.parentFile);
  const payload={schema:'rig-review/interview-picks@1',set:{path:w.path,sha256:w.hash},picks:[{ask:'reference',option_id:'keep'}],by:'user',at:new Date(testClock.now()).toISOString()};
  const selected=JSON.parse(reviewAnswer(w,payload,['--why-file',w.reason]));
  expect(selected.overrides).toEqual({collection:'synthetic',question:'reference',collection_answer_at:'2026-11-09T00:00:00Z'});expect(selected.why_verbatim).toBe(w.why);
  expect(readFileSync(w.parentFile)).toEqual(parent);expect(checkProject(w.dir).refusals).toEqual([]);expect(checkProject(w.dir).warnings).toEqual([]);
  const q=obj(arr(obj(w.parent.interview).framing)[0]);q.history=[q.answer as Json];q.answer={...obj(q.answer),at:new Date(sourceDraftAt+2_000).toISOString()};writeFileSync(w.parentFile,JSON.stringify(w.parent));const changedParent=readFileSync(w.parentFile);
  testClock.set(sourceDraftAt+3_000);interviewOptionsCommand(['reference',w.dir,'--file',w.path]);
  const before=readFileSync(join(w.dir,'project.json'));expect(code(()=>overrideAnswer(w))).toBe('OVERRIDE_REASON_MISSING');expect(readFileSync(join(w.dir,'project.json'))).toEqual(before);
  writeFileSync(w.reason,'A newly stated reason.\n');const replacement=JSON.parse(overrideAnswer(w,['--why-file',w.reason]));
  expect(replacement.overrides).toEqual(selected.overrides);expect(replacement.why_verbatim).toBe('A newly stated reason.\n');expect(arr(framing(load(w.dir),'reference').history)).toContainEqual(selected);
  expect(readFileSync(w.parentFile)).toEqual(changedParent);expect(checkProject(w.dir).ok).toBe(true);expect(checkProject(w.dir).refusals).toEqual([]);expect(checkProject(w.dir).warnings).toEqual([]);
});
test('a member override can delegate and complete a decision without losing its reference or reason',()=>{
  const w=inheritedWorking();const parent=readFileSync(w.parentFile);
  const selected=JSON.parse(interviewAnswerCommand(['reference',w.dir,'--set',w.path,'--sha256',w.hash,'--by','user','--pick','reference=auto','--why-file',w.reason]));
  writeFileSync(join(w.dir,'reasoning.txt'),'Use the approved reference.');writeFileSync(join(w.dir,'fragment.json'),JSON.stringify('none'));
  interviewDecisionCommand(['reference',w.dir,'--by','agent','--reasoning-file',join(w.dir,'reasoning.txt'),'--fragment',`reference=${join(w.dir,'fragment.json')}`]);
  const current=obj(framing(load(w.dir),'reference').answer);expect(current.overrides).toEqual(selected.overrides);expect(current.why_verbatim).toBe(w.why);expect(readFileSync(w.parentFile)).toEqual(parent);expect(checkProject(w.dir).refusals).toEqual([]);expect(checkProject(w.dir).warnings).toEqual([]);
});

test('legacy override without metadata recovers its inherited history through the writer',()=>{
  const w=inheritedWorking();const p=load(w.dir);const record=framing(p,'reference');const inherited=structuredClone(obj(record.answer));
  const parentQuestion=obj(arr(obj(w.parent.interview).framing)[0]);const source=obj(parentQuestion.answer);source.at='2026-11-04T12:00:00Z';inherited.at='2026-11-04T13:00:00Z';writeFileSync(w.parentFile,JSON.stringify(w.parent));
  const legacy:JsonObject={basis:'overridden',delegated:false,by:'user',at:'2026-11-05T00:00:00Z',verbatim:'Use this member reference.',value:'none',source:'interview'};
  record.history=[inherited,structuredClone(source)];record.answer=legacy;save(w.dir,p);const parent=readFileSync(w.parentFile);
  let selected:JsonObject={};expect(code(()=>{selected=JSON.parse(overrideAnswer(w,['--why-file',w.reason]));})).toBe('NO_REFUSAL');
  expect(selected.basis).toBe('overridden');expect(selected.overrides).toEqual({collection:'synthetic',question:'reference',collection_answer_at:source.at});expect(selected.why_verbatim).toBe(w.why);
  expect(arr(framing(load(w.dir),'reference').history)).toContainEqual(legacy);expect(readFileSync(w.parentFile)).toEqual(parent);expect(checkProject(w.dir).refusals).toEqual([]);
});

for(const state of ['withdrawn','per-member'] as const)for(const input of ['flags','job'] as const){
  test(`inherited ${state} shared answer becomes own via ${input} without a reason`,()=>{
    const w=inheritedWorking();const q=obj(arr(obj(w.parent.interview).framing)[0]);const original=q.answer as Json;
    q.history=[original];q.answer=state==='withdrawn'?null:{...obj(original),value:'per-member'};writeFileSync(w.parentFile,JSON.stringify(w.parent));const parent=readFileSync(w.parentFile);
    expect(collectItems(load(w.dir),{collection:w.parent}).find(i=>i.id==='reference')!.state.state).toBe('silent');
    let selected:JsonObject={};
    if(input==='flags')expect(code(()=>{selected=JSON.parse(overrideAnswer(w));})).toBe('NO_REFUSAL');
    else{
      const payload={schema:'rig-review/interview-picks@1',set:{path:w.path,sha256:w.hash},picks:[{ask:'reference',option_id:'keep'}],by:'user',at:new Date(testClock.now()).toISOString()};
      expect(code(()=>{selected=JSON.parse(reviewAnswer(w,payload));})).toBe('NO_REFUSAL');
    }
    expect(selected.basis).toBe('own');expect(selected).not.toHaveProperty('overrides');expect(selected).not.toHaveProperty('why_verbatim');expect(readFileSync(w.parentFile)).toEqual(parent);expect(checkProject(w.dir).refusals).toEqual([]);
  });
}
for(const decided of [false,true]){
  test(`inherited shared delegation stays overridden when decided=${decided}`,()=>{
    const w=inheritedWorking();const q=obj(arr(obj(w.parent.interview).framing)[0]);
    const shared:JsonObject={delegated:true,by:'user',at:'2026-11-09T00:00:00Z',verbatim:'Choose the collection reference.',source:'collection interview'};
    if(decided)shared.agent_decision={by:'agent',at:'2026-11-09T01:00:00Z',reasoning:'Retain the collection choice.',value:'per-member'};
    q.answer=shared;writeFileSync(w.parentFile,JSON.stringify(w.parent));const parent=readFileSync(w.parentFile);const before=readFileSync(join(w.dir,'project.json'));
    expect(collectItems(load(w.dir),{collection:w.parent}).find(i=>i.id==='reference')!.state.state).toBe('delegated');
    expect(code(()=>overrideAnswer(w))).toBe('OVERRIDE_REASON_MISSING');expect(readFileSync(join(w.dir,'project.json'))).toEqual(before);
    const selected=JSON.parse(overrideAnswer(w,['--why-file',w.reason]));expect(selected.basis).toBe('overridden');expect(selected.overrides).toEqual({collection:'synthetic',question:'reference',collection_answer_at:shared.at});expect(selected.why_verbatim).toBe(w.why);expect(readFileSync(w.parentFile)).toEqual(parent);expect(checkProject(w.dir).refusals).toEqual([]);
  });
}

test.each(['rig_type','motion'])('owner chat retains exact words beside checked picks with shared images: %s', question => {
  const w=working(question);const words='  Keep the shown choice.\r\n';const file=join(w.dir,'owner.txt');writeFileSync(file,words);
  const said=new Date(testClock.now()-500).toISOString();
  const args=[question,w.dir,'--set',w.path,'--sha256',w.hash,'--by','user',
    ...arr(w.set.asks).flatMap(a=>['--pick',`${String(obj(a).id)}=keep`]),
    '--owner-chat',file,'--said-at',said,'--relayed-by','operator'];
  const record=JSON.parse(rawInterviewAnswer(args,testClock.now()));
  expect(record.owner_words).toBe(words);expect(record.said_at).toBe(said);expect(record.relayed_by).toBe('operator');
  expect(record.at).toBe(new Date(testClock.now()).toISOString());expect(record.at).not.toBe(said);
  expect(record.verbatim).not.toBe(words);expect(record.source).toBe('owner chat, relayed');
  expect(record.actId).toBeUndefined();expect(record.act_id).toBeUndefined();
  expect(current(load(w.dir),question).raw).toEqual(record);
});

test.each(['','  \r\n'])('blank owner words refuse atomically: %j', words => {
  const w=working('rig_type');const file=join(w.dir,'owner.txt');writeFileSync(file,words);
  const before=readFileSync(join(w.dir,'project.json'));
  expect(code(()=>rawInterviewAnswer(['rig_type',w.dir,'--set',w.path,'--sha256',w.hash,'--by','user','--pick','rig_type=keep',
    '--owner-chat',file,'--said-at',new Date(testClock.now()-500).toISOString(),'--relayed-by','operator'],testClock.now()))).toBe('OWNER_CHAT_INVALID');
  expect(readFileSync(join(w.dir,'project.json'))).toEqual(before);
});

test.each(['--said-at','--relayed-by','agent','--from-review','bad-pick'])('owner chat refuses missing/mixed authority and invalid picks atomically: %s', change => {
  const w=working('rig_type');const file=join(w.dir,'owner.txt');writeFileSync(file,'Keep this.');
  const args=['rig_type',w.dir,'--set',w.path,'--sha256',w.hash,'--by',change==='agent'?'agent':'user',
    '--pick',change==='bad-pick'?'rig_type=missing':'rig_type=keep','--owner-chat',file,
    '--said-at',new Date(testClock.now()-500).toISOString(),'--relayed-by','operator'];
  if(change.startsWith('--') && change!=='--from-review')args.splice(args.indexOf(change),2);
  if(change==='--from-review')args.push('--from-review','synthetic-act');
  const before=readFileSync(join(w.dir,'project.json'));
  expect(code(()=>rawInterviewAnswer(args,testClock.now()))).toBe(change==='bad-pick'||change==='agent'?'INTERVIEW_CHOICE_INVALID':'OWNER_CHAT_INVALID');
  expect(readFileSync(join(w.dir,'project.json'))).toEqual(before);
});

function syntheticPick(w: ReturnType<typeof working>, recorded = true): void {
  const raw = obj(current(load(w.dir), String(w.set.question)).raw);
  const picks = arr(obj(raw.choice).picks).map(value => ({ ask: obj(value).ask, option_id: obj(value).option_id === 'auto' ? 'keep' : obj(value).option_id }));
  if (recorded) reviewAnswer(w, { set: { path: w.path, sha256: w.hash }, picks, at: new Date(testClock.now()).toISOString() });
  else answer(w, picks.map(pick => `${pick.ask}=${pick.option_id}`));
}

test.each([true, false])('#701 source plan with all picks = %s', allPicked => {
  const first = working('rig_type');
  const { dir } = first;
  const questions = ['rig_type', 'reference', 'seethrough', 'assemble'];
  for (const [index, question] of questions.entries()) {
    const w = index === 0 ? first : registerReask(dir, question, `test-${question}`, sourceDraftAt + 2_000 * index);
    syntheticPick(w, allPicked || index !== questions.length - 1);
  }
  const lastPickAt = new Date(testClock.now()).toISOString();
  testClock.set(testClock.now() + 2_000);
  const record = join(dir, 'project.json');
  const before = readFileSync(record);
  const next = () => nextProject(dir, testClock.now());
  if (!allPicked) {
    expect(code(() => signoffCommand(['interview', dir, '--from-picks']))).toBe('SIGNOFF_PICKS_REQUIRED');
    expect(readFileSync(record)).toEqual(before);
    expect(next().moves.some(move => move.act.includes('job open --plan'))).toBe(true);
    const publication = readRecordPublished({ root: dir, record: { path: 'project.json', sha256: jobHash(before) },
      result: { kind: 'plan' }, phase: 'inventory' }, testClock.now()) as RecordPlanContext;
    expect(publication.subjects).toEqual([{ kind: 'signoff', stage: 'interview' }]);
    expect(checkProject(dir).refusals).toEqual([]);
    expect(checkProject(dir).warnings).toEqual([]);
    return;
  }
  const project = load(dir);
  const plan = obj(project.plan);
  const steps = plan.steps;
  plan.steps = arr(steps).filter(step => obj(step).id !== 'assemble');
  save(dir, project);
  const incomplete = readFileSync(record);
  expect(code(() => signoffCommand(['interview', dir, '--from-picks']))).toBe('SIGNOFF_PICKS_PLAN_INCOMPLETE');
  expect(readFileSync(record)).toEqual(incomplete);
  plan.steps = steps;
  plan.drafted_at = new Date(testClock.now() - 1_000).toISOString();
  save(dir, project);
  for (const stage of ['interview', 'plan-approved']) {
    const moves = next().moves;
    expect(moves.some(move => move.act.includes('job open --plan') || move.command?.includes('job open --plan'))).toBe(false);
    expect(moves.some(move => move.command?.includes(`signoff ${stage}`) && move.command.endsWith('--from-picks'))).toBe(true);
    expect(signoffCommand([stage, dir, '--from-picks']).exit).toBe(0);
    expect(arr(load(dir).signoffs).at(-1)).toMatchObject({
      stage, by: 'synthetic-owner', at: new Date(testClock.now()).toISOString(),
      evidence: { from: 'picks', act_id: 'pick-test-assemble', said_at: lastPickAt, picks: expect.any(Array) },
    });
    advanceCommand([stage === 'interview' ? 'plan-approved' : 'parts', dir]);
  }
  expect(checkProject(dir).refusals).toEqual([]);
  expect(checkProject(dir).warnings).toEqual([]);
});


test('#701 all rigging picks reach rigging without a plan publication', () => {
  const first = working('bones');
  const { dir } = first;
  for (const [index, question] of ['bones', 'meshes', 'constraints', 'turn', 'motion'].entries()) {
    syntheticPick(index === 0 ? first : registerReask(dir, question, `rig-${question}`, riggingDraftAt + 2_000 * index));
  }
  const lastPickAt = new Date(testClock.now()).toISOString();
  testClock.set(testClock.now() + 2_000);
  for (const id of ['bones', 'meshes', 'constraints', 'motion']) {
    expect(planCommand(['revise', id, dir, '--by', 'agent',
      '--reason', `The ${id} definition still fits the recorded synthetic picks.`]).exit).toBe(0);
  }
  const moves = nextProject(dir, testClock.now()).moves;
  expect(moves.some(move => move.command?.endsWith('--from-picks'))).toBe(true);
  expect(moves.some(move => move.act.includes('job open --plan') || move.command?.includes('job open --plan'))).toBe(false);
  expect(signoffCommand(['rigging-interview', dir, '--from-picks']).exit).toBe(0);
  expect(arr(load(dir).signoffs).at(-1)).toMatchObject({
    stage: 'rigging-interview', by: 'synthetic-owner',
    evidence: { from: 'picks', act_id: 'pick-rig-motion', said_at: lastPickAt, picks: expect.any(Array) },
  });
  const tampered = load(dir);
  obj(obj(arr(tampered.signoffs).at(-1)).evidence).act_id = 'unrecorded';
  expect(reviewActFindings(tampered).map(finding => finding.code)).toContain('REVIEW_ACT_LEDGER_INVALID');
  expect(nextProject(dir, testClock.now()).moves.some(move => move.command?.includes('advance rigging '))).toBe(true);
  advanceCommand(['rigging', dir]);
  expect(checkProject(dir).refusals).toEqual([]);
  expect(checkProject(dir).warnings).toEqual([]);
});

/** #828: a Review signoff act on the interview stage, fetched through the injected adapter. */
function reviewSignoff(w: {dir:string}, actId: string, at: string, words: string, reviewer: JsonObject = { id: 'synthetic-owner', role: 'owner' }) {
  return rawSignoff(['interview', realpathSync(w.dir), '--from-review', actId], testClock.now(), { fetch: transport => ({ bytes: JSON.stringify({
    schema: 'rig-review/act@2', kind: 'signoff', jobId: transport.jobId, actId, askId: 'synthetic-ask', publicationId: 'synthetic-publication',
    at, authority: { actor: 'human', channel: 'review-ui', reviewer },
    source: { sourceHash: '1'.repeat(64), projectHash: '2'.repeat(64), package: { id: 'synthetic-package', revision: 'one' },
      selector: null, model: null, direction: null, optionSet: null, appliedResult: null, plan: null, parts: { enumeratorVersion: '2.45.0' } },
    value: { stage: 'interview', decision: 'approved', words },
  }) }) });
}
const agentReviewer = (act: JsonObject): void => { obj(obj(act.authority).reviewer).id = 'agent'; };
function rehash(receipt: JsonObject, edit: (act: JsonObject) => void): void {
  const act = JSON.parse(String(receipt.bytes)) as JsonObject; edit(act);
  receipt.bytes = JSON.stringify(act); receipt.sha256 = sha256(Buffer.from(String(receipt.bytes)));
}

test('#828 the owner acting under an owner host keeps the owner pick and signoff record bytes', () => {
  const w = working('reference');
  testClock.set(testClock.now() + 1_000);
  const pickAt = testClock.iso();
  const pick = reviewAnswer(w, { set: { path: w.path, sha256: w.hash }, picks: [{ ask: 'reference', option_id: 'keep' }], at: pickAt });
  const shown = obj(obj(arr(obj(arr(w.set.asks)[0]).options)[0]));
  const asks = JSON.stringify(obj(JSON.parse(pick)).asks);
  expect(pick).toBe(`{"delegated":false,"by":"user","at":"${pickAt}","verbatim":${JSON.stringify(`${String(shown.label)}\n${String(shown.effect)}\n`)},"source":"review questionnaire","choice":{"spec":"${CHOICE_SPEC}","set":{"path":"${w.path}","sha256":"${w.hash}"},"picks":[{"ask":"reference","option_id":"keep","shown":{"label":${JSON.stringify(shown.label)},"effect":${JSON.stringify(shown.effect)}}}],"note":""},"asks":${asks},"value":${JSON.stringify(obj(JSON.parse(pick)).value)}}`);
  testClock.set(testClock.now() + 1_000);
  const signAt = testClock.iso();
  bindReview(w);
  expect(reviewSignoff(w, 'owner-sign', signAt, 'I approve the interview.').exit).toBe(0);
  const signed = obj(arr(load(w.dir).signoffs).at(-1));
  expect(JSON.stringify(signed)).toBe(`{"stage":"interview","checkpoint":null,"by":"user","at":"${signAt}","verbatim":"I approve the interview.","source":"review act synthetic-interview-job/owner-sign","answer_hashes":${JSON.stringify(signed.answer_hashes)}}`);
  expect(reviewActFindings(load(w.dir))).toEqual([]);
});

test('#828 the ledger keeps an earlier agent act recorded as user with a WARN and refuses one from REVIEW_ACT_ACTOR_SINCE', () => {
  const w = working('reference');
  testClock.set(testClock.now() + 1_000);
  reviewAnswer(w, { set: { path: w.path, sha256: w.hash }, picks: [{ ask: 'reference', option_id: 'keep' }], at: testClock.iso() });
  testClock.set(testClock.now() + 1_000);
  bindReview(w);
  expect(reviewSignoff(w, 'owner-sign', testClock.iso(), 'I approve the interview.').exit).toBe(0);
  const recorded = load(w.dir);
  const receipts = (project: JsonObject) => arr(project.review_acts).map(obj).filter(entry => ['interview-picks', 'signoff'].includes(String(entry.kind)));
  const current = structuredClone(recorded);
  for (const receipt of receipts(current)) rehash(receipt, agentReviewer);
  expect(reviewActFindings(current).map(f => f.code)).toEqual(['REVIEW_ACT_LEDGER_INVALID', 'REVIEW_ACT_LEDGER_INVALID']);
  const earlier = structuredClone(recorded);
  const at = new Date(Date.parse(REVIEW_ACT_ACTOR_SINCE) - 60_000).toISOString();
  for (const receipt of receipts(earlier)) {
    const was = String(JSON.parse(String(receipt.bytes)).at);
    rehash(receipt, act => { agentReviewer(act); act.at = at; });
    if (receipt.kind === 'signoff') {
      receipt.version_hash = jobHash(JSON.stringify({ stage: 'interview', checkpoint: null, at }));
      obj(arr(earlier.signoffs).map(obj).find(row => row.at === was)).at = at;
    } else obj(collectItems(earlier, { collection: null }).find(item => item.id === 'reference')!.raw).at = at;
  }
  const warnings: Finding[] = [];
  expect(reviewActFindings(earlier, warnings)).toEqual([]);
  expect(warnings.map(f => [f.code, f.path])).toEqual([['REVIEW_ACT_ACTOR_LEGACY', expect.any(String)], ['REVIEW_ACT_ACTOR_LEGACY', expect.any(String)]]);
});

test('#828 an agent act under an owner host records the agent, so it refuses as a pick or signoff and writes nothing', () => {
  const w = working('reference');
  const file = join(w.dir, 'project.json');
  testClock.set(testClock.now() + 1_000);
  const payload = { set: { path: w.path, sha256: w.hash }, picks: [{ ask: 'reference', option_id: 'keep' }], at: testClock.iso() };
  bindReview(w);
  let before = readFileSync(file);
  expect(code(() => reviewAnswer(w, payload, [], agentReviewer))).toBe('INTERVIEW_CHOICE_INVALID');
  expect(readFileSync(file)).toEqual(before);
  reviewAnswer(w, payload);
  testClock.set(testClock.now() + 1_000);
  before = readFileSync(file);
  expect(code(() => reviewSignoff(w, 'agent-sign', testClock.iso(), 'I approve the interview.', { id: 'agent', role: 'owner' }))).toBe('SIGNOFF_NOT_HUMAN');
  expect(readFileSync(file)).toEqual(before);
});
