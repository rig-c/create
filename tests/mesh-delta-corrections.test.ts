import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyMeshDeltaCorrections, recordMeshDeltaCorrections, type MeshDeltaCorrectionAct } from '../src/correction-writers.ts';
import { checkCorrections, correctionApprovalFindings, correctionHash, pendingMeshDeltaRevision } from '../src/corrections.ts';
import { applyMeshEdits, type MeshEditEntry } from '../src/mesh-edit.ts';
import type { JsonObject } from '../src/templates.ts';
import { correctionFixture } from './correction-fixture.ts';
import { testClock } from './clock.ts';

// Model just the published Parts receipt, file writes, and replay behavior. No geometry is measured here.
const stub = String.raw`
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

function row(path, bytes) {
  return { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}
function refuse(code, object, detail) {
  throw Object.assign(new Error(detail), { problems: [{ code, object, detail }] });
}
export function applyMeshEditAct(input) {
  const { rig, part, out, edit, actId, actSourceHash, payloadSha256 } = input;
  const receipt = join(rig, 'remesh.json');
  const before = JSON.parse(readFileSync(join(rig, 'rig.json'), 'utf8'));
  if (before.edits.includes(part)) {
    if (before.edits.at(-1) === part) return { provenance: JSON.parse(readFileSync(receipt)), written: [] };
    refuse('REMESH_DELTA_ACT_SUPERSEDED', receipt, 'the current revision moved past that edit');
  }
  if (part === 'right' && existsSync(join(dirname(input.config), '../derived/deny-right'))) {
    refuse('REMESH_DELTA_SOURCE', 'source.positions[0]', 'synthetic refusal');
  }
  const motion = readFileSync(join(rig, 'motion.json'));
  const files = new Map([['rig.json', Buffer.from(JSON.stringify({ edits: [...before.edits, part] }))], ['motion.json', motion]]);
  const inputRig = [row('rig.json', readFileSync(join(rig, 'rig.json'))), row('motion.json', motion)];
  const parents = [];
  if (existsSync(receipt)) {
    const bytes = readFileSync(receipt);
    const previous = JSON.parse(bytes);
    for (const member of previous.revision) {
      if (member.path.startsWith('provenance/')) files.set(member.path, readFileSync(join(rig, member.path)));
    }
    const ref = row('remesh.json', bytes);
    const archive = 'provenance/remesh-' + ref.sha256 + '.json';
    files.set(archive, bytes);
    inputRig.push(ref);
    parents.push({ ...row(archive, bytes), source: 'remesh.json' });
  }
  const provenance = {
    spec: 'rig-parts-remesh/1',
    request: { part, edit, act_id: actId, act_source_hash: actSourceHash, payload_sha256: payloadSha256 },
    input: { rig: inputRig, provenance: parents },
    revision: [...files].map(([path, bytes]) => row(path, bytes)),
  };
  files.set('remesh.json', Buffer.from(JSON.stringify(provenance)));
  for (const [path, bytes] of files) {
    const target = join(out, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }
  return { provenance, written: [...files.keys()] };
}
`;

