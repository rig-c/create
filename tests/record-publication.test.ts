import { expect, test } from 'bun:test';
import { startJobHost } from '@rig-c/review/job-host';
import { cpSync, mkdirSync, readFileSync, readdirSync, lstatSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { collectItems, checkProject } from '../src/check.ts';
import { optionContext, sha256 } from '../src/choices.ts';
import { interviewOptionsCommand } from '../src/choice-writers.ts';
import { currentJobIdentity, loadedPartsIdentity, partsEnumerator, readPublished, readRecordPublished, type RecordPublicationRequest } from '../src/job-publication.ts';
import { OWN_NODE_MODULES, PARTS_PACKAGE } from '../src/parts-sections.ts';
import { jobHash, jobPrivateRoot } from '../src/job-outbox.ts';
import { signoffCommand } from '../src/signoff.ts';
import { Refusal } from '../src/refusal.ts';
import { stageIndex } from '../src/stages.ts';
import { fixture, retainSignoffs, supersede, obj, arr } from './fixtures.ts';
import { TEST_NOW } from './clock.ts';
import { expectedReopenSubjectsThrough } from './reopen-act-fixture.ts';
import { tempDir } from './helpers.ts';
import { checkpointWorkspace } from './checkpoint-evidence-fixture.ts';
import type { JsonObject } from '../src/templates.ts';

function save(root: string, project: JsonObject): void {
  writeFileSync(join(root, 'project.json'), JSON.stringify(project, null, 2) + '\n');
}

function pending(stage = 'interview') {
  const root = realpathSync(fixture(project => {
    project.stage = stage;
    project.versions = [];
    project.scenes = [];
    // Rewind the narrative's later ledger row and the draft recorded for it with the versions.
    project.drafts = arr(project.drafts).filter(draft => obj(draft).id === 'example');
    project.fix_ledger = [];
    delete project.direction_contract;
    retainSignoffs(project, signature => stageIndex(String(obj(signature).stage)) < stageIndex(stage));
    project.advances = arr(project.advances).filter(value => stageIndex(String(obj(value).stage)) <= stageIndex(stage));
    for (const step of arr(obj(project.plan).steps).map(obj)) step.status = 'pending';
    for (const item of arr(obj(obj(project.interview).post).items).map(obj)) item.guide = null;
    for (const item of arr(obj(project.interview).waypoints).map(obj)) {
      if (['bones', 'meshes', 'constraints', 'motion'].includes(String(item.id))) item.guide = null;
    }
  }, 'example-project.json'));
  const project = JSON.parse(readFileSync(join(root, 'project.json'), 'utf8')) as JsonObject;
  const item = collectItems(project, { collection: null }).find(item => item.id === 'reference')!;
  const binding = obj(obj(item.raw).choice).set as JsonObject;
  const set = JSON.parse(readFileSync(join(root, String(binding.path)), 'utf8')) as JsonObject;
  set.id = 'pending-reference';
  set.drafted_at = new Date(TEST_NOW - 1000).toISOString();
  set.context = optionContext(project, 'interview', Date.parse(String(set.drafted_at)), root);
  const path = 'evidence/interview/pending-reference.json';
  writeFileSync(join(root, path), JSON.stringify(set, null, 2) + '\n');
  if (stage === 'interview') interviewOptionsCommand(['reference', root, '--file', path], TEST_NOW);
  return { root, path, set };
}

function request(root: string): RecordPublicationRequest {
  return { root, record: { path: 'project.json', sha256: jobHash(readFileSync(join(root, 'project.json'))) },
    result: { kind: 'option-set', questionId: 'reference', setId: 'pending-reference' }, phase: 'inventory' };
}

function snapshot(root: string): unknown[] {
  const directory = lstatSync(root);
  return [directory.mode, directory.mtimeMs, directory.ctimeMs, readdirSync(root).sort().map(name => {
    const path = join(root, name);
    const stat = lstatSync(path);
    return [name, stat.mode, stat.mtimeMs, stat.ctimeMs, stat.isDirectory() ? snapshot(path) : jobHash(readFileSync(path))];
  })];
}

function rejectsUnchanged(input: RecordPublicationRequest, code = 'JOB_RECORD_INCOMPLETE'): void {
  const before = readFileSync(join(input.root, 'project.json'));
  try {
    readRecordPublished(input, TEST_NOW);
    throw Error('reader did not refuse');
  } catch (error) {
    expect(error).toBeInstanceOf(Refusal);
    expect((error as Refusal).code).toBe(code);
  }
  expect(readFileSync(join(input.root, 'project.json'))).toEqual(before);
}

test('pending option-set publishes exact inputs and merges identical references in code-unit order', () => {
  const { root, path } = pending();
  expect(checkProject(root, undefined, { now: TEST_NOW, readOnly: true }).refusals).toEqual([]);
  const before = snapshot(root);
  const context = readRecordPublished(request(root), TEST_NOW);
  expect(context.subjects).toEqual([{ kind: 'interview-picks', questionId: 'reference', setId: 'pending-reference' }]);
  expect(Object.keys(context).sort()).toEqual(['files', 'inputs', 'label', 'parts', 'plan', 'subjects']);
  expect(context.files.map(file => file.path)).toEqual(context.files.map(file => file.path).sort());
  expect(new Set(context.files.map(file => file.path)).size).toBe(context.files.length);
  expect(context.files.map(file => file.path)).toContain(path);
  expect(context.files.map(file => file.path)).toContain('project.json');
  for (const input of context.inputs) {
    expect(context.files.filter(file => file.path === input.path)).toEqual([input]);
    expect(input.sha256).toBe(jobHash(readFileSync(join(root, input.path))));
  }
  expect(snapshot(root)).toEqual(before);
});

test.each(['record', 'input', 'options'])('changed %s bytes refuse without writing the record', source => {
  const { root, path } = pending();
  const input = request(root);
  const project = JSON.parse(readFileSync(join(root, 'project.json'), 'utf8'));
  const file = source === 'record' ? 'project.json' : source === 'options' ? path : project.inputs[0].path;
  writeFileSync(join(root, file), Buffer.concat([readFileSync(join(root, file)), Buffer.from(' ')]));
  rejectsUnchanged(input);
});

test.each(['question', 'set', 'phase', 'stage'])('explicit %s mismatch never infers a subject', field => {
  const { root, path } = pending(field === 'stage' ? 'plan-approved' : 'interview');
  if (field === 'stage') {
    const project = JSON.parse(readFileSync(join(root, 'project.json'), 'utf8'));
    collectItems(project, { collection: null }).find(item => item.id === 'reference')!.record.pending_options = { path, sha256: jobHash(readFileSync(join(root, path))) };
    save(root, project);
  }
  let input = request(root);
  if (field === 'question') input = { ...input, result: { kind: 'option-set', questionId: 'absent', setId: 'pending-reference' } };
  if (field === 'set') input = { ...input, result: { kind: 'option-set', questionId: 'reference', setId: 'absent' } };
  if (field === 'phase') input = { ...input, phase: 'invalid' as RecordPublicationRequest['phase'] };
  rejectsUnchanged(input, field === 'question' || field === 'phase' ? 'JOB_RECORD_INCOMPLETE' : 'JOB_RECORD_SUBJECT_INVALID');
});

test.each(['duplicate', 'conflict'])('%s input declarations refuse with unchanged record bytes', control => {
  const { root } = pending();
  const project = JSON.parse(readFileSync(join(root, 'project.json'), 'utf8'));
  project.inputs.push({ ...project.inputs[0], ...(control === 'conflict' ? { sha256: '0'.repeat(64) } : {}) });
  save(root, project);
  rejectsUnchanged(request(root));
});

test('duplicate context declarations refuse even when the official context accepts repeated references', () => {
  const { root, path, set } = pending();
  const context = obj(set.context);
  arr(context.files).push(arr(context.files)[0]!);
  const bytes = JSON.stringify(set, null, 2) + '\n';
  writeFileSync(join(root, path), bytes);
  const project = JSON.parse(readFileSync(join(root, 'project.json'), 'utf8'));
  collectItems(project, { collection: null }).find(item => item.id === 'reference')!.record.pending_options = { path, sha256: sha256(Buffer.from(bytes)) };
  save(root, project);
  rejectsUnchanged(request(root));
});

test('pending plan reads the signoff answer evidence and binds only its effective stage', () => {
  const { root } = pending('plan-approved');
  const input = { ...request(root), result: { kind: 'plan' as const } };
  const before = snapshot(root);
  const context = readRecordPublished(input, TEST_NOW);
  expect(context.subjects).toEqual([{ kind: 'signoff', stage: 'plan-approved' }, ...expectedReopenSubjectsThrough('plan-approved')]);
  expect(context.plan?.steps.length).toBeGreaterThan(0);
  expect(context.files.some(file => file.path.includes('interview'))).toBe(true);
  expect(snapshot(root)).toEqual(before);
  expect(context.plan).not.toBeNull();
});

test.each(['intent', 'pending'])('existing %s outbox and another live owner lock remain byte and metadata identical', phase => {
  const { root } = pending();
  const outbox = join(jobPrivateRoot(root), 'outbox');
  mkdirSync(outbox, { recursive: true, mode: 0o700 });
  const input = request(root);
  const entry = { schema: 'rig-create/job-pending@1', root, id: 'a'.repeat(64), recordHash: input.record.sha256,
    versionHash: 'b'.repeat(64), result: { path: 'missing.json', selector: { kind: 'rig', version: 999 } }, identity: {}, phase };
  writeFileSync(join(outbox, `${entry.id}.json`), JSON.stringify(entry), { mode: 0o600 });
  const lock = join(root, '.rig-create-job-write.lock');
  mkdirSync(lock);
  // A separate live process owns the lock until the synchronous reader returns.
  const owner = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], { stdout: 'ignore', stderr: 'ignore' });
  writeFileSync(join(lock, `${owner.pid}-00000000-0000-0000-0000-000000000000`), '');
  try {
    const before = snapshot(root);
    if (phase === 'intent') readRecordPublished(input, TEST_NOW);
    else rejectsUnchanged(input);
    expect(snapshot(root)).toEqual(before);
  } finally { owner.kill(); }
});

