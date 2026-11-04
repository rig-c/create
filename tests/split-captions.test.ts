import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { splitCaptions } from '../src/split-captions.ts';
import { Refusal } from '../src/refusal.ts';
import type { Json, JsonObject } from '../src/templates.ts';
import { cli } from './helpers.ts';

const templates = join(import.meta.dir, '..', 'templates');
const example = join(templates, 'example-project.json');
const configPath = join(templates, 'example-split', 'config.json');
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(): { dir: string; project: JsonObject; config: JsonObject; save: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'split-captions-'));
  dirs.push(dir);
  const project = JSON.parse(readFileSync(example, 'utf8')) as JsonObject;
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as JsonObject;
  const save = (): void => {
    writeFileSync(join(dir, 'project.json'), `${JSON.stringify(project)}\n`);
    writeFileSync(join(dir, 'config.json'), `${JSON.stringify(config)}\n`);
  };
  save();
  return { dir, project, config, save };
}

function obj(value: unknown): JsonObject {
  return value as JsonObject;
}

function refused(file: string, config: string, code: string): void {
  try {
    splitCaptions(file, config);
    throw new Error('expected refusal');
  } catch (error) {
    expect(error).toBeInstanceOf(Refusal);
    expect((error as Refusal).code).toBe(code);
  }
}

test('the shipped list is generated from the filled example and synthetic config', () => {
  const generated = splitCaptions(example, configPath);
  expect(`${JSON.stringify(generated, null, 2)}\n`).toBe(readFileSync(join(templates, 'example-split', 'captions.json'), 'utf8'));
  expect(generated.parts).toHaveLength(19);
  expect(generated.inputs.project.sha256).toBe(createHash('sha256').update(readFileSync(example)).digest('hex'));
  expect(generated.inputs.config.sha256).toBe(createHash('sha256').update(readFileSync(configPath)).digest('hex'));
  expect(generated.parts.find((part) => part.name === 'lantern')?.text).toBe('"lantern" = "rigid"');
  expect(generated.config.find((entry) => entry.path === 'config["regions"]')?.text).toContain('"lantern":"hand_r"');
});

test('scale, source plan, arm route and region binding changes change actual caption text', () => {
  const f = fixture();
  const file = join(f.dir, 'project.json');
  const before = splitCaptions(file);
  obj(f.config.assemble).rig_scale = 0.75;
  const plan = obj(f.config.assemble).plan as unknown[][];
  plan[0]![2] = 'author:replacement';
  const limbs = obj(f.config.limbs);
  const segments = obj(limbs.arm_l).segments as JsonObject[];
  segments[0]!.from = 'scarf';
  segments[1]!.from = 'scarf';
  delete obj(f.config.regions).scarf;
  obj(f.config.regions).sleeve_l = 'root';
  obj(f.config.regions).lantern = 'hand_l';
  f.save();
  const after = splitCaptions(file);
  for (const section of ['assemble', 'limbs', 'regions']) {
    const path = `config[${JSON.stringify(section)}]`;
    expect(after.config.find((entry) => entry.path === path)?.text).not.toBe(before.config.find((entry) => entry.path === path)?.text);
  }
  expect(after.config.find((entry) => entry.path === 'config["assemble"]')?.text).toContain('"rig_scale":0.75');
  expect(after.config.find((entry) => entry.path === 'config["limbs"]')?.text).toContain('"from":"scarf"');
  expect(after.inputs.config.sha256).not.toBe(before.inputs.config.sha256);
});

test('split names, labels, membership and order come from the current record', () => {
  const f = fixture();
  const file = join(f.dir, 'project.json');
  const before = splitCaptions(file);
  const parts = obj(f.project.split).parts as JsonObject[];
  parts[0]!.name = 'new-name';
  parts[0]!.label = 'physics';
  parts.reverse();
  parts.pop();
  f.save();
  const after = splitCaptions(file);
  expect(after.parts).toHaveLength(before.parts.length - 1);
  expect(after.parts[0]?.name).toBe('lantern');
  expect(after.inputs.project.sha256).not.toBe(before.inputs.project.sha256);
  parts.push({ name: 'new-name', label: 'physics' });
  f.save();
  expect(splitCaptions(file).parts.at(-1)?.text).toBe('"new-name" = "physics"');
});

