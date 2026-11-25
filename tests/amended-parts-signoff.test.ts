import { afterEach, expect, test } from 'bun:test';
import { appendFileSync, cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXAMPLE_NOW } from '../scripts/example-time.ts';
import { amendCommand } from '../src/amend.ts';
import { checkProject, type Finding } from '../src/check.ts';
import { draftRigCommand } from '../src/drafts.ts';
import { acknowledgePublication, JOB_BINDING_FILE, jobHash, pendingPublications, publicationVersionHash, writePrivateJson, type WriterBinding } from '../src/job-outbox.ts';
import { currentJobIdentity, draftPackageIdentity, prepareDraftManifest, readPublished } from '../src/job-publication.ts';
import { partsReviewCommand } from '../src/parts-review.ts';
import { latestPartsReceipt, recordedPartsVerdict } from '../src/parts-verdict-record.ts';
import { pauseCommand, resumeCommand } from '../src/pause.ts';
import { collectReopens, liveSignoff } from '../src/reopen.ts';
import { reviewActFindings } from '../src/review-act.ts';
import { checkReviewPackages } from '../src/review-package.ts';
import { rigVersionCommand } from '../src/rig-version.ts';
import { signoffCommand } from '../src/signoff.ts';
import { latestPartsApproval, partsApprovalIdentity, rigPartsApproval } from '../src/structure.ts';
import { structureSnapshotCommand } from '../src/structure-snapshot.ts';
import type { JsonObject } from '../src/templates.ts';

const draft = 'changed';
const draftRoot = `derived/drafts/${draft}`;
const manifest = `${draftRoot}/input/parts.json`;
const structure = `evidence/structure-${draft}.json`;
const builtAt = EXAMPLE_NOW;
const reviewedAt = builtAt + 1000;
const amendedAt = reviewedAt + 1000;
const signedAt = amendedAt + 1000;
const iso = (time: number) => new Date(time).toISOString();
const file = (root: string) => join(root, 'project.json');
const read = (root: string): JsonObject => JSON.parse(readFileSync(file(root), 'utf8'));
const write = (root: string, value: JsonObject) => writeFileSync(file(root), `${JSON.stringify(value, null, 2)}\n`);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(changed = true, bound = changed) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'create-amended-parts-')));
  roots.push(root);
  cpSync(join(import.meta.dir, '../templates/example-chain/checkpoints/3-rig-review'), root, { recursive: true });
  const project = read(root);
  project.stage = 'rigging';
  project.advances = (project.advances as JsonObject[]).filter(entry => entry.stage !== 'rig-review');
  const binding: WriterBinding = {
    schema: 'rig-create/job-binding@1', jobId: 'synthetic-job', origin: 'http://127.0.0.1:43123',
    fetchCapability: 'synthetic-fetch', listenerIncarnation: 'synthetic-listener',
    identity: currentJobIdentity({ root, stateDir: join(root, 'synthetic-state'), fingerprint: 'rig-create/live-review/1',
      reviewer: { id: 'synthetic-owner', role: 'owner' } }, root),
  };
  if (bound) {
    project.review_job = { jobId: binding.jobId, origin: binding.origin };
    writePrivateJson(join(root, JOB_BINDING_FILE), binding, true);
  }
  write(root, project);
  cpSync(join(root, 'derived/drafts/chain'), join(root, draftRoot), { recursive: true });
  rmSync(join(root, draftRoot, 'out/check'), { recursive: true });
  if (changed) appendFileSync(join(root, manifest), '\n');
  const registration = draftRigCommand([draft, root, '--config', `${draftRoot}/config.json`, '--from', `${draftRoot}/out`,
    '--parts', `${draftRoot}/input`, '--json'], builtAt);
  expect(registration.exit).toBe(0);
  structureSnapshotCommand([root, '--draft', draft]);
  expect(checkProject(root, undefined, { now: builtAt }).refusals).toEqual([]);
  return { root, binding, registration: JSON.parse(registration.stdout) as JsonObject };
}

