import { afterEach, expect, spyOn, test } from 'bun:test';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as checker from '../src/check.ts';
import { sha256 } from '../src/current.ts';
import { recordCommand } from '../src/record.ts';
import { selectSignoffTarget } from '../src/signoff-target.ts';
import { stageIndex } from '../src/stages.ts';
import { TEMPLATES_DIR, type JsonObject } from '../src/templates.ts';
import { checkProject, signoffCommand, testClock } from './clock.ts';
import { arr, fixture, obj, plantLegacyReopen } from './fixtures.ts';
import { treeDigest } from './helpers.ts';

const producer = join(TEMPLATES_DIR, 'example-draft');
const root = 'outputs/rig';
const staged = 'outputs/rig.next';
const config = 'specs/rig/config.json';
const stage = 'rig-review';
const load = (dir: string): JsonObject => JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
const save = (dir: string, project: JsonObject): void => writeFileSync(join(dir, 'project.json'), `${JSON.stringify(project, null, 2)}\n`);
const record = (dir: string) => recordCommand(['rig', dir, '--from', staged, '--config', config], testClock.now());

afterEach(() => testClock.reset());

function stageProducerOutput(dir: string, revision: number): void {
  cpSync(join(producer, 'out'), join(dir, staged), { recursive: true });
  const report = JSON.stringify({ revision });
  writeFileSync(join(dir, staged, 'mesh_report.json'), report);
  const runFile = join(dir, staged, 'run.json');
  const run = JSON.parse(readFileSync(runFile, 'utf8')) as JsonObject;
  obj(arr(run.outputs).find(output => obj(output).path === 'mesh_report.json')).sha256 = sha256(report);
  writeFileSync(runFile, JSON.stringify(run));
  const modelSha = sha256(readFileSync(join(dir, staged, 'check/build/skeleton.model.json')));
  writeFileSync(join(dir, staged, 'check/check.json'), JSON.stringify({
    spec: 'rig-parts-check/1', bar_outcomes: {}, build: { model_sha256: modelSha }, PASS: true,
  }));
}

function relay(dir: string, words: string) {
  const file = join(dir, 'words.txt');
  writeFileSync(file, words);
  return signoffCommand([stage, dir, '--by', 'owner', '--owner-chat', file,
    '--said-at', new Date(testClock.now() - 1000).toISOString(), '--relayed-by', 'operator', '--json']);
}

function recordFirstRig(dir: string): void {
  mkdirSync(join(dir, 'specs/rig'), { recursive: true });
  cpSync(join(producer, 'config.json'), join(dir, config));
  testClock.set('2026-11-26T00:00:00Z');
  stageProducerOutput(dir, 1);
  expect(record(dir).exit).toBe(0);
}

function signedRig(): { dir: string; path: string } {
  const dir = fixture(project => {
    project.stage = stage;
    project.signoffs = arr(project.signoffs).filter(entry => stageIndex(String(obj(entry).stage)) < stageIndex(stage));
    project.versions = [];
  });
  recordFirstRig(dir);
  const index = arr(load(dir).signoffs).length;
  testClock.set('2026-11-26T00:00:02Z');
  expect(relay(dir, 'Approve rig revision one.').exit).toBe(0);
  expect(checkProject(dir).refusals).toEqual([]);
  stageProducerOutput(dir, 2);
  testClock.set('2026-11-26T00:00:04Z');
  return { dir, path: `signoffs[${index}].target` };
}

test('record rig replaces a signed tree and leaves it stale until the owner signs the new output', () => {
  const { dir, path } = signedRig();
  const original = load(dir);
  expect(record(dir).exit).toBe(0);
  expect(readFileSync(join(dir, root, 'mesh_report.json'), 'utf8')).toBe('{"revision":2}');
  expect(load(dir).signoffs).toEqual(original.signoffs!);
  expect(checkProject(dir).refusals).toEqual([expect.objectContaining({ code: 'SIGNOFF_TARGET_STALE', path })]);

  testClock.set('2026-11-26T00:00:06Z');
  expect(relay(dir, 'Approve rig revision two.').exit).toBe(0);
  const fresh = load(dir);
  expect(arr(fresh.signoffs).slice(0, -1)).toEqual(arr(original.signoffs));
  expect(obj(arr(fresh.signoffs).at(-1)).target).toEqual(selectSignoffTarget(dir, fresh, stage)!);
  expect(checkProject(dir).refusals).toEqual([]);
});