test('default check still recovers an uncommitted intent while readOnly leaves it retained', () => {
  const { root } = pending();
  const outbox = join(jobPrivateRoot(root), 'outbox');
  mkdirSync(outbox, { recursive: true, mode: 0o700 });
  const entry = { schema: 'rig-create/job-pending@1', root, id: 'a'.repeat(64), recordHash: request(root).record.sha256,
    versionHash: 'b'.repeat(64), result: { path: 'missing.json', selector: { kind: 'rig', version: 999 } }, identity: {}, phase: 'intent' };
  const file = join(outbox, `${entry.id}.json`);
  writeFileSync(file, JSON.stringify(entry), { mode: 0o600 });
  const before = snapshot(root);
  checkProject(root, undefined, { now: TEST_NOW, readOnly: true });
  expect(snapshot(root)).toEqual(before);
  const record = readFileSync(join(root, 'project.json'));
  checkProject(root, undefined, { now: TEST_NOW });
  expect(readdirSync(outbox)).toEqual([]);
  expect(JSON.parse(readFileSync(join(jobPrivateRoot(root), 'discarded-intents.jsonl'), 'utf8')).event).toBe('intent-not-committed');
  expect(readFileSync(join(root, 'project.json'))).toEqual(record);
});


test('external collection evidence refuses by code and preserves the entire synthetic member tree', () => {
  const { root } = pending();
  const container = dirname(root);
  const member = join(container, 'members', 'synthetic');
  mkdirSync(dirname(member), { recursive: true });
  cpSync(root, member, { recursive: true });
  writeFileSync(join(container, 'collection.json'), JSON.stringify({ name: 'synthetic' }));
  const before = snapshot(container);
  rejectsUnchanged(request(member), 'JOB_RECORD_COLLECTION_EXTERNAL');
  expect(snapshot(container)).toEqual(before);
});

