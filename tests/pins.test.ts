import { expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { jobHostStateRoot, jobPrivateRoot, readWriterBinding } from '../src/job-outbox.ts';
import { SOURCE_CONDITION, SOURCE_CONDITION_FLAG, jobRuntimeCommand, jobRuntimeExecArgv } from '../src/job-writer.ts';
import { PINNED_PACKAGES } from '../src/pins.ts';
import { readTemplate } from '../src/templates.ts';
import { sourceOnlyTest } from './source-only.ts';

const EXACT = /^\d+\.\d+\.\d+$/;
const REPO = join(import.meta.dir, '..');
const CLI = join(REPO, 'src/cli.ts');

function linkSourcePackages(baseDir: string): {
  cliPath: string;
  jobWriterPath: string;
  playSourceEntry: string;
} {
  const wsRoot = join(baseDir, 'linked-ws');
  const createRoot = join(wsRoot, 'packages/create');
  mkdirSync(join(wsRoot, 'node_modules/@rig-c'), { recursive: true });
  mkdirSync(join(createRoot, 'node_modules/@rig-c'), { recursive: true });
  for (const entry of readdirSync(join(REPO, 'node_modules')).filter(name => name !== '@rig-c')) {
    symlinkSync(join(REPO, 'node_modules', entry), join(wsRoot, 'node_modules', entry));
    symlinkSync(join(REPO, 'node_modules', entry), join(createRoot, 'node_modules', entry));
  }
  for (const name of ['core', 'parts', 'play', 'review'] as const) {
    const pkgTarget = join(wsRoot, 'packages', name);
    cpSync(join(REPO, 'node_modules/@rig-c', name), pkgTarget, { recursive: true });
    if (name === 'play' && !existsSync(join(pkgTarget, 'src/index.ts'))) {
      mkdirSync(join(pkgTarget, 'src'), { recursive: true });
      writeFileSync(join(pkgTarget, 'src/index.ts'), "export * from '../dist/index.js';\nexport const PLAY_SOURCE_LINKED = true;\n");
    }
    symlinkSync(pkgTarget, join(wsRoot, 'node_modules/@rig-c', name), 'dir');
    symlinkSync(pkgTarget, join(createRoot, 'node_modules/@rig-c', name), 'dir');
  }
  cpSync(join(REPO, 'package.json'), join(createRoot, 'package.json'));
  cpSync(join(REPO, 'src'), join(createRoot, 'src'), { recursive: true });
  symlinkSync(join(REPO, 'templates'), join(createRoot, 'templates'), 'dir');
  return {
    cliPath: join(createRoot, 'src/cli.ts'),
    jobWriterPath: join(createRoot, 'src/job-writer.ts'),
    playSourceEntry: realpathSync(join(wsRoot, 'packages/play/src/index.ts')),
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
  expect(pkg.private).toBe(true);
  expect(pkg.version).toBe('0.0.0');
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
      resolvedPlay: realpathSync(join(REPO, 'node_modules/@rig-c/play/dist/index.js')),
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

for (const [label, execFlags] of [
  ['linked source condition', [SOURCE_CONDITION_FLAG]],
  ['default dist mode', []],
] as const) sourceOnlyTest(`CLI job open, draft-rig publish, reconcile, and close succeed on a synthetic project in ${label}`, async () => {
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
