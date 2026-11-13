import { expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { jobHostStateRoot, jobPrivateRoot, readWriterBinding } from '../src/job-outbox.ts';
import { SOURCE_CONDITION, SOURCE_CONDITION_FLAG, jobRuntimeCommand, jobRuntimeExecArgv } from '../src/job-writer.ts';
import { PINNED_PACKAGES } from '../src/pins.ts';
import { readTemplate } from '../src/templates.ts';

const EXACT = /^\d+\.\d+\.\d+$/;
const REPO = join(import.meta.dir, '..');
const CLI = join(REPO, 'src/cli.ts');

function resolveInstalledPackageDir(name: 'core' | 'parts' | 'play' | 'review'): string {
  const reviewDir = realpathSync(join(REPO, 'node_modules/@rig-c/review'));
  if (name === 'play') {
    const fromReview = join(reviewDir, 'node_modules/@rig-c/play');
    return realpathSync(existsSync(fromReview) ? fromReview : dirname(dirname(realpathSync(Bun.resolveSync('@rig-c/play', reviewDir)))));
  }
  return realpathSync(join(REPO, 'node_modules/@rig-c', name));
}

function linkSourcePackages(baseDir: string): {
  createRoot: string;
  cliPath: string;
  jobWriterPath: string;
  playSourceEntry: string;
  playDistEntry: string;
  reviewHostSourceEntry: string;
  reviewCliEntry: string;
  fetchRuntimeEntry: string;
} {
  const wsRoot = join(baseDir, 'linked-ws');
  const createRoot = join(wsRoot, 'packages/create');
  mkdirSync(join(wsRoot, 'node_modules/@rig-c'), { recursive: true });
  mkdirSync(join(createRoot, 'node_modules/@rig-c'), { recursive: true });
  for (const entry of readdirSync(join(REPO, 'node_modules')).filter(name => name !== '@rig-c')) {
    const target = realpathSync(join(REPO, 'node_modules', entry));
    symlinkSync(target, join(wsRoot, 'node_modules', entry));
    symlinkSync(target, join(createRoot, 'node_modules', entry));
  }
  for (const name of ['core', 'parts', 'play', 'review'] as const) {
    const pkgSource = resolveInstalledPackageDir(name);
    const pkgTarget = join(wsRoot, 'packages', name);
    cpSync(pkgSource, pkgTarget, {
      recursive: true,
      filter: src => {
        const rel = src.slice(pkgSource.length);
        return rel !== '/.git' && !rel.startsWith('/.git/') && rel !== '/node_modules' && !rel.startsWith('/node_modules/');
      },
    });
    if (name === 'play') {
      if (!existsSync(join(pkgTarget, 'src/index.ts'))) {
        mkdirSync(join(pkgTarget, 'src'), { recursive: true });
        writeFileSync(join(pkgTarget, 'src/index.ts'), "export * from '../dist/index.js';\nexport const PLAY_SOURCE_LINKED = true;\n");
      }
      writeFileSync(
        join(pkgTarget, 'dist/index.js'),
        `${readFileSync(join(pkgTarget, 'dist/index.js'), 'utf8')}\n;(globalThis).__RIG_PLAY_LOADED_ENTRY ??= import.meta.path;\n`,
      );
      writeFileSync(
        join(pkgTarget, 'src/index.ts'),
        `${readFileSync(join(pkgTarget, 'src/index.ts'), 'utf8')}\n;(globalThis as Record<string, unknown>).__RIG_PLAY_LOADED_ENTRY = import.meta.path;\n`,
      );
    }
    if (existsSync(join(pkgSource, 'node_modules'))) {
      mkdirSync(join(pkgTarget, 'node_modules/@rig-c'), { recursive: true });
      for (const entry of readdirSync(join(pkgSource, 'node_modules')).filter(dep => dep !== '@rig-c')) {
        symlinkSync(realpathSync(join(pkgSource, 'node_modules', entry)), join(pkgTarget, 'node_modules', entry));
      }
      for (const dep of ['core', 'parts', 'play', 'review'] as const) {
        symlinkSync(join(wsRoot, 'packages', dep), join(pkgTarget, 'node_modules/@rig-c', dep), 'dir');
      }
    }
    symlinkSync(pkgTarget, join(wsRoot, 'node_modules/@rig-c', name), 'dir');
    symlinkSync(pkgTarget, join(createRoot, 'node_modules/@rig-c', name), 'dir');
  }
  cpSync(join(REPO, 'package.json'), join(createRoot, 'package.json'));
  cpSync(join(REPO, 'src'), join(createRoot, 'src'), { recursive: true });
  symlinkSync(join(REPO, 'templates'), join(createRoot, 'templates'), 'dir');
  const reviewPkg = JSON.parse(readFileSync(join(wsRoot, 'packages/review/package.json'), 'utf8')) as {
    bin?: Record<string, string>;
  };
  return {
    createRoot: realpathSync(createRoot),
    cliPath: join(createRoot, 'src/cli.ts'),
    jobWriterPath: join(createRoot, 'src/job-writer.ts'),
    playSourceEntry: realpathSync(join(wsRoot, 'packages/play/src/index.ts')),
    playDistEntry: realpathSync(join(wsRoot, 'packages/play/dist/index.js')),
    reviewHostSourceEntry: realpathSync(join(wsRoot, 'packages/review/src/job-host.ts')),
    reviewCliEntry: realpathSync(join(wsRoot, 'packages/review', reviewPkg.bin?.['rig-review'] ?? 'src/entry.ts')),
    fetchRuntimeEntry: realpathSync(join(createRoot, 'src/review-act-runtime.ts')),
  };
}

test('every pin is an exact version, no range', () => {
  expect(Object.keys(PINNED_PACKAGES).sort()).toEqual(['@rig-c/core', '@rig-c/parts']);
  for (const [pkg, version] of Object.entries(PINNED_PACKAGES)) {
    expect(`${pkg}@${version}`).toBe(`${pkg}@${version.match(EXACT)?.[0]}`);
  }
});

test("the template's waypoints were read from the pinned @rig-c/parts", () => {
  const interview = readTemplate('project.json').interview;
  if (interview === null || typeof interview !== 'object' || Array.isArray(interview)) {
    throw new Error('template has no interview object');
  }
  expect(interview.question_set).toContain(`@rig-c/parts ${PINNED_PACKAGES['@rig-c/parts']})`);
});

test('package.json, bun.lock, and tsconfig.json declare direct @rig-c/core and the @rig-c/source condition', () => {
  const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as {
    private?: unknown;
    version?: unknown;
    dependencies?: Record<string, string>;
  };
  expect(pkg.private).toBeUndefined();
  expect(pkg.version).toBe('1.0.3');
  expect(pkg.dependencies?.['@rig-c/core']).toBe(PINNED_PACKAGES['@rig-c/core']);
  expect(pkg.dependencies?.['@rig-c/parts']).toBe(PINNED_PACKAGES['@rig-c/parts']);

  const lock = Bun.JSONC.parse(readFileSync(join(REPO, 'bun.lock'), 'utf8')) as {
    workspaces?: Record<string, { dependencies?: Record<string, string> }>;
    packages?: Record<string, unknown[]>;
  };
  expect(lock.workspaces?.['']?.dependencies).toEqual(pkg.dependencies);
  expect(lock.packages?.['@rig-c/core']?.[0]).toBe(`@rig-c/core@${PINNED_PACKAGES['@rig-c/core']}`);

  const tsconfig = JSON.parse(readFileSync(join(REPO, 'tsconfig.json'), 'utf8')) as {
    compilerOptions?: { customConditions?: string[] };
  };
  expect(tsconfig.compilerOptions?.customConditions).toContain(SOURCE_CONDITION);
});

test('jobRuntimeExecArgv forwards only the explicit @rig-c/source condition and drops arbitrary execArgv flags', () => {
  expect(jobRuntimeExecArgv([])).toEqual([]);
  expect(jobRuntimeExecArgv(['--smol', '--conditions=other', '--conditions', 'other'])).toEqual([]);
  expect(jobRuntimeExecArgv(['-e', SOURCE_CONDITION_FLAG, '--eval', SOURCE_CONDITION_FLAG])).toEqual([]);
  expect(jobRuntimeExecArgv(['--', SOURCE_CONDITION_FLAG])).toEqual([]);
  expect(jobRuntimeExecArgv([SOURCE_CONDITION_FLAG])).toEqual([SOURCE_CONDITION_FLAG]);
  expect(jobRuntimeExecArgv(['--smol', '--conditions', SOURCE_CONDITION, '--conditions=other'])).toEqual([SOURCE_CONDITION_FLAG]);
  expect(jobRuntimeCommand('publish', '/tmp/runtime.ts', ['--smol', SOURCE_CONDITION_FLAG])).toEqual([
    process.execPath,
    SOURCE_CONDITION_FLAG,
    '/tmp/runtime.ts',
    'publish',
  ]);
});

test('Bun parent-to-child job runtime launch resolves a synthetic linked source/dist package in both source and default modes', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'create-source-cond-')));
  try {
    const pkgDir = join(dir, 'node_modules', '@rig-c', 'synth-play');
    mkdirSync(join(pkgDir, 'src'), { recursive: true });
    mkdirSync(join(pkgDir, 'dist'), { recursive: true });
    writeFileSync(
      join(pkgDir, 'package.json'),
      JSON.stringify(
        {
          name: '@rig-c/synth-play',
          version: '0.0.0-synthetic',
          type: 'module',
          exports: {
            '.': {
              '@rig-c/source': './src/index.ts',
              types: './dist/index.d.ts',
              import: './dist/index.js',
              default: './dist/index.js',
            },
          },
        },
        null,
        2,
      ),
    );
    writeFileSync(join(pkgDir, 'src/index.ts'), "export const PLAY_MODE = 'source';\nexport type SourceOnlyMarker = { readonly linked: true };\n");
    writeFileSync(join(pkgDir, 'dist/index.js'), "export const PLAY_MODE = 'dist';\n");
    writeFileSync(join(pkgDir, 'dist/index.d.ts'), "export declare const PLAY_MODE: 'dist';\n");

    const fallbackPkgDir = join(dir, 'node_modules', '@rig-c', 'synth-registry');
    mkdirSync(join(fallbackPkgDir, 'dist'), { recursive: true });
    writeFileSync(
      join(fallbackPkgDir, 'package.json'),
      JSON.stringify(
        {
          name: '@rig-c/synth-registry',
          version: '1.23.0-synthetic',
          type: 'module',
          exports: {
            '.': {
              types: './dist/index.d.ts',
              import: './dist/index.js',
              default: './dist/index.js',
            },
          },
        },
        null,
        2,
      ),
    );
    writeFileSync(join(fallbackPkgDir, 'dist/index.js'), "export const REGISTRY_MODE = 'dist-fallback';\n");
    writeFileSync(join(fallbackPkgDir, 'dist/index.d.ts'), "export declare const REGISTRY_MODE: 'dist-fallback';\n");

    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({
        extends: join(REPO, 'tsconfig.json'),
        compilerOptions: { types: [] },
        include: ['typecheck-probe.ts'],
      }),
    );
    writeFileSync(
      join(dir, 'typecheck-probe.ts'),
      [
        "import { PLAY_MODE, type SourceOnlyMarker } from '@rig-c/synth-play';",
        "import { REGISTRY_MODE } from '@rig-c/synth-registry';",
        'const marker: SourceOnlyMarker = { linked: true };',
        "const modes: ['source', 'dist-fallback'] = [PLAY_MODE, REGISTRY_MODE];",
        'void marker; void modes;',
      ].join('\n'),
    );
    const tsc = Bun.spawnSync([process.execPath, join(REPO, 'node_modules/typescript/bin/tsc'), '--noEmit', '-p', join(dir, 'tsconfig.json')], {
      cwd: dir,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect({ exit: tsc.exitCode, stdout: tsc.stdout.toString('utf8'), stderr: tsc.stderr.toString('utf8') }).toEqual({
      exit: 0,
      stdout: '',
      stderr: '',
    });

    const linkedWs = linkSourcePackages(dir);
    const childScript = join(dir, 'child-runtime.ts');
    writeFileSync(
      childScript,
      [
        "import { PLAY_MODE } from '@rig-c/synth-play';",
        'console.log(JSON.stringify({ mode: PLAY_MODE, execArgv: process.execArgv, action: process.argv[2] }));',
      ].join('\n'),
    );

    const sourceParentScript = join(dir, 'parent-source.ts');
    writeFileSync(
      sourceParentScript,
      [
        "import { realpathSync } from 'node:fs';",
        "import { PLAY_MODE } from '@rig-c/synth-play';",
        `import { jobRuntimeCommand } from ${JSON.stringify(linkedWs.jobWriterPath)};`,
        `const resolvedPlay = realpathSync(Bun.resolveSync('@rig-c/play', ${JSON.stringify(join(dir, 'linked-ws/packages/create/node_modules/@rig-c/review/src'))}));`,
        `const child = Bun.spawnSync(jobRuntimeCommand('publish', ${JSON.stringify(childScript)}), { cwd: ${JSON.stringify(dir)}, stdout: 'pipe', stderr: 'pipe' });`,
        'if (child.exitCode !== 0) { process.stderr.write(child.stderr); process.exit(child.exitCode); }',
        "console.log(JSON.stringify({ parentMode: PLAY_MODE, resolvedPlay, parentExecArgv: process.execArgv, child: JSON.parse(child.stdout.toString('utf8')) }));",
      ].join('\n'),
    );

    const distParentScript = join(dir, 'parent-dist.ts');
    writeFileSync(
      distParentScript,
      [
        "import { realpathSync } from 'node:fs';",
        "import { PLAY_MODE } from '@rig-c/synth-play';",
        `import { jobRuntimeCommand } from ${JSON.stringify(join(REPO, 'src/job-writer.ts'))};`,
        `const resolvedPlay = realpathSync(Bun.resolveSync('@rig-c/play', ${JSON.stringify(join(REPO, 'node_modules/@rig-c/review/src'))}));`,
        `const child = Bun.spawnSync(jobRuntimeCommand('publish', ${JSON.stringify(childScript)}), { cwd: ${JSON.stringify(dir)}, stdout: 'pipe', stderr: 'pipe' });`,
        'if (child.exitCode !== 0) { process.stderr.write(child.stderr); process.exit(child.exitCode); }',
        "console.log(JSON.stringify({ parentMode: PLAY_MODE, resolvedPlay, parentExecArgv: process.execArgv, child: JSON.parse(child.stdout.toString('utf8')) }));",
      ].join('\n'),
    );

    for (const parentFlags of [[SOURCE_CONDITION_FLAG, '--smol', '--conditions=other'], ['--conditions', SOURCE_CONDITION, '--smol']]) {
      const linked = Bun.spawnSync([process.execPath, ...parentFlags, sourceParentScript], {
        cwd: dir,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect({ exit: linked.exitCode, stderr: linked.stderr.toString('utf8') }).toEqual({ exit: 0, stderr: '' });
      expect(JSON.parse(linked.stdout.toString('utf8'))).toEqual({
        parentMode: 'source',
        resolvedPlay: linkedWs.playSourceEntry,
        parentExecArgv: parentFlags,
        child: {
          mode: 'source',
          execArgv: [SOURCE_CONDITION_FLAG],
          action: 'publish',
        },
      });
    }

    const distDefault = Bun.spawnSync([process.execPath, '--smol', '--conditions=other', distParentScript], {
      cwd: dir,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect({ exit: distDefault.exitCode, stderr: distDefault.stderr.toString('utf8') }).toEqual({ exit: 0, stderr: '' });
    expect(JSON.parse(distDefault.stdout.toString('utf8'))).toEqual({
      parentMode: 'dist',
      resolvedPlay: realpathSync(join(resolveInstalledPackageDir('play'), 'dist/index.js')),
      parentExecArgv: ['--smol', '--conditions=other'],
      child: {
        mode: 'dist',
        execArgv: [],
        action: 'publish',
      },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('all six review-act-runtime and parts-review-cli child launchers propagate only @rig-c/source in source mode and preserve dist resolution in default mode', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'create-child-launchers-')));
  const linkedWs = linkSourcePackages(dir);
  const actsDir = join(dir, 'served-acts');
  const outerPreloadPath = join(dir, 'outer-ci-observer.ts');
  const obsPreloadPath = join(dir, 'child-preload-observer.ts');
  mkdirSync(actsDir, { recursive: true });

  // Benign outer observer matching scripts/run-source-ci.ts preload structure to regression-test inherited BUN_OPTIONS preload coexistence.
  writeFileSync(
    outerPreloadPath,
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
      '  } catch { /* Ignore non-file entrypoints in outer observer. */ }',
      '}',
    ].join('\n'),
  );

  writeFileSync(
    obsPreloadPath,
    [
      "import { randomUUID } from 'node:crypto';",
      "import { realpathSync, writeFileSync } from 'node:fs';",
      "import { dirname, join } from 'node:path';",
      'const selfPath = import.meta.path;',
      'const preloadEnv = process.env.RIG_PINS_TEST_OBSERVER_PRELOAD;',
      'const outerPreloadEnv = process.env.RIG_CREATE_CHILD_OBSERVER_PRELOAD;',
      'for (let i = process.execArgv.length - 1; i >= 0; i--) {',
      '  const arg = process.execArgv[i];',
      '  if (arg === `--preload=${selfPath}` || (preloadEnv && arg === `--preload=${preloadEnv}`) || (outerPreloadEnv && arg === `--preload=${outerPreloadEnv}`)) {',
      '    process.execArgv.splice(i, 1);',
      "  } else if ((arg === '--preload' || arg === '-r') && (process.execArgv[i + 1] === selfPath || (preloadEnv && process.execArgv[i + 1] === preloadEnv) || (outerPreloadEnv && process.execArgv[i + 1] === outerPreloadEnv))) {",
      '    process.execArgv.splice(i, 2);',
      '  }',
      '}',
      'const initialExecArgv = [...process.execArgv];',
      'const logDir = process.env.RIG_PINS_TEST_OBSERVER_DIR;',
      'const rawEntry = process.argv[1];',
      'if (logDir && rawEntry) {',
      '  try {',
      '    const entry = realpathSync(rawEntry);',
      '    const fetchEntry = process.env.RIG_PINS_TEST_EXPECTED_FETCH_ENTRY;',
      '    const cliEntry = process.env.RIG_PINS_TEST_EXPECTED_REVIEW_CLI_ENTRY;',
      "    let kind: 'review-act-fetch' | 'parts-review-cli' | null = null;",
      "    if (fetchEntry && entry === fetchEntry) kind = 'review-act-fetch';",
      "    else if (cliEntry && entry === cliEntry && process.argv[2] === 'parts') kind = 'parts-review-cli';",
      '    if (kind) {',
      "      process.on('exit', exitCode => {",
      '        try {',
      "          const resolvedReviewHost = kind === 'review-act-fetch'",
      "            ? realpathSync(Bun.resolveSync('@rig-c/review/job-host', dirname(entry)))",
      '            : null;',
      '          const resolveBase = resolvedReviewHost ? dirname(resolvedReviewHost) : dirname(entry);',
      "          const resolvedPlay = realpathSync(Bun.resolveSync('@rig-c/play', resolveBase));",
      '          const rawLoadedPlay = (globalThis as Record<string, unknown>).__RIG_PLAY_LOADED_ENTRY;',
      "          const loadedPlay = typeof rawLoadedPlay === 'string' ? realpathSync(rawLoadedPlay) : null;",
      '          writeFileSync(',
      '            join(logDir, `${Date.now()}-${process.pid}-${randomUUID()}.json`),',
      "            JSON.stringify({ observer: 'pins-test-fixture', kind, entry, argv: process.argv, execArgv: initialExecArgv, exitCode, resolvedReviewHost, resolvedPlay, loadedPlay }),",
      '          );',
      '        } catch (error) {',
      '          writeFileSync(',
      '            join(logDir, `${Date.now()}-${process.pid}-${randomUUID()}-error.json`),',
      '            JSON.stringify({ entry, argv: process.argv, execArgv: initialExecArgv, error: error instanceof Error ? error.message : String(error) }),',
      '          );',
      '        }',
      '      });',
      '    }',
      '  } catch { /* Non-file entrypoints are ignored. */ }',
      '}',
    ].join('\n'),
  );

  const driverScript = join(dir, 'driver.ts');
  writeFileSync(
    driverScript,
    [
      "import { cpSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      `import { partsReviewCommand } from ${JSON.stringify(join(linkedWs.createRoot, 'src/parts-review.ts'))};`,
      `import { signoffCommand } from ${JSON.stringify(join(linkedWs.createRoot, 'src/signoff.ts'))};`,
      `import { recordReviewAct } from ${JSON.stringify(join(linkedWs.createRoot, 'src/feedback.ts'))};`,
      `import { interviewAnswerCommand } from ${JSON.stringify(join(linkedWs.createRoot, 'src/choice-writers.ts'))};`,
      `import { JOB_BINDING_FILE, jobHash, writePrivateJson } from ${JSON.stringify(join(linkedWs.createRoot, 'src/job-outbox.ts'))};`,
      `import { currentJobIdentity, partsEnumerator, prepareDraftManifest, prepareLiveManifest } from ${JSON.stringify(join(linkedWs.createRoot, 'src/job-publication.ts'))};`,
      `import { reviewActFindings } from ${JSON.stringify(join(linkedWs.createRoot, 'src/review-act.ts'))};`,
      `import { partsActFindings } from ${JSON.stringify(join(linkedWs.createRoot, 'src/parts-act.ts'))};`,
      `import { partsReadFindings } from ${JSON.stringify(join(linkedWs.createRoot, 'src/parts-verdict-record.ts'))};`,
      `import { stepHash } from ${JSON.stringify(join(linkedWs.createRoot, 'src/step-hash.ts'))};`,
      '',
      'const [origin, runRoot, obsDir, actsDir, repoRoot] = process.argv.slice(2) as [string, string, string, string, string];',
      "const now = Date.parse('2026-11-06T01:02:00.000Z');",
      "const at = '2026-11-06T01:01:30.000Z';",
      "const jobId = 'job-child-cond-1';",
      '',
      'const readProject = (root: string) => JSON.parse(readFileSync(join(root, "project.json"), "utf8")) as Record<string, any>;',
      'const writeProject = (root: string, project: Record<string, any>) => writeFileSync(join(root, "project.json"), `${JSON.stringify(project, null, 2)}\\n`);',
      'const bindJob = (root: string) => {',
      '  const realRoot = realpathSync(root);',
      '  const identity = currentJobIdentity({ root: realRoot, stateDir: "unused-private-state", fingerprint: "rig-create/live-review/1", reviewer: { id: "synthetic-owner", role: "owner" } }, realRoot);',
      '  writePrivateJson(join(realRoot, JOB_BINDING_FILE), { schema: "rig-create/job-binding@1", identity, jobId, origin, fetchCapability: "synthetic-fetch-cap", agentCapability: "synthetic-agent-cap" }, true);',
      '  const project = readProject(realRoot);',
      '  project.review_job = { jobId, origin };',
      '  writeProject(realRoot, project);',
      '};',
      'const clearObs = () => {',
      '  for (const name of readdirSync(obsDir)) rmSync(join(obsDir, name), { force: true });',
      '};',
      'const takeSingleObs = (launcher: string) => {',
      '  const files = readdirSync(obsDir).sort();',
      '  if (files.length !== 1 || files[0]!.endsWith("-error.json")) {',
      '    throw new Error(`Expected exactly 1 child observation for ${launcher}, got: ${JSON.stringify(files.map(f => readFileSync(join(obsDir, f), "utf8")))}`);',
      '  }',
      '  const parsed = JSON.parse(readFileSync(join(obsDir, files[0]!), "utf8"));',
      '  if (parsed.observer !== "pins-test-fixture") {',
      '    throw new Error(`Unexpected observer record in ${launcher}: ${JSON.stringify(parsed)}`);',
      '  }',
      '  clearObs();',
      '  return parsed;',
      '};',
      '',
      'const results: unknown[] = [];',
      '',
      '// 1. parts-review --from-review (src/parts-review.ts -> review-act-runtime.ts)',
      '{',
      '  const root = join(runRoot, "1-parts-act");',
      '  cpSync(join(repoRoot, "templates/example-chain/checkpoints/1-parts-verdict"), root, { recursive: true });',
      '  bindJob(root);',
      '  const project = readProject(root);',
      '  const manifestFile = prepareDraftManifest(root, project, "chain");',
      '  const publishedManifest = JSON.parse(readFileSync(join(root, manifestFile), "utf8")) as Record<string, any>;',
      '  const inputDir = join(root, "derived/drafts/chain/input");',
      '  const images = partsEnumerator.enumerate(inputDir).map(row => ({ ...row, sha256: jobHash(readFileSync(join(inputDir, row.path))) }));',
      '  const steps = (project.plan.steps as Record<string, any>[]).map(step => ({ id: String(step.id), hash: stepHash(step) }));',
      '  const act = {',
      '    schema: "rig-review/act@5", actId: "act-parts-1", jobId, askId: "ask-parts-1", publicationId: "pub-parts-1", kind: "parts-verdict",',
      '    authority: { actor: "human", channel: "review-ui", reviewer: { id: "synthetic-owner", role: "owner" } }, at,',
      '    source: {',
      '      sourceHash: "a".repeat(64), projectHash: jobHash(readFileSync(join(root, "project.json"))),',
      '      package: { id: "create-draft-chain", revision: String(publishedManifest.revision) },',
      '      selector: { kind: "draft", id: "chain" },',
      '      model: { path: "derived/drafts/chain/out/check/build/skeleton.model.json", sha256: jobHash(readFileSync(join(root, "derived/drafts/chain/out/check/build/skeleton.model.json"))) },',
      '      direction: null, optionSet: null, appliedResult: null, plan: { steps },',
      '      parts: { enumeratorVersion: partsEnumerator.version, manifest: { path: "derived/drafts/chain/input/parts.json", sha256: jobHash(readFileSync(join(root, "derived/drafts/chain/input/parts.json"))) }, images },',
      '    },',
      '    value: { verdict: "approved", issues: [], words: "Approved parts via act.\\n" },',
      '  };',
      '  writeFileSync(join(actsDir, "act-parts-1.json"), JSON.stringify(act));',
      '  clearObs();',
      '  const res = partsReviewCommand([root, "--from-review", "act-parts-1", "--json"], now);',
      '  const after = readProject(root);',
      '  if (res.exit !== 0 || reviewActFindings(after).length > 0 || partsActFindings(root, after).length > 0) throw new Error("parts-review --from-review failed");',
      '  results.push({ launcher: "parts-review-act", child: takeSingleObs("parts-review-act"), outcome: { exit: res.exit, recordedActId: after.review_acts.at(-1)?.actId, verdict: JSON.parse(res.stdout).verdict } });',
      '}',
      '',
      '// 2. signoff <stage> --from-review (src/signoff.ts -> review-act-runtime.ts)',
      '{',
      '  const root = join(runRoot, "2-signoff-stage");',
      '  cpSync(join(repoRoot, "templates/example-chain/checkpoints/0b-plan-pending"), root, { recursive: true });',
      '  bindJob(root);',
      '  const project = readProject(root);',
      '  const steps = (project.plan.steps as Record<string, any>[]).map(step => ({ id: String(step.id), hash: stepHash(step) }));',
      '  const act = {',
      '    schema: "rig-review/act@2", kind: "signoff", jobId, actId: "act-signoff-1", askId: "ask-signoff-1", publicationId: "pub-signoff-1", at,',
      '    authority: { actor: "human", channel: "review-ui", reviewer: { id: "synthetic-owner", role: "owner" } },',
      '    source: {',
      '      sourceHash: "1".repeat(64), projectHash: "2".repeat(64), package: { id: "synthetic-package", revision: "one" },',
      '      selector: null, model: null, direction: null, optionSet: null, appliedResult: null, plan: { steps }, parts: { enumeratorVersion: partsEnumerator.version },',
      '    },',
      '    value: { stage: "plan-approved", decision: "approved", words: "Approved plan via act.\\n" },',
      '  };',
      '  writeFileSync(join(actsDir, "act-signoff-1.json"), JSON.stringify(act));',
      '  clearObs();',
      '  const res = signoffCommand(["plan-approved", root, "--from-review", "act-signoff-1", "--json"], now);',
      '  const after = readProject(root);',
      '  if (res.exit !== 0 || reviewActFindings(after).length > 0) throw new Error("signoff --from-review failed");',
      '  results.push({ launcher: "signoff-stage-act", child: takeSingleObs("signoff-stage-act"), outcome: { exit: res.exit, recordedActId: after.review_acts.at(-1)?.actId, signedStage: after.signoffs.at(-1)?.stage } });',
      '}',
      '',
      '// 3. signoff <stage> --checkpoint <id> --from-review (src/signoff-checkpoint-act.ts -> review-act-runtime.ts)',
      '{',
      '  const root = join(runRoot, "3-signoff-checkpoint");',
      '  cpSync(join(repoRoot, "templates/example-chain/checkpoints/1-parts-verdict"), root, { recursive: true });',
      '  const initial = readProject(root);',
      '  const checkpointAt = String((initial.signoffs as Record<string, any>[]).find(s => s.checkpoint === "assemble")!.at);',
      '  initial.signoffs = (initial.signoffs as Record<string, any>[]).filter(s => s.checkpoint !== "assemble");',
      '  writeProject(root, initial);',
      '  bindJob(root);',
      '  const project = readProject(root);',
      '  const steps = (project.plan.steps as Record<string, any>[]).map(step => ({ id: String(step.id), hash: stepHash(step) }));',
      '  const act = {',
      '    schema: "rig-review/act@2", kind: "checkpoint", jobId, actId: "act-checkpoint-1", askId: "ask-checkpoint-1", publicationId: "pub-checkpoint-1", at: checkpointAt,',
      '    authority: { actor: "human", channel: "review-ui", reviewer: { id: "synthetic-owner", role: "owner" } },',
      '    source: {',
      '      sourceHash: "1".repeat(64), projectHash: "2".repeat(64), package: { id: "synthetic-package", revision: "one" },',
      '      selector: null, model: null, direction: null, optionSet: null, appliedResult: null, plan: { steps }, parts: { enumeratorVersion: partsEnumerator.version },',
      '    },',
      '    value: { checkpointId: "assemble", planStepId: "assemble", outcome: "pass", words: "Passed assemble checkpoint via act.\\n" },',
      '  };',
      '  writeFileSync(join(actsDir, "act-checkpoint-1.json"), JSON.stringify(act));',
      '  clearObs();',
      '  const res = signoffCommand(["parts", root, "--checkpoint", "assemble", "--from-review", "act-checkpoint-1", "--json"], now);',
      '  const after = readProject(root);',
      '  if (res.exit !== 0 || reviewActFindings(after).length > 0) throw new Error("signoff --checkpoint --from-review failed");',
      '  results.push({ launcher: "signoff-checkpoint-act", child: takeSingleObs("signoff-checkpoint-act"), outcome: { exit: res.exit, recordedActId: after.review_acts.at(-1)?.actId, checkpoint: after.signoffs.at(-1)?.checkpoint } });',
      '}',
      '',
      '// 4. review <n> --from-review (src/feedback.ts -> review-act-runtime.ts)',
      '{',
      '  const root = join(runRoot, "4-review-verdict");',
      '  cpSync(join(repoRoot, "templates/example-chain/checkpoints/3-rig-review"), root, { recursive: true });',
      '  bindJob(root);',
      '  const project = readProject(root);',
      '  const manifestPath = prepareLiveManifest(root, project, 1);',
      '  const manifest = JSON.parse(readFileSync(join(root, manifestPath), "utf8")) as Record<string, any>;',
      '  const partsRoot = "outputs/v1/out";',
      '  const images = partsEnumerator.enumerate(join(root, partsRoot)).map(row => ({ ...row, sha256: jobHash(readFileSync(join(root, partsRoot, row.path))) }));',
      '  const steps = (project.plan.steps as Record<string, any>[]).map(step => ({ id: String(step.id), hash: stepHash(step) }));',
      '  const act = {',
      '    schema: "rig-review/act@2", kind: "review-verdict", jobId, actId: "act-review-1", askId: "ask-review-1", publicationId: "pub-review-1", at,',
      '    authority: { actor: "human", channel: "review-ui", reviewer: { id: "synthetic-owner", role: "owner" } },',
      '    source: {',
      '      sourceHash: "1".repeat(64), projectHash: jobHash(readFileSync(join(root, "project.json"))),',
      '      package: { id: String(manifest.id), revision: String(manifest.revision) },',
      '      selector: { kind: "rig", version: 1 },',
      '      model: { path: "derived/review/v1/out/check/build/skeleton.model.json", sha256: jobHash(readFileSync(join(root, "derived/review/v1/out/check/build/skeleton.model.json"))) },',
      '      direction: null, optionSet: null, appliedResult: null, plan: { steps },',
      '      parts: { enumeratorVersion: partsEnumerator.version, manifest: { path: `${partsRoot}/parts.json`, sha256: jobHash(readFileSync(join(root, `${partsRoot}/parts.json`))) }, images },',
      '    },',
      '    value: { stage: "rig-review", verdict: "approved", words: "Approved rig v1 via act.\\n" },',
      '  };',
      '  writeFileSync(join(actsDir, "act-review-1.json"), JSON.stringify(act));',
      '  clearObs();',
      '  const res = recordReviewAct(root, 1, "act-review-1", now);',
      '  const after = readProject(root);',
      '  if (reviewActFindings(after).length > 0) throw new Error("review --from-review failed");',
      '  results.push({ launcher: "review-verdict-act", child: takeSingleObs("review-verdict-act"), outcome: { recordedActId: after.review_acts.at(-1)?.actId, verdict: (res.verdict as Record<string, any>).verdict } });',
      '}',
      '',
      '// 5. interview-answer <question> --from-review (src/choice-writers.ts -> review-act-runtime.ts)',
      '{',
      '  const root = join(runRoot, "5-interview-answer");',
      '  cpSync(join(repoRoot, "templates/example-chain/checkpoints/2-rigging-answers"), root, { recursive: true });',
      '  bindJob(root);',
      '  const setBytes = readFileSync(join(root, "evidence/interview/bones.json"));',
      '  const set = JSON.parse(setBytes.toString("utf8")) as Record<string, any>;',
      '  const act = {',
      '    schema: "rig-review/act@2", kind: "interview-picks", jobId, actId: "act-interview-1", askId: "ask-interview-1", publicationId: "pub-interview-1", at,',
      '    authority: { actor: "human", channel: "review-ui", reviewer: { id: "synthetic-owner", role: "owner" } },',
      '    source: {',
      '      sourceHash: "1".repeat(64), projectHash: "2".repeat(64), package: { id: "synthetic-package", revision: "one" },',
      '      parts: { enumeratorVersion: partsEnumerator.version }, optionSet: { id: String(set.id), sha256: jobHash(setBytes) },',
      '    },',
      '    value: {',
      '      questionId: "bones",',
      '      selections: (set.asks as Record<string, any>[]).map(ask => ({ itemId: String(ask.id), optionId: "keep", otherText: null })),',
      '      note: "Picked bones via act.",',
      '    },',
      '  };',
      '  writeFileSync(join(actsDir, "act-interview-1.json"), JSON.stringify(act));',
      '  clearObs();',
      '  const stdout = interviewAnswerCommand(["bones", root, "--from-review", "act-interview-1"], now);',
      '  const after = readProject(root);',
      '  if (reviewActFindings(after).length > 0) throw new Error("interview-answer --from-review failed");',
      '  results.push({ launcher: "interview-answer-act", child: takeSingleObs("interview-answer-act"), outcome: { recordedActId: after.review_acts.at(-1)?.actId, by: JSON.parse(stdout).by } });',
      '}',
      '',
      '// 6. parts-review --from-review-cli (src/review-read.ts -> review/src/entry.ts)',
      '{',
      '  const root = join(runRoot, "6-parts-cli");',
      '  cpSync(join(repoRoot, "templates/example-chain/checkpoints/1-parts-verdict"), root, { recursive: true });',
      '  const storedVerdict = JSON.parse(readFileSync(join(repoRoot, "templates/example-chain/checkpoints/2-rigging-answers/evidence/review-reads/a12dea02d32508acc99386f894af76a14f1c85f45f804db2aa6b4dea5297973f.json"), "utf8")) as Record<string, any>;',
      '  delete storedVerdict.by;',
      '  delete storedVerdict.savedFileSha256;',
      '  writeFileSync(join(root, "evidence/parts-review.json"), `${JSON.stringify(storedVerdict, null, 2)}\\n`);',
      '  clearObs();',
      '  const res = partsReviewCommand([root, "--draft", "chain", "--from-review-cli", "--by", "user", "--json", "--", "derived/drafts/chain/input", "--verdict", "evidence/parts-review.json"], now);',
      '  const after = readProject(root);',
      '  if (res.exit !== 0 || partsReadFindings(root, after).length > 0) throw new Error("parts-review --from-review-cli failed");',
      '  results.push({ launcher: "parts-review-cli", child: takeSingleObs("parts-review-cli"), outcome: { exit: res.exit, route: JSON.parse(res.stdout).route, status: JSON.parse(res.stdout).status, schema: after.review_acts.at(-1)?.schema } });',
      '}',
      '',
      'console.log(JSON.stringify({ parentExecArgv: process.execArgv, results }));',
    ].join('\n'),
  );

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { jobId: string; actId: string; requestId: string };
      const raw = readFileSync(join(actsDir, `${body.actId}.json`), 'utf8');
      if (request.headers.get('accept') === 'application/vnd.rig-review.act+json') {
        return new Response(raw, { headers: { 'content-type': 'application/vnd.rig-review.act+json' } });
      }
      return Response.json({
        schema: 'rig-review/job-api@2',
        verb: 'fetch-act',
        jobId: body.jobId,
        requestId: body.requestId,
        ok: true,
        value: JSON.parse(raw),
      });
    },
  });

  try {
    const cases = [
      {
        label: 'source-equals',
        parentFlags: [SOURCE_CONDITION_FLAG, '--smol', '--conditions=other'],
        expectedChildExecArgv: [SOURCE_CONDITION_FLAG],
        expectedPlay: linkedWs.playSourceEntry,
      },
      {
        label: 'source-space',
        parentFlags: ['--conditions', SOURCE_CONDITION, '--smol'],
        expectedChildExecArgv: [SOURCE_CONDITION_FLAG],
        expectedPlay: linkedWs.playSourceEntry,
      },
      {
        label: 'default-dist',
        parentFlags: ['--smol', '--conditions=other'],
        expectedChildExecArgv: [] as string[],
        expectedPlay: linkedWs.playDistEntry,
      },
    ] as const;

    for (const c of cases) {
      const runRoot = join(dir, `run-${c.label}`);
      const obsDir = join(dir, `obs-${c.label}`);
      const outerObsDir = join(dir, `outer-obs-${c.label}`);
      mkdirSync(runRoot, { recursive: true });
      mkdirSync(obsDir, { recursive: true });
      mkdirSync(outerObsDir, { recursive: true });

      const hasHostedCiObserver = Boolean(process.env.RIG_CREATE_CHILD_OBSERVER_PRELOAD);
      const existingBunOptions = process.env.BUN_OPTIONS?.trim();
      const bunOptionsWithOuter = hasHostedCiObserver
        ? existingBunOptions
          ? `${existingBunOptions} --preload=${obsPreloadPath}`
          : `--preload=${obsPreloadPath}`
        : [existingBunOptions, `--preload=${outerPreloadPath}`, `--preload=${obsPreloadPath}`].filter(Boolean).join(' ');

      const proc = Bun.spawn(
        [process.execPath, ...c.parentFlags, driverScript, `http://127.0.0.1:${server.port}`, runRoot, obsDir, actsDir, REPO],
        {
          cwd: dir,
          env: {
            ...process.env,
            BUN_OPTIONS: bunOptionsWithOuter,
            ...(hasHostedCiObserver
              ? {}
              : {
                  RIG_CREATE_CHILD_OBSERVER_PRELOAD: outerPreloadPath,
                  RIG_CREATE_CHILD_OBSERVER_DIR: outerObsDir,
                  RIG_CREATE_EXPECTED_FETCH_ENTRY: linkedWs.fetchRuntimeEntry,
                  RIG_CREATE_EXPECTED_REVIEW_CLI_ENTRY: linkedWs.reviewCliEntry,
                }),
            RIG_PINS_TEST_OBSERVER_PRELOAD: obsPreloadPath,
            RIG_PINS_TEST_OBSERVER_DIR: obsDir,
            RIG_PINS_TEST_EXPECTED_FETCH_ENTRY: linkedWs.fetchRuntimeEntry,
            RIG_PINS_TEST_EXPECTED_REVIEW_CLI_ENTRY: linkedWs.reviewCliEntry,
          },
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      const [stdout, stderr, exit] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect({ label: c.label, exit, stderr }).toEqual({ label: c.label, exit: 0, stderr: '' });
      if (!hasHostedCiObserver) {
        const outerFiles = readdirSync(outerObsDir).sort();
        expect(outerFiles).toHaveLength(6);
        expect(outerFiles.filter(name => name.endsWith('-error.json'))).toEqual([]);
        const outerObs = outerFiles.map(
          name =>
            JSON.parse(readFileSync(join(outerObsDir, name), 'utf8')) as {
              kind: 'review-act-fetch' | 'parts-review-cli';
              resolvedPlay: string;
            },
        );
        expect(outerObs.filter(o => o.kind === 'review-act-fetch')).toHaveLength(5);
        expect(outerObs.filter(o => o.kind === 'parts-review-cli')).toHaveLength(1);
        for (const o of outerObs) {
          expect(o.resolvedPlay).toBe(c.expectedPlay);
        }
      }
      const parsed = JSON.parse(stdout) as {
        parentExecArgv: string[];
        results: {
          launcher: string;
          child: {
            kind: 'review-act-fetch' | 'parts-review-cli';
            entry: string;
            argv: string[];
            execArgv: string[];
            exitCode: number;
            resolvedReviewHost: string | null;
            resolvedPlay: string;
            loadedPlay: string | null;
          };
          outcome: Record<string, unknown>;
        }[];
      };
      expect(parsed.parentExecArgv).toEqual([...c.parentFlags]);
      expect(parsed.results.map(r => r.launcher)).toEqual([
        'parts-review-act',
        'signoff-stage-act',
        'signoff-checkpoint-act',
        'review-verdict-act',
        'interview-answer-act',
        'parts-review-cli',
      ]);

      for (const item of parsed.results) {
        expect(item.child.exitCode).toBe(0);
        expect(item.child.execArgv).toEqual([...c.expectedChildExecArgv]);
        expect(item.child.resolvedPlay).toBe(c.expectedPlay);
        expect(item.child.loadedPlay).toBe(c.expectedPlay);
        if (item.launcher === 'parts-review-cli') {
          expect(item.child.kind).toBe('parts-review-cli');
          expect(item.child.entry).toBe(linkedWs.reviewCliEntry);
          expect(item.child.resolvedReviewHost).toBeNull();
        } else {
          expect(item.child.kind).toBe('review-act-fetch');
          expect(item.child.entry).toBe(linkedWs.fetchRuntimeEntry);
          expect(item.child.resolvedReviewHost).toBe(linkedWs.reviewHostSourceEntry);
        }
      }

      if (process.env.RIG_CREATE_385_TRACE_STDOUT === '1') {
        const rel = (p: string | null) => (p ? p.slice(dir.length + 1) : null);
        console.log(
          `create-385-trace[${c.label}]: ${JSON.stringify({
            label: c.label,
            parentExecArgv: parsed.parentExecArgv,
            results: parsed.results.map(r => ({
              launcher: r.launcher,
              kind: r.child.kind,
              entry: rel(r.child.entry),
              execArgv: r.child.execArgv,
              exitCode: r.child.exitCode,
              resolvedReviewHost: rel(r.child.resolvedReviewHost),
              resolvedPlay: rel(r.child.resolvedPlay),
              loadedPlay: rel(r.child.loadedPlay),
              outcome: r.outcome,
            })),
          })}`,
        );
      }

      expect(parsed.results.map(r => ({ launcher: r.launcher, outcome: r.outcome }))).toEqual([
        { launcher: 'parts-review-act', outcome: { exit: 0, recordedActId: 'act-parts-1', verdict: 'approved' } },
        { launcher: 'signoff-stage-act', outcome: { exit: 0, recordedActId: 'act-signoff-1', signedStage: 'plan-approved' } },
        { launcher: 'signoff-checkpoint-act', outcome: { exit: 0, recordedActId: 'act-checkpoint-1', checkpoint: 'assemble' } },
        { launcher: 'review-verdict-act', outcome: { recordedActId: 'act-review-1', verdict: 'accepted' } },
        { launcher: 'interview-answer-act', outcome: { recordedActId: 'act-interview-1', by: 'user' } },
        { launcher: 'parts-review-cli', outcome: { exit: 0, route: 'cli', status: 'approved', schema: 'rig-create/parts-verdict-cli@1' } },
      ]);
    }
  } finally {
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);

for (const [label, execFlags] of [
  ['linked source condition', [SOURCE_CONDITION_FLAG]],
  ['default dist mode', []],
] as const) test(`CLI job open, draft-rig publish, reconcile, and close succeed on a synthetic project in ${label}`, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'create-job-cond-')));
  const ws = label === 'linked source condition' ? linkSourcePackages(root) : null;
  const activeCli = ws ? ws.cliPath : CLI;
  const projectRoot = join(root, 'project');
  let proc: Bun.Subprocess | null = null;
  try {
    cpSync(join(REPO, 'templates/example-chain/checkpoints/1-parts-verdict'), projectRoot, { recursive: true });
    cpSync(join(projectRoot, 'derived/drafts/chain'), join(projectRoot, 'derived/drafts/chain-2'), { recursive: true });
    const spawned = Bun.spawn([process.execPath, ...execFlags, activeCli, 'job', 'open', projectRoot, '--reviewer', 'synthetic-owner', '--role', 'owner'], {
      cwd: projectRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    proc = spawned;
    const reader = spawned.stdout.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (!/\njob: .*\n$/.test(text)) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value);
    }
    reader.releaseLock();
    const lines = text.trim().split('\n');
    expect(lines[0]).toStartWith('http://127.0.0.1:');
    expect(lines.slice(1)).toEqual(['job: draft chain published', 'job: asked parts-verdict chain, checkpoint assemble']);

    const drafted = Bun.spawnSync(
      [
        process.execPath,
        ...execFlags,
        activeCli,
        'draft-rig',
        'chain-2',
        projectRoot,
        '--config',
        'derived/drafts/chain-2/config.json',
        '--from',
        'derived/drafts/chain-2/out',
        '--parts',
        'derived/drafts/chain-2/input',
      ],
      { cwd: projectRoot, stdout: 'pipe', stderr: 'pipe' },
    );
    expect({ exit: drafted.exitCode, stderr: drafted.stderr.toString('utf8') }).toEqual({ exit: 0, stderr: '' });
    expect(drafted.stdout.toString('utf8').trim().split('\n')).toEqual([
      'draft-rig: recorded chain-2; no production version created',
      'job: asked parts-verdict chain-2, checkpoint assemble',
    ]);

    const reconciled = Bun.spawnSync([process.execPath, ...execFlags, activeCli, 'job', 'reconcile', projectRoot], {
      cwd: projectRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect({ exit: reconciled.exitCode, stdout: reconciled.stdout.toString('utf8').trim(), stderr: reconciled.stderr.toString('utf8') }).toEqual({
      exit: 0,
      stdout: 'job: reconciled 0 publication(s)',
      stderr: '',
    });

    const closed = Bun.spawnSync([process.execPath, ...execFlags, activeCli, 'job', 'close', projectRoot], {
      cwd: projectRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect({ exit: closed.exitCode, stdout: closed.stdout.toString('utf8').trim(), stderr: closed.stderr.toString('utf8') }).toEqual({
      exit: 0,
      stdout: 'job: closed',
      stderr: '',
    });
    expect(await proc.exited).toBe(0);
    expect(readWriterBinding(projectRoot)).toBeNull();
  } finally {
    if (proc && proc.exitCode === null) {
      proc.kill();
      await proc.exited;
    }
    rmSync(jobPrivateRoot(projectRoot), { recursive: true, force: true });
    rmSync(jobHostStateRoot(projectRoot), { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
