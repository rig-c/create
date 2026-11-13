/** Separate processes keep delayed npm and Bun hook clocks independent of this suite. */
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ALIAS_COMMAND_TIMEOUT_MS, MAX_PACK_TIMEOUT_MS, PACK_TIMEOUT_MS } from '../scripts/alias_tarball.ts';

const ROOT = resolve(import.meta.dir, '..');
const helper = join(ROOT, 'scripts/alias_tarball.ts');
const npm = spawnSync('which', ['npm'], { encoding: 'utf8', timeout: 5_000 }).stdout.trim();

function control(body: (dir: string, bin: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'alias-bootstrap-'));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    body(dir, bin);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
function fakeNpm(bin: string, body: string): void {
  writeFileSync(join(bin, 'npm'), `#!${process.execPath}\n${body}\n`, { mode: 0o700 });
}
function run(file: string, bin: string, args: string[] = [], timeout = ALIAS_COMMAND_TIMEOUT_MS + 5_000) {
  return spawnSync(process.execPath, [file, ...args], {
    cwd: ROOT, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    encoding: 'utf8', timeout, killSignal: 'SIGKILL',
  });
}

test('actual alias bootstrap finishes beyond default five-second hook with bounded pack and caller budgets', () => {
  control((dir, bin) => {
    const marker = join(dir, 'delayed');
    expect(npm).not.toBe('');
    // Only bootstrap is delayed. Native npm still makes and gates real tarballs.
    fakeNpm(bin, `
      import { existsSync, writeFileSync } from 'node:fs';
      import { spawnSync } from 'node:child_process';
      if (!existsSync(${JSON.stringify(marker)})) {
        writeFileSync(${JSON.stringify(marker)}, 'delayed');
        Bun.sleepSync(5_200);
      }
      const r = spawnSync(${JSON.stringify(npm)}, process.argv.slice(2), { stdio: 'inherit', timeout: ${PACK_TIMEOUT_MS}, killSignal: 'SIGKILL' });
      process.exit(r.status ?? 1);
    `);
    const started = performance.now();
    const result = run('test', bin, ['./tests/alias.test.ts', '-t', 'pack control: same files']);
    const elapsed = performance.now() - started;
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stderr).toContain('1 pass');
    expect(elapsed).toBeGreaterThan(5_000);
    expect(elapsed).toBeLessThan(ALIAS_COMMAND_TIMEOUT_MS + 5_000);
    console.log(`ALIAS_DELAY: ${Math.round(elapsed)} ms; native pack/content gate passed`);
  });
}, ALIAS_COMMAND_TIMEOUT_MS + 10_000);

test('stuck npm ignoring TERM is killed at its bound with output, identity and shell cleanup', () => {
  control((dir, bin) => {
    const trace = join(dir, 'trace.json');
    fakeNpm(bin, `
      import { writeFileSync, writeSync } from 'node:fs';
      process.on('SIGTERM', () => {});
      writeFileSync(${JSON.stringify(trace)}, JSON.stringify({ pid: process.pid, shell: process.argv[process.argv.indexOf('--script-shell') + 1] }));
      writeSync(2, 'pack stuck control');
      for (;;) Bun.sleepSync(100);
    `);
    const probe = join(dir, 'probe.ts');
    const destination = join(dir, 'packed');
    writeFileSync(probe, `
      import { packInto, AliasTarballError } from ${JSON.stringify(helper)};
      const started = performance.now();
      try { packInto(${JSON.stringify(dir)}, ${JSON.stringify(destination)}, 1_500); process.exit(9); }
      catch (error) {
        if (!(error instanceof AliasTarballError)) throw error;
        console.log(error.message);
        console.log('ELAPSED=' + Math.round(performance.now() - started));
      }
    `);
    const result = run(probe, bin, [], 5_000);
    expect(result.status, result.stderr).toBe(0);
    for (const fragment of ['npm pack', 'TIMEOUT', 'limit=1500 ms', 'signal=SIGKILL', 'elapsed=', 'pack stuck control', `cwd=${dir}`, `destination=${destination}`, '0 new tarball(s)']) {
      expect(result.stdout).toContain(fragment);
    }
    const elapsed = Number(result.stdout.match(/ELAPSED=(\d+)/)![1]);
    expect(elapsed).toBeGreaterThanOrEqual(1_400);
    expect(elapsed).toBeLessThan(4_000);
    const recorded = JSON.parse(readFileSync(trace, 'utf8')) as { pid: number; shell: string };
    expect(() => process.kill(recorded.pid, 0)).toThrow();
    expect(readdirSync(destination)).toEqual([]);
    expect(() => readFileSync(recorded.shell)).toThrow();
    console.log(`ALIAS_STUCK: ${elapsed} ms; SIGKILL, child absent, shell removed`);
  });
}, 10_000);