test('notes and records never become caption prose, including nested config annotations', () => {
  const f = fixture();
  const file = join(f.dir, 'project.json');
  const before = splitCaptions(file);
  const marker = 'AUTHORED CAPTION MUST NEVER APPEAR';
  for (const part of obj(f.project.split).parts as JsonObject[]) part.note = marker;
  f.config.note = marker;
  f.config['x-caption'] = marker;
  obj(f.config.assemble).scale_note = marker;
  (f.config.bones as JsonObject[])[0]!.note = marker;
  f.save();
  const after = splitCaptions(file);
  expect(after.config).toEqual(before.config);
  expect(after.parts).toEqual(before.parts);
  expect(JSON.stringify(after)).not.toContain(marker);
});

test('part-name maps retain a part named note and filter its field annotations', () => {
  const f = fixture();
  const parts = obj(f.project.split).parts as JsonObject[];
  parts.push({ name: 'note', label: 'rigid' });
  (obj(f.config.assemble).plan as unknown[][]).push(['note', 'full', 'author:note']);
  obj(f.config.regions).note = { bone: 'root', note: 'omit me' };
  f.save();
  const result = splitCaptions(join(f.dir, 'project.json'));
  const regions = obj(result.config.find((entry) => entry.path === 'config["regions"]')?.value);
  expect(regions.note).toEqual({ bone: 'root' });
});

test.each(['full', 'head'])('depth.%s.layers preserves exact source names and removes sheet annotations', (run) => {
  const f = fixture();
  const sheet = { image: 'synthetic-depth.png', near: 'black', zScale: 1 };
  const layers = Object.fromEntries(['note', 'layer_note', 'x-layer'].map((name) => [name,
    { ...sheet, note: 'sheet annotation', source_note: 'sheet annotation', 'x-record': { annotation: true } },
  ]));
  f.config.depth = { [run]: { layers, note: 'run annotation' }, note: 'depth annotation' };
  f.save();
  const file = join(f.dir, 'project.json');
  const before = splitCaptions(file);
  const expected = { [run]: { layers: Object.fromEntries(Object.keys(layers).map((name) => [name, sheet])) } };
  const caption = before.config.find((entry) => entry.path === 'config["depth"]');
  expect(caption?.value).toEqual(expected);
  expect(caption?.text).toBe(`config["depth"] = ${JSON.stringify(expected)}`);
  obj(obj(obj(f.config.depth)[run]).layers).note = { ...sheet, zScale: 2 };
  f.save();
  expect(splitCaptions(file).config.find((entry) => entry.path === 'config["depth"]')?.text).not.toBe(caption?.text);
});

test.each(['note', 'arm_note', 'x-arm'])('limb name %s survives while its field annotations are omitted', (name) => {
  const f = fixture();
  const limbs = obj(f.config.limbs);
  const limb = obj(limbs.arm_l);
  const expected = structuredClone(limb);
  limb.note = 'limb annotation';
  (limb.segments as JsonObject[])[0]!.source_note = 'segment annotation';
  limbs[name] = limb;
  delete limbs.arm_l;
  f.save();
  const result = splitCaptions(join(f.dir, 'project.json'));
  const value = obj(result.config.find((entry) => entry.path === 'config["limbs"]')?.value);
  expect(value[name]).toEqual(expected);
  expect(value.arm_l).toBeUndefined();
});

test.each(['note', 'part_note', 'x-part'])('turn.depths preserves exact part name %s', (name) => {
  const f = fixture();
  (obj(f.config.assemble).plan as Json[][]).push([name, 'full', `author:${name}`]);
  obj(f.config.regions)[name] = 'root';
  f.config.turn = { pivot: 1, depths: { [name]: 0 }, note: 'turn annotation' };
  f.save();
  const result = splitCaptions(join(f.dir, 'project.json'));
  expect(result.config.find((entry) => entry.path === 'config["turn"]')?.value).toEqual({ pivot: 1, depths: { [name]: 0 } });
});

test('early assembly configs work before complete rig sections exist', () => {
  const f = fixture();
  for (const key of ['bones', 'limbs', 'regions', 'meshes', 'motion']) delete f.config[key];
  f.save();
  expect(splitCaptions(join(f.dir, 'project.json')).config.find((entry) => entry.path === 'config["assemble"]')?.text).toContain('"rig_scale":0.5');
});