async function retainVerdict(root: string, binding: WriterBinding, verdict: 'approved' | 'changes-requested' = 'approved', at = reviewedAt) {
  const bytes = readFileSync(file(root));
  const projectHash = jobHash(bytes);
  const identity = draftPackageIdentity(draft, true);
  const result = { selector: { kind: 'draft' as const, id: draft }, path: identity.path };
  const revision = publicationVersionHash(bytes, result)!;
  prepareDraftManifest(root, read(root), draft, identity.path);
  const context = await readPublished({ root, record: { path: 'project.json', sha256: projectHash }, result });
  const subject = { kind: 'parts-verdict' as const, draftId: draft };
  expect(context.subjects).toContainEqual(subject);
  const sourceHash = jobHash('Synthetic acknowledged draft.');
  const publicationId = 'historical-publication';
  acknowledgePublication({ schema: 'rig-create/job-pending@1', root, jobId: binding.jobId, origin: binding.origin,
    id: 'historical-intent', identity: binding.identity, recordHash: projectHash, versionHash: revision, result, failure: null },
  publicationId, 1, 'historical-request', [subject], { projectHash, sourceHash });

  const act = {
    schema: 'rig-review/act@2', kind: 'parts-verdict', actId: 'historical-act', askId: 'historical-ask',
    jobId: binding.jobId, publicationId, at: iso(at),
    authority: { actor: 'human', channel: 'review-ui', reviewer: binding.identity.reviewer },
    source: { package: { id: identity.id, revision }, projectHash, sourceHash, selector: result.selector,
      model: null, direction: null, plan: context.plan, parts: context.parts },
    value: { verdict, words: '  Synthetic owner verdict.\r\n', parts: context.partIds!.map((partId, index) => ({ partId,
      part: verdict === 'changes-requested' && index === 0 ? { outcome: 'flagged', note: 'Synthetic correction.' } : { outcome: 'clean', note: '' },
      mesh: { outcome: 'clean', note: '' },
    })) },
  };
  const actBytes = JSON.stringify(act);
  const ingest = () => partsReviewCommand([root, '--from-review', act.actId], reviewedAt, { fetch: () => ({ bytes: actBytes }) });
  expect(ingest().exit).toBe(0);
  return { act, actBytes, ingest };
}

function amendmentArgs(root: string, changePath = manifest, target = draft): string[] {
  const words = join(root, 'owner-amendment.txt');
  writeFileSync(words, 'Please amend the parts to the reviewed draft.\n');
  return ['parts-review', root, '--kind', 'draft', '--target', target, '--change', changePath, '--by', 'synthetic-owner',
    '--owner-chat', words, '--said-at', iso(amendedAt), '--relayed-by', 'synthetic-operator'];
}

function sign(root: string, actId: string, extra: string[] = [], target = draft) {
  return signoffCommand(['parts-review', root, '--draft', target, '--from-review', actId, '--json', ...extra], signedAt,
    { fetch: () => { throw new Error('A retained act must not be fetched'); } });
}

function refuses(root: string, code: string, command: () => unknown) {
  const before = readFileSync(file(root));
  expect(command).toThrow(expect.objectContaining({ code }));
  expect(readFileSync(file(root))).toEqual(before);
}

