import { afterAll, expect, test } from 'bun:test';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkProject, collectItems, loadCollection } from '../src/check.ts';
import { optionContext } from '../src/choices.ts';
import { interviewAnswerCommand, interviewOptionsCommand } from '../src/choice-writers.ts';
import { reopenCommand } from '../src/reopen.ts';
import { selectAnswerHashes } from '../src/signoff-answers.ts';
import { main } from '../src/cli.ts';
import {
  COLLECTION_BINDING_SPEC,
  DEFAULT_COLLECTION_BINDING_PATH,
  collectionBindingCommand,
  isLiveMemberRoot,
  writeCollectionBinding,
} from '../src/collection-binding.ts';
import { JOB_BINDING_FILE, acquireJobLock, jobHash, writePrivateJson } from '../src/job-outbox.ts';
import { currentJobIdentity, readRecordPublished, type RecordPublicationRequest } from '../src/job-publication.ts';
import { Refusal } from '../src/refusal.ts';
import { stageIndex } from '../src/stages.ts';
import { readTemplate, type JsonObject } from '../src/templates.ts';
import { TEST_NOW } from './clock.ts';
import { arr, fixture, obj, retainSignoffs } from './fixtures.ts';
import { installStrictReads, uninstallStrictReads } from './strict-reads.ts';

installStrictReads();
afterAll(uninstallStrictReads);

