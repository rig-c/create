import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { collectItems } from '../src/check.ts';
import { optionContext, optionFile, sha256, validateChoice, validateContext } from '../src/choices.ts';
import { OWNER_CHAT_SOURCE } from '../src/owner-chat.ts';
import { recordCommand } from '../src/record.ts';
import { sorted } from '../src/step-hash.ts';
import { assertCurrentPartsStructure, checkRiggingContext, currentPartsApproval, latestPartsApproval, readCurrentPartsContext, riggingContext } from '../src/structure.ts';
import { structureSnapshotCommand } from '../src/structure-snapshot.ts';
import type { JsonObject } from '../src/templates.ts';
import { TEST_NOW } from './clock.ts';
import { syntheticLedgerReport } from './fix-ledger-report-fixture.ts';
import { arr, fixture, obj } from './fixtures.ts';

const stage = 'rigging-interview';
const now = TEST_NOW;
const iso = (at: number): string => new Date(at).toISOString();
const recordedAt = iso(now);
const next = 'outputs/parts.next';
const root = 'outputs/parts';
const stale = expect.objectContaining({ code: 'INTERVIEW_OPTIONS_STALE' });

function write(dir: string, path: string, bytes: string) {
  const file = join(dir, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, bytes);
  return { path, sha256: sha256(Buffer.from(bytes)) };
}

function load(dir: string): JsonObject {
  return JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
}

function recordParts(dir: string) {
  const project = load(dir);
  const part = write(dir, `${next}/rig/parts.json`, '{}');
  const config = write(dir, 'specs/rig/current-parts.json', '{"meshes":{"part/~detail":{"density":2}}}');
  const source = write(dir, 'inputs/current-parts-source.png', 'synthetic source');
  const full = write(dir, 'inputs/current-parts-full/layers.json', '{"layers":[]}');
  write(dir, `${next}/run.json`, JSON.stringify({
    spec: 'rig-run/1', package: { name: '@rig-c/parts', version: '2.57.0' }, command: 'assemble',
    started_at: recordedAt, finished_at: recordedAt,
    config: { path: '../../staging/config-copy.json', sha256: config.sha256 },
    inputs: [
      { role: 'source', path: `../../${source.path}`, sha256: source.sha256 },
      { role: 'full', path: `../../${full.path}`, sha256: full.sha256 },
    ],
    outputs: [{ path: 'rig/parts.json', sha256: part.sha256 }],
  }));
  write(dir, `${next}/check/parts-check.json`, JSON.stringify({
    spec: 'rig-parts-parts-check/1', stage: 'parts',
    inputs: [{ path: 'parts.json', status: 'read', sha256: part.sha256 }],
    parts: {}, refusals: [], reported: [], holes: [], exit_code: 0,
  }));
  const ledgerArgs = arr(project.fix_ledger ?? []).length ? ['--ledger-report', syntheticLedgerReport(dir, part.sha256, { T1: 'pass' })] : [];
  const result = recordCommand(['parts', dir, '--from', next, '--config', config.path, ...ledgerArgs], now);
  expect(result.exit).toBe(0);
  return { config, source, project: load(dir) };
}

function ownerApproval(dir: string, project: JsonObject, at = now + 1000) {
  const { target } = readCurrentPartsContext(dir, project, at);
  expect(structureSnapshotCommand([dir]).exit).toBe(0);
  const path = `evidence/structure/current-parts/${target.record_sha256}.json`;
  return { stage: 'parts-review', checkpoint: null, by: 'owner', at: iso(at), verbatim: 'Approve these synthetic parts.',
    source: OWNER_CHAT_SOURCE, said_at: iso(at), relayed_by: 'operator', target,
    structure: { path, sha256: sha256(readFileSync(join(dir, path))) } };
}