test.each([['default', []], ['explicit', ['--structure-file', structure]]] as const)('bound draft defers a new ask and carries the acknowledged approval with %s structure', async (_mode, structureArgs) => {
  const { root, binding, registration } = fixture();
  expect(registration.publication).toMatchObject({ status: 'deferred', lines: [expect.stringContaining('RIGGING_DRAFT_PARTS_CHANGED')] });
  expect(pendingPublications(root, true)).toEqual([]);
  expect(existsSync(join(root, draftPackageIdentity(draft, true).path))).toBe(false);
  const { act, actBytes, ingest } = await retainVerdict(root, binding);
  const before = read(root);
  refuses(root, 'AMENDMENT_TARGET_INVALID', () => sign(root, act.actId));
  expect(amendCommand(amendmentArgs(root), amendedAt).exit).toBe(0);
  expect(ingest().exit).toBe(0);
  const amended = read(root);
  expect(amended.signoffs).toEqual(before.signoffs);
  expect(amended.review_acts).toEqual(before.review_acts);
  expect(amended.amendments).toEqual([expect.objectContaining({ target: { stage: 'parts-review', kind: 'draft', id: draft },
    changes: [{ path: manifest, sha256: jobHash(readFileSync(join(root, manifest))) }], by: 'synthetic-owner' })]);
  const report = checkProject(root, amended, { now: amendedAt });
  expect(report.refusals).toEqual([]);
  expect(report.effective_stage).toBe('parts-review');
  expect(report.amendments?.[0]?.lapsed.map(row => row.stage)).toEqual(['parts-review', 'rigging-interview']);
  expect(report.amendments?.[0]?.keep_by_binding).toEqual([]);
  expect((amended.plan as { steps: JsonObject[] }).steps.map(step => step.status)).toEqual(['done', 'done', 'pending', 'pending', 'pending', 'pending']);

  const result = sign(root, act.actId, [...structureArgs]);
  expect(result.exit).toBe(0);
  const signature = JSON.parse(result.stdout) as JsonObject;
  const source = `review act ${act.jobId}/${act.actId}`;
  const evidence = { kind: 'parts-verdict', path: `evidence/review-acts/${jobHash(JSON.stringify([act.jobId, act.actId]))}.json`,
    sha256: jobHash(actBytes), spec: act.schema };
  expect(signature).toMatchObject({ stage: 'parts-review', checkpoint: null, draft_id: draft, by: 'user',
    at: iso(signedAt), verbatim: act.value.words, source, evidence, structure: { path: structure } });
  const signed = read(root);
  const previous = before.signoffs as JsonObject[];
  expect(signed.stage).toBe('rigging');
  expect(signed.signoffs).toEqual([...previous, signature]);
  expect(signed.advances).toEqual(before.advances);
  const retained = (signed.review_acts as JsonObject[]).at(-1)!;
  expect(retained).toMatchObject({ ...(before.review_acts as JsonObject[]).at(-1), signoff: previous.length,
    signoff_amendment: { index: 0, signed_at: iso(signedAt), draft_id: draft } });
  const olderMapping = structuredClone(signed);
  delete ((olderMapping.review_acts as JsonObject[]).at(-1)!.signoff_amendment as JsonObject).draft_id;
  expect(reviewActFindings(olderMapping)).toEqual([]);
  expect(readFileSync(join(root, evidence.path), 'utf8')).toBe(actBytes);
  const checked = checkProject(root, signed, { now: signedAt });
  expect(checked.refusals).toEqual([]);
  expect(checked.effective_stage).toBe('rigging-interview');
  expect(liveSignoff(collectReopens(signed, []), 'rigging-interview', Date.parse(String(previous.at(-1)?.at)))).toBe(false);
  expect(latestPartsApproval(signed)).toEqual(signature);
  const approval = rigPartsApproval(signed, { registration: { at: iso(signedAt + 1000) }, accepted_parts: partsApprovalIdentity(signature)! });
  expect(approval).toEqual(signature);
  expect(recordedPartsVerdict(root, signed, approval!.draft_id, approval!.evidence).partsFile).toBe(join(root, manifest));

  // Exercise the downstream package identity gate with a projected registration, before any new rig is built.
  const version = structuredClone((signed.versions as JsonObject[])[0]!);
  const packageRecord = version.review_package as { open: string; files: { path: string; sha256: string }[] };
  Object.assign(version, { n: 2, at: iso(signedAt + 1000), registration: { at: iso(signedAt + 1000) },
    accepted_parts: partsApprovalIdentity(signature) });
  packageRecord.open = "rig-review open 'derived/review/v2/out'";
  const packageManifest = packageRecord.files.find(row => row.path === 'out/parts.json')!;
  const previousSha = packageManifest.sha256;
  packageManifest.sha256 = jobHash(readFileSync(join(root, manifest)));
  const projected = { ...signed, versions: [version] };
  const packageFindings = (project: JsonObject) => {
    const refusals: Finding[] = [];
    checkReviewPackages({ dir: root, project, refusals, warnings: [] }, 2);
    return refusals;
  };
  expect(packageFindings(projected)).toEqual([]);
  // #981: packaged parts are no longer compared with the parts approval.
  packageManifest.sha256 = previousSha;
  expect(packageFindings(projected)).toEqual([]);

  const movedClock = structuredClone(signed);
  (movedClock.signoffs as JsonObject[]).at(-1)!.at = iso(signedAt + 1);
  expect(reviewActFindings(movedClock).map(finding => finding.code)).toEqual(['REVIEW_ACT_LEDGER_INVALID']);

  const committed = readFileSync(file(root));
  rmSync(join(root, JOB_BINDING_FILE));
  rmSync(join(root, draftRoot, 'out/mesh_report.json'));
  expect(recordedPartsVerdict(root, signed, draft, evidence, { requireAvailable: false }).partsFile).toBe(join(root, manifest));
  expect(JSON.parse(sign(root, act.actId).stdout)).toEqual(signature);
  expect(readFileSync(file(root))).toEqual(committed);
});

