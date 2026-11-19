import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyMeshEdits, type MeshEditAct, type MeshEditEntry, type MeshEditInput } from '../src/mesh-edit.ts';

const stub = String.raw`
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

class PartsError extends Error {
  constructor(problems) {
    super(problems.map(p => p.code + ': ' + p.object + ' — ' + p.detail).join('\n'));
    this.problems = problems;
  }
}

export function applyMeshEditAct(input) {
  const { rig, part, out, actId, actSourceHash, payloadSha256 } = input;
  appendFileSync(join(import.meta.dir, 'calls.jsonl'), JSON.stringify(input) + '\n');
  const current = JSON.parse(readFileSync(join(rig, 'rig.json'), 'utf8'));
  const record = join(rig, 'remesh.json');
  const earlier = current.edits.find(edit => edit.actId === actId && edit.part === part);
  if (earlier) {
    if (earlier.actSourceHash !== actSourceHash || earlier.payloadSha256 !== payloadSha256) {
      throw new PartsError([{ code: 'REMESH_DELTA_ACT', object: record, detail: 'literal REMESH_DELTA_ACT_SUPERSEDED in conflict detail' }]);
    }
    if (earlier !== current.edits.at(-1)) {
      throw new PartsError([{ code: 'REMESH_DELTA_ACT_SUPERSEDED', object: record, detail: 'literal REMESH_DELTA_ACT in superseded detail' }]);
    }
    return { provenance: JSON.parse(readFileSync(record, 'utf8')), written: [] };
  }
  if (part === 'refused') {
    throw new PartsError([
      { code: 'REMESH_DELTA_SOURCE', object: 'edit source.positions[0]', detail: 'found [4, 5]; requires [0, 0]' },
      { code: 'REMESH_DELTA_SOURCE', object: 'edit source.frame', detail: 'found 80 × 60; requires 80 × 64' },
    ]);
  }
  const request = { part, actId, actSourceHash, payloadSha256 };
  current.edits.push(request);
  const provenance = { spec: 'rig-parts-remesh/1', request };
  mkdirSync(out);
  writeFileSync(join(out, 'rig.json'), JSON.stringify(current));
  writeFileSync(join(out, 'remesh.json'), JSON.stringify(provenance));
  return { provenance, written: ['rig.json', 'remesh.json'] };
}
`;

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function project(api: string | null = stub) {
  const dir = mkdtempSync(join(tmpdir(), 'mesh-edit-'));
  roots.push(dir);
  const installed = join(dir, 'node_modules/@rig-c/parts');
  const source = join(installed, 'src');
  mkdirSync(source, { recursive: true });
  writeFileSync(join(installed, 'package.json'), '{"name":"@rig-c/parts","version":"1.0.0","exports":{}}');
  writeFileSync(join(source, 'config.ts'), 'export const CONFIG_SECTIONS = ["synthetic"];');
  if (api !== null) writeFileSync(join(source, 'remesh-api.ts'), api);
  const rig = join(dir, 'original');
  const config = join(dir, 'config.json');
  const parts = join(dir, 'parts');
  const record = join(dir, 'project.json');
  mkdirSync(rig);
  mkdirSync(parts);
  writeFileSync(join(rig, 'rig.json'), '{"edits":[]}');
  writeFileSync(config, '{}');
  writeFileSync(join(parts, 'parts.json'), '{}');
  writeFileSync(record, '{\r\n  "corrections": [ ]\r\n}\r\n');
  return {
    dir, rig, config, parts, record,
    paths: (suffix: string, inputRig = rig) => ({ rig: inputRig, config, parts, out: join(dir, suffix) }),
    calls: (): MeshEditInput[] => readFileSync(join(source, 'calls.jsonl'), 'utf8').trimEnd().split('\n').map(line => JSON.parse(line)),
  };
}

function entry(part: string, digest = 'b'): MeshEditEntry {
  return {
    edit: {
      skin: 'default', slot: part, attachment: part, basis: 'setup',
      source: {
        vertexCount: 3, triangleCount: 1, hullLength: 3, hash: 'a'.repeat(64),
        frame: { width: 80, height: 64 }, positions: [[0, 0], [0, 4], [4, 4]],
      },
      ops: [{ op: 'move', v: 0, from: [0, 0], to: [0.5, 0] }],
    },
    sha256: digest.repeat(64),
  };
}

function act(...meshEdits: MeshEditEntry[]): MeshEditAct {
  return {
    schema: 'rig-review/act@8', kind: 'review-verdict', actId: 'act-synthetic',
    source: { sourceHash: 'c'.repeat(64) },
    value: { stage: 'rig-review', verdict: 'changes-requested', comments: [], meshEdits },
  };
}