test('current parts snapshots bind the exact run config and leave the project record byte-identical', () => {
  const dir = fixture(() => {}, 'project.json');
  const { config, project } = recordParts(dir);
  const parts = obj(obj(project.current).parts);
  const target = { subject: 'current.parts', record_sha256: sha256(Buffer.from(JSON.stringify(sorted(parts)))), files_sha256: parts.files_sha256 };
  const before = readFileSync(join(dir, 'project.json'));
  const out = `evidence/structure/current-parts/${target.record_sha256}.json`;

  expect(() => optionContext(project, stage, now, dir)).toThrow(stale);
  expect(structureSnapshotCommand([dir]).exit).toBe(0);
  const bytes = readFileSync(join(dir, out));
  expect(JSON.parse(bytes.toString('utf8'))).toEqual({
    schema: 'rig-create/structure-decisions@0', target, run: parts.run, config,
    entries: [{ path: '/meshes/part~1~0detail', value: { density: 2 } }],
  });
  expect(structureSnapshotCommand([dir]).stdout).toContain('unchanged');
  expect(readFileSync(join(dir, out))).toEqual(bytes);
  expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
  const unsignedContext = optionContext(project, stage, now, dir);
  expect(unsignedContext).toMatchObject({ kind: 'current-parts', target, run: parts.run, config });
  expect(unsignedContext.signoff_at).toBeUndefined();
});

test('mixed records keep historical numbered reads while fresh parts context waits for current approval', () => {
  const dir = fixture(() => {}, 'example-numbered/example-project.json');
  const numbered = load(dir);
  const drafted = Date.parse(String(latestPartsApproval(numbered)?.at)) + 1000;
  const selected = drafted + 1000;
  const context = optionContext(numbered, stage, drafted, dir);
  expect(context.kind).toBe('parts');
  expect(optionContext({ ...numbered, current: {} }, stage, drafted, dir)).toEqual(context);
  expect(() => optionContext({ ...numbered, current: { parts: null } }, stage, drafted, dir)).toThrow(stale);

  const { project, config } = recordParts(dir);
  const set = { stage, drafted_at: iso(drafted), context };
  expect(() => validateContext(dir, project, set, selected)).not.toThrow();
  expect(latestPartsApproval(project, drafted, context.accepted_parts, String(context.draft_id)))
    .toEqual(latestPartsApproval(numbered, drafted));
  expect(structureSnapshotCommand([dir, '--draft', String(context.draft_id)]).exit).toBe(0);
  const pending: Parameters<typeof riggingContext>[3] = [];
  expect(riggingContext(dir, project, recordedAt, pending)).toBeNull();
  expect(pending).toEqual([]);
  expect(() => optionContext(project, stage, now, dir)).toThrow(stale);
  expect(() => validateContext(dir, project, set, now, true)).toThrow(stale);

  write(dir, config.path, '{"meshes":{}}');
  expect(() => optionContext(project, stage, now, dir)).toThrow(stale);
  expect(() => validateContext(dir, project, set, selected)).not.toThrow();
  expect(riggingContext(dir, project, recordedAt, pending)).toBeNull();
  expect(pending).toContainEqual(expect.objectContaining({ code: 'STRUCTURE_DECISIONS_INVALID', path: 'current.parts' }));
});

test.each(['run.json', 'rig/parts.json'])('current parts refuses changed %s bytes before writing a snapshot', changed => {
  const dir = fixture(() => {}, 'project.json');
  const { project } = recordParts(dir);
  const before = readFileSync(join(dir, 'project.json'));
  write(dir, `${root}/${changed}`, '{} ');
  const out = 'evidence/current-parts.json';
  expect(() => structureSnapshotCommand([dir, '--out', out])).toThrow(expect.objectContaining({ code: 'STRUCTURE_DECISIONS_INVALID' }));
  expect(existsSync(join(dir, out))).toBe(false);
  expect(() => optionContext(project, stage, now, dir)).toThrow(stale);
  expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
});

test('current parts refuses an ambiguous producer config or an output whose input changed', () => {
  const dir = fixture(() => {}, 'project.json');
  const { project, config, source } = recordParts(dir);
  const duplicate = structuredClone(project);
  const parts = obj(obj(duplicate.current).parts);
  const copy = write(dir, 'specs/rig/config-copy.json', readFileSync(join(dir, config.path), 'utf8'));
  parts.built_from = [...arr(parts.built_from), copy];
  expect(() => readCurrentPartsContext(dir, duplicate, now)).toThrow(expect.objectContaining({ code: 'STRUCTURE_DECISIONS_INVALID' }));

  write(dir, source.path, 'changed source');
  expect(() => readCurrentPartsContext(dir, project, now)).toThrow(expect.objectContaining({
    code: 'STRUCTURE_DECISIONS_INVALID', message: expect.stringContaining(source.path),
  }));
});

