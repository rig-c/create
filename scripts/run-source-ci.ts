import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { SOURCE_CONDITION, SOURCE_CONDITION_FLAG } from '../src/job-writer.ts';

const REQUIRED_TESTS = [
  '#382 draft publication binds inputs[0] in producer.source, seals it in files, and refuses missing or drifted painting bytes before manifest write',
  '#382 source-linked draft publication serves /review-painting and stage-parts painting metadata with and without painting_in_rig',
] as const;

const createRoot = realpathSync(resolve(import.meta.dir, '..'));
const workspaceParent = realpathSync(resolve(createRoot, '..'));
const pins = JSON.parse(readFileSync(join(createRoot, 'scripts/source-ci-pins.json'), 'utf8')) as Record<
  'core' | 'parts' | 'play' | 'review',
  string
>;

const hasSourceCondition =
  process.execArgv.includes(SOURCE_CONDITION_FLAG) ||
  process.execArgv.some((arg, index, argv) => arg === '--conditions' && argv[index + 1] === SOURCE_CONDITION);
if (!hasSourceCondition) {
  throw new Error(`source-linked CI requires ${SOURCE_CONDITION_FLAG} in process.execArgv`);
}

for (const [name, expectedSha] of Object.entries(pins) as [keyof typeof pins, string][]) {
  const siblingDir = realpathSync(join(workspaceParent, name));
  const head = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: siblingDir, stdout: 'pipe', stderr: 'pipe' });
  const actualSha = head.stdout.toString('utf8').trim();
  if (head.exitCode !== 0 || actualSha !== expectedSha) {
    throw new Error(`sibling ${name} HEAD mismatch: expected ${expectedSha}, got ${actualSha}`);
  }
}

const resolvedCore = realpathSync(Bun.resolveSync('@rig-c/core', createRoot));
const resolvedParts = realpathSync(Bun.resolveSync('@rig-c/parts', createRoot));
const resolvedReviewHost = realpathSync(Bun.resolveSync('@rig-c/review/job-host', createRoot));
const resolvedPlayFromReview = realpathSync(Bun.resolveSync('@rig-c/play', dirname(resolvedReviewHost)));

const expectedEntries: [string, string, string][] = [
  ['@rig-c/core', resolvedCore, realpathSync(join(workspaceParent, 'core/src/index.ts'))],
  ['@rig-c/parts', resolvedParts, realpathSync(join(workspaceParent, 'parts/src/index.ts'))],
  ['@rig-c/review/job-host', resolvedReviewHost, realpathSync(join(workspaceParent, 'review/src/job-host.ts'))],
  ['@rig-c/play (from @rig-c/review)', resolvedPlayFromReview, realpathSync(join(workspaceParent, 'play/src/index.ts'))],
];

for (const [label, actual, expected] of expectedEntries) {
  if (actual !== expected) {
    throw new Error(`${label} did not resolve to sibling source entrypoint: expected ${expected}, got ${actual}`);
  }
}

const testRun = Bun.spawnSync(
  [process.execPath, SOURCE_CONDITION_FLAG, 'test', 'tests/job-publication.test.ts'],
  {
    cwd: createRoot,
    env: { ...process.env, RIG_CREATE_SOURCE_CI: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
  },
);

const output = `${testRun.stdout.toString('utf8')}\n${testRun.stderr.toString('utf8')}`;
process.stdout.write(output);

if (testRun.exitCode !== 0) {
  process.exit(testRun.exitCode ?? 1);
}

if (/\b[1-9]\d*\s+skip\b/.test(output) || output.includes('tests skipped:')) {
  throw new Error('source-linked CI refused: one or more tests were skipped');
}

for (const testName of REQUIRED_TESTS) {
  const passedLine = `(pass) ${testName}`;
  const checkLine = `✓ ${testName}`;
  if (!output.includes(passedLine) && !output.includes(checkLine)) {
    throw new Error(`source-linked CI refused: required test did not execute and pass: ${testName}`);
  }
}
