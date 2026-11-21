import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  JOB_ACT_SCHEMA,
  JOB_API_SCHEMA,
  JOB_API_V3_SCHEMA,
  JOB_COMMENT_CONTEXT_ACT_SCHEMA,
  JOB_MESH_EDITS_ACT_SCHEMA,
  JOB_PREVIOUS_DRAFT_SCHEMA,
  JOB_RECORD_ACT_SCHEMA,
  JOB_RECORD_READER_ID,
  parseContextCommentsAct,
  parseMeshEditsAct,
  parseRecordAct,
  prepareJobRecordAct,
  prepareJobRecordSource,
  type JobOwnerHost,
} from '@rig-c/review/job-host';
import reviewPackage from '@rig-c/review/package.json';
import { closeCreateJob, openCreateJob } from '../src/job-host.ts';
import { jobHostStateRoot, jobPrivateRoot, readWriterBinding } from '../src/job-outbox.ts';
import { currentJobIdentity, JOB_BINDING_ID, JOB_ENUMERATOR_ID, JOB_READER_ID } from '../src/job-publication.ts';
import { Refusal } from '../src/refusal.ts';
import { decodeReviewAct, decodeReviewResponse } from '../src/review-act.ts';

function expectRefusalCode(fn: () => unknown, code: string): void {
  try {
    fn();
    throw new Error(`Expected refusal ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(Refusal);
    expect((error as Refusal).code).toBe(code);
  }
}

const dirs: string[] = [];
const hosts: JobOwnerHost[] = [];

afterEach(() => {
  for (const host of hosts.splice(0)) host.stop();
  for (const root of dirs.splice(0)) {
    rmSync(jobPrivateRoot(root), { recursive: true, force: true });
    rmSync(jobHostStateRoot(root), { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

function makeProject(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'rig-create-review-280-')));
  dirs.push(root);
  writeFileSync(
    join(root, 'project.json'),
    `${JSON.stringify({
      schema: 'rig-create/project@0',
      stage: 'interview',
      stage_values: [],
      interview: {},
      plan: { steps: [] },
      versions: [],
    }, null, 2)}\n`,
  );
  return root;
}

test('installed Review 4.10.0 exports the act and previous-draft contracts and retains package-only job schemas', () => {
  expect(reviewPackage.version).toBe('4.10.0');
  expect(reviewPackage.dependencies['@rig-c/play']).toBe('1.24.0');
  expect(JOB_API_SCHEMA).toBe('rig-review/job-api@2');
  expect(JOB_ACT_SCHEMA).toBe('rig-review/act@2');
  expect(JOB_API_V3_SCHEMA).toBe('rig-review/job-api@3');
  expect(JOB_RECORD_ACT_SCHEMA).toBe('rig-review/act@4');
  expect(JOB_RECORD_READER_ID).toBe(JOB_READER_ID);
  expect(JOB_COMMENT_CONTEXT_ACT_SCHEMA).toBe('rig-review/act@7');
  expect(JOB_MESH_EDITS_ACT_SCHEMA).toBe('rig-review/act@8');
  expect(JOB_PREVIOUS_DRAFT_SCHEMA).toBe('rig-review-previous-draft/1');
  expect(typeof parseContextCommentsAct).toBe('function');
  expect(typeof parseMeshEditsAct).toBe('function');
  expect(typeof parseRecordAct).toBe('function');
  expect(typeof prepareJobRecordAct).toBe('function');
  expect(typeof prepareJobRecordSource).toBe('function');

  const root = makeProject();
  const identity = currentJobIdentity({
    root,
    stateDir: join(root, 'state'),
    fingerprint: 'rig-create/live-review/1',
    reviewer: { id: 'synthetic-owner', role: 'owner' },
  }, root);
  expect(identity.readerId).toBe('rig-create/publication-reader/2');
  expect(identity.bindingId).toBe(JOB_BINDING_ID);
  expect(identity.partsEnumeratorId).toBe(JOB_ENUMERATOR_ID);
  expect(identity.publicationMode).toBeUndefined();
  expect(identity.apiSchema).toBe('rig-review/job-api@2');
  expect(identity.actSchema).toBe('rig-review/act@2');
});

test('openCreateJob enables record publication while retaining the package attachment schemas', async () => {
  const root = makeProject();
  const host = await openCreateJob(root, { id: 'synthetic-owner', role: 'owner' }, Date.now());
  hosts.push(host);

  expect(host.session.publicationMode).toBe('record-and-package');
  expect(host.session.apiSchema).toBe(JOB_API_V3_SCHEMA);

  const binding = readWriterBinding(root);
  expect(binding).not.toBeNull();
  expect(binding?.identity).toMatchObject({
    publicationMode: 'record-and-package',
    apiSchema: JOB_API_SCHEMA,
    actSchema: JOB_ACT_SCHEMA,
  });
  const hostDescriptor = JSON.parse(
    readFileSync(join(binding!.identity.stateDir, 'job-ui', `${host.session.jobId}.json`), 'utf8'),
  ) as Record<string, unknown>;
  expect(hostDescriptor.apiSchema).toBe('rig-review/job-api@2');
  expect(hostDescriptor.actSchema).toBe('rig-review/act@2');
  expect(hostDescriptor.publicationMode).toBe('record-and-package');
  expect(hostDescriptor.recordReaderId).toBe(JOB_READER_ID);

  await closeCreateJob(root);
});

test('record-act reader validates admitted act@4 kinds and preserves unsupported kinds and API@3 envelopes', () => {
  const sha = 'a'.repeat(64);
  const recordActV4 = {
    schema: 'rig-review/act@4',
    actId: 'act-record-1',
    jobId: 'job-record-1',
    askId: 'ask-record-1',
    publicationId: 'pub-record-1',
    kind: 'interview-picks',
    authority: {
      actor: 'human',
      channel: 'review-ui',
      reviewer: { id: 'synthetic-owner', role: 'owner' },
    },
    at: '2026-11-09T00:00:00.000Z',
    source: {
      sourceHash: sha,
      projectHash: sha,
      record: { path: 'project.json', sha256: sha },
      inputs: [{ path: 'inputs/painting.png', sha256: sha }],
      files: [{ path: 'project.json', sha256: sha }],
      subject: 'option-set',
      selection: { questionId: 'q1', setId: 'set1' },
      optionSet: { id: 'set1', sha256: sha },
      optionSetFile: { path: 'evidence/options/set1.json', sha256: sha },
      plan: null,
      subjects: [{ kind: 'interview-picks', questionId: 'q1', setId: 'set1' }],
    },
    value: {
      questionId: 'q1',
      note: 'Synthetic record note.',
      selections: [{ itemId: 'ask-1', optionId: 'opt-1', otherText: null }],
    },
  };

  expectRefusalCode(
    () =>
      decodeReviewResponse(
        JSON.stringify({
          schema: 'rig-review/job-api@3',
          verb: 'fetch-act',
          jobId: 'job-record-1',
          requestId: 'req-1',
          generation: 1,
          ok: true,
          value: recordActV4,
        }),
        'job-record-1',
        'act-record-1',
        'req-1',
        'interview-picks',
      ),
    'REVIEW_API_SCHEMA_UNSUPPORTED',
  );

  for (const kind of ['interview-picks', 'checkpoint', 'signoff', 'parts-verdict', 'review-verdict'] as const) {
    const code = ['interview-picks', 'checkpoint', 'signoff'].includes(kind) ? 'REVIEW_ACT_INVALID' : 'REVIEW_ACT_SCHEMA_UNSUPPORTED';
    expectRefusalCode(() => decodeReviewAct(JSON.stringify({ ...recordActV4, kind }), kind), code);
  }

  expectRefusalCode(
    () =>
      decodeReviewResponse(
        JSON.stringify({
          schema: 'rig-review/job-api@2',
          verb: 'fetch-act',
          jobId: 'job-record-1',
          requestId: 'req-1',
          generation: 1,
          ok: true,
          value: recordActV4,
        }),
        'job-record-1',
        'act-record-1',
        'req-1',
        'interview-picks',
      ),
    'REVIEW_ACT_INVALID',
  );

  expectRefusalCode(
    () =>
      decodeReviewAct(
        JSON.stringify({
          ...recordActV4,
          kind: 'reopen',
          value: { stage: 'rigging-interview', words: 'Reopen request.' },
        }),
        'signoff',
      ),
    'REVIEW_ACT_KIND_MISMATCH',
  );

  expectRefusalCode(
    () =>
      decodeReviewAct(
        JSON.stringify({
          schema: 'rig-review/act@2',
          actId: 'act-reopen-1',
          jobId: 'job-record-1',
          askId: 'ask-record-1',
          publicationId: 'pub-record-1',
          kind: 'reopen',
          authority: recordActV4.authority,
          at: recordActV4.at,
          source: {
            sourceHash: sha,
            projectHash: sha,
            package: { id: 'create-v1', revision: 'v1' },
            parts: {
              enumeratorVersion: '2.36.0',
              manifest: { path: 'derived/review/v1/out/parts.json', sha256: sha },
              images: [],
            },
            plan: { steps: [{ id: 'step-1', hash: sha }] },
          },
          value: { stage: 'rigging-interview', words: 'Reopen request.' },
        }),
        'signoff',
      ),
    'REVIEW_ACT_KIND_MISMATCH',
  );
});

// Frozen finalized acts captured from the authenticated synthetic owner HTTP path
// in record-job-path.test.ts. Keep their producer source hashes unchanged.
test('well-formed record picks and signoff decode directly and through legacy API@2 envelopes', () => {
  for (const [name, kind] of [['picks', 'interview-picks'], ['signoff', 'signoff']] as const) {
    const original = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/record-acts', `${name}.json`), 'utf8'));
    const bytes = JSON.stringify(original);
    expect(decodeReviewAct(bytes, kind)).toEqual(original);
    const decoded = decodeReviewResponse(JSON.stringify({ schema: 'rig-review/job-api@2', verb: 'fetch-act',
      jobId: original.jobId, requestId: 'synthetic-fetch', generation: 1, ok: true, value: original }),
    original.jobId, original.actId, 'synthetic-fetch', kind);
    expect(decoded.act).toEqual(original);
    expect(decoded.bytes).toBe(bytes);
  }
});


test('#493 a historical producer reopen act@4 retains its reader compatibility', () => {
  const bytes = readFileSync(join(import.meta.dir, 'fixtures/record-acts/reopen.json'), 'utf8').trimEnd();
  const act = JSON.parse(bytes);
  expect(decodeReviewAct(bytes, 'reopen')).toEqual(act);
  const decoded = decodeReviewResponse(JSON.stringify({ schema: 'rig-review/job-api@2', verb: 'fetch-act',
    jobId: act.jobId, requestId: 'synthetic-reopen-fetch', ok: true, value: act }),
  act.jobId, act.actId, 'synthetic-reopen-fetch', 'reopen');
  expect(decoded.act).toEqual(act);
  expect(decoded.bytes).toBe(bytes);
  expectRefusalCode(() => decodeReviewAct(bytes), 'REVIEW_ACT_KIND_MISMATCH');
  expectRefusalCode(() => decodeReviewAct(bytes, 'signoff'), 'REVIEW_ACT_KIND_MISMATCH');
});
