import { runCiSuite } from './ci-suite.ts';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { SOURCE_CONDITION, SOURCE_CONDITION_FLAG } from '../src/job-writer.ts';
import {
  parsePassedTestNames,
  validateSourceOnlyList,
  type SourceOnlyTestEntry,
} from '../tests/source-only.ts';

interface ChildEntryObservation {
  readonly kind: 'review-act-fetch' | 'parts-review-cli';
  readonly entry: string;
  readonly argv: readonly string[];
  readonly execArgv: readonly string[];
  readonly resolvedReviewHost: string | null;
  readonly resolvedPlay: string;
}

const createRoot = realpathSync(resolve(import.meta.dir, '..'));
const workspaceParent = realpathSync(resolve(createRoot, '..'));
const pins = JSON.parse(readFileSync(join(createRoot, 'scripts/source-ci-pins.json'), 'utf8')) as Record<
  'core' | 'parts' | 'play' | 'review',
  string
>;
const sourceOnlyTests = JSON.parse(
  readFileSync(join(createRoot, 'scripts/source-ci-tests.json'), 'utf8'),
) as readonly SourceOnlyTestEntry[];

validateSourceOnlyList(sourceOnlyTests);
if (sourceOnlyTests.length === 0) throw new Error('source-linked CI requires a non-empty coverage list');

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

const expectedPlaySrc = realpathSync(join(workspaceParent, 'play/src/index.ts'));
const playDistCandidate = join(workspaceParent, 'play/dist/index.js');
if (!existsSync(playDistCandidate)) {
  throw new Error(`source-linked CI requires built play/dist/index.js at ${playDistCandidate}`);
}
const expectedPlayDist = realpathSync(playDistCandidate);

const resolvedCoreRig = realpathSync(Bun.resolveSync('@rig-c/core/rig', createRoot));
const resolvedParts = realpathSync(Bun.resolveSync('@rig-c/parts/src/parts.ts', createRoot));
const resolvedReviewHost = realpathSync(Bun.resolveSync('@rig-c/review/job-host', createRoot));
const resolvedPlayFromReview = realpathSync(Bun.resolveSync('@rig-c/play', dirname(resolvedReviewHost)));

const expectedEntries: [string, string, string][] = [
  ['@rig-c/core/rig', resolvedCoreRig, realpathSync(join(workspaceParent, 'core/src/rig.ts'))],
  ['@rig-c/parts/src/parts.ts', resolvedParts, realpathSync(join(workspaceParent, 'parts/src/parts.ts'))],
  ['@rig-c/review/job-host', resolvedReviewHost, realpathSync(join(workspaceParent, 'review/src/job-host.ts'))],
  ['@rig-c/play (from @rig-c/review)', resolvedPlayFromReview, expectedPlaySrc],
];

for (const [label, actual, expected] of expectedEntries) {
  if (actual !== expected) {
    throw new Error(`${label} did not resolve to sibling source entrypoint: expected ${expected}, got ${actual}`);
  }
}

const reviewPkg = JSON.parse(readFileSync(join(workspaceParent, 'review/package.json'), 'utf8')) as {
  bin?: Record<string, string>;
};
const expectedFetchEntry = realpathSync(join(createRoot, 'src/review-act-runtime.ts'));
const expectedReviewCliEntry = realpathSync(
  join(workspaceParent, 'review', reviewPkg.bin?.['rig-review'] ?? 'src/entry.ts'),
);
const obsRoot = realpathSync(mkdtempSync(join(tmpdir(), 'create-source-ci-obs-')));
const obsPreloadPath = join(obsRoot, 'child-preload-observer.ts');
const obsRecordsDir = join(obsRoot, 'records');
mkdirSync(obsRecordsDir, { recursive: true });