test('newer numbered, mixed and missing targets cannot hide the current signature in a mixed project', () => {
  const dir = fixture(project => {
    project.stage = stage;
    project.signoffs = arr(project.signoffs).filter(raw => stageIndex(String(obj(raw).stage)) <= stageIndex(stage));
    project.versions = arr(project.versions).filter(raw => obj(raw).kind === 'rig');
  });
  recordFirstRig(dir);
  const legacy = load(dir);
  const numbered = obj(arr(legacy.signoffs).find(raw => obj(raw).stage === stage));
  const index = arr(legacy.signoffs).length;
  const currentPath = `signoffs[${index}].target`;
  testClock.set('2026-11-26T00:00:02Z');
  expect(relay(dir, 'Approve the current rig output.').exit).toBe(0);
  const project = load(dir);
  const signoffs = arr(project.signoffs);
  const current = obj(signoffs[index]);
  signoffs.push({ ...numbered, at: '2026-11-26T00:00:03.000Z' });
  save(dir, project);

  stageProducerOutput(dir, 2);
  testClock.set('2026-11-26T00:00:06Z');
  expect(checker.activeCurrentSignoffTargetPath(project, 'rig')).toBe(currentPath);
  expect(record(dir).exit).toBe(0);
  const stale = { code: 'SIGNOFF_TARGET_STALE', path: currentPath };
  const targetRefusals = (candidate?: JsonObject) => checkProject(dir, candidate).refusals
    .filter(f => f.code.startsWith('SIGNOFF_TARGET_')).map(({ code, path }) => ({ code, path }));
  expect(targetRefusals()).toEqual([stale]);

  const rebuilt = load(dir);
  arr(rebuilt.signoffs).push({ ...numbered, at: '2026-11-26T00:00:04.000Z', target: { ...obj(numbered.target), ...obj(current.target) } });
  expect(targetRefusals(rebuilt)).toEqual([stale, { code: 'SIGNOFF_TARGET_STALE', path: `signoffs[${index + 2}].target` }]);
  arr(rebuilt.signoffs).push({ ...numbered, at: '2026-11-26T00:00:05.000Z', target: null });
  expect(checker.activeCurrentSignoffTargetPath(rebuilt, 'rig')).toBe(currentPath);
  expect(targetRefusals(rebuilt)).toEqual([
    stale,
    { code: 'SIGNOFF_TARGET_STALE', path: `signoffs[${index + 2}].target` },
    { code: 'SIGNOFF_TARGET_MISSING', path: `signoffs[${index + 3}].target` },
  ]);
});

test.each(['unrelated', 'duplicate'] as const)('record rig refuses a second new finding (%s) before replacing either tree', kind => {
  const { dir, path } = signedRig();
  const extra = kind === 'unrelated'
    ? { code: 'CURRENT_MALFORMED', path: 'current.motion', message: 'current.motion: planted second candidate refusal' }
    : { code: 'SIGNOFF_TARGET_STALE', path, message: `${path}: planted second candidate refusal` };
  const before = readFileSync(join(dir, 'project.json'));
  const installed = treeDigest(join(dir, root));
  const replacement = treeDigest(join(dir, staged));
  const realCheck = checker.checkProject;
  let sawStale = false;
  const check = spyOn(checker, 'checkProject').mockImplementation((...args) => {
    const report = realCheck(...args);
    if (args[0] !== dir || args[1] === undefined) return report;
    sawStale = report.refusals.some(f => f.code === 'SIGNOFF_TARGET_STALE' && f.path === path);
    return { ...report, refusals: [...report.refusals, extra] };
  });
  try {
    expect(() => record(dir)).toThrow(expect.objectContaining({ code: extra.code, message: extra.message }));
    expect(sawStale).toBe(true);
  } finally { check.mockRestore(); }
  expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
  expect(treeDigest(join(dir, root))).toEqual(installed);
  expect(treeDigest(join(dir, staged))).toEqual(replacement);
});

test('reopening the review makes a stale current signature historical', () => {
  const { dir, path } = signedRig();
  expect(record(dir).exit).toBe(0);
  expect(checkProject(dir).refusals).toContainEqual(expect.objectContaining({ code: 'SIGNOFF_TARGET_STALE', path }));
  testClock.set('2026-11-26T00:00:06Z');
  plantLegacyReopen(dir, stage);
  const { refusals, warnings } = checkProject(dir);
  expect([...refusals, ...warnings].some(f => f.path === path && f.code.startsWith('SIGNOFF_TARGET_'))).toBe(false);
});

test.each([['rig', 'rig-review'], ['direction', 'direction-review']] as const)(
  'adopted %s requires a normal record before a new signature and keeps numbered history readable', (kind, review) => {
    const dir = fixture();
    const project = load(dir);
    const index = arr(project.signoffs).findIndex(raw => obj(raw).stage === review);
    const historical = obj(arr(project.signoffs)[index]);
    const path = `signoffs[${index}].target`;
    project.current = { [kind]: { adopted: { version: obj(historical.target).version! } } };
    expect(() => selectSignoffTarget(dir, project, review)).toThrow(expect.objectContaining({
      code: 'SIGNOFF_TARGET_MISSING', message: expect.stringContaining(`record ${kind} --from outputs/${kind}`),
    }));
    testClock.set('2026-11-26T00:00:06Z');
    plantLegacyReopen(dir, review);
    project.reopens = load(dir).reopens!;
    const targetFindings = () => {
      const { refusals, warnings } = checkProject(dir, project);
      return [...refusals, ...warnings].filter(f => f.path === path && f.code.startsWith('SIGNOFF_TARGET_'));
    };
    expect(targetFindings()).toEqual([]);
    obj(historical.target).verdict = 'versions[100].verdicts[0]';
    expect(targetFindings().map(f => f.code)).toEqual(['SIGNOFF_TARGET_STALE']);
  },
);