test('mesh-only Request changes chains two unique edits on the installed Parts API', () => {
  const p = project();
  const arm = entry('arm');
  const cheek = entry('cheek', 'd');
  const request = act(arm, arm, cheek);
  const allocated: string[] = [];
  const results = applyMeshEdits(p.dir, request, ({ edit }, prior) => {
    allocated.push(edit.attachment);
    expect(prior.map(result => result.status)).toEqual(edit.attachment === 'arm' ? [] : ['applied']);
    return p.paths(edit.attachment);
  });
  const first = p.paths('arm');
  const second = p.paths('cheek', first.out);
  expect(allocated).toEqual(['arm', 'cheek']);
  expect(results.map(result => result.status)).toEqual(['applied', 'applied']);
  expect(p.calls()).toEqual([arm, cheek].map(({ edit, sha256 }, index) => ({
    ...(index === 0 ? first : second), part: edit.attachment, edit,
    actId: request.actId, actSourceHash: request.source.sourceHash, payloadSha256: sha256,
  })));
  expect(JSON.parse(readFileSync(join(second.out, 'rig.json'), 'utf8')).edits.map((edit: { part: string }) => edit.part)).toEqual(['arm', 'cheek']);
  expect(results[1]).toMatchObject({ input: second, written: ['rig.json', 'remesh.json'] });
  expect(JSON.parse(readFileSync(join(second.out, 'remesh.json'), 'utf8'))).toMatchObject({ spec: 'rig-parts-remesh/1' });
});

test('exact replay returns stored provenance, writes nothing and keeps the current rig for the next edit', () => {
  const p = project();
  const arm = entry('arm');
  const cheek = entry('cheek');
  const request = act(arm, cheek);
  const current = p.paths('first').out;
  expect(() => applyMeshEdits(p.dir, request, ({ edit }) => {
    if (edit.attachment === 'cheek') throw new Error('synthetic interruption');
    return p.paths('first');
  })).toThrow('synthetic interruption');
  const stored = readFileSync(join(current, 'remesh.json'));
  const rigBytes = readFileSync(join(current, 'rig.json'));
  const results = applyMeshEdits(p.dir, request, ({ edit }) => (
    edit.attachment === 'arm' ? p.paths('unused', current) : p.paths('second')
  ));
  expect(results[0]).toMatchObject({ status: 'replayed', written: [], provenance: JSON.parse(stored.toString()) });
  expect(results[1]).toMatchObject({ status: 'applied', input: { rig: current } });
  expect(existsSync(p.paths('unused').out)).toBe(false);
  expect(readFileSync(join(current, 'remesh.json'))).toEqual(stored);
  expect(readFileSync(join(current, 'rig.json'))).toEqual(rigBytes);
});

test('superseded replay succeeds with the producer object and detail and keeps the current rig', () => {
  const p = project();
  const request = act(entry('arm'), entry('cheek'));
  applyMeshEdits(p.dir, request, ({ edit }) => p.paths(edit.attachment));
  const current = p.paths('cheek').out;
  const results = applyMeshEdits(p.dir, request, ({ edit }) => (
    edit.attachment === 'arm' ? p.paths('unused-arm', current) : p.paths('unused-cheek')
  ));
  expect(results[0]).toMatchObject({
    status: 'superseded', input: { rig: current },
    problem: {
      code: 'REMESH_DELTA_ACT_SUPERSEDED', object: join(current, 'remesh.json'),
      detail: 'literal REMESH_DELTA_ACT in superseded detail',
    },
  });
  expect(results[1]).toMatchObject({ status: 'replayed', input: { rig: current }, written: [] });
  expect(existsSync(p.paths('unused-arm').out)).toBe(false);
  expect(existsSync(p.paths('unused-cheek').out)).toBe(false);
});

test('REMESH_DELTA_ACT stays a refusal when opaque detail mentions superseded replay', () => {
  const p = project();
  const first = p.paths('first').out;
  applyMeshEdits(p.dir, act(entry('arm')), () => p.paths('first'));
  expect(() => applyMeshEdits(p.dir, act(entry('arm', 'e')), () => p.paths('conflict', first))).toThrow(expect.objectContaining({
    code: 'REMESH_DELTA_ACT', object: join(first, 'remesh.json'), detail: 'literal REMESH_DELTA_ACT_SUPERSEDED in conflict detail',
  }));
  expect(existsSync(p.paths('conflict').out)).toBe(false);
});

test('a second edit refusal relays all Parts problems and leaves project.json byte-identical', () => {
  const p = project();
  const before = readFileSync(p.record);
  const request = act(entry('arm'), entry('refused'), entry('unreached'));
  const problems = [
    { code: 'REMESH_DELTA_SOURCE', object: 'edit source.positions[0]', detail: 'found [4, 5]; requires [0, 0]' },
    { code: 'REMESH_DELTA_SOURCE', object: 'edit source.frame', detail: 'found 80 × 60; requires 80 × 64' },
  ];
  expect(() => {
    const results = applyMeshEdits(p.dir, request, ({ edit }) => p.paths(edit.attachment));
    writeFileSync(p.record, JSON.stringify({ corrections: results }));
  }).toThrow(expect.objectContaining({ ...problems[0], problems }));
  expect(p.calls().map(input => input.part)).toEqual(['arm', 'refused']);
  expect(existsSync(join(p.paths('arm').out, 'remesh.json'))).toBe(true);
  expect(existsSync(p.paths('refused').out)).toBe(false);
  expect(readFileSync(p.record)).toEqual(before);
});

test.each([null, 'export const other = 1;'])('names an absent installed remesh API or export (%p)', api => {
  const p = project(api);
  expect(() => applyMeshEdits(p.dir, act(entry('arm')), () => p.paths('unused'))).toThrow(expect.objectContaining({
    code: 'PARTS_REMESH_API_UNAVAILABLE', message: expect.stringContaining(join(p.dir, 'node_modules/@rig-c/parts/src/remesh-api.ts')),
  }));
  expect(existsSync(p.paths('unused').out)).toBe(false);
});
