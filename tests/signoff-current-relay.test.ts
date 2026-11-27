import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { outputSetHash, treeFiles } from '../src/current.ts';
import { DIRECTION_CONTRACT } from '../src/direction.ts';
import { JOB_BINDING_FILE, writePrivateJson } from '../src/job-outbox.ts';
import { currentJobIdentity } from '../src/job-publication.ts';
import { signoffCommand as rawSignoff } from '../src/signoff.ts';
import { stageIndex } from '../src/stages.ts';
import type { JsonObject } from '../src/templates.ts';
import { advanceCommand, checkProject, signoffCommand, testClock } from './clock.ts';
import { arr, fixture, obj, withdrawSignature } from './fixtures.ts';
import { clockedCli } from './helpers.ts';
import { seedStoredVersionSignoff } from './historical-review-fixture.ts';

const words = '\uFEFF  Approve this output.\r\n\r\n';
const builtAt = '2026-11-25T01:00:00.000Z';
const saidAt = '2026-11-25T01:00:02Z';
const writtenAt = '2026-11-25T01:00:03.000Z';
const load = (dir: string): JsonObject => JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
const save = (dir: string, project: JsonObject): void => writeFileSync(join(dir, 'project.json'), `${JSON.stringify(project, null, 2)}\n`);

afterEach(() => testClock.reset());

function setup(stage: 'rig-review' | 'post', numbered = false): string {
  const dir = fixture(project => {
    project.stage = stage;
    project.signoffs = arr(project.signoffs).filter(entry => stageIndex(String(obj(entry).stage)) < stageIndex(stage));
    project.versions = arr(project.versions).filter(entry => obj(entry).kind === 'rig' && (stage === 'post' || numbered));
    if (numbered) for (const version of arr(project.versions)) obj(version).verdicts = [];
  });
  testClock.set(writtenAt);
  writeFileSync(join(dir, 'words.txt'), words);
  return dir;
}

function recordFixtureOutput(dir: string, kind: 'rig' | 'direction', at = builtAt): { node: JsonObject; product: string } {
  const root = `outputs/${kind}`;
  const product = join(dir, root, 'result.json');
  mkdirSync(join(dir, root), { recursive: true });
  writeFileSync(product, '{"result":"synthetic"}\n');
  writeFileSync(join(dir, root, 'run.json'), '{}\n');
  const files = treeFiles(dir, root);
  const binding = (name: string) => {
    const { path, sha256 } = files.find(file => file.path === `${root}/${name}`)!;
    return { path, sha256 };
  };
  // Preserve the writer's rebuild key order while planting the recorded node.
  const node = { at, built_by: 'agent', built_from: [], built_with: {},
    files: files.map(({ bytes, path, sha256 }) => ({ bytes, path, sha256 })), files_sha256: outputSetHash(files),
    rebuild: { recorded: false, note: 'synthetic fixture' }, report: binding('result.json'), run: binding('run.json') };
  const project = load(dir);
  project.current = { [kind]: node };
  save(dir, project);
  return { node, product };
}

function relayArgs(dir: string, stage: string, omitted?: string): string[] {
  const relay = { '--owner-chat': join(dir, 'words.txt'), '--said-at': saidAt, '--relayed-by': 'operator' };
  return [stage, dir, '--by', 'owner', '--json', ...Object.entries(relay).filter(([flag]) => flag !== omitted).flat()];
}

function refusesUnchanged(dir: string, code: string, write: () => unknown): void {
  const before = readFileSync(join(dir, 'project.json'));
  expect(write).toThrow(expect.objectContaining({ code }));
  expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
}

test.each(['rig', 'direction'] as const)('relays owner chat to current.%s and check detects changed output bytes', kind => {
  const stage = kind === 'rig' ? 'rig-review' : 'direction-review';
  const dir = setup(kind === 'rig' ? 'rig-review' : 'post');
  const { node, product } = recordFixtureOutput(dir, kind);
  if (kind === 'direction') {
    testClock.set('2026-11-25T01:00:01Z');
    expect(advanceCommand(['direction-review', dir]).exit).toBe(0);
    testClock.set(writtenAt);
  }
  const before = load(dir);
  const result = signoffCommand(relayArgs(dir, stage));
  expect(result.exit).toBe(0);
  const canonical = { ...node, rebuild: { note: 'synthetic fixture', recorded: false } };
  const signed = {
    stage, checkpoint: null, by: 'owner', at: writtenAt, verbatim: words,
    source: 'owner chat, relayed', said_at: saidAt, relayed_by: 'operator',
    target: { subject: `current.${kind}`, record_sha256: createHash('sha256').update(JSON.stringify(canonical)).digest('hex'), files_sha256: node.files_sha256 },
  };
  expect(JSON.parse(result.stdout)).toEqual(signed);
  const after = load(dir);
  expect(after).toEqual({ ...before, signoffs: [...arr(before.signoffs), signed] });
  expect(checkProject(dir).refusals).toEqual([]);

  writeFileSync(product, '{"result":"changed"}\n');
  expect(checkProject(dir).refusals).toContainEqual(expect.objectContaining({
    code: 'SIGNOFF_TARGET_STALE', path: `signoffs[${arr(before.signoffs).length}].target`,
  }));
});

