import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { EXAMPLE_NOW } from '../scripts/example-time.ts';
import { reviewCommand } from '../src/feedback.ts';
import { nextProject } from '../src/next.ts';
import { rigVersionCommand } from '../src/rig-version.ts';
import type { JsonObject } from '../src/templates.ts';
import { tempDir } from './helpers.ts';

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

function fileRows(dir: string, within = ''): { path: string; bytes: number; sha256: string }[] {
  return readdirSync(join(dir, within)).sort().flatMap(name => {
    const path = within ? `${within}/${name}` : name;
    if (statSync(join(dir, path)).isDirectory()) return fileRows(dir, path);
    const bytes = readFileSync(join(dir, path));
    return [{ path, bytes: bytes.length, sha256: sha256(bytes) }];
  });
}

function meshCorrection(dir: string, input: string, revision: string, on: JsonObject, index: number): JsonObject {
  const inputRows = fileRows(join(dir, input));
  cpSync(join(dir, input), join(dir, revision), { recursive: true });
  const ancestors = [];
  const receipt = inputRows.find(row => row.path === 'remesh.json');
  if (receipt) {
    const path = `provenance/remesh-${receipt.sha256}.json`;
    mkdirSync(join(dir, revision, dirname(path)), { recursive: true });
    cpSync(join(dir, revision, 'remesh.json'), join(dir, revision, path));
    rmSync(join(dir, revision, 'remesh.json'));
    ancestors.push({ ...receipt, path, source: 'remesh.json' });
  }
  // Vary the synthetic producer bytes so an earlier or unrelated rig cannot satisfy the final binding.
  const rig = join(dir, revision, 'rig.json');
  writeFileSync(rig, `${readFileSync(rig, 'utf8').trim()}${' '.repeat(index)}\n`);
  const sourceHash = 'a'.repeat(64);
  const payloadSha256 = String(index).repeat(64);
  const part = index === 1 ? 'face' : 'torso';
  const edit = { skin: 'default', slot: part, attachment: part };
  const actId = 'synthetic-act';
  const provenance = { spec: 'rig-parts-remesh/1', request: { act_id: actId, act_source_hash: sourceHash,
    payload_sha256: payloadSha256, part, edit },
  input: { rig: inputRows, provenance: ancestors }, revision: fileRows(join(dir, revision)) };
  writeFileSync(join(dir, revision, 'remesh.json'), JSON.stringify(provenance));
  const written = fileRows(join(dir, revision)).map(({ path, sha256 }) => ({ path: `${revision}/${path}`, sha256 }));
  const at = new Date(EXAMPLE_NOW + 1000).toISOString();
  return { schema: 'rig-create/correction@1', id: `synthetic-mesh-${index}`, path: 'made', by: 'user', at, verbatim: null,
    stage: 'rig-review', on, resolves: null, artifact: { kind: 'mesh-delta', actId, sourceHash, payloadSha256, ...edit },
    outcome: { kind: 'mesh-delta', revision, code: null, object: null, provenance, written },
    closure: { by: 'agent', at, reasoning: 'Synthetic retained Parts result.' } };
}

function registerRig(dir: string, n: number, revision: string, at: number, answers: string[] = []) {
  const source = 'registration-source';
  const iso = new Date(at).toISOString();
  const hash = (...path: string[]) => sha256(readFileSync(join(dir, ...path)));
  const write = (name: string, value: unknown) => writeFileSync(join(dir, source, name), JSON.stringify(value));
  write('at-source.json', { finished_at: iso });
  write('run.json', { spec: 'rigc-run/1', package: { name: 'rig-c', version: '3.4.1' }, command: 'build',
    started_at: iso, finished_at: iso,
    inputs: [
      { role: 'rig', path: `../../${revision}/rig.json`, sha256: hash(revision, 'rig.json') },
      { role: 'motion', path: `../../${revision}/motion.json`, sha256: hash(revision, 'motion.json') },
    ],
    outputs: [{ path: 'skeleton.model.json', sha256: hash(source, 'build', 'skeleton.model.json') }] });
  const inputs = {
    '--parts': 'parts', '--build': 'build', '--idle': 'idle', '--config': 'config.json', '--path-adapter': 'adapter.json',
    '--compile-report': 'compile-report.json', '--toolchain-lock': 'package-lock.json', '--run-record': 'run.json',
    '--at-source': 'at-source.json',
  };
  return rigVersionCommand([String(n), dir, ...Object.entries(inputs).flatMap(([flag, rel]) => [flag, `${source}/${rel}`]),
    '--rig', revision, '--at-pointer', '/finished_at', '--by', 'synthetic-agent', ...answers], at);
}

