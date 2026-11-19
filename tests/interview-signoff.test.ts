import { afterEach, expect, test } from 'bun:test';
import { prepareJobRecordSource } from '@rig-c/review/job-host';
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkProject } from '../src/check.ts';
import { interviewCommand } from '../src/interview.ts';
import { currentJobIdentity, readRecordPublished, type RecordPlanContext } from '../src/job-publication.ts';
import { JOB_BINDING_FILE, jobHash, jobPrivateRoot, writePrivateJson } from '../src/job-outbox.ts';
import { nextProject } from '../src/next.ts';
import { pauseCommand } from '../src/pause.ts';
import { reviewActFindings } from '../src/review-act.ts';
import { assertInterviewRecordSignable } from '../src/signable.ts';
import { signoffCommand } from '../src/signoff.ts';
import type { JsonObject } from '../src/templates.ts';
import { TEST_NOW } from './clock.ts';

const roots: string[] = [];
const jobId = 'synthetic-interview-signoff';
const read = (root: string): JsonObject => JSON.parse(readFileSync(join(root, 'project.json'), 'utf8')) as JsonObject;
const save = (root: string, project: JsonObject): void => writeFileSync(join(root, 'project.json'), `${JSON.stringify(project, null, 2)}\n`);
const bytes = (root: string): Buffer => readFileSync(join(root, 'project.json'));
function cleanInterview(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'create-interview-signoff-')));
  roots.push(root);
  cpSync(join(import.meta.dir, '../templates/example-chain/checkpoints/0b-plan-pending'), root, { recursive: true });
  const project = read(root);
  project.stage = 'interview'; project.signoffs = []; project.advances = [];
  save(root, project);
  return root;
}
function publication(root: string): RecordPlanContext {
  return readRecordPublished({ root, record: { path: 'project.json', sha256: jobHash(bytes(root)) },
    result: { kind: 'plan' }, phase: 'inventory' }, TEST_NOW) as RecordPlanContext;
}
function unchanged(root: string, code: string, action: () => unknown): void {
  const before = bytes(root);
  expect(action).toThrow(expect.objectContaining({ code }));
  expect(bytes(root)).toEqual(before);
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(jobPrivateRoot(root), { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('#475 clean interview declares the record signoff without changing bytes or approving plan steps', () => {
  const root = cleanInterview();
  const checked = interviewCommand(['--check', root, '--json'], TEST_NOW);
  expect(checked.exit).toBe(0);
  const before = bytes(root);
  const context = publication(root);
  expect<unknown>(context.subjects).toEqual([{ kind: 'signoff', stage: 'interview' }, { kind: 'reopen', stage: 'interview' }]);
  expect(context.plan.steps.length).toBeGreaterThan(0);
  expect(bytes(root)).toEqual(before);
  const nextReport = nextProject(root, TEST_NOW);
  const move = nextReport.moves.find(move => move.review_act?.stage === 'interview' && move.review_act.kind === 'signoff');
  expect(move?.act).toContain('signoff interview --from-review <actId>');
  expect(move).toMatchObject({ command: null, act: expect.stringContaining('job open --plan') });
});

test.each(['empty', 'absent'])('#475 %s plan refuses by code without writing and next still awaits plan.steps', state => {
  const root = cleanInterview();
  const project = read(root);
  if (state === 'empty') (project.plan as JsonObject).steps = [];
  else delete project.plan;
  save(root, project);
  unchanged(root, 'INTERVIEW_SIGNOFF_PLAN_REQUIRED', () => publication(root));
  const next = nextProject(root, TEST_NOW);
  expect(next.awaits).toContain('plan.steps');
  expect(next.moves.find(move => move.review_act?.stage === 'interview' && move.review_act.kind === 'signoff')).toMatchObject({
    command: null, unanswered_by_record: 'plan.steps', act: expect.stringContaining('plan.steps is empty'),
  });
});

test('#475 full interview check refusal blocks publication byte-identically, including pre-interview history', () => {
  const root = cleanInterview();
  const project = read(root);
  project.versions = [{ n: 1, config_lost: { note: '', source: '' } }];
  save(root, project);
  const checked = JSON.parse(interviewCommand(['--check', root, '--json'], TEST_NOW).stdout);
  expect(checked.refusals.map((f: { code: string }) => f.code)).toContain('PRE_INTERVIEW_CONFIG_LOST_MALFORMED');
  unchanged(root, 'INTERVIEW_SIGNOFF_NOT_CLEAN', () => publication(root));
});

test('#475 paused effective interview keeps its earlier publication subjects and bytes', () => {
  const root = cleanInterview();
  const words = join(root, 'pause.txt'); writeFileSync(words, 'Pause the synthetic interview.');
  expect(signoffCommand(['paused', root, '--by', 'user', '--verbatim-file', words], TEST_NOW).exit).toBe(0);
  expect(pauseCommand([root, '--by', 'user', '--verbatim-file', words], TEST_NOW).exit).toBe(0);
  expect(checkProject(root, undefined, { now: TEST_NOW }).effective_stage).toBe('interview');
  const before = bytes(root);
  expect(publication(root).subjects).toEqual([]);
  expect(bytes(root)).toEqual(before);
});

test('#475 record-only eligibility rejects a different stage and leaves the CLI --by route unchanged', () => {
  const root = cleanInterview();
  const project = read(root); project.stage = 'plan-approved'; save(root, project);
  unchanged(root, 'REVIEW_ACT_TARGET_MISMATCH', () => assertInterviewRecordSignable(project, checkProject(root, project, { now: TEST_NOW })));
  project.stage = 'interview'; (project.plan as JsonObject).steps = []; save(root, project);
  const words = join(root, 'approval.txt'); writeFileSync(words, 'Approve the synthetic interview.');
  expect(signoffCommand(['interview', root, '--by', 'user', '--verbatim-file', words], TEST_NOW).exit).toBe(0);
  expect((read(root).signoffs as JsonObject[]).at(-1)).toMatchObject({ stage: 'interview', by: 'user', checkpoint: null });
  expect(reviewActFindings(read(root))).toEqual([]);
});

/** Build a sealed upstream source, deliberately bypassing Create's publication check for ingest refusal controls. */
async function actFor(root: string, context: RecordPlanContext): Promise<JsonObject> {
  const identity = currentJobIdentity({ root, stateDir: 'synthetic-state', fingerprint: 'synthetic', reviewer: { id: 'synthetic-owner', role: 'owner' } }, root);
  writePrivateJson(join(root, JOB_BINDING_FILE), { schema: 'rig-create/job-binding@1', identity, jobId,
    origin: 'http://127.0.0.1:43123', fetchCapability: 'synthetic-grant' }, true);
  const project = read(root); project.review_job = { jobId, origin: 'http://127.0.0.1:43123' }; save(root, project);
  const record = { path: 'project.json' as const, sha256: jobHash(bytes(root)) };
  const info = statSync(root);
  const retained = await prepareJobRecordSource({ root: { path: root, dev: info.dev, ino: info.ino },
    stateRoot: join(root, '.synthetic-snapshots'), fingerprint: 'synthetic',
    request: { freeze: { kind: 'producer-held', holdId: 'synthetic-hold', record }, result: { kind: 'plan' } },
    readRecordPublished: (() => ({ ...context, files: context.files.map(file => file.path === 'project.json' ? record : file) })) as unknown as NonNullable<Parameters<typeof prepareJobRecordSource>[0]['readRecordPublished']>,
  });
  return { schema: 'rig-review/act@4', kind: 'signoff', jobId, actId: 'synthetic-act', askId: 'synthetic-ask', publicationId: 'synthetic-publication',
    at: new Date(TEST_NOW).toISOString(), authority: { actor: 'human', channel: 'review-ui', reviewer: { id: 'synthetic-owner', role: 'owner' } },
    source: retained.source as unknown as JsonObject, value: { stage: 'interview', decision: 'approved', words: 'Approve the synthetic interview.' } };
}
function ingest(root: string, act: JsonObject, stage = 'interview'): unknown {
  return signoffCommand([stage, root, '--from-review', String(act.actId)], TEST_NOW, { fetch: () => ({ bytes: JSON.stringify(act) }) });
}

test('#475 record interview ingest rejects wrong stage stale source and unclean records without writing', async () => {
  const root = cleanInterview();
  const context = publication(root);
  const act = await actFor(root, context);
  unchanged(root, 'REVIEW_ACT_KIND_MISMATCH', () => ingest(root, act, 'plan-approved'));
  const original = bytes(root); writeFileSync(join(root, 'project.json'), Buffer.concat([original, Buffer.from(' ')]));
  unchanged(root, 'REVIEW_ACT_SOURCE_STALE', () => ingest(root, act));
  writeFileSync(join(root, 'project.json'), original);
  const project = read(root); project.stage = 'plan-approved'; save(root, project);
  const wrongStage = await actFor(root, context);
  unchanged(root, 'REVIEW_ACT_TARGET_MISMATCH', () => ingest(root, wrongStage));
  project.stage = 'interview'; project.versions = [{ n: 1, config_lost: { note: '', source: '' } }]; save(root, project);
  const unclean = await actFor(root, context);
  expect(interviewCommand(['--check', root], TEST_NOW).exit).toBe(1);
  unchanged(root, 'INTERVIEW_SIGNOFF_NOT_CLEAN', () => ingest(root, unclean));
});
