import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkSourcePins } from '../scripts/check-source-pins.ts';

test('scripts/check-source-pins.ts accepts release descendants and refuses a planted older SHA naming the package', () => {
  const root = mkdtempSync(join(tmpdir(), 'pin-ancestry-'));
  try {
    const create = join(root, 'create');
    mkdirSync(join(create, 'scripts'), { recursive: true });
    writeFileSync(join(create, 'package.json'), JSON.stringify({ dependencies: { '@rig-c/core': '1.0.0', '@rig-c/parts': '1.0.0', '@rig-c/review': '1.0.0' } }));
    const pins: Record<string, string> = {};
    let older = '';
    for (const name of ['core', 'parts', 'review', 'play']) {
      const cwd = join(root, name); mkdirSync(cwd);
      const git = (...args: string[]) => {
        const r = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
        if (r.exitCode !== 0) throw new Error(r.stderr.toString());
        return r.stdout.toString().trim();
      };
      git('init', '-q'); git('config', 'user.email', 'fixture@example.test'); git('config', 'user.name', 'Fixture');
      git('commit', '--allow-empty', '-qm', 'before');
      if (name === 'core') older = git('rev-parse', 'HEAD');
      writeFileSync(join(cwd, 'package.json'), JSON.stringify({ dependencies: { '@rig-c/play': '1.0.0' } }));
      git('add', 'package.json'); git('commit', '-qm', 'release'); git('tag', 'v1.0.0');
      git('commit', '--allow-empty', '-qm', 'after'); pins[name] = git('rev-parse', 'HEAD');
    }
    const save = () => writeFileSync(join(create, 'scripts/source-ci-pins.json'), JSON.stringify(pins));
    save(); expect(() => checkSourcePins(create)).not.toThrow();
    pins.core = older; save();
    expect(() => checkSourcePins(create)).toThrow('SOURCE_PIN_ANCESTRY: scripts/source-ci-pins.json @rig-c/core');
    try { checkSourcePins(create); } catch (error) { console.log(`Planted failure: ${String(error)}`); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