test.each(['--owner-chat', '--said-at', '--relayed-by'])('current relay without %s refuses before writing', omitted => {
  const dir = setup('rig-review');
  recordFixtureOutput(dir, 'rig');
  refusesUnchanged(dir, 'OWNER_CHAT_INVALID', () => signoffCommand(relayArgs(dir, 'rig-review', omitted)));
});

test.each(['rig', 'direction'] as const)('current.%s signing refuses a raw verbatim file', kind => {
  const stage = kind === 'rig' ? 'rig-review' : 'direction-review';
  const dir = setup(kind === 'rig' ? 'rig-review' : 'post');
  recordFixtureOutput(dir, kind);
  if (kind === 'direction') expect(advanceCommand([stage, dir]).exit).toBe(0);
  refusesUnchanged(dir, 'OWNER_CHAT_REQUIRED', () => signoffCommand([stage, dir, '--by', 'owner', '--verbatim-file', join(dir, 'words.txt')]));
});

test.each(['verbatim', 'said_at', 'relayed_by'])('check refuses a persisted current relay missing %s', field => {
  const dir = setup('rig-review');
  recordFixtureOutput(dir, 'rig');
  signoffCommand(relayArgs(dir, 'rig-review'));
  const project = load(dir);
  const index = arr(project.signoffs).length - 1;
  delete obj(arr(project.signoffs)[index])[field];
  expect(checkProject(dir, project).refusals).toContainEqual(expect.objectContaining({
    code: 'OWNER_CHAT_INVALID', path: `project.json.signoffs[${index}]`,
  }));
});

test('numbered relay and --version signoff refuse with NUMBERED_WRITER_REMOVED before writing', () => {
  const dir = setup('rig-review', true);
  refusesUnchanged(dir, 'NUMBERED_WRITER_REMOVED', () => signoffCommand([...relayArgs(dir, 'rig-review'), '--version', '2']));
});

test('stored numbered signoff still checks clean with raw verbatim for the accepted version', () => {
  const dir = fixture();
  const at = withdrawSignature(dir, 'rig-review');
  testClock.set(at);
  writeFileSync(join(dir, 'words.txt'), words);
  refusesUnchanged(dir, 'NUMBERED_WRITER_REMOVED', () =>
    signoffCommand(['rig-review', dir, '--by', 'owner', '--verbatim-file', join(dir, 'words.txt'), '--version', '2', '--json']));
  const signed = seedStoredVersionSignoff(dir, 'rig-review', 2, { by: 'owner', at, verbatim: words });
  expect(signed).toMatchObject({ verbatim: words, target: { version: 2, verdict: 'versions[1].verdicts[0]' } });
  expect(checkProject(dir).refusals).toEqual([]);
});

test('current relay requires its current output even when a numbered verdict was accepted', () => {
  const dir = fixture();
  testClock.set(writtenAt);
  writeFileSync(join(dir, 'words.txt'), words);
  const project = load(dir);
  project.current = {};
  save(dir, project);
  refusesUnchanged(dir, 'SIGNOFF_TARGET_STALE', () => signoffCommand(relayArgs(dir, 'rig-review')));
  recordFixtureOutput(dir, 'rig');
  refusesUnchanged(dir, 'NUMBERED_WRITER_REMOVED', () => signoffCommand([...relayArgs(dir, 'rig-review'), '--version', '2']));
});