test('next guides the final chained mesh revision until a later rig retains its bytes', () => {
  const dir = realpathSync(tempDir());
  try {
    cpSync(join(import.meta.dir, '../templates/example-chain/checkpoints/3-rig-review'), dir, { recursive: true });
    const bounce = join(dir, 'bounce.txt');
    writeFileSync(bounce, 'Adjust the synthetic mesh.\n');
    expect(reviewCommand(['1', dir, '--review', 'rig-review', '--verdict', 'bounced', '--by', 'user',
      '--verbatim-file', bounce, '--source', 'synthetic bounce', '--item', 'meshes:user'], EXAMPLE_NOW).exit).toBe(0);

    const source = join(dir, 'registration-source');
    cpSync(join(import.meta.dir, 'fixtures/rig-registration'), source, { recursive: true });
    cpSync(join(dir, 'derived/drafts/chain/input'), join(source, 'parts'), { recursive: true });
    writeFileSync(join(source, 'config.json'), JSON.stringify({ key: 'synthetic', requirements: 'requirements.json' }));
    writeFileSync(join(source, 'requirements.json'), JSON.stringify({ spec: 'spine-parts-requirements/1', fps: 4,
      requirements: [], setup_painting: { required: true } }));
    writeFileSync(join(source, 'adapter.json'), '[]');

    const file = join(dir, 'project.json');
    const project = JSON.parse(readFileSync(file, 'utf8'));
    const modelPath = 'derived/review/v1/out/check/build/skeleton.model.json';
    const model = { path: modelPath, sha256: sha256(readFileSync(join(dir, modelPath))) };
    const on = { kind: 'rig', n: 1, config: project.versions[0].provenance.config, model };
    const first = 'derived/mesh-revisions/first';
    const final = 'derived/mesh-revisions/final';
    project.corrections = [meshCorrection(dir, 'outputs/v1/out/rig', first, on, 1), meshCorrection(dir, first, final, on, 2)];
    const seeded = JSON.stringify(project);
    writeFileSync(file, seeded);

    const assertPending = (at: number, answersFeedback: boolean) => {
      const next = nextProject(dir, at);
      expect(next.refusals).toEqual([]);
      expect(next.awaits).toEqual(['versions[n=2]', 'current.rig']);
      expect(next.moves).toEqual([
        expect.objectContaining({ role: 'agent', field: 'versions', awaits: 'versions[n=2]' }),
        expect.objectContaining({ command: `rig-create record rig --adopt ${dir}` }),
      ]);
      expect(next.moves[0]!.command).toStartWith(`rig-create rig-version 2 ${dir} `);
      expect(next.moves[0]!.command).toContain(` --rig ${final} `);
      expect(next.moves[0]!.command?.endsWith(' --answers 1:0')).toBe(answersFeedback);
      expect(next.moves[0]!.act).toContain("pass that build's run.json to --run-record");
    };
    assertPending(EXAMPLE_NOW + 1000, true);
    expect(readFileSync(file, 'utf8')).toBe(seeded);

    writeFileSync(file, JSON.stringify({ ...project, current: {} }));
    const current = nextProject(dir, EXAMPLE_NOW + 1000);
    expect(current.moves.filter(move => move.field === 'current.rig').map(move => move.command)).toEqual([
      `rig-create record rig --adopt ${dir}`,
      `rig-create record rig ${dir} --from outputs/rig.next --config specs/rig/config.json`,
    ]);
    expect(current.moves.some(move => move.command?.includes('--answers') || move.command?.startsWith('rig-create rig-version '))).toBe(false);

    project.versions[0].verdicts = [];
    writeFileSync(file, JSON.stringify(project));
    assertPending(EXAMPLE_NOW + 1000, false);
    writeFileSync(file, seeded);

    expect(() => registerRig(dir, 2, first, EXAMPLE_NOW + 2000, ['--answers', '1:0']))
      .toThrow(expect.objectContaining({ code: 'CORRECTION_MESH_DELTA_REVISION' }));
    expect(readFileSync(file, 'utf8')).toBe(seeded);
    assertPending(EXAMPLE_NOW + 2000, true);

    expect(registerRig(dir, 2, final, EXAMPLE_NOW + 3000, ['--answers', '1:0']).exit).toBe(0);
    const registered = nextProject(dir, EXAMPLE_NOW + 3000);
    expect(registered.refusals).toEqual([]);
    expect(registered.awaits.filter(field => !field.startsWith('current.'))).toEqual(['versions[n=2].verdicts[review=rig-review]']);
    expect(registered.moves.some(move => move.command?.startsWith('rig-create rig-version '))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