function approvalFixture(stage: string): string {
  return realpathSync(fixture(project => {
    project.stage = stage;
    retainSignoffs(project, signature => stageIndex(String(obj(signature).stage)) < stageIndex(stage));
    project.advances = arr(project.advances).filter(value => stageIndex(String(obj(value).stage)) <= stageIndex(stage));
    if (stage === 'rigging-interview') {
      project.versions = [];
      project.scenes = [];
      delete project.direction_contract;
      for (const item of arr(obj(obj(project.interview).post).items).map(obj)) item.guide = null;
    } else {
      project.versions = arr(project.versions).filter(value => obj(value).kind === 'rig');
      delete project.direction_contract;
    }
    for (const step of arr(obj(project.plan).steps).map(obj)) {
      if (stage === 'post-interview' ? step.phase === 'post' : !['seethrough', 'assemble'].includes(String(step.id))) step.status = 'pending';
    }
  }, 'example-project.json'));
}

test.each(['rigging-interview', 'post-interview'])('%s plan seals the current writer evidence', stage => {
  const root = approvalFixture(stage);
  const before = snapshot(root);
  const input = { ...request(root), result: { kind: 'plan' as const }, phase: 'inventory' as const };
  const context = readRecordPublished(input, TEST_NOW);
  expect(context.subjects).toEqual([{ kind: 'signoff', stage }, ...expectedReopenSubjectsThrough(stage)]);
  if (stage === 'rigging-interview') {
    const project = JSON.parse(readFileSync(join(root, 'project.json'), 'utf8'));
    const approval = project.signoffs.find((signature: JsonObject) => signature.stage === 'parts-review' && signature.checkpoint === null);
    expect(context.files).toContainEqual(approval.structure);
    expect(context.files).toContainEqual({ path: approval.evidence.path, sha256: approval.evidence.sha256 });
  }
  expect(snapshot(root)).toEqual(before);
});

test.each(['plan-approved', 'rigging-interview', 'post-interview', 'direction-review'])(
  '#475 unchanged %s record publication is repeatable and byte-identical', stage => {
    const root = stage === 'plan-approved' ? pending(stage).root
      : stage === 'direction-review' ? realpathSync(fixture(project => {
        project.stage = stage;
        retainSignoffs(project, signature => obj(signature).stage !== stage);
        project.advances = arr(project.advances).filter(value => obj(value).stage !== 'accepted');
      }, 'example-project.json')) : approvalFixture(stage);
    const input = { ...request(root), result: { kind: 'plan' as const } };
    const before = snapshot(root);
    const first = readRecordPublished(input, TEST_NOW);
    expect(first.subjects.map(subject => JSON.stringify(subject))).toContain(JSON.stringify({ kind: 'signoff', stage }));
    expect(readRecordPublished(input, TEST_NOW)).toEqual(first);
    expect(snapshot(root)).toEqual(before);
  },
);


test.each(['rigging-interview', 'post-interview'])('%s pending options seal retained context evidence', stage => {
  const root = approvalFixture(stage);
  const project = JSON.parse(readFileSync(join(root, 'project.json'), 'utf8'));
  const questionId = stage === 'rigging-interview' ? 'motion' : 'camera_depth';
  const item = collectItems(project, { collection: null }).find(item => item.id === questionId)!;
  const original = obj(obj(item.raw).choice).set as JsonObject;
  const set = JSON.parse(readFileSync(join(root, String(original.path)), 'utf8'));
  set.id = 'pending-context';
  set.drafted_at = new Date(TEST_NOW - 1000).toISOString();
  set.context = optionContext(project, stage, TEST_NOW - 1000, root);
  const path = 'evidence/interview/pending-context.json';
  writeFileSync(join(root, path), JSON.stringify(set, null, 2) + '\n');
  interviewOptionsCommand([questionId, root, '--file', path], TEST_NOW);
  const input = { ...request(root), phase: 'inventory' as const,
    result: { kind: 'option-set' as const, questionId, setId: set.id } };
  const before = snapshot(root);
  const context = readRecordPublished(input, TEST_NOW);
  expect(context.subjects).toEqual([{ kind: 'interview-picks', questionId, setId: set.id }]);
  expect(context.files).toContainEqual({ path, sha256: jobHash(readFileSync(join(root, path))) });
  expect(snapshot(root)).toEqual(before);
  const evidence = stage === 'rigging-interview' ? set.context.structure : set.context.scene ?? set.context.config;
  writeFileSync(join(root, evidence.path), Buffer.concat([readFileSync(join(root, evidence.path)), Buffer.from(' ')]));
  rejectsUnchanged(input);
});


