import { expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { jobHostStateRoot, jobPrivateRoot, readWriterBinding } from '../src/job-outbox.ts';
import { seedRetainedDraft } from './numbered-seed.ts';
import { SOURCE_CONDITION, SOURCE_CONDITION_FLAG, jobRuntimeCommand, jobRuntimeExecArgv } from '../src/job-writer.ts';
import { CREATE_PACKAGE, PINNED_PACKAGES, initDependencies, runningCreateVersion } from '../src/pins.ts';
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
      // Play 1.25.0 strips the checkout-only @rig-c/source condition from its published package.json; a linked checkout keeps it.
      const manifestPath = join(pkgTarget, 'package.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (manifest.exports['.'][SOURCE_CONDITION] === undefined) {
        manifest.exports['.'] = { [SOURCE_CONDITION]: './src/index.ts', ...manifest.exports['.'] };
        writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
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
  expect(Object.keys(initDependencies()).sort()).toEqual(['@rig-c/core', CREATE_PACKAGE, '@rig-c/parts']);
  for (const [pkg, version] of Object.entries(initDependencies())) {
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
  expect(pkg.version).toBe('1.27.0');
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

test('surviving review-act-runtime and review-cli child launchers propagate only @rig-c/source in source mode and preserve dist resolution in default mode', async () => {
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
      "    let kind: 'review-act-fetch' | 'review-cli' | null = null;",
      "    if (fetchEntry && entry === fetchEntry) kind = 'review-act-fetch';",
      "    else if (cliEntry && entry === cliEntry && process.argv[2] === 'feedback') kind = 'review-cli';",
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
      "    let kind: 'review-act-fetch' | 'review-cli' | null = null;",
      "    if (fetchEntry && entry === fetchEntry) kind = 'review-act-fetch';",
      "    else if (cliEntry && entry === cliEntry && process.argv[2] === 'feedback') kind = 'review-cli';",
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
      "import { cpSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      `import { commentCommand } from ${JSON.stringify(join(linkedWs.createRoot, 'src/comment-act.ts'))};`,
      `import { readReview, retainedReviewRead } from ${JSON.stringify(join(linkedWs.createRoot, 'src/review-read.ts'))};`,
      `import { JOB_BINDING_FILE, jobHash, writePrivateJson } from ${JSON.stringify(join(linkedWs.createRoot, 'src/job-outbox.ts'))};`,
      `import { currentJobIdentity } from ${JSON.stringify(join(linkedWs.createRoot, 'src/job-publication.ts'))};`,
      `import { reviewActFindings } from ${JSON.stringify(join(linkedWs.createRoot, 'src/review-act.ts'))};`,
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
      '// 1. comment --from-review (src/comment-act.ts -> fetchReviewActBytes -> review-act-runtime.ts)',
      '{',
      '  const root = join(runRoot, "1-comment-act");',
      '  cpSync(join(repoRoot, "templates/example-chain/checkpoints/3-rig-review"), root, { recursive: true });',
      '  bindJob(root);',
      '  const recordHash = jobHash(readFileSync(join(root, "project.json")));',
      '  const modelPath = "derived/review/v1/out/check/build/skeleton.model.json";',
      '  const act = {',
      '    schema: "rig-review/act@10", actId: "act-comment-1", jobId, publicationId: "pub-comment-1", kind: "comments", at,',
      '    authority: { actor: "human", channel: "review-ui", reviewer: { id: "synthetic-owner", role: "owner" } },',
      '    source: {',
      '      sourceHash: "1".repeat(64), projectHash: recordHash, package: { id: "create-v1", revision: "v1" },',
      '      selector: null, model: { path: modelPath, sha256: jobHash(readFileSync(join(root, modelPath))) },',
      '      direction: null, optionSet: null, appliedResult: null, plan: null, parts: null,',
      '    },',
      '    value: { comments: [{ text: "Comment recorded via act@10." }] },',
      '  };',
      '  writeFileSync(join(actsDir, "act-comment-1.json"), JSON.stringify(act));',
      '  clearObs();',
      '  const res = commentCommand(["--from-review", "act-comment-1", root, "--json"], now);',
      '  const after = readProject(root);',
      '  if (res.exit !== 0 || reviewActFindings(after).length > 0) throw new Error("comment --from-review failed");',
      '  results.push({ launcher: "comment-act", child: takeSingleObs("comment-act"), outcome: { exit: res.exit, recordedActId: after.review_acts.at(-1)?.actId, comment: JSON.parse(res.stdout).comment } });',
      '}',
      '',
      '// 2. rig-review feedback CLI read (src/review-read.ts -> review/src/entry.ts)',
      '{',
      '  const root = join(runRoot, "2-review-cli");',
      '  cpSync(join(repoRoot, "templates/example-chain/checkpoints/3-rig-review"), root, { recursive: true });',
      '  clearObs();',
      '  const read = readReview(root, "derived/review/v1/out");',
      '  retainedReviewRead(root, read.receipt, read.file);',
      '  results.push({ launcher: "review-cli", child: takeSingleObs("review-cli"), outcome: { route: read.receipt.route, argv1: (read.receipt.argv as string[])[1] } });',
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
        expect(outerFiles).toHaveLength(2);
        expect(outerFiles.filter(name => name.endsWith('-error.json'))).toEqual([]);
        const outerObs = outerFiles.map(
          name =>
            JSON.parse(readFileSync(join(outerObsDir, name), 'utf8')) as {
              kind: 'review-act-fetch' | 'review-cli';
              resolvedPlay: string;
            },
        );
        expect(outerObs.filter(o => o.kind === 'review-act-fetch')).toHaveLength(1);
        expect(outerObs.filter(o => o.kind === 'review-cli')).toHaveLength(1);
        for (const o of outerObs) {
          expect(o.resolvedPlay).toBe(c.expectedPlay);
        }
      }
      const parsed = JSON.parse(stdout) as {
        parentExecArgv: string[];
        results: {
          launcher: string;
          child: {
            kind: 'review-act-fetch' | 'review-cli';
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
        'comment-act',
        'review-cli',
      ]);

      for (const item of parsed.results) {
        expect(item.child.exitCode).toBe(0);
        expect(item.child.execArgv).toEqual([...c.expectedChildExecArgv]);
        expect(item.child.resolvedPlay).toBe(c.expectedPlay);
        expect(item.child.loadedPlay).toBe(c.expectedPlay);
        if (item.launcher === 'review-cli') {
          expect(item.child.kind).toBe('review-cli');
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
        { launcher: 'comment-act', outcome: { exit: 0, recordedActId: 'act-comment-1', comment: 'comments[0]' } },
        { launcher: 'review-cli', outcome: { route: 'cli', argv1: 'feedback' } },
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
] as const) test(`CLI job open, draft republish, reconcile, and close succeed on a synthetic project in ${label}`, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'create-job-cond-')));
  const ws = label === 'linked source condition' ? linkSourcePackages(root) : null;
  const activeCli = ws ? ws.cliPath : CLI;
  const projectRoot = join(root, 'project');
  const run = (args: string[]) => Bun.spawnSync([process.execPath, ...execFlags, activeCli, ...args], {
    cwd: projectRoot, stdout: 'pipe', stderr: 'pipe',
  });
  let proc: Bun.Subprocess | null = null;
  try {
    cpSync(join(REPO, 'templates/example-chain/checkpoints/1-parts-verdict'), projectRoot, { recursive: true });
    cpSync(join(projectRoot, 'derived/drafts/chain'), join(projectRoot, 'derived/drafts/chain-2'), { recursive: true });
    cpSync(join(REPO, 'templates/example-chain/evidence/diff-components.json'), join(projectRoot, 'evidence/diff-components.json'));
    for (const args of [
      ['structure-snapshot', projectRoot, '--draft', 'chain', '--out', 'evidence/structure-chain.json'],
      ['diff-classes', projectRoot, '--diff-report', 'evidence/diff-components.json', '--by', 'agent'],
      ['advance', 'parts-review', projectRoot, '--parts-check', 'evidence/parts-check.json', '--parts', 'derived/drafts/chain/input'],
    ]) {
      const result = run(args);
      expect({ exit: result.exitCode, stderr: result.stderr.toString('utf8') }).toEqual({ exit: 0, stderr: '' });
    }
    const snapshotPath = join(projectRoot, 'evidence/structure-chain.json');
    const originalSnapshot = readFileSync(snapshotPath);
    const snapshot = JSON.parse(originalSnapshot.toString('utf8')) as { draft_id: string; config: { path: string } };
    snapshot.draft_id = 'chain-2';
    snapshot.config.path = 'derived/drafts/chain-2/config.json';
    writeFileSync(join(projectRoot, 'evidence/structure-chain-2.json'), JSON.stringify(snapshot));
    // With its snapshot temporarily absent, the initial draft opens for inspection without an ask.
    rmSync(snapshotPath);
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
    expect(lines.at(-1)).toMatch(/^job: draft chain published \(publication [A-Za-z0-9][A-Za-z0-9._-]{0,127}\)$/);
    writeFileSync(snapshotPath, originalSnapshot);

    seedRetainedDraft([
      'chain-2',
      projectRoot,
      '--config',
      'derived/drafts/chain-2/config.json',
      '--from',
      'derived/drafts/chain-2/out',
      '--parts',
      'derived/drafts/chain-2/input',
    ]);
    const republished = Bun.spawnSync(
      [
        process.execPath,
        ...execFlags,
        activeCli,
        'job',
        'open',
        projectRoot,
        '--draft',
        'chain-2',
        '--reviewer',
        'synthetic-owner',
        '--role',
        'owner',
      ],
      { cwd: projectRoot, stdout: 'pipe', stderr: 'pipe' },
    );
    expect({ exit: republished.exitCode, stderr: republished.stderr.toString('utf8') }).toEqual({ exit: 0, stderr: '' });
    const draftLines = republished.stdout.toString('utf8').trim().split('\n');
    expect(draftLines[0]).toStartWith('http://127.0.0.1:');
    expect(draftLines.at(-1)).toMatch(/^job: draft chain-2 published \(publication [A-Za-z0-9][A-Za-z0-9._-]{0,127}\)$/);

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
}, 60_000);