writeFileSync(
  obsPreloadPath,
  [
    "import { randomUUID } from 'node:crypto';",
    "import { realpathSync, writeFileSync } from 'node:fs';",
    "import { dirname, join } from 'node:path';",
    'const selfPath = import.meta.path;',
    'const preloadEnv = process.env.RIG_CREATE_CHILD_OBSERVER_PRELOAD;',
    'for (let i = process.execArgv.length - 1; i >= 0; i--) {',
    '  const arg = process.execArgv[i];',
    '  if (arg === `--preload=${selfPath}` || (preloadEnv && arg === `--preload=${preloadEnv}`)) {',
    '    process.execArgv.splice(i, 1);',
    "  } else if ((arg === '--preload' || arg === '-r') && (process.execArgv[i + 1] === selfPath || (preloadEnv && process.execArgv[i + 1] === preloadEnv))) {",
    '    process.execArgv.splice(i, 2);',
    '  }',
    '}',
    'const logDir = process.env.RIG_CREATE_CHILD_OBSERVER_DIR;',
    'const rawEntry = process.argv[1];',
    'if (logDir && rawEntry) {',
    '  try {',
    '    const entry = realpathSync(rawEntry);',
    '    const fetchEntry = process.env.RIG_CREATE_EXPECTED_FETCH_ENTRY;',
    '    const cliEntry = process.env.RIG_CREATE_EXPECTED_REVIEW_CLI_ENTRY;',
    "    let kind: 'review-act-fetch' | 'parts-review-cli' | null = null;",
    "    if (fetchEntry && entry === fetchEntry) kind = 'review-act-fetch';",
    "    else if (cliEntry && entry === cliEntry && process.argv[2] === 'parts') kind = 'parts-review-cli';",
    '    if (kind) {',
    "      const resolvedReviewHost = kind === 'review-act-fetch'",
    "        ? realpathSync(Bun.resolveSync('@rig-c/review/job-host', dirname(entry)))",
    '        : null;',
    '      const resolveBase = resolvedReviewHost ? dirname(resolvedReviewHost) : dirname(entry);',
    "      const resolvedPlay = realpathSync(Bun.resolveSync('@rig-c/play', resolveBase));",
    '      writeFileSync(',
    '        join(logDir, `${process.pid}-${randomUUID()}.json`),',
    '        JSON.stringify({ kind, entry, argv: process.argv, execArgv: [...process.execArgv], resolvedReviewHost, resolvedPlay }),',
    '      );',
    '    }',
    '  } catch (error) {',
    '    writeFileSync(',
    '      join(logDir, `${process.pid}-${randomUUID()}-error.json`),',
    '      JSON.stringify({ entry: rawEntry, argv: process.argv, execArgv: [...process.execArgv], error: error instanceof Error ? error.message : String(error) }),',
    '    );',
    '  }',
    '}',
  ].join('\n'),
);

try {
  const existingBunOptions = process.env.BUN_OPTIONS?.trim();
  const testRun = runCiSuite(createRoot, 'source', {
      BUN_OPTIONS: existingBunOptions ? `${existingBunOptions} --preload=${obsPreloadPath}` : `--preload=${obsPreloadPath}`,
      RIG_CREATE_CHILD_OBSERVER_PRELOAD: obsPreloadPath,
      RIG_CREATE_CHILD_OBSERVER_DIR: obsRecordsDir,
      RIG_CREATE_EXPECTED_FETCH_ENTRY: expectedFetchEntry,
      RIG_CREATE_EXPECTED_REVIEW_CLI_ENTRY: expectedReviewCliEntry,
  });
  const output = testRun.output;

  if (testRun.exitCode !== 0) {
    process.exit(testRun.exitCode ?? 1);
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

  const obsFiles = readdirSync(obsRecordsDir).sort();
  const errorFiles = obsFiles.filter(name => name.endsWith('-error.json'));
  if (errorFiles.length > 0) {
    const firstError = readFileSync(join(obsRecordsDir, errorFiles[0]!), 'utf8');
    throw new Error(`source-linked CI child preload observer error: ${firstError}`);
  }

  const observations = obsFiles.map(
    name => JSON.parse(readFileSync(join(obsRecordsDir, name), 'utf8')) as ChildEntryObservation,
  );
  const fetchObs = observations.filter(obs => obs.kind === 'review-act-fetch' && obs.entry === expectedFetchEntry);
  const cliObs = observations.filter(obs => obs.kind === 'parts-review-cli' && obs.entry === expectedReviewCliEntry);

  if (fetchObs.length === 0) {
    throw new Error(`source-linked CI refused: no actual review-act-fetch child process observed for ${expectedFetchEntry}`);
  }
  if (cliObs.length === 0) {
    throw new Error(`source-linked CI refused: no actual parts-review-cli child process observed for ${expectedReviewCliEntry}`);
  }

  const classifyPlayTarget = (obs: ChildEntryObservation): 'src' | 'dist' => {
    if (obs.resolvedPlay === expectedPlaySrc) return 'src';
    if (obs.resolvedPlay === expectedPlayDist) return 'dist';
    throw new Error(
      `source-linked CI refused: child ${obs.kind} (${obs.entry}) resolved @rig-c/play to unknown path ${obs.resolvedPlay}`,
    );
  };

  for (const obs of [...fetchObs, ...cliObs]) {
    classifyPlayTarget(obs);
  }

  const childEntryEvidence = {
    'review-act-fetch': {
      observedCount: fetchObs.length,
      entry: expectedFetchEntry,
      sampleArgv: fetchObs[0]!.argv,
      execArgv: fetchObs[0]!.execArgv,
      resolvedReviewHost: fetchObs[0]!.resolvedReviewHost,
      resolvedPlay: fetchObs[0]!.resolvedPlay,
      playTarget: classifyPlayTarget(fetchObs[0]!),
    },
    'parts-review-cli': {
      observedCount: cliObs.length,
      entry: expectedReviewCliEntry,
      sampleArgv: cliObs[0]!.argv,
      execArgv: cliObs[0]!.execArgv,
      resolvedPlay: cliObs[0]!.resolvedPlay,
      playTarget: classifyPlayTarget(cliObs[0]!),
    },
  };
  process.stdout.write(`source-ci child entry evidence: ${JSON.stringify(childEntryEvidence, null, 2)}\n`);
} finally {
  rmSync(obsRoot, { recursive: true, force: true });
}
