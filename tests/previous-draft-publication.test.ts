import { afterEach, expect, test } from 'bun:test';
import { encodePng } from '@rig-c/core/plate';
import { JOB_API_SCHEMA, JOB_PREVIOUS_DRAFT_SCHEMA, startJobHost } from '@rig-c/review/job-host';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkProject, type Finding } from '../src/check.ts';
import { jobHash } from '../src/job-outbox.ts';
import {
  draftPublicationContext, JOB_BINDING_ID, JOB_ENUMERATOR_ID, JOB_READER_ID,
  partsEnumerator, prepareDraftManifest, readPublished,
} from '../src/job-publication.ts';
import { PARTS_CHECK_SPEC } from '../src/parts-check.ts';
import { PARTS_CLI_RECEIPT } from '../src/parts-verdict-record.ts';
import type { JsonObject } from '../src/templates.ts';

const scratch: string[] = [];
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }); });

const currentPath = 'derived/drafts/chain/input/recomposite_rig.png';
const priorPath = 'derived/drafts/prior/input/render/recomposite_rig.png';
const at = '2026-11-10T00:00:00Z';

function setup() {
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'previous-draft-publication-')));
  scratch.push(work);
  const root = join(work, 'project');
  cpSync(join(import.meta.dir, '../templates/example-chain/checkpoints/1-parts-verdict'), root, { recursive: true });
  const project: JsonObject = JSON.parse(readFileSync(join(root, 'project.json'), 'utf8'));
  const current = (project.drafts as JsonObject[])[0]!;
  const previous: JsonObject = JSON.parse(JSON.stringify(current).replaceAll('derived/drafts/chain/', 'derived/drafts/prior/'));
  previous.id = 'prior';
  (previous.parts as JsonObject).path = 'derived/drafts/prior/input/rig';
  for (const row of (previous.parts as JsonObject).files as JsonObject[]) row.path = String(row.path).replace('/input/', '/input/rig/');
  cpSync(join(root, 'derived/drafts/chain'), join(root, 'derived/drafts/prior'), { recursive: true });
  renameSync(join(root, 'derived/drafts/prior/input'), join(root, 'derived/drafts/prior/assembly'));
  mkdirSync(join(root, 'derived/drafts/prior/input/render'), { recursive: true });
  renameSync(join(root, 'derived/drafts/prior/assembly'), join(root, 'derived/drafts/prior/input/rig'));
  rmSync(join(root, 'derived/drafts/prior/input/rig/recomposite_rig.png'));
  const put = (path: string, bytes: string | Uint8Array) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), bytes);
    return { path, sha256: jobHash(bytes) };
  };
  const previousSeal = put(priorPath, encodePng(128, 128, new Uint8Array(128 * 128 * 4).fill(79)));
  const row = (previous.files as JsonObject[]).find(file => String(file.path).endsWith('/recomposite_rig.png'))!;
  Object.assign(row, previousSeal);
  const currentSeal = { path: currentPath, sha256: jobHash(readFileSync(join(root, currentPath))) };
  project.drafts = [previous, current];
  const tool = { name: '@rig-c/review', version: '0.0.0-synthetic' };
  const receipt = (status: 'approved' | 'changes-requested') => {
    const bytes = JSON.stringify({ schema: 'rig-review-parts-verdict/2', status, tool,
      source: { sha256: 'a'.repeat(64), files: ((previous.parts as JsonObject).files as JsonObject[]).map(({ sha256 }) => ({ sha256 })) },
      parts: { synthetic: { outcome: status === 'approved' ? 'clean' : 'flagged', note: '' } } });
    const evidence = { kind: 'parts-verdict', ...put(`evidence/review-reads/${jobHash(bytes)}.json`, bytes) };
    return { schema: PARTS_CLI_RECEIPT, kind: 'parts-verdict', route: 'cli', draft_id: 'prior', argv: ['parts', 'prior'],
      evidence, tool, status, flagged: status === 'approved' ? [] : ['synthetic'], noted: [], by: 'owner', at };
  };
  const approval = receipt('approved');
  project.review_acts = [approval];
  (project.signoffs as JsonObject[]).push({ stage: 'parts-review', checkpoint: null, draft_id: 'prior',
    evidence: { ...approval.evidence, spec: PARTS_CLI_RECEIPT }, by: 'owner', at, verbatim: 'Approve the synthetic draft.' });
  const save = () => put('project.json', `${JSON.stringify(project, null, 2)}\n`);
  save();
  return { root, work, project, previous, current, currentSeal, previousSeal, put, save, receipt };
}