test('current CLI rejects --version before relay and assemble-only draft validation', () => {
  const dir = setup('rig-review');
  const project = load(dir);
  const draftId = 'legacy-draft';
  project.drafts = [...arr(project.drafts ?? []), { id: draftId, layout: 'assemble-only' }];
  project.current = {};
  save(dir, project);
  const record = join(dir, 'project.json');
  const before = readFileSync(record);
  for (const args of [
    ['rig-review', dir, '--by', 'owner', '--version', '2'],
    [...relayArgs(dir, 'rig-review'), '--version', draftId],
  ]) {
    const result = Bun.spawnSync([process.execPath, ...clockedCli(), 'signoff', ...args], { stdout: 'pipe', stderr: 'pipe' });
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toMatch(/^rig-create: NUMBERED_WRITER_REMOVED: project\.json: signoff --version was removed/);
    expect(result.stdout.toString()).toBe('');
    expect(readFileSync(record)).toEqual(before);
  }
});

test('current direction must predate a new advance and can be replaced after the move', () => {
  const dir = setup('post');
  const advance = () => advanceCommand(['direction-review', dir]);
  refusesUnchanged(dir, 'DIRECTION_REVIEW_POST_MISSING', advance);
  recordFixtureOutput(dir, 'direction');
  testClock.set('2026-11-25T00:59:59Z');
  refusesUnchanged(dir, 'DIRECTION_REVIEW_POST_MISSING', advance);
  testClock.set(writtenAt);
  expect(advance().exit).toBe(0);
  expect(checkProject(dir).refusals).toEqual([]);
  const { advances } = load(dir);

  testClock.set('2026-11-25T02:00:00Z');
  recordFixtureOutput(dir, 'direction', testClock.iso());
  expect(load(dir).advances).toEqual(advances);
  expect(checkProject(dir).refusals).toEqual([]);
});

test('a numbered historical move keeps its numbered evidence rules after current is recorded', () => {
  const dir = fixture(project => {
    project.stage = 'post';
    project.signoffs = arr(project.signoffs).filter(entry => obj(entry).stage !== 'direction-review');
  });
  testClock.set(writtenAt);
  expect(advanceCommand(['direction-review', dir]).exit).toBe(0);
  const project = load(dir);
  const contract = { schema: DIRECTION_CONTRACT, adopted_at: builtAt, grandfathered_posts: [] };
  const findings = (candidate: JsonObject) => checkProject(dir, candidate).refusals.filter(finding => finding.code === 'DIRECTION_REVIEW_POST_MISSING');
  const numberedRefusals = findings({ ...project, direction_contract: contract });
  expect(numberedRefusals).toHaveLength(1);

  testClock.set('2026-11-25T02:00:00Z');
  recordFixtureOutput(dir, 'direction', testClock.iso());
  expect(checkProject(dir).refusals).toEqual([]);
  expect(findings({ ...load(dir), direction_contract: contract })).toEqual(numberedRefusals);
});

test('signoff --from-review is retired, while check still validates a stored numbered target alongside current', () => {
  const dir = realpathSync(fixture());
  const storedNumbered = structuredClone(arr(load(dir).signoffs).map(obj).find(s => s.stage === 'rig-review')!);
  recordFixtureOutput(dir, 'rig');
  const at = withdrawSignature(dir, 'rig-review');
  const jobId = 'synthetic-signoff-job';
  const origin = 'http://127.0.0.1:43123';
  const reviewer = { id: 'owner', role: 'owner' } as const;
  const identity = currentJobIdentity({ root: dir, stateDir: 'unused-state', fingerprint: 'synthetic', reviewer }, dir);
  writePrivateJson(join(dir, JOB_BINDING_FILE), { schema: 'rig-create/job-binding@1', identity, jobId, origin, fetchCapability: 'synthetic-read-grant' }, true);
  const project = load(dir);
  project.review_job = { jobId, origin };
  save(dir, project);
  const before = readFileSync(join(dir, 'project.json'));
  expect(() => rawSignoff(['rig-review', dir, '--from-review', 'sign-rig', '--json'], testClock.now()))
    .toThrow(expect.objectContaining({ code: 'SIGNOFF_FROM_REVIEW_REMOVED', exitCode: 2 }));
  expect(readFileSync(join(dir, 'project.json'))).toEqual(before);

  const seeded = load(dir);
  seeded.signoffs = [...arr(seeded.signoffs), { ...storedNumbered, at }];
  save(dir, seeded);
  expect(checkProject(dir).refusals).toEqual([]);
  const after = load(dir);
  expect(after.current).toEqual(project.current);
  obj(arr(after.versions)[1]).verdicts = [];
  expect(checkProject(dir, after).refusals).toContainEqual(expect.objectContaining({
    code: 'SIGNOFF_TARGET_STALE', path: `signoffs[${arr(after.signoffs).length - 1}].target`,
  }));
});