const roots: string[] = [];
const now = Date.parse('2026-11-04T09:20:00Z');
afterEach(() => { testClock.reset(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function entry(part: string): MeshEditEntry {
  // In sorted-key order, so this literal encodes the signed canonical payload in the fixture.
  const edit: MeshEditEntry['edit'] = {
    attachment: part, basis: 'setup', ops: [{ from: [0, 0], op: 'move', to: [0.5, 0], v: 0 }], skin: 'default', slot: part,
    source: {
      frame: { height: 64, width: 80 }, hash: 'a'.repeat(64), hullLength: 3,
      positions: [[0, 0], [0, 4], [4, 4]], triangleCount: 1, vertexCount: 3,
    },
  };
  return { edit, sha256: correctionHash(Buffer.from(JSON.stringify(edit))) };
}

function fixture(...meshEdits: MeshEditEntry[]) {
  const dir = mkdtempSync(join(tmpdir(), 'mesh-delta-correction-'));
  roots.push(dir);
  const { project } = correctionFixture(dir, 'rig');
  const record = join(dir, 'project.json');
  project.versions = (project.versions as JsonObject[]).slice(0, 1);
  writeFileSync(record, JSON.stringify(project, null, 2) + '\n');
  const derived = join(dir, 'derived');
  const paths = { rig: join(derived, 'source-rig'), config: join(dir, 'evidence/source-config.json'), parts: join(dir, 'parts') };
  mkdirSync(paths.rig);
  writeFileSync(join(paths.rig, 'rig.json'), '{"edits":[]}');
  writeFileSync(join(paths.rig, 'motion.json'), '{}');
  const installed = join(dir, 'node_modules/@rig-c/parts');
  mkdirSync(join(installed, 'src'), { recursive: true });
  writeFileSync(join(installed, 'package.json'), '{"name":"@rig-c/parts","version":"1.0.0"}');
  writeFileSync(join(installed, 'src/config.ts'), 'export const CONFIG_SECTIONS = ["synthetic"];');
  writeFileSync(join(installed, 'src/remesh-api.ts'), stub);
  const model = 'derived/review/v1/out/check/build/skeleton.model.json';
  const act: MeshDeltaCorrectionAct = {
    schema: 'rig-review/act@8', kind: 'review-verdict', actId: 'synthetic-finalized-act', at: '2026-11-04T09:10:00Z',
    source: { sourceHash: 'c'.repeat(64), selector: { kind: 'rig', version: 1 }, model: { path: model, sha256: correctionHash(readFileSync(join(dir, model))) } },
    value: { stage: 'rig-review', verdict: 'changes-requested', meshEdits, comments: [] },
  };
  return { dir, record, derived, paths, act, apply: () => applyMeshDeltaCorrections(dir, act, paths, now) };
}

function load(path: string): JsonObject { return JSON.parse(readFileSync(path, 'utf8')); }

function check(dir: string, project: JsonObject) {
  const ctx: Parameters<typeof checkCorrections>[0] = { dir, project, refusals: [], warnings: [] };
  checkCorrections(ctx, now);
  return ctx.refusals.map(finding => finding.code);
}

test('mesh-only act records both attachments once and adopts their final chained revision', () => {
  const left = entry('left');
  const right = entry('right');
  const f = fixture(left, left, right);
  const applied = f.apply();
  expect(applied.map(result => result.status)).toEqual(['applied', 'applied']);
  const project = load(f.record);
  const records = project.corrections as JsonObject[];
  expect(records).toHaveLength(2);
  expect(records[1]).toMatchObject({
    schema: 'rig-create/correction@1', path: 'made', by: 'user', verbatim: null, stage: 'rig-review', on: { n: 1 },
    artifact: { kind: 'mesh-delta', actId: f.act.actId, sourceHash: f.act.source.sourceHash, payloadSha256: right.sha256, skin: 'default', slot: 'right', attachment: 'right' },
    outcome: { kind: 'mesh-delta', code: null, object: null },
  });
  expect(check(f.dir, project)).toEqual([]);
  const final = records[1]!.outcome as JsonObject;
  const revision = String(final.revision);
  expect(load(join(f.dir, revision, 'rig.json'))).toEqual({ edits: ['left', 'right'] });
  expect(pendingMeshDeltaRevision(project)).toEqual({ sourceVersion: 1, revision });
  expect(correctionApprovalFindings(project, 'rig-review').map(finding => finding.code)).toEqual(['CORRECTION_PENDING']);
  const version = { n: 2, kind: 'rig', at: '2026-11-04T09:20:00Z', outputs: [] as JsonObject[], registration: {} as JsonObject };
  (project.versions as JsonObject[]).push(version);
  expect(check(f.dir, project)).toEqual(['CORRECTION_MESH_DELTA_REVISION']);
  version.outputs = (final.written as JsonObject[]).map(row => ({ ...row, path: String(row.path).replace(revision, 'outputs/v2/out/rig') }));
  const modelHash = correctionHash(Buffer.from('synthetic compiled result'));
  version.outputs.push({ path: 'outputs/v2/out/check/build/skeleton.model.json', sha256: modelHash });
  const run = {
    spec: 'rigc-run/1', package: { name: 'rig-c', version: '0.0.0-synthetic' }, command: 'build',
    started_at: new Date(now - 1).toISOString(), finished_at: new Date(now).toISOString(),
    inputs: [
      { role: 'rig', path: '../rig.json', sha256: correctionHash(readFileSync(join(f.paths.rig, 'rig.json'))) },
      { role: 'motion', path: '../motion.json', sha256: correctionHash(readFileSync(join(f.dir, revision, 'motion.json'))) },
    ],
    outputs: [{ path: 'skeleton.model.json', sha256: modelHash }],
  };
  const bindRun = () => {
    const path = 'evidence/compiler-run.json';
    const bytes = Buffer.from(JSON.stringify(run));
    writeFileSync(join(f.dir, path), bytes);
    version.registration = { runs: [{ spec: run.spec, source: { path, sha256: correctionHash(bytes) } }] };
  };
  bindRun();
  expect(check(f.dir, project)).toEqual(['CORRECTION_MESH_DELTA_REVISION']);
  run.inputs[0]!.sha256 = correctionHash(readFileSync(join(f.dir, revision, 'rig.json')));
  bindRun();
  expect(check(f.dir, project)).toEqual([]);
  expect(pendingMeshDeltaRevision(project)).toBeNull();
  expect(correctionApprovalFindings(project, 'rig-review')).toEqual([]);
  const before = readFileSync(f.record);
  expect(applyMeshDeltaCorrections(f.dir, f.act, { ...f.paths, rig: revision }, now)).toEqual([
    { status: 'superseded', code: 'REMESH_DELTA_ACT_SUPERSEDED', object: join(f.dir, revision, 'remesh.json'), detail: 'the current revision moved past that edit' },
    { status: 'replayed', code: null, object: null },
  ]);
  expect(readFileSync(f.record)).toEqual(before);
});

test('a refusal on the second apply leaves the record unchanged and retry can use fresh owned destinations', () => {
  const f = fixture(entry('left'), entry('right'));
  const before = readFileSync(f.record);
  const preexisting = join(f.derived, 'mesh-delta-preexisting');
  mkdirSync(preexisting);
  const marker = join(preexisting, 'owned-by-someone-else');
  writeFileSync(marker, 'keep');
  const deny = join(f.derived, 'deny-right');
  writeFileSync(deny, 'refuse');
  expect(f.apply).toThrow(expect.objectContaining({ code: 'REMESH_DELTA_SOURCE', object: 'source.positions[0]' }));
  expect(readFileSync(f.record)).toEqual(before);
  expect(readdirSync(f.derived).filter(name => name.startsWith('mesh-delta-'))).toEqual(['mesh-delta-preexisting']);
  expect(readFileSync(marker, 'utf8')).toBe('keep');
  rmSync(deny);
  expect(f.apply().map(result => result.status)).toEqual(['applied', 'applied']);
});

test('writer refuses retained results whose bytes or lineage differ without replacing project.json', () => {
  const f = fixture(entry('left'), entry('right'));
  const results = applyMeshEdits(f.dir, f.act, (_entry, prior) => ({ ...f.paths, out: join(f.derived, `test-${prior.length}`) }));
  const before = readFileSync(f.record);
  expect(() => recordMeshDeltaCorrections(f.dir, f.act, [results[0]!, { ...results[1]!, input: { ...results[1]!.input, rig: f.paths.rig } }], now))
    .toThrow(expect.objectContaining({ code: 'CORRECTION_MESH_DELTA_INVALID' }));
  expect(readFileSync(f.record)).toEqual(before);
  writeFileSync(join(results[1]!.input.out, 'rig.json'), '{"edits":[]}');
  expect(() => recordMeshDeltaCorrections(f.dir, f.act, results, now)).toThrow(expect.objectContaining({ code: 'CORRECTION_MESH_DELTA_INVALID' }));
  expect(readFileSync(f.record)).toEqual(before);
});