for (const status of [0, 7]) {
  test(`empty-output npm exit ${status} without tarball stays an actionable refusal`, () => {
    control((dir, bin) => {
      fakeNpm(bin, `process.exit(${status});`);
      const probe = join(dir, 'probe.ts');
      writeFileSync(probe, `
        import { packInto, AliasTarballError } from ${JSON.stringify(helper)};
        try { packInto(${JSON.stringify(dir)}, ${JSON.stringify(join(dir, 'packed'))}); process.exit(9); }
        catch (error) { if (!(error instanceof AliasTarballError)) throw error; console.log(error.message); }
      `);
      const result = run(probe, bin);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(`exited ${status} and left 0 new tarball(s); one was required`);
      expect(result.stdout).toContain('(no output)');
      expect(result.stdout).toContain('signal=none');
      expect(result.stdout).not.toContain('TIMEOUT');
    });
  }, ALIAS_COMMAND_TIMEOUT_MS + 10_000);
}

// This private tiny package exercises the real CLI path with no --tarball:
// both the primary and alias npm processes must receive the explicit budget.
test('CLI release override reaches both real packs beyond the default bound and still gates equality', () => {
  control((dir, bin) => {
    const scripts = join(dir, 'scripts');
    mkdirSync(scripts);
    const copy = join(scripts, 'alias_tarball.ts');
    writeFileSync(copy, readFileSync(helper));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@rig-c/create', version: '1.2.3', files: ['payload.bin'] }, null, 2) + '\n');
    writeFileSync(join(dir, 'payload.bin'), Buffer.from([0, 1, 2, 255]));
    const trace = join(dir, 'calls');
    fakeNpm(bin, `
      import { appendFileSync } from 'node:fs';
      import { spawnSync } from 'node:child_process';
      appendFileSync(${JSON.stringify(trace)}, 'pack\\n');
      Bun.sleepSync(${PACK_TIMEOUT_MS + 250});
      const r = spawnSync(${JSON.stringify(npm)}, process.argv.slice(2), { stdio: 'inherit', timeout: ${PACK_TIMEOUT_MS}, killSignal: 'SIGKILL' });
      process.exit(r.status ?? 1);
    `);
    const started = performance.now();
    const result = run(copy, bin, ['pack', '--name', 'rig-create', '--out', join(dir, 'out'), '--pack-timeout-ms', String(MAX_PACK_TIMEOUT_MS)]);
    const elapsed = Math.round(performance.now() - started);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(readFileSync(trace, 'utf8')).toBe('pack\npack\n');
    expect(result.stderr).toContain('byte for byte but for the name line');
    expect(readFileSync(result.stdout.trim()).byteLength).toBeGreaterThan(0);
    expect(elapsed).toBeGreaterThan(2 * PACK_TIMEOUT_MS);
    expect(elapsed).toBeLessThan(ALIAS_COMMAND_TIMEOUT_MS + 5_000);
    console.log(`ALIAS_RELEASE_OVERRIDE: ${elapsed} ms; two native packs each delayed beyond ${PACK_TIMEOUT_MS} ms; CLI equality gate passed`);
  });
}, ALIAS_COMMAND_TIMEOUT_MS + 10_000);

test('CLI refuses above-ceiling and malformed pack bounds before invoking npm', () => {
  control((dir, bin) => {
    const trace = join(dir, 'called');
    fakeNpm(bin, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(trace)}, 'unexpected npm'); process.exit(9);`);
    expect(PACK_TIMEOUT_MS).toBe(15_000);
    expect(MAX_PACK_TIMEOUT_MS).toBe(300_000);
    for (const value of [String(MAX_PACK_TIMEOUT_MS + 1), '0', '-1', 'NaN', 'Infinity', '1.5', '9007199254740992']) {
      const result = run(helper, bin, ['pack', '--name', 'rig-create', '--out', join(dir, 'out'), '--pack-timeout-ms', value]);
      expect(result.status, `${value}: ${result.stderr}`).toBe(2);
      expect(result.stderr).toContain('--pack-timeout-ms must be an integer in 1..300000 ms');
      expect(result.stdout).toBe('');
    }
    expect(readdirSync(dir)).toEqual(['bin']);
  });
}, ALIAS_COMMAND_TIMEOUT_MS + 10_000);