test('fresh parts choices require the latest live owner relay and its exact retained structure', () => {
  const dir = fixture(() => {}, 'example-numbered/example-project.json');
  const { project, config } = recordParts(dir);
  const numbered = latestPartsApproval(project)!;
  const approval = ownerApproval(dir, project);
  const selected = now + 4000;
  project.signoffs = [...arr(project.signoffs), approval, { ...numbered, at: iso(now + 2000) }];

  expect(currentPartsApproval(project, now)).toBeUndefined();
  expect(latestPartsApproval(project, now + 1000)).toEqual(numbered);
  expect(currentPartsApproval(project, selected)?.target).toEqual(approval.target);
  const context = optionContext(project, stage, selected, dir);
  expect(context).toMatchObject({ kind: 'current-parts', target: approval.target, structure: approval.structure, config });
  expect(() => validateContext(dir, project, { stage, drafted_at: iso(selected), context }, selected, true)).not.toThrow();
  expect(() => assertCurrentPartsStructure(dir, project, approval.structure, selected)).not.toThrow();

  const path = String(obj(approval.structure).path);
  const snapshot = JSON.parse(readFileSync(join(dir, path), 'utf8')) as JsonObject;
  const wrong = write(dir, 'evidence/wrong-current-structure.json', JSON.stringify({ ...snapshot, entries: [] }));
  expect(() => assertCurrentPartsStructure(dir, project, wrong, selected))
    .toThrow(expect.objectContaining({ code: 'STRUCTURE_DECISIONS_INVALID' }));

  const missingRelay = { ...approval, at: iso(now + 3000), relayed_by: '' };
  expect(() => optionContext({ ...project, signoffs: [...arr(project.signoffs), missingRelay] }, stage, selected, dir)).toThrow(stale);
  obj(obj(project.current).parts).at = iso(now + 2000);
  expect(() => optionContext(project, stage, selected, dir)).toThrow(stale);
  const findings: Parameters<typeof checkRiggingContext>[3] = [];
  checkRiggingContext(dir, project, stage, findings);
  expect(findings).toEqual([]);
});

test('answered current parts options use their historical authority and retained structure', () => {
  const dir = fixture(() => {}, 'example-numbered/example-project.json');
  const { project, config } = recordParts(dir);
  const approval = ownerApproval(dir, project);
  const drafted = now + 2000;
  const selected = now + 4000;
  project.signoffs = [...arr(project.signoffs), approval];
  const context = optionContext(project, stage, drafted, dir);
  const item = collectItems(project, { collection: null }).find(item => item.id === 'meshes')!;
  const answer = structuredClone(obj(item.raw));
  answer.at = iso(selected);
  const choice = obj(answer.choice);
  const { set: original } = optionFile(dir, choice.set);
  const set = { ...original, drafted_at: iso(drafted), context };
  choice.set = write(dir, 'evidence/current-parts-answer.json', JSON.stringify(set));

  obj(obj(project.current).parts).at = iso(selected + 2000);
  write(dir, `${root}/rig/parts.json`, '{"replaced":true}');
  write(dir, `${root}/run.json`, '{}');
  write(dir, config.path, '{}');
  expect(() => validateChoice(dir, project, item, answer)).not.toThrow();
  expect(() => validateContext(dir, project, set, selected + 2000, true)).toThrow(stale);

  const reopenedAt = (at: number) => ({ ...project, reopens: [{ stage: 'parts-review', from_stage: stage, by: 'owner',
    at: iso(at), verbatim: 'Review the parts again.', source: OWNER_CHAT_SOURCE, said_at: iso(at), relayed_by: 'operator', steps_before: [] }] });
  expect(() => validateChoice(dir, reopenedAt(selected + 1000), item, answer)).not.toThrow();
  expect(() => validateChoice(dir, reopenedAt(drafted + 1000), item, answer)).toThrow(stale);
  const renewed = { ...approval, at: iso(drafted + 1000) };
  expect(() => validateChoice(dir, { ...project, signoffs: [...arr(project.signoffs), renewed] }, item, answer)).toThrow(stale);

  const tampered = { ...context, run: { path: `${root}/run.json`, sha256: 'f'.repeat(64) } };
  choice.set = write(dir, 'evidence/current-parts-answer.json', JSON.stringify({ ...set, context: tampered }));
  expect(() => validateChoice(dir, project, item, answer)).toThrow(stale);
});