test('a paused project must resume before carrying a changed parts approval', async () => {
  const { root, binding } = fixture();
  const { act } = await retainVerdict(root, binding);
  const words = join(root, 'pause-words.txt');
  writeFileSync(words, 'Pause and resume the synthetic project.\n');
  const human = ['--by', 'synthetic-owner', '--verbatim-file', words];
  expect(signoffCommand(['paused', root, ...human], reviewedAt + 1).exit).toBe(0);
  expect(pauseCommand([root, ...human], reviewedAt + 2).exit).toBe(0);
  expect(resumeCommand(['rigging', root, ...human], reviewedAt + 3).exit).toBe(0);
  expect(amendCommand(amendmentArgs(root), amendedAt).exit).toBe(0);
  expect(signoffCommand(['paused', root, ...human], amendedAt + 2).exit).toBe(0);
  expect(pauseCommand([root, ...human], amendedAt + 3).exit).toBe(0);
  refuses(root, 'PARTS_REVIEW_FOLD_NOT_READY', () => sign(root, act.actId));
  expect(resumeCommand(['rigging', root, ...human], amendedAt + 4).exit).toBe(0);
  expect(sign(root, act.actId).exit).toBe(0);
});

test('rigging draft amendment requires owner chat and bound changed inputs', () => {
  const { root } = fixture();
  refuses(root, 'OWNER_CHAT_REQUIRED', () => amendCommand(amendmentArgs(root).slice(0, -6), amendedAt));
  refuses(root, 'AMENDMENT_CHANGES_INVALID', () => amendCommand(amendmentArgs(root, 'derived/drafts/chain/input/parts.json'), amendedAt));
  appendFileSync(join(root, manifest), '\n');
  refuses(root, 'AMENDMENT_CHANGES_INVALID', () => amendCommand(amendmentArgs(root), amendedAt));
  const drifted = fixture().root;
  appendFileSync(join(drifted, draftRoot, 'input/parts/face.png'), '\n');
  refuses(drifted, 'AMENDMENT_CHANGES_INVALID', () => amendCommand(amendmentArgs(drifted), amendedAt));
  const identical = fixture(false).root;
  refuses(identical, 'AMENDMENT_CHANGES_INVALID', () => amendCommand(amendmentArgs(identical), amendedAt));
});

test('an ordinary Review signoff still uses its fetch transport', () => {
  const { root, binding } = fixture();
  const actId = 'ordinary-signoff';
  const fetch = (transport: { kind?: string; jobId: string; actId: string }) => {
    expect(transport).toMatchObject({ kind: 'signoff', jobId: binding.jobId, actId });
    return { bytes: '{' };
  };
  refuses(root, 'REVIEW_ACT_INVALID', () => signoffCommand(['parts-review', root, '--draft', draft, '--from-review', actId], signedAt, { fetch }));
});

test.each([false, true])('carries the retained verdict after retirement with replacement job = %s', async replacement => {
  const { root, binding } = fixture();
  const { act, actBytes } = await retainVerdict(root, binding);
  rmSync(join(root, JOB_BINDING_FILE));
  expect(amendCommand(amendmentArgs(root), amendedAt).exit).toBe(0);
  if (replacement) writePrivateJson(join(root, JOB_BINDING_FILE), { ...binding, jobId: 'replacement-job' });
  const args = ['parts-review', root, '--from-review', act.actId];
  const fetch = () => { throw new Error('A retained verdict must not be fetched'); };
  refuses(root, 'PARTS_VERDICT_RECEIPT_REQUIRED', () =>
    signoffCommand(['parts-review', root, '--from-review', 'never-ingested'], signedAt, { fetch }));
  const project = read(root);
  const receipt = (project.review_acts as JsonObject[]).at(-1)!;
  const evidence = receipt.evidence as JsonObject;
  const path = join(root, String(evidence.path));
  writeFileSync(path, actBytes + '\n');
  refuses(root, 'REVIEW_ACT_LEDGER_INVALID', () => signoffCommand(args, signedAt, { fetch }));
  writeFileSync(path, actBytes);
  const result = signoffCommand(args, signedAt, { fetch });
  expect(result.exit).toBe(0);
  expect(result.stdout).toContain(`review act ${act.jobId}/${act.actId} (sha256 ${jobHash(actBytes)})`);
  const saved = readFileSync(file(root));
  expect(signoffCommand(args, signedAt, { fetch }).exit).toBe(0);
  expect(readFileSync(file(root))).toEqual(saved);
});