test('an explicitly inapplicable empty post plan stays eligible under the writer predicate', () => {
  const root = realpathSync(fixture(project => {
    project.stage = 'post-interview';
    for (const item of arr(obj(obj(project.interview).post).items).map(obj)) {
      supersede(item, 'guide', { not_applicable: true, because: 'No post work applies.', by: 'user', at: new Date(TEST_NOW - 1000).toISOString() });
    }
    obj(project.plan).steps = arr(obj(project.plan).steps).filter(step => obj(step).phase === 'rig');
    project.signoffs = arr(project.signoffs).filter(signature => !['direction-review', 'post-interview'].includes(String(obj(signature).stage)));
  }));
  const project = JSON.parse(readFileSync(join(root, 'project.json'), 'utf8'));
  const painting = Buffer.from('Synthetic immutable painting input');
  mkdirSync(join(root, 'inputs'), { recursive: true });
  writeFileSync(join(root, 'inputs/painting.png'), painting);
  project.inputs = [{ ...project.inputs[0], path: 'inputs/painting.png', sha256: jobHash(painting) }];
  save(root, project);
  const words = join(root, 'approval.txt');
  writeFileSync(words, 'Approve the inapplicable post answers.');
  signoffCommand(['interview', root, '--by', 'user', '--verbatim-file', words], TEST_NOW);
  const before = snapshot(root);
  const context = readRecordPublished({ ...request(root), result: { kind: 'plan' }, phase: 'inventory' }, TEST_NOW);
  expect(context.subjects).toEqual([{ kind: 'signoff', stage: 'post-interview' }, ...expectedReopenSubjectsThrough('post')]);
  expect(snapshot(root)).toEqual(before);
});

function retained(input: RecordPublicationRequest): RecordPublicationRequest {
  const context = readRecordPublished(input, TEST_NOW);
  const root = join(tempDir(), 'retained');
  mkdirSync(root);
  for (const file of context.files) {
    mkdirSync(dirname(join(root, file.path)), { recursive: true });
    cpSync(join(input.root, file.path), join(root, file.path));
  }
  return { ...input, root, phase: 'retained', parts: context.parts };
}

test('the measured #277 case: the retained phase equals the inventory phase with 0 refusals', () => {
  const { root } = pending();
  const inventory = readRecordPublished(request(root), TEST_NOW);
  const project = JSON.parse(readFileSync(join(root, 'project.json'), 'utf8'));
  const paths = inventory.files.map(file => file.path);
  // Historical choices are decision evidence; the producer receipt is not part of this ask.
  for (const item of collectItems(project, { collection: null })) {
    if (item.state.state === 'user' || item.state.state === 'delegated') {
      const choice = item.state.answer.choice;
      if (choice && typeof choice === 'object' && !Array.isArray(choice)) expect(paths).toContain(String(obj(choice.set).path));
    }
  }
  const input = retained(request(root));
  expect(checkProject(input.root, undefined, { now: TEST_NOW, readOnly: true, recordPublication: true }).refusals).toEqual([]);
  const before = snapshot(input.root);
  expect(readRecordPublished(input, TEST_NOW)).toEqual(inventory);
  expect(snapshot(input.root)).toEqual(before);
});

test('a sealed-closure file removed from the retained root refuses JOB_RECORD_CLOSURE_INCOMPLETE by code and path', () => {
  const { root } = pending();
  const input = retained(request(root));
  const project = JSON.parse(readFileSync(join(input.root, 'project.json'), 'utf8'));
  const historical = collectItems(project, { collection: null }).find(item => item.id === 'rig_type')!;
  rmSync(join(input.root, String(obj(obj(obj(historical.raw).choice).set).path)));
  const before = snapshot(input.root);
  rejectsUnchanged(input, 'JOB_RECORD_CLOSURE_INCOMPLETE');
  try {
    readRecordPublished(input, TEST_NOW);
    throw Error('retained reader did not refuse');
  } catch (error) {
    expect(error).toMatchObject({ code: 'JOB_RECORD_CLOSURE_INCOMPLETE',
      details: [{ code: 'INTERVIEW_OPTIONS_FILE', path: 'interview.framing[rig_type].answer' }] });
  }
  expect(snapshot(input.root)).toEqual(before);
});

test.each(['inventory', 'retained'] as const)('%s: a question whose pick is recorded refuses JOB_RECORD_SUBJECT_INVALID', phase => {
  const { root } = pending();
  const project = JSON.parse(readFileSync(join(root, 'project.json'), 'utf8'));
  delete collectItems(project, { collection: null }).find(item => item.id === 'reference')!.record.pending_options;
  save(root, project);
  rejectsUnchanged({ ...request(root), phase, ...(phase === 'retained' ? { parts: loadedPartsIdentity(root, 'host') } : {}) }, 'JOB_RECORD_SUBJECT_INVALID');
});