const malformedSplits: Json[] = [null, [], {}, { parts: [] }, { parts: [null] }, { parts: [{ name: '', label: 'still' }] },
  { parts: [{ name: 'a', label: 'unknown' }] }, { parts: [{ name: 'a', label: 'still' }, { name: 'a', label: 'rigid' }] }];

test.each(malformedSplits.map((split) => [split] as const))(
  'malformed split data is refused (%j)', (split) => {
    const f = fixture();
    f.project.split = split;
    f.save();
    refused(join(f.dir, 'project.json'), join(f.dir, 'config.json'), 'SPLIT_CAPTIONS_PARTS_INVALID');
  },
);

test.each([0, -1, '0.5', null])('malformed scale is refused by the installed config contract (%j)', (scale) => {
  const f = fixture();
  obj(f.config.assemble).rig_scale = scale;
  f.save();
  refused(join(f.dir, 'project.json'), join(f.dir, 'config.json'), 'SPLIT_CAPTIONS_CONFIG_INVALID');
});

test('malformed assembly plans and limb references are refused', () => {
  const f = fixture();
  const plan = obj(f.config.assemble).plan;
  obj(f.config.assemble).plan = [['bad', 'unknown-run', 'unknown-tag']];
  f.save();
  refused(join(f.dir, 'project.json'), join(f.dir, 'config.json'), 'SPLIT_CAPTIONS_CONFIG_INVALID');
  obj(f.config.assemble).plan = plan;
  const segments = obj(obj(f.config.limbs).arm_l).segments as JsonObject[];
  segments[0]!.bone = 'missing-bone';
  f.save();
  refused(join(f.dir, 'project.json'), join(f.dir, 'config.json'), 'SPLIT_CAPTIONS_CONFIG_INVALID');
});

test('invalid config route is refused instead of printed as a caption', () => {
  const f = fixture();
  obj(f.config.regions).lantern = 'missing-bone';
  f.save();
  refused(join(f.dir, 'project.json'), join(f.dir, 'config.json'), 'SPLIT_CAPTIONS_CONFIG_INVALID');
});

test.each(['project.json', 'config.json'])('missing, invalid JSON and non-object %s inputs are refused', (name) => {
  const f = fixture();
  const file = join(f.dir, name);
  const project = join(f.dir, 'project.json');
  const config = join(f.dir, 'config.json');
  rmSync(file);
  refused(project, config, 'SPLIT_CAPTIONS_INPUT_UNREADABLE');
  for (const bytes of ['{', 'null', '[]']) {
    writeFileSync(file, bytes);
    refused(project, config, 'SPLIT_CAPTIONS_INPUT_INVALID');
  }
});

test('unknown project schema is refused', () => {
  const f = fixture();
  f.project.schema = 'unknown';
  f.save();
  refused(join(f.dir, 'project.json'), join(f.dir, 'config.json'), 'SCHEMA_UNKNOWN');
});

test('CLI supports a project folder, cwd defaults, an explicit project file and config relative to it', () => {
  const f = fixture();
  const env = { ...process.env } as Record<string, string>;
  const before = ['project.json', 'config.json'].map((file) => readFileSync(join(f.dir, file), 'utf8'));
  for (const args of [['split-captions'], ['split-captions', f.dir],
    ['split-captions', example, '--config', 'example-split/config.json']]) {
    const result = cli(args, f.dir, env);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout).parts).toHaveLength(19);
  }
  expect(['project.json', 'config.json'].map((file) => readFileSync(join(f.dir, file), 'utf8'))).toEqual(before);
});

test.each([['--config'], ['--config', '--other'], ['--config', 'a', '--config', 'b'], ['a', 'b'], ['--json']]
  .map((args) => [args] as const))(
  'CLI usage errors return exit 2 and no caption output (%j)', (args) => {
    const f = fixture();
    const result = cli(['split-captions', ...args], f.dir, process.env as Record<string, string>);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
  },
);

test('CLI malformed input returns exit 1 with a named refusal and no stdout', () => {
  const f = fixture();
  writeFileSync(join(f.dir, 'config.json'), '{');
  const result = cli(['split-captions'], f.dir, process.env as Record<string, string>);
  expect(result.code).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('SPLIT_CAPTIONS_INPUT_INVALID');
});
