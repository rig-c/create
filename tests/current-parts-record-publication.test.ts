import { expect, test } from 'bun:test';
import { cpSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { interviewAnswerCommand, interviewOptionsCommand } from '../src/choice-writers.ts';
import { optionContext, sha256 } from '../src/choices.ts';
import { readRecordPublished, type RecordPublicationRequest } from '../src/job-publication.ts';
import { PARTS_CHECK_SPEC } from '../src/parts-check.ts';
import { PINNED_PACKAGES } from '../src/pins.ts';
import { planCommand } from '../src/plan-writers.ts';
import { recordCommand } from '../src/record.ts';
import { signoffCommand } from '../src/signoff.ts';
import { currentPartsApproval, currentPartsTarget, latestPartsApproval } from '../src/structure.ts';
import { structureSnapshotCommand } from '../src/structure-snapshot.ts';
import { TEMPLATES_DIR, type JsonObject } from '../src/templates.ts';
import { TEST_NOW } from './clock.ts';
import { arr, obj } from './fixtures.ts';
import { tempDir } from './helpers.ts';

const chain = join(TEMPLATES_DIR, 'example-chain');
const stage = 'rigging-interview';
const staged = 'outputs/parts.next';
const manifest = 'rig/parts.json';
const owner = 'synthetic-owner';
const iso = (at: number): string => new Date(at).toISOString();
const json = (file: string): JsonObject => JSON.parse(readFileSync(file, 'utf8')) as JsonObject;
const load = (dir: string): JsonObject => json(join(dir, 'project.json'));

function write(dir: string, path: string, bytes: string) {
  const file = join(dir, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, bytes);
  return { path, sha256: sha256(Buffer.from(bytes)) };
}

function buildAndApprove(dir: string, revision: number, at: number) {
  const config = write(dir, `specs/rig/synthetic-parts-${revision}.json`, JSON.stringify({ meshes: { panel: { density: revision } } }));
  const source = write(dir, 'inputs/producer-source.png', 'synthetic producer source');
  const layers = write(dir, 'inputs/producer-layers/layers.json', '{"layers":[]}');
  const part = write(dir, `${staged}/${manifest}`, JSON.stringify({ revision, parts: [] }));
  write(dir, `${staged}/run.json`, JSON.stringify({
    spec: 'rig-run/1', package: { name: '@rig-c/parts', version: PINNED_PACKAGES['@rig-c/parts'] }, command: 'assemble',
    started_at: iso(at), finished_at: iso(at), config,
    inputs: [{ role: 'source', ...source }, { role: 'full', ...layers }],
    outputs: [{ path: manifest, sha256: part.sha256 }],
  }));
  write(dir, `${staged}/check/parts-check.json`, JSON.stringify({
    spec: PARTS_CHECK_SPEC, stage: 'parts', inputs: [{ path: 'parts.json', status: 'read', sha256: part.sha256 }],
    parts: {}, refusals: [], reported: [], holes: [], exit_code: 0,
  }));
  expect(recordCommand(['parts', dir, '--from', staged, '--config', config.path], at).exit).toBe(0);
  expect(structureSnapshotCommand([dir]).exit).toBe(0);
  const words = write(dir, 'approval.txt', `Approve synthetic parts revision ${revision}.\n`);
  expect(signoffCommand(['parts-review', dir, '--by', owner, '--owner-chat', join(dir, words.path), '--said-at', iso(at + 1000),
    '--relayed-by', 'synthetic-operator'], at + 1000).exit).toBe(0);
  const project = load(dir);
  const target = currentPartsTarget(obj(obj(project.current).parts));
  const path = `evidence/structure/current-parts/${target.record_sha256}.json`;
  const structure = { path, sha256: sha256(readFileSync(join(dir, path))) };
  expect(currentPartsApproval(project, at + 1000)?.structure).toEqual(structure);
  return { config, structure, manifest: { ...part, path: `outputs/parts/${manifest}` } };
}

function register(dir: string, question: string, at: number, suffix = '') {
  const original = json(join(chain, 'evidence/interview', `${question}.json`));
  const id = `current-${question}${suffix}`;
  const context = optionContext(load(dir), stage, at, dir);
  const set = { ...original, id, drafted_at: iso(at), context };
  const binding = write(dir, `evidence/interview/${id}.json`, JSON.stringify(set));
  expect(JSON.parse(interviewOptionsCommand([question, dir, '--file', binding.path], at))).toEqual(binding);
  const picks = arr(original.asks).map(obj).flatMap(ask => {
    const option = arr(ask.options).map(obj).find(option => option.recommended === true)!;
    return ['--pick', `${String(ask.id)}=${String(option.id)}`];
  });
  return { id, binding, context, picks };
}

function answeredPlan() {
  const dir = realpathSync(tempDir());
  cpSync(join(chain, 'checkpoints/2-rigging-answers'), dir, { recursive: true });
  const numbered = latestPartsApproval(load(dir))!;
  const first = buildAndApprove(dir, 1, TEST_NOW);
  let next = TEST_NOW + 2000;
  let meshes: ReturnType<typeof register> | undefined;
  for (const question of ['bones', 'meshes', 'constraints', 'turn', 'motion']) {
    const set = register(dir, question, next);
    interviewAnswerCommand([question, dir, '--by', owner, '--set', set.binding.path, '--sha256', set.binding.sha256, ...set.picks], next + 1000);
    if (question !== 'turn') {
      expect(planCommand(['revise', question, dir, '--by', 'agent', '--reason', 'Reviewed the synthetic answer.'], next + 2000).exit).toBe(0);
    }
    if (question === 'meshes') meshes = set;
    next += 3000;
  }
  return { dir, next, numbered, first, meshes: meshes! };
}

function request(root: string, result: RecordPublicationRequest['result']): RecordPublicationRequest {
  return { root, record: { path: 'project.json', sha256: sha256(readFileSync(join(root, 'project.json'))) }, result, phase: 'inventory' };
}

test('a plan seals the answered current-parts set and structure after the producer output is replaced', () => {
  const { dir, next, first, meshes } = answeredPlan();
  const second = buildAndApprove(dir, 2, next);
  rmSync(join(dir, first.config.path));

  const input = request(dir, { kind: 'plan' });
  const published = readRecordPublished(input, next + 2000);
  expect(published.files).toContainEqual(meshes.binding);
  expect(meshes.context.structure).toEqual(first.structure);
  expect(published.files).toContainEqual(first.structure);
  expect(published.files).toContainEqual(second.manifest);
  expect(published.files).not.toContainEqual(first.manifest);
  expect(published.files.some(file => file.path === first.config.path)).toBe(false);

  const retained = realpathSync(tempDir());
  for (const { path } of published.files) {
    mkdirSync(dirname(join(retained, path)), { recursive: true });
    cpSync(join(dir, path), join(retained, path));
  }
  expect(readRecordPublished({ ...input, root: retained, phase: 'retained', parts: published.parts }, next + 2000)).toEqual(published);
});

test('a current-parts plan skips the numbered approval evidence and structure', () => {
  const { dir, next, numbered } = answeredPlan();
  const { files } = readRecordPublished(request(dir, { kind: 'plan' }), next);
  expect(files.some(file => file.path === obj(numbered.evidence).path)).toBe(false);
  expect(files.some(file => file.path === obj(numbered.structure).path)).toBe(false);
});

test('a fresh current-parts option-set publication seals the full shown evidence', () => {
  const { dir, next, first } = answeredPlan();
  const set = register(dir, 'meshes', next, '-fresh');
  const input = request(dir, { kind: 'option-set', questionId: 'meshes', setId: set.id });
  const { files } = readRecordPublished(input, next);
  expect(files).toEqual(expect.arrayContaining([set.binding, first.manifest, set.context.structure, set.context.run, set.context.config,
    ...arr(obj(set.context.parts).files)]));

  write(dir, first.manifest.path, '{"changed":true}');
  expect(() => readRecordPublished(input, next)).toThrow(expect.objectContaining({ code: 'JOB_RECORD_INCOMPLETE',
    message: expect.stringContaining(first.manifest.path) }));
});
