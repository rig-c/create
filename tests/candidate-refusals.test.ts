import { expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { checkCandidateReceipts } from '../src/candidate-check.ts';
import { collectItems, type Finding } from '../src/check.ts';
import { candidateBatchPath, candidateOptionPaths, CANDIDATE_STORAGE_PATH } from '../src/candidate-storage.ts';
import { jobRuntimeExecArgv } from '../src/job-writer.ts';
import type { JsonObject } from '../src/templates.ts';
import { candidateFixture, CANDIDATE_NOW, CANDIDATE_QUESTION, CANDIDATE_SET, CANDIDATE_SET_PATH, literalDigest } from './candidate-fixture.ts';
import { obj } from './fixtures.ts';
import { gitEnv, run, tempDir, treeDigest } from './helpers.ts';

function fixture() {
  const f = candidateFixture();
  const { root, project } = f;
  const harness = tempDir();
  const record = join(root, 'project.json');
  const items = collectItems(project, { collection: null });
  const item = items.find(row => row.id === CANDIDATE_QUESTION)!.record;
  const otherQuestion = 'post_timing';
  const otherSetPath = `evidence/interview/${otherQuestion}.json`;
  const otherSet = {
    question: otherQuestion, setId: String(f.read(otherSetPath).id),
    setSha256: literalDigest(readFileSync(join(root, otherSetPath))),
  };
  items.find(row => row.id === otherQuestion)!.record.pending_options = { path: otherSetPath, sha256: otherSet.setSha256 };

  const storage = join(root, CANDIDATE_STORAGE_PATH);
  const otherBatch = candidateBatchPath(storage, otherSet);
  for (const dir of [storage, otherBatch, join(root, '.rig-create-review'), join(root, 'scratch/unrelated')]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  writeFileSync(join(otherBatch, 'batch.json'), JSON.stringify(otherSet), { mode: 0o600 });
  writeFileSync(join(otherBatch, 'ready.json'), '{"count":1}\n', { mode: 0o600 });
  writeFileSync(join(otherBatch, 'retained.bin'), 'unrelated candidate bytes');
  writeFileSync(join(root, '.rig-create-review', 'retained.bin'), 'unrelated review bytes');
  writeFileSync(join(root, 'scratch/unrelated', 'retained.bin'), 'unrelated scratch bytes');
  writeFileSync(join(storage, 'ballast'), 'allocated-block control');
  writeFileSync(join(root, 'bunfig.toml'), `preload = [${JSON.stringify(join(import.meta.dir, 'candidate-refusal-fixture.ts'))}]\n`);

  const env = gitEnv({ name: 'Synthetic Candidate Test', email: 'candidate-test@example.invalid' });
  const setup = (configure?: (set: JsonObject) => void) => {
    let binding = f.save();
    if (configure) {
      const set = f.read(CANDIDATE_SET_PATH);
      configure(set);
      binding = f.write(CANDIDATE_SET_PATH, set);
      item.pending_options = binding;
      f.write('project.json', project);
    }
    for (const args of [['init', '--initial-branch=main'], ['add', 'project.json'], ['commit', '--message', 'Synthetic baseline']]) {
      const result = run(['git', ...args], root, env);
      expect(result.code, result.stderr).toBe(0);
    }
    return candidateBatchPath(storage, { question: CANDIDATE_QUESTION, setId: CANDIDATE_SET, setSha256: binding.sha256 });
  };

  const raceRecord = (replaceId: boolean) => {
    const current = f.read(CANDIDATE_SET_PATH);
    if (replaceId) current.id = 'superseding-option-set';
    else current.drafted_by = 'synthetic-redraft';
    const binding = f.write('evidence/interview/superseding.json', current);
    const next = structuredClone(project);
    collectItems(next, { collection: null }).find(row => row.id === CANDIDATE_QUESTION)!.record.pending_options = binding;
    const bytes = Buffer.from(`${JSON.stringify(next, null, 2)}\n`);
    writeFileSync(join(harness, 'concurrent-project.json'), bytes);
    return bytes;
  };

  const assertRefused = (batch: string, code: string, opts: {
    plant?: string; set?: string; recordAfter?: Buffer; compose?: number; proofs?: number;
  } = {}) => {
    const owned = relative(root, batch).replaceAll('\\', '/');
    const retainedTree = () => [...treeDigest(root)].filter(([path]) =>
      path !== 'project.json' && !path.startsWith(`${owned}/`));
    const beforeTree = retainedTree();
    const beforeRecord = readFileSync(record);
    const headPaths = ['.git/HEAD', '.git/refs/heads/main'];
    const head = () => headPaths.map(path => readFileSync(join(root, path)));
    const beforeHead = head();
    const traceFile = join(harness, 'trace');
    writeFileSync(join(harness, 'request.json'), JSON.stringify({ plant: opts.plant ?? '', now: CANDIDATE_NOW }));
    rmSync(traceFile, { force: true });
    const result = Bun.spawnSync([
      process.execPath, ...jobRuntimeExecArgv(), join(import.meta.dir, 'cli-at.ts'), new Date(CANDIDATE_NOW).toISOString(),
      'candidate', 'open', root, '--question', CANDIDATE_QUESTION, '--set', opts.set ?? CANDIDATE_SET,
      '--reviewer', 'synthetic-owner', '--role', 'owner',
    ], { cwd: root, env: { ...env, RIG_CREATE_CANDIDATE_REFUSAL_FIXTURE: harness }, stdout: 'pipe', stderr: 'pipe',
      timeout: 5000, killSignal: 'SIGTERM' });
    const trace = existsSync(traceFile) ? readFileSync(traceFile, 'utf8').trim().split('\n') : [];
    expect(result.stderr.toString(), trace.join('\n')).toMatch(new RegExp(`^rig-create: ${code}:`, 'm'));
    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe('');
    expect(trace).not.toContain('Review listener opened');
    expect(trace.filter(event => event === 'Parts compose')).toHaveLength(opts.compose ?? 0);
    expect(trace.filter(event => event === 'proof sealed')).toHaveLength(opts.proofs ?? 0);
    expect(readFileSync(record).equals(opts.recordAfter ?? beforeRecord)).toBe(true);
    expect(head()).toEqual(beforeHead);
    expect(existsSync(batch)).toBe(false);
    expect(retainedTree()).toEqual(beforeTree);
    return { trace, stderr: result.stderr.toString() };
  };
  return { ...f, harness, setup, raceRecord, assertRefused };
}

test('#1171 candidate open refuses an obsolete set id before compose', () => {
  const f = fixture();
  f.assertRefused(f.setup(), 'CANDIDATE_OPTION_SET_STALE', { set: 'obsolete-set' });
});

test('#1171 candidate open refuses a set that supersedes the request during compose', () => {
  const f = fixture();
  const batch = f.setup();
  const recordAfter = f.raceRecord(true);
  const { trace } = f.assertRefused(batch, 'CANDIDATE_OPTION_SET_STALE', { plant: 'race', recordAfter, compose: 2, proofs: 2 });
  expect(trace).toContain('pending set replaced');
});

test('#1171 candidate open refuses a changed pending digest with the same id during compose', () => {
  const f = fixture();
  const batch = f.setup();
  const recordAfter = f.raceRecord(false);
  const { trace } = f.assertRefused(batch, 'CANDIDATE_OPTION_SET_STALE', { plant: 'race-digest', recordAfter, compose: 2, proofs: 2 });
  expect(trace).toContain('pending set replaced');
});

for (const [plant, path] of [
  ['scene', 'camera-free.scene.json'], ['run', 'producer/compose-run.json'], ['playback', 'package/take.json'],
] as const) {
  test(`#1171 candidate open refuses a one-byte ${plant} change after sealing`, () => {
    const f = fixture();
    const { trace } = f.assertRefused(f.setup(), 'CANDIDATE_RECEIPT_MISMATCH', { plant, compose: 2, proofs: 2 });
    expect(trace).toContain(`planted one byte in ${path}`);
  });
}

test('#1171 candidate open reserves the storage cap before compose', () => {
  const f = fixture();
  const { stderr, trace } = f.assertRefused(f.setup(), 'CANDIDATE_STORAGE_LIMIT', { plant: 'cap' });
  expect(stderr).toContain('Composing keep would cross');
  expect(trace).not.toContain('disk floor sampled');
});

test('#1171 candidate open reserves the free disk floor before compose', () => {
  const f = fixture();
  const { stderr, trace } = f.assertRefused(f.setup(), 'CANDIDATE_STORAGE_LIMIT', { plant: 'disk' });
  expect(stderr).toContain('free disk space is below');
  expect(trace).toEqual(['disk floor sampled']);
});

test('#1171 candidate open refuses changed retained interview option bytes', () => {
  const f = fixture();
  const batch = f.setup();
  const file = join(f.root, CANDIDATE_SET_PATH);
  writeFileSync(file, `${readFileSync(file, 'utf8')} `);
  f.assertRefused(batch, 'INTERVIEW_OPTIONS_FILE');
});

test('#1171 candidate open strictly rechecks the current interview context', () => {
  const f = fixture();
  const batch = f.setup(set => { obj(obj(set.context).run).sha256 = '0'.repeat(64); });
  f.assertRefused(batch, 'INTERVIEW_OPTIONS_STALE');
});

function bindKeyedScene(f: ReturnType<typeof fixture>, offset?: number[]) {
  const path = 'specs/direction/candidate-keyed.scene.json';
  const scene = f.read('specs/direction/compose-scene.json');
  scene.camera = { backdrop: 'backdrop', tracks: { idle: [{ t: 0, pan: [0, 0], zoom: 1 }, { t: 4, pan: [0, 0], zoom: 1 }] } };
  if (offset) obj((scene.characters as JsonObject[])[0]).offset = offset;
  obj(obj(f.options[0]!.fragment).compose).camera_scene = f.write(path, scene);
  return path;
}

test('#1171 candidate open refuses changed bytes behind the camera scene binding', () => {
  const f = fixture();
  const path = bindKeyedScene(f);
  const batch = f.setup();
  const file = join(f.root, path);
  writeFileSync(file, `${readFileSync(file, 'utf8')} `);
  expect(f.assertRefused(batch, 'INTERVIEW_CAMERA_SCENE_INVALID').trace).toEqual([]);
});

test('#1171 candidate open refuses a bound scene with placement from a different option', () => {
  const f = fixture();
  bindKeyedScene(f, [4, 0]);
  f.assertRefused(f.setup(), 'DIRECTION_COMPOSE_CHOICE_MISMATCH');
});

test('#1171 cached proof corruption warns and candidate open rebuilds before rechecking publication', () => {
  const f = fixture();
  const batch = f.setup();
  f.assertRefused(batch, 'CANDIDATE_RECEIPT_MISMATCH', { plant: 'cache', compose: 2, proofs: 2 });
  cpSync(join(f.harness, 'sealed-batch'), batch, { recursive: true });
  writeFileSync(join(batch, 'ready.json'), '{"count":2}\n', { mode: 0o600 });
  const verify = () => {
    const warnings: Finding[] = [];
    checkCandidateReceipts({ dir: f.root, project: f.project, items: collectItems(f.project, { collection: null }), warnings });
    return warnings.map(finding => finding.code);
  };
  expect(verify()).toEqual([]);
  const file = join(candidateOptionPaths(batch)[0]!, 'producer', 'compose-run.json');
  const bytes = readFileSync(file);
  expect(bytes.at(-1)).toBe(10);
  bytes[bytes.length - 1] = 32;
  writeFileSync(file, bytes);
  expect(verify()).toEqual(['CANDIDATE_RECEIPT_MISMATCH']);
  f.assertRefused(batch, 'CANDIDATE_RECEIPT_MISMATCH', { plant: 'run', compose: 2, proofs: 2 });
});