function saveJson(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function snapshot(root: string): unknown[] {
  const directory = lstatSync(root);
  return [
    directory.mode,
    directory.mtimeMs,
    directory.ctimeMs,
    readdirSync(root)
      .sort()
      .map((name) => {
        const path = join(root, name);
        const stat = lstatSync(path);
        return [
          name,
          stat.mode,
          stat.mtimeMs,
          stat.ctimeMs,
          stat.isSymbolicLink() ? `symlink:${stat.size}` : stat.isDirectory() ? snapshot(path) : jobHash(readFileSync(path)),
        ];
      }),
  ];
}

interface MemberFixture {
  readonly container: string;
  readonly collectionFile: string;
  readonly memberRoot: string;
  readonly optionPath: string;
  readonly optionSet: JsonObject;
}

/**
 * Builds a synthetic collection (`harbour`) and a member (`members/hero`) at `stage`
 * where:
 * - `rig_type` and `seethrough` are inherited from `../../collection.json` (with collection `history[]`);
 * - `assemble` overrides the collection's `assemble` guide (with a matching `overrides[]` entry);
 * - `reference` has a local choice answer and (at `interview`) a pending option set ready to publish.
 */
function memberFixture(stage: 'interview' | 'plan-approved' = 'interview'): MemberFixture {
  const baseRoot = realpathSync(
    fixture((project) => {
      project.stage = stage;
      project.versions = [];
      project.scenes = [];
      project.drafts = arr(project.drafts).filter((draft) => obj(draft).id === 'example');
      project.fix_ledger = [];
      delete project.direction_contract;
      retainSignoffs(project, (signature) => stageIndex(String(obj(signature).stage)) < stageIndex(stage));
      project.advances = arr(project.advances).filter((value) => stageIndex(String(obj(value).stage)) <= stageIndex(stage));
      for (const step of arr(obj(project.plan).steps).map(obj)) step.status = 'pending';
      for (const item of arr(obj(obj(project.interview).post).items).map(obj)) item.guide = null;
      for (const item of arr(obj(project.interview).waypoints).map(obj)) {
        if (['bones', 'meshes', 'constraints', 'turn', 'motion'].includes(String(item.id))) item.guide = null;
      }
    }, 'example-project.json'),
  );

  const container = realpathSync(mkdtempSync(join(tmpdir(), 'rig-create-col-bind-')));
  const memberRoot = join(container, 'members', 'hero');
  mkdirSync(dirname(memberRoot), { recursive: true });
  cpSync(baseRoot, memberRoot, { recursive: true });

  const project = JSON.parse(readFileSync(join(memberRoot, 'project.json'), 'utf8')) as JsonObject;
  project.name = 'hero';

  // Extract the example's valid answers for `rig_type`, `seethrough`, and `assemble`
  // so `collection.json` holds real, schema-valid answers and `history[]`.
  const items = collectItems(project, { collection: null });
  const rigTypeItem = items.find((i) => i.id === 'rig_type')!;
  const seethroughItem = items.find((i) => i.id === 'seethrough')!;
  const assembleItem = items.find((i) => i.id === 'assemble')!;

  const stripChoice = (raw: JsonObject): JsonObject => {
    const copy = structuredClone(raw);
    delete copy.choice;
    return copy;
  };
  const collectionRigTypeAnswer = stripChoice(obj(rigTypeItem.raw));
  const collectionSeethroughGuide = stripChoice(obj(seethroughItem.raw));
  const collectionAssembleGuide: JsonObject = {
    ...stripChoice(obj(assembleItem.raw)),
    value: 'coarse',
    verbatim: 'Keep the collection default coarse.',
    asks: [
      { id: 'split_granularity', value: 'coarse' },
      { id: 'split_emphasis', value: 'as-painted' },
    ],
  };
  const historicalSeethroughGuide = {
    ...collectionSeethroughGuide,
    at: '2026-11-01T00:00:00.000Z',
    verbatim: 'Earlier collection seethrough guide.',
  };

  const collection = readTemplate('collection.json');
  collection.name = 'harbour';
  collection.title = 'Harbour Collection';
  collection.members = [{ name: 'hero', project: 'members/hero/project.json', input: null, note: null }];
  const colInterview = obj(collection.interview);
  for (const q of arr(colInterview.framing).map(obj)) {
    if (q.id === 'rig_type') {
      q.answer = collectionRigTypeAnswer;
      q.history = [];
    }
  }
  for (const w of arr(colInterview.waypoints).map(obj)) {
    if (w.id === 'seethrough') {
      w.guide = collectionSeethroughGuide;
      w.history = [historicalSeethroughGuide];
    } else if (w.id === 'assemble') {
      w.guide = collectionAssembleGuide;
      w.history = [];
    }
  }

  const collectionFile = join(container, 'collection.json');
  saveJson(collectionFile, collection);

  // Switch member's `rig_type` and `seethrough` to `basis: 'inherited'`,
  // and record a member override on `assemble` against the collection's `assemble` answer.
  rigTypeItem.record.answer = {
    basis: 'inherited',
    from: { collection: 'harbour', question: 'rig_type' },
    by: 'rig-create',
    at: '2026-11-05T00:05:00.000Z',
  };
  rigTypeItem.record.history = [];

  seethroughItem.record.guide = {
    basis: 'inherited',
    from: { collection: 'harbour', question: 'seethrough' },
    by: 'rig-create',
    at: '2026-11-05T00:05:00.000Z',
  };
  seethroughItem.record.history = [];

  const memberAssembleAnswer = obj(assembleItem.raw);
  memberAssembleAnswer.basis = 'overridden';
  memberAssembleAnswer.overrides = {
    collection: 'harbour',
    question: 'assemble',
    collection_answer_at: String(collectionAssembleGuide.at),
  };
  memberAssembleAnswer.why_verbatim = 'Hero needs finer cut around the cape clasp.';
  for (const sig of arr(project.signoffs).map(obj)) {
    const hashes = selectAnswerHashes(memberRoot, project, sig);
    if (hashes !== undefined) sig.answer_hashes = hashes;
  }
  saveJson(join(memberRoot, 'project.json'), project);

  const referenceItem = collectItems(project, { collection }).find((i) => i.id === 'reference')!;
  const refBinding = obj(obj(referenceItem.raw).choice).set as JsonObject;
  const optionSet = JSON.parse(readFileSync(join(memberRoot, String(refBinding.path)), 'utf8')) as JsonObject;
  optionSet.id = 'pending-reference';
  optionSet.drafted_at = new Date(TEST_NOW - 1000).toISOString();
  optionSet.context = optionContext(project, 'interview', Date.parse(String(optionSet.drafted_at)), memberRoot);
  const optionPath = 'evidence/interview/pending-reference.json';
  saveJson(join(memberRoot, optionPath), optionSet);
  if (stage === 'interview') {
    interviewOptionsCommand(['reference', memberRoot, '--file', optionPath], TEST_NOW);
  }

  return { container, collectionFile, memberRoot, optionPath, optionSet };
}

function optionRequest(root: string): RecordPublicationRequest {
  return {
    root,
    record: { path: 'project.json', sha256: jobHash(readFileSync(join(root, 'project.json'))) },
    result: { kind: 'option-set', questionId: 'reference', setId: 'pending-reference' },
    phase: 'inventory',
  };
}

function planRequest(root: string): RecordPublicationRequest {
  return {
    root,
    record: { path: 'project.json', sha256: jobHash(readFileSync(join(root, 'project.json'))) },
    result: { kind: 'plan' },
    phase: 'inventory',
  };
}

function copyRetainedIsolated(input: RecordPublicationRequest): RecordPublicationRequest {
  const context = readRecordPublished(input, TEST_NOW);
  const isolatedParent = realpathSync(mkdtempSync(join(tmpdir(), 'rig-create-retained-')));
  const root = join(isolatedParent, 'retained');
  mkdirSync(root);
  for (const file of context.files) {
    mkdirSync(dirname(join(root, file.path)), { recursive: true });
    cpSync(join(input.root, file.path), join(root, file.path));
  }
  return { ...input, root, phase: 'retained', parts: context.parts };
}

test('unbound member refuses JOB_RECORD_COLLECTION_EXTERNAL without mutating the member tree', () => {
  const { container, memberRoot } = memberFixture('interview');
  const before = snapshot(container);
  expect(() => readRecordPublished(optionRequest(memberRoot), TEST_NOW)).toThrow(
    expect.objectContaining({ code: 'JOB_RECORD_COLLECTION_EXTERNAL' }),
  );
  expect(snapshot(container)).toEqual(before);
});

test('collection-binding writer binds ../../collection.json and publishes option-set and plan in inventory and isolated retained roots', () => {
  for (const stage of ['interview', 'plan-approved'] as const) {
    const { collectionFile, memberRoot } = memberFixture(stage);
    const exit = main(['collection-binding', memberRoot], TEST_NOW);
    expect(exit).toBe(0);

    const project = JSON.parse(readFileSync(join(memberRoot, 'project.json'), 'utf8')) as JsonObject;
    const pointer = obj(project.collection_binding);
    expect(pointer.path).toBe(DEFAULT_COLLECTION_BINDING_PATH);
    expect(pointer.spec).toBe(COLLECTION_BINDING_SPEC);
    expect(pointer.collection_sha256).toBe(jobHash(readFileSync(collectionFile)));
    expect(pointer.sha256).toBe(jobHash(readFileSync(join(memberRoot, DEFAULT_COLLECTION_BINDING_PATH))));

    const bindingDoc = JSON.parse(readFileSync(join(memberRoot, DEFAULT_COLLECTION_BINDING_PATH), 'utf8')) as JsonObject;
    expect(bindingDoc.schema).toBe(COLLECTION_BINDING_SPEC);
    expect(bindingDoc.member).toBe('hero');
    expect(obj(bindingDoc.collection)).toEqual({
      name: 'harbour',
      sha256: jobHash(readFileSync(collectionFile)),
    });
    expect(Object.keys(obj(bindingDoc.inherited_answers)).sort()).toEqual(['rig_type', 'seethrough']);

    const req = stage === 'interview' ? optionRequest(memberRoot) : planRequest(memberRoot);
    const beforeInventory = snapshot(memberRoot);
    const inventory = readRecordPublished(req, TEST_NOW);
    expect(snapshot(memberRoot)).toEqual(beforeInventory);
    expect(inventory.files).toContainEqual({
      path: DEFAULT_COLLECTION_BINDING_PATH,
      sha256: String(pointer.sha256),
    });

    const retainedInput = copyRetainedIsolated(req);
    // Control: the retained root is outside `members/` and has no external `../../collection.json`.
    expect(isLiveMemberRoot(retainedInput.root)).toBe(false);
    expect(existsSync(join(dirname(dirname(retainedInput.root)), 'collection.json'))).toBe(false);

    // The live boundary still validates producer artifacts; a record snapshot validates decisions.
    expect(checkProject(memberRoot, undefined, { now: TEST_NOW, readOnly: true }).refusals).toEqual([]);
    const retainedReport = checkProject(retainedInput.root, undefined, { now: TEST_NOW, readOnly: true, recordPublication: true });
    expect(retainedReport.refusals).toEqual([]);
    const beforeRetained = snapshot(retainedInput.root);
    expect(readRecordPublished(retainedInput, TEST_NOW)).toEqual(inventory);
    expect(snapshot(retainedInput.root)).toEqual(beforeRetained);
  }
});

test('retained collection snapshot preserves inherited guide, history, and override semantics without external collection.json', () => {
  const { memberRoot } = memberFixture('plan-approved');
  writeCollectionBinding(memberRoot, { now: TEST_NOW });
  const retainedInput = copyRetainedIsolated(planRequest(memberRoot));

  expect(isLiveMemberRoot(retainedInput.root)).toBe(false);
  expect(existsSync(join(dirname(dirname(retainedInput.root)), 'collection.json'))).toBe(false);

  const boundCol = loadCollection(retainedInput.root);
  expect(boundCol).not.toBeNull();
  expect(boundCol?.name).toBe('harbour');
  const seethroughRecord = arr(obj(boundCol?.interview).waypoints)
    .map(obj)
    .find((w) => w.id === 'seethrough')!;
  expect(arr(seethroughRecord.history).length).toBe(1);

  // Override semantic check inside retained root: corrupting `overrides.collection_answer_at` in candidate
  // triggers `OVERRIDE_ANSWER_STALE` against the bound snapshot's `assemble` guide.
  const retainedProject = JSON.parse(readFileSync(join(retainedInput.root, 'project.json'), 'utf8')) as JsonObject;
  const badOverrideCandidate = structuredClone(retainedProject);
  const assembleGuide = obj(
    arr(obj(badOverrideCandidate.interview).waypoints)
      .map(obj)
      .find((w) => w.id === 'assemble')!.guide,
  );
  obj(assembleGuide.overrides).collection_answer_at = '2020-01-01T00:00:00.000Z';
  const overrideReport = checkProject(retainedInput.root, badOverrideCandidate, { now: TEST_NOW, readOnly: true, recordPublication: true });
  expect(overrideReport.refusals.map((r) => r.code)).toContain('OVERRIDE_ANSWER_STALE');
});

test('changing ../../collection.json after binding refuses JOB_RECORD_COLLECTION_EXTERNAL in both reader and check', () => {
  const { container, collectionFile, memberRoot } = memberFixture('interview');
  writeCollectionBinding(memberRoot, { now: TEST_NOW });

  // 1. Formatting / byte change in ../../collection.json
  const originalCollectionBytes = readFileSync(collectionFile);
  writeFileSync(collectionFile, Buffer.concat([originalCollectionBytes, Buffer.from('\n')]));
  const beforeMember = snapshot(memberRoot);
  expect(() => readRecordPublished(optionRequest(memberRoot), TEST_NOW)).toThrow(
    expect.objectContaining({ code: 'JOB_RECORD_COLLECTION_EXTERNAL' }),
  );
  expect(snapshot(memberRoot)).toEqual(beforeMember);
  expect(checkProject(memberRoot, undefined, { now: TEST_NOW, readOnly: true }).refusals.map((r) => r.code)).toContain(
    'JOB_RECORD_COLLECTION_EXTERNAL',
  );

  // 2. Semantic answer change in ../../collection.json
  const collection = JSON.parse(originalCollectionBytes.toString('utf8')) as JsonObject;
  const seethrough = arr(obj(collection.interview).waypoints)
    .map(obj)
    .find((w) => w.id === 'seethrough')!;
  obj(seethrough.guide).verbatim = 'Changed collection seethrough instructions after binding.';
  saveJson(collectionFile, collection);
  expect(() => readRecordPublished(optionRequest(memberRoot), TEST_NOW)).toThrow(
    expect.objectContaining({ code: 'JOB_RECORD_COLLECTION_EXTERNAL' }),
  );
  expect(snapshot(memberRoot)).toEqual(beforeMember);
  void container;
});

test('live members root with missing or malformed ../../collection.json does not fall back to bound snapshot', () => {
  const { collectionFile, memberRoot } = memberFixture('interview');
  writeCollectionBinding(memberRoot, { now: TEST_NOW });
  expect(isLiveMemberRoot(memberRoot)).toBe(true);

  const originalCollectionBytes = readFileSync(collectionFile);

  // Malformed external collection.json in live members root
  writeFileSync(collectionFile, '{not-valid-json\n');
  expect(loadCollection(memberRoot)).toBeNull();
  const malformedReport = checkProject(memberRoot, undefined, { now: TEST_NOW, readOnly: true });
  expect(malformedReport.refusals.map((r) => r.code)).toContain('JOB_RECORD_COLLECTION_EXTERNAL');
  expect(malformedReport.refusals.map((r) => r.code)).toContain('INHERITED_UNRESOLVED');
  expect(() => readRecordPublished(optionRequest(memberRoot), TEST_NOW)).toThrow(
    expect.objectContaining({ code: 'JOB_RECORD_COLLECTION_EXTERNAL' }),
  );

  // Deleted external collection.json in live members root
  rmSync(collectionFile);
  expect(loadCollection(memberRoot)).toBeNull();
  const missingReport = checkProject(memberRoot, undefined, { now: TEST_NOW, readOnly: true });
  expect(missingReport.refusals.map((r) => r.code)).toContain('JOB_RECORD_COLLECTION_EXTERNAL');
  expect(missingReport.refusals.map((r) => r.code)).toContain('INHERITED_UNRESOLVED');
  expect(() => readRecordPublished(optionRequest(memberRoot), TEST_NOW)).toThrow(
    expect.objectContaining({ code: 'JOB_RECORD_COLLECTION_EXTERNAL' }),
  );

  // Restore external collection.json -> clean again
  writeFileSync(collectionFile, originalCollectionBytes);
  expect(checkProject(memberRoot, undefined, { now: TEST_NOW, readOnly: true }).refusals).toEqual([]);
});

test('writer validation failure preserves both project.json and existing binding file byte-for-byte', () => {
  const { collectionFile, memberRoot } = memberFixture('interview');
  // 1. Write initial valid binding
  writeCollectionBinding(memberRoot, { now: TEST_NOW });
  const bindingFile = join(memberRoot, DEFAULT_COLLECTION_BINDING_PATH);
  const initialBindingBytes = readFileSync(bindingFile);

  // 2. Update ../../collection.json (so a re-bind would produce new binding bytes)
  // AND plant a check refusal in project.json (malformed signoff).
  const collection = JSON.parse(readFileSync(collectionFile, 'utf8')) as JsonObject;
  collection.title = 'Updated Harbour Title';
  saveJson(collectionFile, collection);

  const project = JSON.parse(readFileSync(join(memberRoot, 'project.json'), 'utf8')) as JsonObject;
  project.signoffs = [{ stage: 'interview' }]; // Missing `by`, `at`, `verbatim` -> SIGNOFF_MALFORMED
  saveJson(join(memberRoot, 'project.json'), project);
  const plantedProjectBytes = readFileSync(join(memberRoot, 'project.json'));

  expect(() => collectionBindingCommand([memberRoot], TEST_NOW)).toThrow(
    expect.objectContaining({ code: 'SIGNOFF_MALFORMED' }),
  );

  // Both project.json and the pre-existing binding file must remain byte-identical!
  expect(readFileSync(join(memberRoot, 'project.json'))).toEqual(plantedProjectBytes);
  expect(readFileSync(bindingFile)).toEqual(initialBindingBytes);

  // 3. Also verify when no prior binding file existed in a custom subdirectory:
  // a failed write leaves no file and removes any newly created parent directory.
  const customSubdir = join(memberRoot, 'evidence', 'nested-custom');
  expect(existsSync(customSubdir)).toBe(false);
  expect(() => collectionBindingCommand([memberRoot, '--out', 'evidence/nested-custom/binding.json'], TEST_NOW)).toThrow(
    expect.objectContaining({ code: 'SIGNOFF_MALFORMED' }),
  );
  expect(existsSync(customSubdir)).toBe(false);
  expect(readFileSync(join(memberRoot, 'project.json'))).toEqual(plantedProjectBytes);
});

test.each([
  ['parent traversal', '../collection-binding.json'],
  ['inner traversal', 'evidence/../collection-binding.json'],
  ['ignored derived root', 'derived/collection-binding.json'],
  ['ignored outputs root', 'outputs/collection-binding.json'],
  ['ignored node_modules root', 'node_modules/collection-binding.json'],
  ['ignored .rig-create-review root', '.rig-create-review/collection-binding.json'],
  ['hidden segment', 'evidence/.hidden.json'],
  ['non-json extension', 'evidence/collection-binding.txt'],
  ['reserved project.json', 'project.json'],
])('unsafe --out path (%s: %s) refuses COLLECTION_BINDING_PATH_INVALID', (_label, badPath) => {
  const { memberRoot } = memberFixture('interview');
  const before = snapshot(memberRoot);
  expect(() => collectionBindingCommand([memberRoot, '--out', badPath], TEST_NOW)).toThrow(
    expect.objectContaining({ code: 'COLLECTION_BINDING_PATH_INVALID' }),
  );
  expect(snapshot(memberRoot)).toEqual(before);
});

test('symlinked binding file, parent directory, or member directory refuses COLLECTION_BINDING_PATH_INVALID without touching target', () => {
  const { container, memberRoot } = memberFixture('interview');
  const outsideTarget = join(container, 'outside-target.json');
  writeFileSync(outsideTarget, '{"untouched":true}\n');
  const outsideBytes = readFileSync(outsideTarget);

  // 1. Symlink at destination file
  symlinkSync(outsideTarget, join(memberRoot, DEFAULT_COLLECTION_BINDING_PATH));
  expect(() => collectionBindingCommand([memberRoot], TEST_NOW)).toThrow(
    expect.objectContaining({ code: 'COLLECTION_BINDING_PATH_INVALID' }),
  );
  expect(readFileSync(outsideTarget)).toEqual(outsideBytes);
  rmSync(join(memberRoot, DEFAULT_COLLECTION_BINDING_PATH));

  // 2. Symlink at parent directory
  const outsideDir = join(container, 'outside-dir');
  mkdirSync(outsideDir);
  symlinkSync(outsideDir, join(memberRoot, 'evidence', 'linked'));
  expect(() => collectionBindingCommand([memberRoot, '--out', 'evidence/linked/binding.json'], TEST_NOW)).toThrow(
    expect.objectContaining({ code: 'COLLECTION_BINDING_PATH_INVALID' }),
  );
  expect(readdirSync(outsideDir)).toEqual([]);
  rmSync(join(memberRoot, 'evidence', 'linked'));

  // 3. Symlink at member root itself
  const symlinkMember = join(container, 'members', 'linked-hero');
  symlinkSync(memberRoot, symlinkMember);
  expect(() => collectionBindingCommand([symlinkMember], TEST_NOW)).toThrow(
    expect.objectContaining({ code: 'COLLECTION_BINDING_PATH_INVALID' }),
  );
});

test('project.collection and member name mismatches refuse COLLECTION_BINDING_MEMBER_MISMATCH', () => {
  const { collectionFile, memberRoot } = memberFixture('interview');

  // 1. project.collection mismatch
  const project = JSON.parse(readFileSync(join(memberRoot, 'project.json'), 'utf8')) as JsonObject;
  project.collection = 'wrong-collection';
  saveJson(join(memberRoot, 'project.json'), project);
  const before1 = snapshot(memberRoot);
  expect(() => collectionBindingCommand([memberRoot], TEST_NOW)).toThrow(
    expect.objectContaining({ code: 'COLLECTION_BINDING_MEMBER_MISMATCH' }),
  );
  expect(snapshot(memberRoot)).toEqual(before1);

  // 2. project.name mismatch with member folder
  delete project.collection;
  project.name = 'someone-else';
  saveJson(join(memberRoot, 'project.json'), project);
  const before2 = snapshot(memberRoot);
  expect(() => collectionBindingCommand([memberRoot], TEST_NOW)).toThrow(
    expect.objectContaining({ code: 'COLLECTION_BINDING_MEMBER_MISMATCH' }),
  );
  expect(snapshot(memberRoot)).toEqual(before2);

  // 3. Member not listed in collection.json members[]
  project.name = 'hero';
  saveJson(join(memberRoot, 'project.json'), project);
  const collection = JSON.parse(readFileSync(collectionFile, 'utf8')) as JsonObject;
  collection.members = [{ name: 'other', project: 'members/other/project.json', input: null, note: null }];
  saveJson(collectionFile, collection);
  const before3 = snapshot(memberRoot);
  expect(() => collectionBindingCommand([memberRoot], TEST_NOW)).toThrow(
    expect.objectContaining({ code: 'COLLECTION_BINDING_MEMBER_MISMATCH' }),
  );
  expect(snapshot(memberRoot)).toEqual(before3);
});

test('tampered or removed binding file in retained root refuses by code without mutating retained tree', () => {
  const { memberRoot } = memberFixture('interview');
  writeCollectionBinding(memberRoot, { now: TEST_NOW });
  const req = optionRequest(memberRoot);

  // 1. Tampered binding bytes in retained root -> JOB_PUBLICATION_INVALID
  const tamperedRetained = copyRetainedIsolated(req);
  const retainedBindingFile = join(tamperedRetained.root, DEFAULT_COLLECTION_BINDING_PATH);
  writeFileSync(retainedBindingFile, Buffer.concat([readFileSync(retainedBindingFile), Buffer.from(' ')]));
  const beforeTampered = snapshot(tamperedRetained.root);
  expect(() => readRecordPublished(tamperedRetained, TEST_NOW)).toThrow(
    expect.objectContaining({ code: 'JOB_PUBLICATION_INVALID' }),
  );
  expect(snapshot(tamperedRetained.root)).toEqual(beforeTampered);

  // 2. Removed binding file from retained root -> JOB_RECORD_CLOSURE_INCOMPLETE
  const missingRetained = copyRetainedIsolated(req);
  rmSync(join(missingRetained.root, DEFAULT_COLLECTION_BINDING_PATH));
  const beforeMissing = snapshot(missingRetained.root);
  try {
    readRecordPublished(missingRetained, TEST_NOW);
    throw new Error('retained reader did not refuse');
  } catch (err) {
    expect(err).toBeInstanceOf(Refusal);
    expect(err).toMatchObject({
      code: 'JOB_RECORD_CLOSURE_INCOMPLETE',
      details: expect.arrayContaining([
        { code: 'JOB_RECORD_COLLECTION_EXTERNAL', path: 'collection_binding.path' },
        { code: 'INHERITED_UNRESOLVED', path: 'interview.framing[rig_type].answer' },
      ]),
    });
  }
  expect(snapshot(missingRetained.root)).toEqual(beforeMissing);
});

test('shared write lock is acquired before reading records so concurrent writer updates are preserved under contention', () => {
  const { collectionFile, memberRoot } = memberFixture('interview');
  let releaseCompeting: (() => void) | null = null;
  let contentions = 0;

  const result = writeCollectionBinding(memberRoot, {
    now: TEST_NOW,
    waitMs: 500,
    hooks: {
      beforeLock: () => {
        // Competing writer holds the shared lock before writeCollectionBinding reads anything
        releaseCompeting = acquireJobLock(memberRoot, true);
      },
      onContention: () => {
        contentions += 1;
        // Competing writer mutates both project.json and collection.json while holding the lock, then releases
        const project = JSON.parse(readFileSync(join(memberRoot, 'project.json'), 'utf8')) as JsonObject;
        project.notes = [...arr(project.notes), 'concurrent-writer-note'];
        saveJson(join(memberRoot, 'project.json'), project);

        const collection = JSON.parse(readFileSync(collectionFile, 'utf8')) as JsonObject;
        collection.title = 'Concurrent Collection Title';
        saveJson(collectionFile, collection);

        releaseCompeting?.();
        releaseCompeting = null;
      },
    },
  });

  expect(contentions).toBe(1);
  const updatedProject = JSON.parse(readFileSync(join(memberRoot, 'project.json'), 'utf8')) as JsonObject;
  expect(updatedProject.notes).toContain('concurrent-writer-note');
  expect(result.binding.collection_sha256).toBe(jobHash(readFileSync(collectionFile)));
  expect(obj(updatedProject.collection_binding).collection_sha256).toBe(result.binding.collection_sha256);
  expect(existsSync(join(memberRoot, '.rig-create-job-write.lock'))).toBe(false);

  // Unreleased lock refuses JOB_WRITE_BUSY without mutating memberRoot (including directory metadata)
  const holdRelease = acquireJobLock(memberRoot, true)!;
  try {
    const beforeBusy = snapshot(memberRoot);
    expect(() => writeCollectionBinding(memberRoot, { now: TEST_NOW, waitMs: 25 })).toThrow(
      expect.objectContaining({ code: 'JOB_WRITE_BUSY' }),
    );
    expect(snapshot(memberRoot)).toEqual(beforeBusy);
  } finally {
    holdRelease();
  }
});

test('cli --help exposes collection-binding usage and options', () => {
  const chunks: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stdout.write;
  try {
    expect(main(['--help'], TEST_NOW)).toBe(0);
  } finally {
    process.stdout.write = origWrite;
  }
  const helpText = chunks.join('');
  expect(helpText).toContain('rig-create collection-binding [<member dir>] [--out <path>]');
  expect(helpText).toContain('collection-binding:');
});

test('bound member supports reopen -> review-tool answer override -> check -> inventory and retained publication', () => {
  const { memberRoot, optionPath, optionSet } = memberFixture('plan-approved');
  writeCollectionBinding(memberRoot, { now: TEST_NOW });

  // Live interview signoff requires formal reopen before changing an interview answer
  const reopenWords = join(memberRoot, 'reopen-words.txt');
  writeFileSync(reopenWords, 'Reopen interview to override seethrough for this member.\n');
  reopenCommand(['interview', memberRoot, '--by', 'user', '--verbatim-file', reopenWords], TEST_NOW - 2000);

  // Draft and register a pending option set for the inherited 'seethrough' waypoint question
  const afterReopen = JSON.parse(readFileSync(join(memberRoot, 'project.json'), 'utf8')) as JsonObject;
  const templateProject = readTemplate('example-project.json');
  const templateSeethrough = arr(obj(templateProject.interview).waypoints)
    .map(obj)
    .find((q) => q.id === 'seethrough')!;
  const origSetRef = obj(obj(templateSeethrough.guide).choice).set as JsonObject;
  const seethroughSet = JSON.parse(readFileSync(join(memberRoot, String(origSetRef.path)), 'utf8')) as JsonObject;
  seethroughSet.id = 'member-override-seethrough';
  seethroughSet.drafted_at = new Date(TEST_NOW - 1000).toISOString();
  seethroughSet.context = optionContext(afterReopen, 'interview', Date.parse(String(seethroughSet.drafted_at)), memberRoot);
  const seethroughPath = 'evidence/interview/member-override-seethrough.json';
  const seethroughBytes = `${JSON.stringify(seethroughSet, null, 2)}\n`;
  writeFileSync(join(memberRoot, seethroughPath), seethroughBytes);
  const seethroughSha = jobHash(Buffer.from(seethroughBytes));
  interviewOptionsCommand(['seethrough', memberRoot, '--file', seethroughPath], TEST_NOW);
  rmSync(reopenWords, { force: true });

  // Bind review job and ingest the user's override through interviewAnswerCommand (--from-review + --why-file)
  const boundProject = JSON.parse(readFileSync(join(memberRoot, 'project.json'), 'utf8')) as JsonObject;
  const jobId = 'synthetic-member-override-job';
  const origin = 'http://127.0.0.1:43123';
  const identity = currentJobIdentity(
    {
      root: memberRoot,
      stateDir: 'unused-private-state',
      fingerprint: 'synthetic',
      reviewer: { id: 'synthetic-owner', role: 'owner' },
    },
    memberRoot,
  );
  writePrivateJson(
    join(realpathSync(memberRoot), JOB_BINDING_FILE),
    {
      schema: 'rig-create/job-binding@1',
      identity,
      jobId,
      origin,
      fetchCapability: 'synthetic-read-grant',
    },
    true,
  );
  boundProject.review_job = { jobId, origin };
  saveJson(join(memberRoot, 'project.json'), boundProject);

  const whyText = 'This member has a translucent veil requiring a member-specific seethrough override.\n';
  const whyFile = join(dirname(memberRoot), 'override-why.txt');
  writeFileSync(whyFile, whyText);
  const actId = 'pick-member-override-seethrough';
  const selections = arr(seethroughSet.asks)
    .map(obj)
    .map((ask) => ({
      itemId: ask.id,
      optionId: obj(arr(ask.options)[0]).id,
      otherText: null,
    }));
  const act = {
    schema: 'rig-review/act@2',
    kind: 'interview-picks',
    jobId,
    actId,
    askId: 'synthetic-ask',
    publicationId: 'synthetic-publication',
    at: new Date(TEST_NOW).toISOString(),
    authority: { actor: 'human', channel: 'review-ui', reviewer: { id: 'synthetic-owner', role: 'owner' } },
    source: {
      sourceHash: '1'.repeat(64),
      projectHash: '2'.repeat(64),
      package: { id: 'synthetic-package', revision: 'one' },
      parts: { enumeratorVersion: '2.30.1' },
      optionSet: { id: seethroughSet.id, sha256: seethroughSha },
    },
    value: {
      questionId: 'seethrough',
      selections,
      note: '',
    },
  };

  const rawSelected = interviewAnswerCommand(
    ['seethrough', realpathSync(memberRoot), '--from-review', actId, '--why-file', whyFile],
    TEST_NOW,
    {
      fetch: (transport) => {
        expect(transport.jobId).toBe(jobId);
        expect(transport.actId).toBe(actId);
        expect(transport.kind).toBe('interview-picks');
        return { bytes: JSON.stringify(act) };
      },
    },
  );
  const selected = JSON.parse(rawSelected) as JsonObject;
  expect(selected.basis).toBe('overridden');
  expect(selected.overrides).toEqual({
    collection: 'harbour',
    question: 'seethrough',
    collection_answer_at: obj(templateSeethrough.guide).at,
  });
  expect(selected.why_verbatim).toBe(whyText);

  // Check passes at 0 refusals and both inventory + isolated retained publication succeed
  const checkAfter = checkProject(memberRoot, undefined, { now: TEST_NOW });
  expect(checkAfter.ok).toBe(true);
  expect(checkAfter.refusals).toEqual([]);

  // Re-register the reference option set to publish an option-set subject on the reopened overridden member
  const currentProject = JSON.parse(readFileSync(join(memberRoot, 'project.json'), 'utf8')) as JsonObject;
  optionSet.context = optionContext(currentProject, 'interview', Date.parse(String(optionSet.drafted_at)), memberRoot);
  writeFileSync(join(memberRoot, optionPath), `${JSON.stringify(optionSet, null, 2)}\n`);
  interviewOptionsCommand(['reference', memberRoot, '--file', optionPath], TEST_NOW);

  const req = optionRequest(memberRoot);
  const inv = readRecordPublished(req, TEST_NOW);
  expect(inv.files).toContainEqual({
    path: DEFAULT_COLLECTION_BINDING_PATH,
    sha256: String(obj(JSON.parse(readFileSync(join(memberRoot, 'project.json'), 'utf8')).collection_binding).sha256),
  });

  const retReq = copyRetainedIsolated(req);
  expect(isLiveMemberRoot(retReq.root)).toBe(false);
  expect(existsSync(join(dirname(dirname(retReq.root)), 'collection.json'))).toBe(false);
  const ret = readRecordPublished(retReq, TEST_NOW);
  expect(ret).toEqual(inv);
});