test('tampered retained seals fail mechanically before the incomplete retained check', () => {
  const { root } = pending();
  const input = retained(request(root));
  const inventory = readRecordPublished(request(root), TEST_NOW);
  const file = join(input.root, inventory.inputs[0]!.path);
  writeFileSync(file, Buffer.concat([readFileSync(file), Buffer.from(' ')]));
  const before = snapshot(input.root);
  rejectsUnchanged(input, 'JOB_PUBLICATION_INVALID');
  expect(snapshot(input.root)).toEqual(before);
});

test('inventory and retained contexts agree when all check dependencies are sealed', () => {
  const { root, set } = pending();
  const project = JSON.parse(readFileSync(join(root, 'project.json'), 'utf8'));
  for (const item of collectItems(project, { collection: null })) {
    if (item.state.state !== 'user' && item.state.state !== 'delegated') continue;
    const choice = item.state.answer.choice;
    if (!choice || typeof choice !== 'object' || Array.isArray(choice)) continue;
    const binding = obj(choice.set);
    project.inputs.push({ ...project.inputs[0], path: binding.path, sha256: binding.sha256, bytes: readFileSync(join(root, String(binding.path))).length });
  }
  for (const receipt of project.review_acts ?? []) {
    if (receipt.schema !== 'rig-create/parts-verdict-cli@1') continue;
    const binding = obj(receipt.evidence);
    project.inputs.push({ ...project.inputs[0], path: binding.path, sha256: binding.sha256, bytes: readFileSync(join(root, String(binding.path))).length });
  }
  save(root, project);
  set.id = 'complete-pending';
  set.context = optionContext(project, 'interview', TEST_NOW - 1000, root);
  const path = 'evidence/interview/complete-pending.json';
  writeFileSync(join(root, path), JSON.stringify(set, null, 2) + '\n');
  interviewOptionsCommand(['reference', root, '--file', path], TEST_NOW);
  const input: RecordPublicationRequest = { ...request(root), result: { kind: 'option-set', questionId: 'reference', setId: String(set.id) } };
  const inventory = readRecordPublished(input, TEST_NOW);
  expect(inventory.plan).toBeNull();
  const copy = retained(input);
  const before = snapshot(copy.root);
  expect(readRecordPublished(copy, TEST_NOW)).toEqual(inventory);
  expect(snapshot(copy.root)).toEqual(before);
});

test('input order stays in project order while unique file rows remain sorted', () => {
  const { root, set } = pending();
  const project = JSON.parse(readFileSync(join(root, 'project.json'), 'utf8'));
  project.inputs.reverse();
  save(root, project);
  set.context = optionContext(project, 'interview', TEST_NOW - 1000, root);
  set.id = 'input-order';
  const orderedPath = 'evidence/interview/input-order.json';
  writeFileSync(join(root, orderedPath), JSON.stringify(set, null, 2) + '\n');
  interviewOptionsCommand(['reference', root, '--file', orderedPath], TEST_NOW);
  const context = readRecordPublished({ ...request(root), result: { kind: 'option-set', questionId: 'reference', setId: set.id as string } }, TEST_NOW);
  expect(context.inputs).toEqual(project.inputs.map(({ path, sha256 }: { path: string; sha256: string }) => ({ path, sha256 })));
  expect(context.files.map(file => file.path)).toEqual(context.files.map(file => file.path).sort());
  expect(new Set(context.files.map(file => file.path)).size).toBe(context.files.length);
  expect(Object.keys(context.subjects[0]!)).toEqual(['kind', 'questionId', 'setId']);
});

test('only an enabled at-checkpoint step is offered with canonical subject keys', () => {
  const root = realpathSync(fixture(project => {
    project.stage = 'parts';
    project.versions = [];
    project.scenes = [];
    delete project.direction_contract;
    retainSignoffs(project, signature => stageIndex(String(obj(signature).stage)) < stageIndex('parts'));
    project.advances = arr(project.advances).filter(value => stageIndex(String(obj(value).stage)) <= stageIndex('parts'));
    for (const item of arr(obj(obj(project.interview).post).items).map(obj)) item.guide = null;
    for (const item of arr(obj(project.interview).waypoints).map(obj)) {
      if (['bones', 'meshes', 'constraints', 'motion'].includes(String(item.id))) item.guide = null;
    }
    for (const step of arr(obj(project.plan).steps).map(obj)) {
      step.status = step.id === 'assemble' ? 'at-checkpoint' : step.id === 'seethrough' ? 'done' : 'pending';
    }
  }, 'example-project.json'));
  const input = { ...request(root), result: { kind: 'plan' as const } };
  const context = readRecordPublished(input, TEST_NOW);
  expect(context.subjects).toEqual([{ kind: 'checkpoint', checkpointId: 'assemble' }, ...expectedReopenSubjectsThrough('parts')]);
  expect(Object.keys(context.subjects[0]!)).toEqual(['kind', 'checkpointId']);
  const project = JSON.parse(readFileSync(join(root, 'project.json'), 'utf8'));
  const step = obj(arr(obj(project.plan).steps).find(step => obj(step).id === 'assemble'));
  step.status = 'in-progress';
  step.status_history = arr(step.status_history).filter(entry => obj(entry).status === 'in-progress');
  save(root, project);
  expect(readRecordPublished({ ...request(root), result: { kind: 'plan' } }, TEST_NOW).subjects).toEqual(expectedReopenSubjectsThrough('parts'));
});

