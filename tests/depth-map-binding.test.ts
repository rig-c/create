/** The installed Parts provider-map identity contract, on synthetic inputs only. */
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { locateParts } from '../src/parts-sections.ts';
import { jobRuntimeExecArgv } from '../src/job-writer.ts';
import { EXAMPLE_SOURCE_DATE_EPOCH } from '../scripts/example-time.ts';

const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

test('#559 real Parts sequence binds new maps, reuses unchanged input and refuses stale maps before output', () => {
  const root = mkdtempSync(join(tmpdir(), 'create-depth-binding-'));
  try {
    const parts = locateParts(root)!;
    const cli = (args: string[], expected = 0) => {
      const result = Bun.spawnSync([process.execPath, ...jobRuntimeExecArgv(), join(parts, 'cli.ts'), ...args],
        { cwd: root, env: { ...process.env, SOURCE_DATE_EPOCH: EXAMPLE_SOURCE_DATE_EPOCH }, stdout: 'pipe', stderr: 'pipe', timeout: 30_000 });
      expect(result.exitCode, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`).toBe(expected);
      return `${result.stdout}\n${result.stderr}`;
    };
    const put = (path: string, value: unknown) => writeFileSync(join(root, path), `${JSON.stringify(value, null, 2)}\n`);
    cpSync(join(import.meta.dir, '../templates/example-draft/input'), join(root, 'parts'), { recursive: true });
    const manifest = JSON.parse(readFileSync(join(root, 'parts/parts.json'), 'utf8'));
    const selected = ['torso', 'lantern'];
    put('config.json', { key: 'synthetic',
      assemble: { rig_scale: 1, plan: manifest.parts.map((part: { name: string; from: string }) => [part.name, part.from.slice(0, part.from.indexOf(':')), part.from.slice(part.from.indexOf(':') + 1)]) },
      motion: { duration: 4, tracks: [{ bone: 'body', prop: 'translatey', amp: 0.9, period: 4, phase: 0, base: 0 }] },
      bones: [{ name: 'body', parent: 'root', at: [64, 64] }], meshes: {},
      regions: Object.fromEntries(manifest.parts.map((part: { name: string }) => [part.name, 'body'])),
      turn: { body: { bone: 'body', pivot: 15, roles: Object.fromEntries(selected.map(part => [part, 'surface'])) } } });
    const recipe = { spec: 'rig-parts-depth/1', prepare: { longSide: 64, paddingFraction: 0, padding: 0 },
      groups: { body: { near: 'white', zScale: 30, pivot: 15 } },
      parts: Object.fromEntries(selected.map(part => [part, { map: `${part}.json`, source: 'depth', frame: 'part', group: 'body', median: 15, relief: 2 }])), clear: [] };
    put('depth.json', recipe);
    const prepare = (out: string) => cli(['depth-prepare', '--parts', 'parts', '--config', 'depth.json', '--out', out]);
    const apply = (input: string, out: string, expected = 0) => cli(['depth-apply', '--parts', 'parts', '--manifest', `${input}/manifest.json`, '--config', 'depth.json', '--rig-config', 'config.json', '--out', out], expected);
    prepare('inference');
    for (const part of selected) {
      const size = manifest.parts.find((row: { name: string }) => row.name === part);
      put(`${part}.json`, { spec: 'rig-parts-map/1', width: size.w, height: size.h, channels: 1,
        data: Array.from({ length: size.w * size.h }, (_, i) => i / (size.w * size.h)) });
    }
    // Absence is a real producer WARN, never an inferred producer report field.
    const absent = apply('inference', 'unbound');
    expect(absent.match(/DEPTH_MAP_BINDING_ABSENT/g)).toHaveLength(2);
    for (const part of selected) {
      cli(['depth-bind', '--map', `${part}.json`, '--input', `inference/${part}.png`, '--part', part]);
      const receipt = JSON.parse(readFileSync(join(root, `${part}.json.binding.json`), 'utf8'));
      expect(receipt).toEqual({ spec: 'rig-parts-depth-map-binding/1', part,
        mapSha256: hash(readFileSync(join(root, `${part}.json`))), inputSha256: hash(readFileSync(join(root, `inference/${part}.png`))) });
    }
    expect(apply('inference', 'bound')).not.toContain('DEPTH_MAP_BINDING_ABSENT');
    expect(readFileSync(join(root, 'bound/depth-report.json'))).toEqual(readFileSync(join(root, 'unbound/depth-report.json')));
    cli(['rig', '--parts', 'bound', '--config', 'bound/config.json', '--out', 'rig']);
    expect(JSON.parse(readFileSync(join(root, 'rig/depth_sheets.json'), 'utf8')).spec).toBe('rig-parts-depth-sheets/1');
    const receipt = readFileSync(join(root, 'torso.json.binding.json'));
    prepare('unchanged');
    expect(apply('unchanged', 'reused')).not.toContain('DEPTH_MAP_BINDING_ABSENT');
    expect(readFileSync(join(root, 'torso.json.binding.json'))).toEqual(receipt);
    expect(cli(['depth-bind', '--map', 'torso.json', '--input', 'unchanged/torso.png', '--part', 'torso'], 1)).toContain('DEPTH_MAP_BINDING');
    recipe.prepare.padding = 1;
    put('depth.json', recipe);
    prepare('changed');
    expect(apply('changed', 'stale', 1)).toContain('DEPTH_MAP_BINDING');
    expect(existsSync(join(root, 'stale'))).toBe(false);
    expect(readFileSync(join(root, 'torso.json.binding.json'))).toEqual(receipt);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30_000);
