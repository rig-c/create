import { afterEach, expect, test } from 'bun:test';
import { prepareJobRecordSource } from '@rig-c/review/job-host';
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkProject } from '../src/check.ts';
import { interviewCommand } from '../src/interview.ts';
import { requestedRecordResult } from '../src/job-host.ts';
import { currentJobIdentity, readRecordPublished, type RecordPlanContext } from '../src/job-publication.ts';
import { JOB_BINDING_FILE, jobHash, jobPrivateRoot, writePrivateJson } from '../src/job-outbox.ts';
import { nextProject } from '../src/next.ts';
import { OWN_NODE_MODULES } from '../src/parts-sections.ts';
import { planCommand } from '../src/plan-writers.ts';
import { Refusal } from '../src/refusal.ts';
import { signoffCommand } from '../src/signoff.ts';
import { stageIndex } from '../src/stages.ts';
import { stepHash } from '../src/step-hash.ts';
import type { JsonObject } from '../src/templates.ts';
import { HEAD_TURN_SINCE } from '../src/waypoints.ts';
import { arr, obj, retainSignoffs, waypoint } from './fixtures.ts';
import { TEST_NOW } from './clock.ts';

const roots: string[] = [];
const now = Math.max(TEST_NOW, Date.parse(HEAD_TURN_SINCE) + 86_400_000);
const read = (root: string): JsonObject => JSON.parse(readFileSync(join(root, 'project.json'), 'utf8')) as JsonObject;
const bytes = (root: string): Buffer => readFileSync(join(root, 'project.json'));
const save = (root: string, project: JsonObject): void => writeFileSync(join(root, 'project.json'), `${JSON.stringify(project, null, 2)}\n`);
function setup(order = 7, answerAt = HEAD_TURN_SINCE): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'create-depth-signoff-')));
  roots.push(root);
  cpSync(join(import.meta.dir, '../templates/example-chain/checkpoints/3-rig-review'), root, { recursive: true });
  symlinkSync(OWN_NODE_MODULES, join(root, 'node_modules'));
  cpSync(join(OWN_NODE_MODULES, '..', 'bun.lock'), join(root, 'bun.lock'));
  const project = read(root);
  project.stage = 'rigging-interview'; project.versions = [];
  retainSignoffs(project, row => stageIndex(String(row.stage)) < stageIndex('rigging-interview'));
  project.advances = arr(project.advances).filter(row => stageIndex(String(obj(row).stage)) <= stageIndex('rigging-interview'));
  const steps = arr(obj(project.plan).steps).map(obj);
  for (const step of steps.filter(step => ['bones', 'meshes', 'constraints', 'motion'].includes(String(step.id)))) {
    step.status = 'pending'; delete step.status_history;
  }
  const guide = obj(waypoint(project, 'turn').guide);
  guide.at = answerAt; guide.value = { mode: 'depth' };
  guide.verbatim = 'Head turn\nThe head turns with depth, like the head-turn demo.';
  obj(guide.choice).picks = [{ ask: 'view', option_id: 'turn', shown: { label: 'Head turn', effect: 'The head turns with depth, like the head-turn demo.' } }];
  arr(obj(project.plan).steps).push({ ...structuredClone(steps.find(step => step.id === 'bones')!), id: 'turn', order, rests_on: ['turn'], checkpoint: null });
  save(root, project);
  return root;
}
function publication(root: string): RecordPlanContext {
  return readRecordPublished({ root, record: { path: 'project.json', sha256: jobHash(bytes(root)) }, result: { kind: 'plan' }, phase: 'inventory' }, now);
}
function refusesUnchanged(root: string, code: string, action: () => unknown): void {
  const before = bytes(root);
  expect(action).toThrow(expect.objectContaining({ code }));
  expect(bytes(root)).toEqual(before);
}
/** Real Review snapshot and finalized act; the override exists only to test ingest against a bypassed publication. */
async function actFor(root: string, bypass?: RecordPlanContext): Promise<JsonObject> {
  const jobId = 'synthetic-depth-signoff';
  const identity = currentJobIdentity({ root, stateDir: 'synthetic-state', fingerprint: 'synthetic', reviewer: { id: 'synthetic-owner', role: 'owner' } }, root);
  writePrivateJson(join(root, JOB_BINDING_FILE), { schema: 'rig-create/job-binding@1', identity, jobId,
    origin: 'http://127.0.0.1:43123', fetchCapability: 'synthetic-grant' }, true);
  const project = read(root); project.review_job = { jobId, origin: 'http://127.0.0.1:43123' }; save(root, project);
  const record = { path: 'project.json' as const, sha256: jobHash(bytes(root)) };
  const info = statSync(root);
  const retained = await prepareJobRecordSource({ root: { path: root, dev: info.dev, ino: info.ino },
    stateRoot: join(root, '.synthetic-snapshots'), fingerprint: 'synthetic',
    request: { freeze: { kind: 'producer-held', holdId: 'synthetic-hold', record }, result: { kind: 'plan' } },
    readRecordPublished: bypass ? (() => ({ ...bypass,
      plan: { steps: arr(obj(project.plan).steps).map(obj).map(step => ({ id: String(step.id), hash: stepHash(step) })) },
      files: bypass.files.map(file => file.path === 'project.json' ? record : file) })) as unknown as NonNullable<Parameters<typeof prepareJobRecordSource>[0]['readRecordPublished']>
      : ((input: Parameters<typeof readRecordPublished>[0]) => readRecordPublished(input, now)) as typeof readRecordPublished,
  });
  return { schema: 'rig-review/act@4', kind: 'signoff', jobId, actId: 'synthetic-act', askId: 'synthetic-ask', publicationId: 'synthetic-publication',
    at: new Date(now).toISOString(), authority: { actor: 'human', channel: 'review-ui', reviewer: { id: 'synthetic-owner', role: 'owner' } },
    source: retained.source as unknown as JsonObject, value: { stage: 'rigging-interview', decision: 'approved', words: 'Approve the synthetic plan.' } };
}
function ingest(root: string, act: JsonObject): { stdout: string; exit: number } {
  return signoffCommand(['rigging-interview', root, '--from-review', String(act.actId)], now, { fetch: () => ({ bytes: JSON.stringify(act) }) });
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(jobPrivateRoot(root), { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('#562 depth after bones refuses before signoff and next gives the reorder move', () => {
  const root = setup();
  const checked = interviewCommand(['--check', root, '--json'], now);
  expect(checked.exit).toBe(1);
  expect(JSON.parse(checked.stdout).refusals.map((finding: { code: string }) => finding.code)).toEqual(['RIG_DEPTH_PLAN_MISSING']);
  const next = nextProject(root, now);
  expect(next.refusals.map(finding => finding.code)).toEqual(['RIG_DEPTH_PLAN_MISSING']);
  expect(next.moves).toContainEqual(expect.objectContaining({ act: expect.stringContaining('plan revise turn --order <before the first rigging step>') }));
  expect(next.moves.some(move => move.review_act?.kind === 'signoff')).toBe(false);
  refusesUnchanged(root, 'JOB_RECORD_INCOMPLETE', () => requestedRecordResult(root, undefined, true, now));
  try { publication(root); } catch (error) { expect((error as Refusal).message).toContain('RIG_DEPTH_PLAN_MISSING'); }
});

test('#562 missing depth step gives the add move', () => {
  const root = setup(); const project = read(root);
  obj(project.plan).steps = arr(obj(project.plan).steps).filter(step => obj(step).id !== 'turn'); save(root, project);
  expect(nextProject(root, now).moves).toContainEqual(expect.objectContaining({ act: expect.stringContaining('plan add turn --phase rig --rests-on turn --order') }));
});

test('#562 old depth answers retain HEAD_TURN_SINCE WARN and may publish', () => {
  const root = setup(7, new Date(Date.parse(HEAD_TURN_SINCE) - 1).toISOString());
  const report = checkProject(root, undefined, { now });
  expect(report.refusals).toEqual([]);
  expect(report.warnings.map(finding => finding.code)).toContain('RIG_DEPTH_PLAN_MISSING');
  expect(publication(root).subjects).toContainEqual({ kind: 'signoff', stage: 'rigging-interview' });
});

test('#562 reordered depth plan publishes and fully ingests while retaining array-bound identities', async () => {
  const root = setup();
  expect(planCommand(['revise', 'turn', root, '--order', '2.5', '--by', 'drafter'], now - 1000).exit).toBe(0);
  const before = bytes(root);
  const project = read(root);
  const context = publication(root);
  expect(bytes(root)).toEqual(before);
  expect(context.plan.steps.map(step => step.id)).toEqual(arr(obj(project.plan).steps).map(step => String(obj(step).id)));
  expect(context.plan.steps.map(step => step.id)).toEqual(['seethrough', 'assemble', 'turn', 'bones', 'meshes', 'constraints', 'motion']);
  const act = await actFor(root);
  expect(ingest(root, act).exit).toBe(0);
  expect(arr(read(root).signoffs).map(obj).at(-1)).toMatchObject({ stage: 'rigging-interview', by: 'user' });
  expect(checkProject(root, undefined, { now }).refusals.map(finding => finding.code)).toEqual([]);
});

test('#562 ingest refuses a carried depth finding even when publication was bypassed', async () => {
  const root = setup(2.5);
  const context = publication(root);
  const project = read(root); arr(obj(project.plan).steps).map(obj).find(step => step.id === 'turn')!.order = 7; save(root, project);
  const act = await actFor(root, context);
  refusesUnchanged(root, 'RIG_DEPTH_PLAN_MISSING', () => ingest(root, act));
});

