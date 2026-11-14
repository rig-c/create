/**
 * Live sign-off routes over package publications (#324): the publication declares the
 * `signoff` and `checkpoint` subjects the record can sign, Review asks and finalizes the
 * act through its own host, and `signoff … --from-review` records it.
 */
import { afterEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startJobHost, type JobHostOptions, type JobOwnerHost, type JobSubject } from '@rig-c/review/job-host';
import { checkProject } from '../src/check.ts';
import { openCreateJob, publishPending, reconcileCreateJob } from '../src/job-host.ts';
import { draftPublicationResult, jobRuntimeExecArgv } from '../src/job-writer.ts';
import { enqueuePublication, jobHostStateRoot, readAcknowledgedPublication, readWriterBinding, type PublicationSubject } from '../src/job-outbox.ts';
import { packageSignSubjects } from '../src/signable.ts';
import type { JsonObject } from '../src/templates.ts';

const roots: string[] = [];
const hosts: JobOwnerHost[] = [];
afterEach(() => {
  for (const host of hosts.splice(0)) host.stop();
  for (const root of roots.splice(0)) {
    rmSync(jobHostStateRoot(root), { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
const WORDS = '  Synthetic approval, 좋아.\r\n';
const read = (root: string): JsonObject => JSON.parse(readFileSync(join(root, 'project.json'), 'utf8'));
const write = (root: string, project: JsonObject): void => writeFileSync(join(root, 'project.json'), `${JSON.stringify(project, null, 2)}\n`);
const steps = (project: JsonObject): JsonObject[] => (project.plan as JsonObject).steps as JsonObject[];

function copy(checkpoint: string, edit?: (project: JsonObject) => void): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'create-sign-subjects-')));
  roots.push(root);
  cpSync(join(import.meta.dir, '../templates/example-chain/checkpoints', checkpoint), root, { recursive: true });
  if (edit) { const project = read(root); edit(project); write(root, project); }
  return root;
}

async function cli(root: string, args: string[]): Promise<{ stdout: string; stderr: string; exit: number }> {
  const child = Bun.spawn([process.execPath, ...jobRuntimeExecArgv(), join(import.meta.dir, '../src/cli.ts'), ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, exit };
}

async function open(root: string, startHost?: (options: JobHostOptions) => Promise<JobOwnerHost>): Promise<JobOwnerHost> {
  const host = await openCreateJob(root, { id: 'synthetic-owner', role: 'owner' }, Date.now(), startHost);
  hosts.push(host);
  return host;
}

/** Review's agent verb; returns its JSON reply unchanged. */
async function agent(host: JobOwnerHost, verb: string, fields: object): Promise<{ ok: boolean; error?: { code: string }; value: JsonObject }> {
  const response = await host.ports.handleJobApi(new Request(`${host.origin}/jobs/${host.session.jobId}/api`, { method: 'POST',
    headers: { authorization: `Bearer ${host.session.hostCredentials().agent}`, 'content-type': 'application/json' },
    body: JSON.stringify({ schema: 'rig-review/job-api@2', verb, jobId: host.session.jobId, requestId: randomUUID(),
      expectedGeneration: host.session.status().generation, idempotencyKey: randomUUID(), ...fields }) }));
  return await response.json() as { ok: boolean; error?: { code: string }; value: JsonObject };
}
const ask = (host: JobOwnerHost, subject: JobSubject) => agent(host, 'ask', { publicationId: host.session.status().publication!.publicationId, subject });

/** The person's page: one displayed acknowledgment, then each act through Review's UI port. */
async function page(host: JobOwnerHost) {
  const publication = host.session.status().publication!;
  const ui = (route: string, body: object) => new Request(`${host.origin}/jobs/${host.session.jobId}/ui/${route}`, { method: 'POST',
    headers: { origin: host.origin, 'X-Review-Capability': host.session.hostCredentials().ui, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const pageId = randomUUID();
  const displayed = await host.ports.ackDisplayed(host.session.jobId, ui('displayed', { publicationId: publication.publicationId, pageId, sourceHash: publication.source.sourceHash }));
  if (!displayed.ok) throw Error(displayed.error.code);
  return { pageId, act: async (askId: string, kind: string, value: object, extra: object = {}) => {
    const result = await host.ports.commitUIAct(host.session.jobId, ui('acts', { publicationId: publication.publicationId, askId, pageId,
      displayedNonce: displayed.value.displayedNonce, expectedGeneration: host.session.status().generation, submissionId: randomUUID(), kind, value, ...extra }));
    if (!result.ok) throw Error(result.error.code);
    return result.value;
  } };
}

function declared(root: string, host: JobOwnerHost): readonly PublicationSubject[] | undefined {
  return readAcknowledgedPublication(root, host.session.jobId, host.session.status().publication!.publicationId)?.subjects;
}
const codes = (root: string): string[] => checkProject(root, undefined, { now: Date.now() }).refusals.map(finding => finding.code);

/** The parts stage with the enabled `assemble` checkpoint at its checkpoint and unsigned, and no draft yet. */
function partsAtCheckpoint(): string {
  return copy('1-parts-verdict', project => {
    project.drafts = [];
    project.signoffs = (project.signoffs as JsonObject[]).filter(signoff => signoff.checkpoint !== 'assemble');
    const assemble = steps(project).find(step => step.id === 'assemble')!;
    assemble.status = 'at-checkpoint';
    (assemble.status_history as JsonObject[]).pop();
  });
}
const draftArgs = ['draft-rig', 'chain', '--config', 'derived/drafts/chain/config.json', '--from', 'derived/drafts/chain/out', '--parts', 'derived/drafts/chain/input', '--json'];

test('a rig version published in rig-review carries its stage sign-off, and the act signs the displayed version', async () => {
  const root = copy('3-rig-review');
  const host = await open(root);
  enqueuePublication(root, readWriterBinding(root)!, { path: 'review-live-v1.json', selector: { kind: 'rig', version: 1 } });
  expect(await reconcileCreateJob(root)).toBe(1);
  expect(declared(root, host)).toEqual([{ kind: 'review-verdict', stage: 'rig-review' }, { kind: 'signoff', stage: 'rig-review' }]);
  // Review binds an ask only to a declared subject: a stage the record cannot sign here is refused by name.
  expect((await ask(host, { kind: 'signoff', stage: 'direction-review' })).error?.code).toBe('JOB_ASK_INVALID');
  const verdictAsk = await ask(host, { kind: 'review-verdict', stage: 'rig-review' });
  const signoffAsk = await ask(host, { kind: 'signoff', stage: 'rig-review' });
  expect([verdictAsk.ok, signoffAsk.ok]).toEqual([true, true]);
  const { pageId, act } = await page(host);
  const publication = host.session.status().publication!;
  const png = readFileSync(join(root, 'evidence/setup.png'));
  const verdict = await act(String(verdictAsk.value.askId), 'review-verdict', { stage: 'rig-review', verdict: 'approved', words: WORDS }, {
    capture: { png: `data:image/png;base64,${png.toString('base64')}`, width: png.readUInt32BE(16), height: png.readUInt32BE(20),
      camera: 'fixed', framing: 'default', view: 'whole-rig', frame: 'setup', playing: false,
      binding: { publicationId: publication.publicationId, instanceKey: publication.instanceKey, sourceHash: publication.source.sourceHash,
        pageId, askId: verdictAsk.value.askId, drawGeneration: 1, playerGeneration: 0 } } });
  const signed = await act(String(signoffAsk.value.askId), 'signoff', { stage: 'rig-review', decision: 'approved', words: WORDS });
  expect(signed).toMatchObject({ schema: 'rig-review/act@6', kind: 'signoff', source: { selector: { kind: 'rig', version: 1 } }, value: { stage: 'rig-review', decision: 'approved', comments: [{ text: WORDS }] } });
  const reviewed = await cli(root, ['review', '1', root, '--from-review', verdict.actId, '--json']);
  expect({ exit: reviewed.exit, stderr: reviewed.stderr }).toEqual({ exit: 0, stderr: '' });
  const result = await cli(root, ['signoff', 'rig-review', root, '--from-review', signed.actId, '--json']);
  expect({ exit: result.exit, stderr: result.stderr }).toEqual({ exit: 0, stderr: '' });
  const signature = (read(root).signoffs as JsonObject[]).at(-1)!;
  expect(signature).toMatchObject({ stage: 'rig-review', checkpoint: null, by: 'user', verbatim: `[general]\n${WORDS}`, at: signed.at,
    source: `review act ${host.session.jobId}/${signed.actId}`, target: { version: 1 } });
  // The signature authorizes the next stage; the separate advance writer records the move.
  expect(codes(root)).toEqual(['STAGE_LAGGING']);
});

test('a draft published at an enabled parts checkpoint carries it, and the passed act is the checkpoint sign-off', async () => {
  const root = partsAtCheckpoint();
  const host = await open(root);
  const drafted = await cli(root, draftArgs);
  expect({ exit: drafted.exit, stderr: drafted.stderr }).toEqual({ exit: 0, stderr: '' });
  // seethrough's checkpoint is off and parts is a bar stage, so neither is declared.
  expect(declared(root, host)).toEqual([{ kind: 'parts-verdict', draftId: 'chain' }, { kind: 'checkpoint', checkpointId: 'assemble' }]);
  expect((await ask(host, { kind: 'checkpoint', checkpointId: 'seethrough' })).error?.code).toBe('JOB_ASK_INVALID');
  const asked = await ask(host, { kind: 'checkpoint', checkpointId: 'assemble' });
  expect(asked.ok).toBe(true);
  const passed = await (await page(host)).act(String(asked.value.askId), 'checkpoint', { checkpointId: 'assemble', outcome: 'pass', words: WORDS });
  expect(passed).toMatchObject({ schema: 'rig-review/act@6', kind: 'checkpoint', value: { checkpointId: 'assemble', planStepId: 'assemble', outcome: 'pass',
    comments: [{ text: WORDS, anchor: { checkpointId: 'assemble', planStepId: 'assemble' } }] } });
  const before = codes(root);
  const result = await cli(root, ['signoff', 'parts', root, '--checkpoint', 'assemble', '--from-review', passed.actId, '--json']);
  expect({ exit: result.exit, stderr: result.stderr }).toEqual({ exit: 0, stderr: '' });
  expect((read(root).signoffs as JsonObject[]).at(-1)).toMatchObject({ stage: 'parts', checkpoint: 'assemble', by: 'user', verbatim: `[["checkpoint","assemble"]]\n${WORDS}`,
    at: passed.at, source: `review act ${host.session.jobId}/${passed.actId}` });
  expect(before).toEqual([]);
  expect(codes(root)).toEqual([]);
  // Any later write ends the publication's asks: Review requires the published record bytes.
  expect((await ask(host, { kind: 'checkpoint', checkpointId: 'assemble' })).error?.code).toBe('JOB_RECORD_MOVED');
});

test('an act for a subject create did not declare refuses by name and leaves the record byte-identical', async () => {
  const root = partsAtCheckpoint();
  const drafted = await cli(root, draftArgs);
  expect({ exit: drafted.exit, stderr: drafted.stderr }).toEqual({ exit: 0, stderr: '' });
  // A host that declares more than create's records allow: Review asks and finalizes the extra subject.
  const wider = (options: JobHostOptions) => startJobHost({ ...options, readPublished: async input => {
    const context = await options.readPublished!(input);
    return { ...context, subjects: [...context.subjects, { kind: 'signoff', stage: 'interview' }] };
  } });
  const host = await open(root, wider);
  enqueuePublication(root, readWriterBinding(root)!, draftPublicationResult('chain'));
  expect(await reconcileCreateJob(root, entry => publishPending(entry, undefined, undefined, wider))).toBe(1);
  expect(declared(root, host)).toEqual([{ kind: 'parts-verdict', draftId: 'chain' }, { kind: 'checkpoint', checkpointId: 'assemble' }]);
  const asked = await ask(host, { kind: 'signoff', stage: 'interview' });
  expect(asked.error).toBeUndefined();
  const planted = await (await page(host)).act(String(asked.value.askId), 'signoff', { stage: 'interview', decision: 'approved', words: WORDS });
  // Only these two consumers run at the finalized act's instant; Review's producer is unchanged.
  const signoff = async () => {
    const requested = { jobId: readWriterBinding(root)!.jobId, actId: planted.actId };
    const commandClock = planted.at;
    const diagnostic = JSON.stringify({
      planted: { jobId: planted.jobId, actId: planted.actId, at: planted.at }, requested, commandClock,
      comparisons: {
        'act.jobId !== transport.jobId': planted.jobId !== requested.jobId,
        'act.actId !== transport.actId': planted.actId !== requested.actId,
        'Date.parse(act.at) > now': Date.parse(planted.at) > Date.parse(commandClock),
      },
    });
    const child = Bun.spawn([process.execPath, ...jobRuntimeExecArgv(), join(import.meta.dir, 'cli-at.ts'), commandClock,
      'signoff', 'interview', root, '--from-review', requested.actId], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, exit, diagnostic };
  };
  const bytes = readFileSync(join(root, 'project.json'));
  const result = await signoff();
  expect(result.exit, result.diagnostic).toBe(1);
  expect(result.stderr, result.diagnostic).toStartWith('rig-create: REVIEW_ACT_SUBJECT_UNDECLARED: project.json.review_acts:');
  expect(readFileSync(join(root, 'project.json'))).toEqual(bytes);
  // Control: without the acknowledged receipt (a clone) the same act is recorded, so the receipt is what refused it.
  rmSync(join(root, '.rig-create-review/acknowledged-publications'), { recursive: true });
  const unverified = await signoff();
  expect({ exit: unverified.exit, stderr: unverified.stderr }, unverified.diagnostic).toEqual({ exit: 0, stderr: '' });
});

test('a target stage needs its own version kind and a plan-bound stage needs plan steps', () => {
  const project = read(copy('3-rig-review'));
  expect(packageSignSubjects(project, 'rig-review', { kind: 'rig', version: 1 }, 6)).toEqual([{ kind: 'signoff', stage: 'rig-review' }]);
  expect(packageSignSubjects(project, 'rig-review', { kind: 'post', version: 2, rigVersion: 1 }, 6)).toEqual([]);
  expect(packageSignSubjects(project, 'rig-review', { kind: 'draft', id: 'chain' }, 6)).toEqual([]);
  // rigging-interview is already signed in this record, so it is not signable again.
  expect(packageSignSubjects(project, 'rigging-interview', { kind: 'rig', version: 1 }, 6)).toEqual([]);
  project.signoffs = (project.signoffs as JsonObject[]).filter(signoff => signoff.stage !== 'rigging-interview');
  expect(packageSignSubjects(project, 'rigging-interview', { kind: 'draft', id: 'chain' }, 6)).toEqual([{ kind: 'signoff', stage: 'rigging-interview' }]);
  expect(packageSignSubjects(project, 'rigging-interview', { kind: 'draft', id: 'chain' }, 0)).toEqual([]);
});