/** The host's own parts identity, read independently from create's install and lockfile. */
function hostParts(): { name: string; version: string; integrity: string } {
  const version = JSON.parse(readFileSync(join(OWN_NODE_MODULES, PARTS_PACKAGE, 'package.json'), 'utf8')).version as string;
  const entry = (Bun.JSONC.parse(readFileSync(join(OWN_NODE_MODULES, '..', 'bun.lock'), 'utf8')) as { packages: Record<string, string[]> }).packages[PARTS_PACKAGE]!;
  return { name: PARTS_PACKAGE, version, integrity: entry.at(-1)! };
}

/** A pending project with its own parts install (linked to the host's) and the given lockfiles. */
function installed(lockfiles: Record<string, unknown>): string {
  const { root } = pending();
  mkdirSync(join(root, 'node_modules', '@rig-c'), { recursive: true });
  symlinkSync(join(OWN_NODE_MODULES, PARTS_PACKAGE), join(root, 'node_modules', PARTS_PACKAGE));
  for (const [file, value] of Object.entries(lockfiles)) writeFileSync(join(root, file), JSON.stringify(value, null, 2) + '\n');
  return root;
}

const bunLock = (version: string, integrity: string) => ({ lockfileVersion: 1, workspaces: {}, packages: {
  [PARTS_PACKAGE]: [`${PARTS_PACKAGE}@${version}`, '', {}, integrity], 'unrelated-dep': ['unrelated-dep@1.0.0', '', {}, 'sha512-unrelated'] } });
const npmLock = (version: string, integrity: string) => ({ lockfileVersion: 3, packages: { [`node_modules/${PARTS_PACKAGE}`]: { version, integrity } } });

test.each([['bun.lock'], ['package-lock.json'], ['both']])('matching parts identity from %s passes both phases', which => {
  const host = hostParts();
  const root = installed({
    ...(which !== 'package-lock.json' ? { 'bun.lock': bunLock(host.version, host.integrity) } : {}),
    ...(which !== 'bun.lock' ? { 'package-lock.json': npmLock(host.version, host.integrity) } : {}),
  });
  const inventory = readRecordPublished(request(root), TEST_NOW);
  expect(inventory.parts).toEqual(host);
  // The lockfile is not a closure file: an unrelated dependency bump cannot stale the closure.
  expect(inventory.files.map(file => file.path).filter(path => path.endsWith('.lock') || path.endsWith('lock.json'))).toEqual([]);
  const copy = retained(request(root));
  expect(readRecordPublished(copy, TEST_NOW)).toEqual(inventory);
});

test.each([['version'], ['integrity']])('a sealed parts %s different from the host refuses JOB_RECORD_PARTS_MISMATCH naming both versions', field => {
  const { root } = pending();
  const copy = retained(request(root));
  const host = hostParts();
  const sealed = field === 'version' ? { ...host, version: '2.0.0' } : { ...host, integrity: 'sha512-planted' };
  rejectsUnchanged({ ...copy, parts: sealed }, 'JOB_RECORD_PARTS_MISMATCH');
  try { readRecordPublished({ ...copy, parts: sealed }, TEST_NOW); } catch (error) {
    expect((error as Error).message).toContain(`${PARTS_PACKAGE} ${sealed.version}`);
    expect((error as Error).message).toContain(`${PARTS_PACKAGE} ${host.version}`);
    expect((error as Error).message).toContain(`rebuild the project on the host's ${PARTS_PACKAGE} ${host.version}, or run the check where ${sealed.version} is installed`);
  }
});

test.each([['no lockfile', {}], ['no parts entry', { 'bun.lock': { lockfileVersion: 1, workspaces: {}, packages: {} } }],
  ['another version only', { 'bun.lock': bunLock('2.0.0', 'sha512-other') }], ['no integrity', { 'package-lock.json': { packages: { [`node_modules/${PARTS_PACKAGE}`]: { version: hostParts().version } } } }]] as const)(
  '%s for the installed parts refuses JOB_RECORD_PARTS_LOCK_MISSING', (_name, lockfiles) => {
    rejectsUnchanged(request(installed(lockfiles)), 'JOB_RECORD_PARTS_LOCK_MISSING');
  });

/** Build each pending set through the ordinary writer, on a synthetic current record. */
function stageOptions(stage: string, questionId: string): RecordPublicationRequest {
  const root = approvalFixture(stage);
  const project = JSON.parse(readFileSync(join(root, 'project.json'), 'utf8'));
  const item = collectItems(project, { collection: null }).find(item => item.id === questionId)!;
  const binding = obj(obj(item.raw).choice).set as JsonObject;
  const set = JSON.parse(readFileSync(join(root, String(binding.path)), 'utf8'));
  set.id = `pending-${questionId}`;
  set.drafted_at = new Date(TEST_NOW - 1000).toISOString();
  set.context = optionContext(project, stage, TEST_NOW - 1000, root);
  const path = `evidence/interview/${set.id}.json`;
  writeFileSync(join(root, path), JSON.stringify(set, null, 2) + '\n');
  interviewOptionsCommand([questionId, root, '--file', path], TEST_NOW);
  return { ...request(root), result: { kind: 'option-set', questionId, setId: set.id } };
}