test.each([
  ['changes-requested', reviewedAt, 'PARTS_VERDICT_NOT_APPROVED'],
  ['approved', builtAt - 1, 'REVIEW_ACT_SOURCE_STALE'],
] as const)('refuses %s at %d with %s', async (verdict, at, code) => {
  const { root, binding } = fixture();
  const { act } = await retainVerdict(root, binding, verdict, at);
  expect(amendCommand(amendmentArgs(root), amendedAt).exit).toBe(0);
  refuses(root, code, () => sign(root, act.actId, ['--structure-file', structure]));
});

test('refuses a different draft or a mismatched byte in the amendment or in the live parts inventory', async () => {
  const { root, binding } = fixture();
  const { act } = await retainVerdict(root, binding);
  expect(amendCommand(amendmentArgs(root), amendedAt).exit).toBe(0);
  refuses(root, 'AMENDMENT_TARGET_INVALID', () => sign(root, act.actId, [], 'chain'));

  // Keep the original act and draft valid so the amendment hash check is the only guard against this plant.
  const project = read(root);
  const change = (project.amendments as { changes: { sha256: string }[] }[])[0]!.changes[0]!;
  const original = change.sha256;
  change.sha256 = jobHash('Different parts.json bytes.');
  write(root, project);
  refuses(root, 'AMENDMENT_CHANGES_INVALID', () => sign(root, act.actId));

  change.sha256 = original;
  write(root, project);
  // A matching manifest and amendment cannot hide drift in a non-manifest part file.
  appendFileSync(join(root, draftRoot, 'input/parts/face.png'), '\n');
  refuses(root, 'REVIEW_ACT_SOURCE_STALE', () => sign(root, act.actId));
});

const targetId = 'carry-target';
const targetRoot = `derived/drafts/${targetId}`;
const targetParts = `${targetRoot}/input`;
const targetManifest = `${targetParts}/parts.json`;

async function crossDraft(differentImage = false) {
  const { root, binding } = fixture();
  const { act } = await retainVerdict(root, binding);
  // Retire the synthetic binding once its act is ingested, retaining the acknowledged evidence.
  rmSync(join(root, JOB_BINDING_FILE));
  cpSync(join(root, draftRoot), join(root, targetRoot), { recursive: true });
  if (differentImage) appendFileSync(join(root, targetParts, 'parts/face.png'), '\n');
  // The owner saw these bytes on the source draft before the target got its own registration.
  expect(draftRigCommand([targetId, root, '--config', `${targetRoot}/config.json`, '--from', `${targetRoot}/out`,
    '--parts', targetParts], reviewedAt + 100).exit).toBe(0);
  structureSnapshotCommand([root, '--draft', targetId]);
  expect(amendCommand(amendmentArgs(root, targetManifest, targetId), amendedAt).exit).toBe(0);
  expect(checkProject(root, undefined, { now: amendedAt }).refusals).toEqual([]);
  return { root, act };
}

function rigRegistration(root: string) {
  const source = 'registration-source';
  const rig = `${source}/rig`;
  const at = signedAt + 1000;
  cpSync(join(import.meta.dir, 'fixtures/rig-registration'), join(root, source), { recursive: true });
  const put = (name: string, value: unknown) => writeFileSync(join(root, source, name), JSON.stringify(value));
  const hash = (path: string) => jobHash(readFileSync(join(root, source, path)));
  const previous = (read(root).versions as JsonObject[])[0]!;
  put('citations.json', (previous.provenance as JsonObject).sections);
  put('adapter.json', []);
  put('at-source.json', { finished_at: iso(at) });
  put('run.json', { spec: 'rigc-run/1', package: { name: 'rig-c', version: '3.4.1' }, command: 'build',
    started_at: iso(at), finished_at: iso(at), inputs: [
      { role: 'rig', path: '../rig/rig.json', sha256: hash('rig/rig.json') },
      { role: 'motion', path: '../rig/motion.json', sha256: hash('rig/motion.json') },
    ], outputs: [{ path: 'skeleton.model.json', sha256: hash('build/skeleton.model.json') }] });
  put('check.json', { spec: 'rig-parts-check/1', bar_outcomes: { gate: { status: 'PASS' } },
    build: { model_sha256: hash('build/skeleton.model.json') } });
  const inputs = {
    '--build': 'build', '--idle': 'idle', '--path-adapter': 'adapter.json', '--compile-report': 'compile-report.json',
    '--toolchain-lock': 'package-lock.json', '--run-record': 'run.json', '--at-source': 'at-source.json',
    '--check-report': 'check.json', '--citations': 'citations.json',
  };
  return (parts: string) => rigVersionCommand(['2', root, ...Object.entries(inputs).flatMap(([flag, path]) => [flag, `${source}/${path}`]),
    '--rig', rig, '--parts', parts, '--config', `${targetRoot}/config.json`, '--at-pointer', '/finished_at', '--by', 'synthetic-agent', '--json'], at);
}