function unbind(draft: JsonObject, path: string): void {
  draft.files = (draft.files as JsonObject[]).filter(row => row.path !== path);
}

test('Review retains both source seals and replays the immutable publication after optional evidence disappears', async () => {
  const { root, work, project, previous, currentSeal, previousSeal, save } = setup();
  const record = save();
  const path = prepareDraftManifest(root, project, 'chain');
  const manifest = readFileSync(join(root, path));
  const result = { path, selector: { kind: 'draft' as const, id: 'chain' } };
  const binding = { path: 'project.json' as const, sha256: record.sha256 };
  const context = await readPublished({ root, record: binding, result });
  const comparison = { schema: JOB_PREVIOUS_DRAFT_SCHEMA,
    draft: { id: 'prior', revision: jobHash(`${JSON.stringify(previous, null, 2)}\n`) },
    composites: { current: currentSeal, previous: previousSeal } } satisfies NonNullable<typeof context.previousDraft>;
  expect(context.previousDraft).toEqual(comparison);
  expect(context.files.filter(file => file.path === currentPath)).toEqual([currentSeal]);
  expect(context.files.filter(file => file.path === priorPath)).toEqual([previousSeal]);
  const host = await startJobHost({ root, stateDir: join(work, 'host'), fingerprint: 'synthetic-previous-draft',
    reviewer: { id: 'owner', role: 'owner' }, readPublished, readerId: JOB_READER_ID,
    partsEnumerator, partsEnumeratorId: JOB_ENUMERATOR_ID, bindingId: JOB_BINDING_ID, installWriterBinding: () => {} });
  try {
    const request = { schema: JOB_API_SCHEMA, verb: 'publish', jobId: host.session.jobId, requestId: 'publish-prior',
      expectedGeneration: 0, idempotencyKey: 'publish-prior', result, freeze: { kind: 'producer-held', holdId: 'synthetic', record: binding } };
    const publish = async (body = request) => (await host.ports.handleJobApi(new Request(`${host.origin}/jobs/${host.session.jobId}/api`, {
      method: 'POST', headers: { authorization: `Bearer ${host.session.hostCredentials().agent}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }))).json();
    const first = await publish();
    expect(first).toMatchObject({ ok: true });
    const retained = host.session.status().publication!;
    expect(retained.source).toMatchObject({ previousDraft: comparison });

    rmSync(join(root, priorPath));
    const warnings: Finding[] = [];
    expect(draftPublicationContext(root, project, 'chain', warnings).previousDraft).toBeUndefined();
    expect(warnings).toContainEqual(expect.objectContaining({ code: 'PREVIOUS_DRAFT_UNAVAILABLE', path: 'drafts[prior].files' }));
    expect(prepareDraftManifest(root, project, 'chain')).toBe(path);
    expect(readFileSync(join(root, path))).toEqual(manifest);
    expect(await publish()).toEqual(first);
    expect(host.session.status().publication).toEqual(retained);

    const fresh = await publish({ ...request, requestId: 'publish-fresh', idempotencyKey: 'publish-fresh', expectedGeneration: retained.generation });
    expect(fresh).toMatchObject({ ok: true });
    const next = host.session.status().publication!;
    expect(next.publicationId).not.toBe(retained.publicationId);
    expect(next.source.sourceHash).not.toBe(retained.source.sourceHash);
    expect(next.source).not.toHaveProperty('previousDraft');
  } finally { host.stop(); }
});

test.each(['missing', 'changed'] as const)('the current mandatory recomposite still refuses when %s', async defect => {
  const { root, project, save } = setup();
  const record = save();
  const path = prepareDraftManifest(root, project, 'chain');
  const before = readFileSync(join(root, path));
  if (defect === 'missing') rmSync(join(root, currentPath));
  else writeFileSync(join(root, currentPath), 'mutated mandatory source');
  const invalid = expect.objectContaining({ code: 'JOB_PUBLICATION_INVALID' });
  expect(() => draftPublicationContext(root, project, 'chain')).toThrow(invalid);
  expect(() => prepareDraftManifest(root, project, 'chain')).toThrow(invalid);
  await expect(readPublished({ root, record: { path: 'project.json', sha256: record.sha256 },
    result: { path, selector: { kind: 'draft', id: 'chain' } } })).rejects.toThrow(invalid);
  expect(readFileSync(join(root, path))).toEqual(before);
  if (defect === 'changed') expect(checkProject(root, project, { now: Date.parse(at), readOnly: true }).refusals).toContainEqual(expect.objectContaining({ code: 'DRAFT_RIG_FILE' }));
});

test.each(['unbound', 'changed'] as const)('the %s optional predecessor stack warns without changing the base closure', defect => {
  const { root, project, previous, currentSeal } = setup();
  if (defect === 'unbound') unbind(previous, priorPath);
  else writeFileSync(join(root, priorPath), 'mutated comparison source');
  const warnings: Finding[] = [];
  const context = draftPublicationContext(root, project, 'chain', warnings);
  expect(context.previousDraft).toBeUndefined();
  expect(context.files).toContainEqual(currentSeal);
  expect(context.files.some(file => file.path === priorPath)).toBe(false);
  expect(warnings).toContainEqual(expect.objectContaining({ code: 'PREVIOUS_DRAFT_UNAVAILABLE', path: 'drafts[prior].files' }));
});

test('a hash-bound diff_map fallback is specific to the path named by its producer', () => {
  const { root, project, previous, previousSeal, put } = setup();
  unbind(previous, priorPath);
  const report = JSON.parse(readFileSync(join(import.meta.dir, '../templates/example-diff/diff-components.json'), 'utf8')) as JsonObject;
  const file = 'evidence/previous-diff.json';
  report.stack = { path: currentPath, sha256: previousSeal.sha256 };
  project.diff_map = { report: put(file, JSON.stringify(report)) };
  const warnings: Finding[] = [];
  expect(draftPublicationContext(root, project, 'chain', warnings).previousDraft).toBeUndefined();
  expect(warnings).toContainEqual(expect.objectContaining({ code: 'PREVIOUS_DRAFT_UNAVAILABLE' }));
  report.stack = { path: join(root, priorPath), sha256: previousSeal.sha256 };
  const bound = put(file, JSON.stringify(report));
  expect(draftPublicationContext(root, project, 'chain').previousDraft).toBeUndefined();
  project.diff_map = { report: bound };
  expect(draftPublicationContext(root, project, 'chain').previousDraft?.composites.previous).toEqual(previousSeal);
});

test('retained parts-check evidence binds a stack only with the same manifest and assembled root', () => {
  const { root, project, current, currentSeal, put } = setup();
  unbind(current, currentPath);
  const parts = current.parts as JsonObject;
  const manifest = (parts.files as JsonObject[]).find(row => row.path === `${parts.path}/parts.json`)!;
  const inputs = [{ path: 'parts.json', status: 'read', sha256: 'b'.repeat(64) },
    { path: 'recomposite_rig.png', status: 'read', sha256: currentSeal.sha256 }];
  const bind = (partsPath = parts.path) => {
    const report = { spec: PARTS_CHECK_SPEC, stage: 'parts', inputs, parts: {}, refusals: [], reported: [], holes: [], exit_code: 0 };
    const seal = put('evidence/assembly-check.json', JSON.stringify(report));
    project.advances = [{ from_stage: 'parts', stage: 'parts-review', at, parts_check: { ...seal,
      parts: partsPath, spec: report.spec, exit_code: report.exit_code, holes: report.holes, reported: report.reported } }];
  };
  bind();
  const warnings: Finding[] = [];
  expect(draftPublicationContext(root, project, 'chain', warnings).previousDraft).toBeUndefined();
  expect(warnings).toContainEqual(expect.objectContaining({ code: 'PREVIOUS_DRAFT_UNAVAILABLE', path: 'drafts[chain].files' }));
  inputs[0]!.sha256 = String(manifest.sha256);
  bind('derived/drafts/other/input');
  expect(draftPublicationContext(root, project, 'chain').previousDraft).toBeUndefined();
  bind();
  const context = draftPublicationContext(root, project, 'chain');
  expect(context.previousDraft?.composites.current).toEqual(currentSeal);
  expect(context.files).toContainEqual(currentSeal);
});

test('a newer changes-requested verdict excludes the previous approval without a comparison warning', () => {
  const { root, project, receipt } = setup();
  (project.review_acts as JsonObject[]).push(receipt('changes-requested'));
  const warnings: Finding[] = [];
  const context = draftPublicationContext(root, project, 'chain', warnings);
  expect(context.previousDraft).toBeUndefined();
  expect(context.files.some(file => file.path === priorPath)).toBe(false);
  expect(warnings.map(finding => finding.code)).not.toContain('PREVIOUS_DRAFT_UNAVAILABLE');
});