// Preserve the reader's option/plan overloads while fixing its test clock.
const clockedRecordReader = ((request: RecordPublicationRequest) => readRecordPublished(request, TEST_NOW)) as typeof readRecordPublished;

const recordAsks: [string, () => RecordPublicationRequest][] = [
  ['interview question', () => request(pending().root)],
  ['plan checkpoint', () => { const fixture = checkpointWorkspace(); fixture.attach(); return { ...request(fixture.root), result: { kind: 'plan' } }; }],
  ['rigging question', () => stageOptions('rigging-interview', 'motion')],
  ...['camera_depth', 'post_timing', 'post_composition'].map(id => [id, () => stageOptions('post-interview', id)] as [string, () => RecordPublicationRequest]),
  ['initial plan signoff', () => ({ ...request(pending('plan-approved').root), result: { kind: 'plan' } })],
  ...['rigging-interview', 'post-interview'].map(stage => [stage + ' signoff', () => ({ ...request(approvalFixture(stage)), result: { kind: 'plan' as const } })] as [string, () => RecordPublicationRequest]),
];

test.each(recordAsks)('%s: every retained input refuses on tamper; excluded draft output does not affect the ask', async (_label, make) => {
  const input = make();
  const context = readRecordPublished(input, TEST_NOW);
  const copy = retained(input);
  expect(readRecordPublished(copy, TEST_NOW)).toEqual(context);
  const identity = currentJobIdentity({ root: input.root, stateDir: tempDir(), fingerprint: 'synthetic-record-closure',
    reviewer: { id: 'synthetic-owner', role: 'owner' } }, input.root);
  const host = await startJobHost({ root: input.root, stateDir: identity.stateDir, fingerprint: identity.fingerprint,
    reviewer: identity.reviewer, readerId: identity.readerId, recordReaderId: identity.readerId,
    readPublished, publicationMode: 'record-and-package',
    readRecordPublished: clockedRecordReader,
    partsEnumeratorId: identity.partsEnumeratorId, partsEnumerator });
  try {
    let sequence = 0;
    const api = async (verb: string, fields: object) => {
      const response = await host.ports.handleJobApi(new Request(`${host.origin}/jobs/${host.session.jobId}/api`, {
        method: 'POST', headers: { authorization: `Bearer ${host.session.hostCredentials().agent}`, 'content-type': 'application/json' },
        body: JSON.stringify({ schema: 'rig-review/job-api@3', verb, jobId: host.session.jobId,
          requestId: `request-${++sequence}`, idempotencyKey: `operation-${sequence}`,
          expectedGeneration: host.session.status().generation, ...fields }),
      }));
      return await response.json() as { ok: boolean; error?: { code: string }; value?: { publicationId: string } };
    };
    const published = await api('publish', { result: input.result,
      freeze: { kind: 'producer-held', holdId: 'synthetic-record-hold', record: input.record } });
    expect(published.ok).toBe(true);
    const publicationId = published.value!.publicationId;
    const snapshot = host.session.retainedSourceV3(publicationId);
    const subject = context.subjects[0]!;
    for (const file of context.files) {
      const path = join(snapshot.snapshotRoot, file.path);
      const original = readFileSync(path);
      try {
        writeFileSync(path, Buffer.concat([original, Buffer.from(' ')]));
        // Review's existing immutable-seal gate runs before Create's retained check.
        expect(await api('ask', { publicationId, subject })).toMatchObject({ ok: false, error: { code: 'JOB_SOURCE_UNRETAINABLE' } });
      } finally { writeFileSync(path, original); }
    }
    expect((await api('ask', { publicationId, subject })).ok).toBe(true);
  } finally { host.stop(); rmSync(identity.stateDir, { recursive: true, force: true }); }
  const project = JSON.parse(readFileSync(join(input.root, 'project.json'), 'utf8'));
  const output = obj(arr(obj(arr(project.drafts)[0]).files).find(file => String(obj(file).path).endsWith('/motion.json')));
  expect(context.files.some(file => file.path === output.path)).toBe(false);
  const path = join(input.root, String(output.path));
  const original = readFileSync(path);
  const before = checkProject(input.root, project, { now: TEST_NOW, readOnly: true, recordPublication: true });
  try {
    writeFileSync(path, Buffer.from('tampered excluded producer output'));
    expect(readRecordPublished(input, TEST_NOW)).toEqual(context);
    expect(checkProject(input.root, project, { now: TEST_NOW, readOnly: true, recordPublication: true })).toEqual(before);
    // The ordinary project boundary still detects the producer artifact's corruption.
    expect(checkProject(input.root, project, { now: TEST_NOW, readOnly: true }).refusals.some(finding => finding.code === 'DRAFT_RIG_FILE')).toBe(true);
  } finally { writeFileSync(path, original); }
}, 30000);

