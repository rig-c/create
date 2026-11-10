import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { SOURCE_CONDITION, SOURCE_CONDITION_FLAG } from '../src/job-writer.ts';
import {
  parsePassedTestNames,
  validateSourceOnlyList,
  type SourceOnlyTestEntry,
} from '../tests/source-only.ts';

const createRoot = realpathSync(resolve(import.meta.dir, '..'));
const workspaceParent = realpathSync(resolve(createRoot, '..'));
const pins = JSON.parse(readFileSync(join(createRoot, 'scripts/source-ci-pins.json'), 'utf8')) as Record<
  'core' | 'parts' | 'play' | 'review',
  string
>;
const sourceOnlyTests = JSON.parse(
  readFileSync(join(createRoot, 'scripts/source-only-tests.json'), 'utf8'),
) as readonly SourceOnlyTestEntry[];

validateSourceOnlyList(sourceOnlyTests);

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

for (const repoName of ['core', 'parts', 'play', 'review', 'create'] as const) {
  const repoDir = repoName === 'create' ? createRoot : realpathSync(join(workspaceParent, repoName));
  const trackedDiff = Bun.spawnSync(
    ['git', 'status', '--porcelain', '--untracked-files=no', '--', 'package.json', 'bun.lock', 'package-lock.json'],
    { cwd: repoDir, stdout: 'pipe', stderr: 'pipe' },
  );
  if (trackedDiff.exitCode !== 0 || trackedDiff.stdout.toString('utf8').trim() !== '') {
    throw new Error(`source-linked CI refused: tracked package/lockfile modified in ${repoName}`);
  }
}

const expectedPkgDirs: [string, string, string][] = [
  ['create/node_modules/@rig-c/core', realpathSync(join(createRoot, 'node_modules/@rig-c/core')), realpathSync(join(workspaceParent, 'core'))],
  ['create/node_modules/@rig-c/parts', realpathSync(join(createRoot, 'node_modules/@rig-c/parts')), realpathSync(join(workspaceParent, 'parts'))],
  ['create/node_modules/@rig-c/review', realpathSync(join(createRoot, 'node_modules/@rig-c/review')), realpathSync(join(workspaceParent, 'review'))],
  ['review/node_modules/@rig-c/play', realpathSync(join(workspaceParent, 'review/node_modules/@rig-c/play')), realpathSync(join(workspaceParent, 'play'))],
];

for (const [label, actual, expected] of expectedPkgDirs) {
  if (actual !== expected) {
    throw new Error(`${label} did not link to sibling checkout directory: expected ${expected}, got ${actual}`);
  }
}

const resolvedCoreRig = realpathSync(Bun.resolveSync('@rig-c/core/rig', createRoot));
const resolvedParts = realpathSync(Bun.resolveSync('@rig-c/parts/src/parts.ts', createRoot));
const resolvedReviewHost = realpathSync(Bun.resolveSync('@rig-c/review/job-host', createRoot));
const resolvedPlayFromReview = realpathSync(Bun.resolveSync('@rig-c/play', dirname(resolvedReviewHost)));

const expectedEntries: [string, string, string][] = [
  ['@rig-c/core/rig', resolvedCoreRig, realpathSync(join(workspaceParent, 'core/src/rig.ts'))],
  ['@rig-c/parts/src/parts.ts', resolvedParts, realpathSync(join(workspaceParent, 'parts/src/parts.ts'))],
  ['@rig-c/review/job-host', resolvedReviewHost, realpathSync(join(workspaceParent, 'review/src/job-host.ts'))],
  ['@rig-c/play (from @rig-c/review)', resolvedPlayFromReview, realpathSync(join(workspaceParent, 'play/src/index.ts'))],
];

for (const [label, actual, expected] of expectedEntries) {
  if (actual !== expected) {
    throw new Error(`${label} did not resolve to sibling source entrypoint: expected ${expected}, got ${actual}`);
  }
}

const testFiles = [...new Set(sourceOnlyTests.map(entry => entry.file))];
const testRun = Bun.spawnSync([process.execPath, SOURCE_CONDITION_FLAG, 'test', ...testFiles], {
  cwd: createRoot,
  env: { ...process.env, RIG_CREATE_SOURCE_CI: '1' },
  stdout: 'pipe',
  stderr: 'pipe',
});

const output = `${testRun.stdout.toString('utf8')}\n${testRun.stderr.toString('utf8')}`;
process.stdout.write(output);

if (testRun.exitCode !== 0) {
  process.exit(testRun.exitCode ?? 1);
}

if (/\b[1-9]\d*\s+skip\b/.test(output) || output.includes('tests skipped:')) {
  throw new Error('source-linked CI refused: one or more tests were skipped');
}

const passedNames = parsePassedTestNames(output);
const requiredNames = [
  '#382 draft publication binds inputs[0] in producer.source, seals it in files, and refuses missing or drifted painting bytes before manifest write',
  ...sourceOnlyTests.map(entry => entry.displayName ?? entry.name),
];

for (const testName of requiredNames) {
  if (!passedNames.has(testName)) {
    throw new Error(`source-linked CI refused: required test did not execute and pass with exact name: ${testName}`);
  }
}