test('cross-draft identical parts carry approval and pass real rig-version registration', async () => {
  const { root, act } = await crossDraft();
  expect(readFileSync(join(root, targetManifest))).toEqual(readFileSync(join(root, manifest)));
  expect(Date.parse(act.at)).toBeLessThan(Date.parse(String((read(root).drafts as JsonObject[]).at(-1)?.at)));
  const written = sign(root, act.actId, [], targetId);
  expect(written.exit).toBe(0);
  const signature = JSON.parse(written.stdout) as JsonObject;
  const signed = read(root);
  const receipt = latestPartsReceipt(signed, targetId);
  expect(receipt).toMatchObject({ draft_id: draft, signoff_amendment: { index: 0, signed_at: iso(signedAt), draft_id: targetId } });
  expect(latestPartsReceipt(signed, draft)).toBeUndefined();
  expect(signature).toMatchObject({ draft_id: targetId, source: `review act ${act.jobId}/${act.actId}`, structure: { path: `evidence/structure-${targetId}.json` } });
  expect(recordedPartsVerdict(root, signed, targetId).partsFile).toBe(join(root, targetManifest));
  expect(recordedPartsVerdict(root, signed, targetId, signature.evidence).partsFile).toBe(join(root, targetManifest));
  expect(checkProject(root, undefined, { now: signedAt }).refusals).toEqual([]);
  const alteredRecord = structuredClone(signed);
  const target = (alteredRecord.drafts as JsonObject[]).at(-1)!;
  const targetImage = (target.parts as { files: JsonObject[] }).files.find(file => String(file.path).endsWith('/parts/face.png'))!;
  targetImage.sha256 = jobHash('Different registered image.');
  expect(reviewActFindings(alteredRecord).map(finding => finding.code)).toEqual(['PARTS_VERDICT_DRAFT_MISMATCH']);
  const committed = readFileSync(file(root));
  expect(JSON.parse(sign(root, act.actId, [], targetId).stdout)).toEqual(signature);
  expect(readFileSync(file(root))).toEqual(committed);
  refuses(root, 'PARTS_VERDICT_DRAFT_MISMATCH', () => sign(root, act.actId));

  const register = rigRegistration(root);
  const result = register(targetParts);
  expect(result.exit).toBe(0);
  expect(JSON.parse(result.stdout).accepted_parts).toBeUndefined();
  expect(JSON.parse(result.stdout)).toMatchObject({ n: 2,
    registration: { check_report: { path: 'evidence/v2/registration/check.json', spec: 'rig-parts-check/1' } } });
  expect(readFileSync(join(root, 'outputs/v2/out/parts.json'))).toEqual(readFileSync(join(root, targetManifest)));
  expect(checkProject(root, undefined, { now: signedAt + 1000 }).refusals).toEqual([]);

  rmSync(join(root, draftRoot, 'out/mesh_report.json'));
  expect(recordedPartsVerdict(root, read(root), targetId, signature.evidence, { requireAvailable: false }).partsFile).toBe(join(root, targetManifest));
});

test('cross-draft same manifest with a different registered image refuses carry', async () => {
  const { root, act } = await crossDraft(true);
  expect(readFileSync(join(root, targetManifest))).toEqual(readFileSync(join(root, manifest)));
  const registered = (read(root).drafts as JsonObject[]).slice(-2);
  const imageHash = (draft: JsonObject) => (draft.parts as { files: { path: string; sha256: string }[] }).files.find(file => file.path.endsWith('/parts/face.png'))!.sha256;
  expect(imageHash(registered[0]!)).not.toBe(imageHash(registered[1]!));
  refuses(root, 'PARTS_VERDICT_DRAFT_MISMATCH', () => sign(root, act.actId, [], targetId));
});