test('synthetic mature version outputs exceed the old retain cap but all post asks retain only decision evidence', async () => {
  const input = stageOptions('post-interview', 'camera_depth');
  const root = input.root;
  for (const questionId of ['post_timing', 'post_composition']) {
    const project = JSON.parse(readFileSync(join(root, 'project.json'), 'utf8'));
    const item = collectItems(project, { collection: null }).find(item => item.id === questionId)!;
    const set = JSON.parse(readFileSync(join(root, String(obj(obj(obj(item.raw).choice).set).path)), 'utf8'));
    set.id = `pending-${questionId}`;
    set.drafted_at = new Date(TEST_NOW - 1000).toISOString();
    set.context = optionContext(project, 'post-interview', TEST_NOW - 1000, root);
    const path = `evidence/interview/${set.id}.json`;
    writeFileSync(join(root, path), JSON.stringify(set, null, 2) + '\n');
    interviewOptionsCommand([questionId, root, '--file', path], TEST_NOW);
  }
  const project = JSON.parse(readFileSync(join(root, 'project.json'), 'utf8'));
  const draft = project.drafts[0];
  // Six 48 MiB frozen draft-version outputs: ordinary files, not mock byte counts.
  const large = Buffer.alloc(48 * 1024 * 1024);
  const digest = jobHash(large);
  const added: string[] = [];
  try {
    for (let version = 1; version <= 3; version++) {
      for (const name of ['demo.mp4', 'idle.png']) {
        const path = `derived/drafts/${draft.id}/out/versions/v${version}/${name}`;
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), large);
        draft.files.push({ path, sha256: digest });
        added.push(path);
      }
    }
    save(root, project);
    const whole = checkProject(root, project, { now: TEST_NOW, readOnly: true, recordReads: true });
    expect(whole.refusals).toEqual([]);
    const before = new Map(whole.reads!.map(file => [file.path, file.sha256]));
    before.set('project.json', jobHash(readFileSync(join(root, 'project.json'))));
    const size = (paths: Iterable<string>) => [...paths].reduce((sum, path) => sum + lstatSync(join(root, path)).size, 0);
    const beforeBytes = size(before.keys());
    expect(beforeBytes).toBeGreaterThan(256 * 1024 * 1024);
    const stateDir = tempDir();
    const identity = currentJobIdentity({ root, stateDir, fingerprint: 'synthetic-mature', reviewer: { id: 'synthetic-owner', role: 'owner' } }, root);
    const host = await startJobHost({ root, stateDir, fingerprint: identity.fingerprint, reviewer: identity.reviewer,
      readerId: identity.readerId, readPublished, publicationMode: 'record-and-package', recordReaderId: identity.readerId,
      readRecordPublished: clockedRecordReader, partsEnumeratorId: identity.partsEnumeratorId, partsEnumerator });
    try {
      for (const result of [
        ...['camera_depth', 'post_timing', 'post_composition'].map(questionId => ({ kind: 'option-set' as const, questionId, setId: `pending-${questionId}` })),
        { kind: 'plan' as const },
      ]) {
        const current = { ...request(root), result };
        const context = readRecordPublished(current, TEST_NOW);
        const afterBytes = size(context.files.map(file => file.path));
        expect(afterBytes).toBeLessThan(256 * 1024 * 1024);
        expect(context.files.some(file => added.includes(file.path))).toBe(false);
        expect(readRecordPublished(retained(current), TEST_NOW)).toEqual(context);
        const sequence = host.session.status().generation;
        const response = await host.ports.handleJobApi(new Request(`${host.origin}/jobs/${host.session.jobId}/api`, {
          method: 'POST', headers: { authorization: `Bearer ${host.session.hostCredentials().agent}`, 'content-type': 'application/json' },
          body: JSON.stringify({ schema: 'rig-review/job-api@3', verb: 'publish', jobId: host.session.jobId,
            requestId: `request-${sequence}`, idempotencyKey: `operation-${sequence}`, expectedGeneration: sequence, result,
            freeze: { kind: 'producer-held', holdId: 'synthetic-mature-hold', record: current.record } }),
        }));
        expect(await response.json()).toMatchObject({ ok: true });
        console.log(JSON.stringify({ fixture: 'synthetic-mature', ask: result.kind === 'plan' ? 'plan' : result.questionId,
          before: { files: before.size, bytes: beforeBytes }, after: { files: context.files.length, bytes: afterBytes } }));
      }
    } finally { host.stop(); rmSync(stateDir, { recursive: true, force: true }); }
  } finally { for (const path of added) rmSync(join(root, path)); }
}, 30000);

test.each([
  ['rig_type', 'RIG_TYPE_UNKNOWN', 'unknown-type'],
  ['meshes', 'BUST_EXCLUSION_UNREASONED', { bust: { excluded: true } }],
] as const)('record checks retain the %s answer-domain refusal %s', (id, code, value) => {
  const root = approvalFixture('post-interview');
  const project = JSON.parse(readFileSync(join(root, 'project.json'), 'utf8'));
  const item = collectItems(project, { collection: null }).find(item => item.id === id)!;
  expect(item.state.state).toBe('user');
  if (item.state.state !== 'user') throw Error('synthetic answer must be user-provided');
  item.state.answer.value = value as JsonObject | string;
  save(root, project);
  const record = checkProject(root, project, { now: TEST_NOW, readOnly: true, recordPublication: true });
  const full = checkProject(root, project, { now: TEST_NOW, readOnly: true });
  expect(record.refusals.find(finding => finding.code === code)).toEqual(full.refusals.find(finding => finding.code === code));
  expect(record.refusals.map(finding => finding.code)).toContain(code);
  expect(() => readRecordPublished({ ...request(root), result: { kind: 'plan' } }, TEST_NOW))
    .toThrow(expect.objectContaining({ code: 'JOB_RECORD_INCOMPLETE' }));
});
