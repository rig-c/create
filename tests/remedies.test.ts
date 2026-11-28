import { afterEach, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXAMPLE_ANCHOR, EXAMPLE_NOW } from '../scripts/example-time.ts';
import { renderAgentGuide } from '../src/agent-guide.ts';
import { checkProject, collectItems, type Finding } from '../src/check.ts';
import { optionContext, OPTIONS_SPEC, sha256 } from '../src/choices.ts';
import { main, RETIRED_NUMBERED_COMMANDS } from '../src/cli.ts';
import { COMPOSE_VALUE_INVALID, ComposeValueError, composeFail } from '../src/compose-value.ts';
import { DirectionError, directionBytes } from '../src/direction.ts';
import { sameArtworkFor } from '../src/init.ts';
import { interviewCommand } from '../src/interview.ts';
import { acknowledgePublication, jobHash, jobPrivateRoot } from '../src/job-outbox.ts';
import { currentJobIdentity } from '../src/job-publication.ts';
import { NUMBERED_WRITER_REMOVED } from '../src/numbered-retirement.ts';
import { checkPartsActEvidence, partsCarryAmendment } from '../src/parts-act.ts';
import { decodePartsRead, PARTS_CLI_RECEIPT, recordedPartsFinding } from '../src/parts-verdict-record.ts';
import { requireRecordDirectionTarget } from '../src/record-direction-target.ts';
import { readVerbatim } from '../src/record-input.ts';
import { Refusal } from '../src/refusal.ts';
import { reopenLapseWarnings } from '../src/reopen-lapses.ts';
import { assertActSubjectDeclared, reviewActTransport, type InterviewPicksAct, type PartsVerdictAct } from '../src/review-act.ts';
import { storeReviewRead } from '../src/review-read.ts';
import { handoff } from '../src/review.ts';
import { pngDimensions } from '../src/scene.ts';
import { sceneCommand } from '../src/scene-writers.ts';
import { assertInterviewRecordSignable } from '../src/signable.ts';
import { SIGNOFF_PAIR_SINCE, signoffPairFinding } from '../src/signoff-pair.ts';
import { signoffCommand } from '../src/signoff.ts';
import { checkSignoffTarget, selectSignoffTarget, SIGNOFF_TARGET_SINCE } from '../src/signoff-target.ts';
import { checkStructure } from '../src/structure.ts';
import { structureSnapshotCommand } from '../src/structure-snapshot.ts';
import type { JsonObject } from '../src/templates.ts';

const roots: string[] = [];
function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'create-remedies-'));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of roots.splice(0)) {
    rmSync(jobPrivateRoot(dir), { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ignored direction input names a retained remedy and preserves source bytes', () => {
  const dir = root();
  mkdirSync(join(dir, 'scratch'));
  writeFileSync(join(dir, 'scratch/direction.json'), '{"synthetic":true}\n');
  const before = readFileSync(join(dir, 'scratch/direction.json'));
  expect(() => directionBytes(dir, 'scratch/direction.json')).toThrow(expect.objectContaining({
    code: 'DIRECTION_FILE', message: expect.stringContaining('path is ignored'),
  }));
  try { directionBytes(dir, 'scratch/direction.json'); }
  catch (error) {
    expect(error).toBeInstanceOf(DirectionError);
    expect((error as DirectionError).message).toContain('evidence/direction-src/');
  }
  expect(readFileSync(join(dir, 'scratch/direction.json'))).toEqual(before);
  mkdirSync(join(dir, 'evidence'));
  writeFileSync(join(dir, 'evidence/direction.json'), before);
  expect(directionBytes(dir, 'evidence/direction.json')).toEqual(before);
});

test('duplicate artwork refuses with the existing version and correction-ledger route', () => {
  const dir = root();
  const existing = join(dir, 'existing');
  mkdirSync(existing);
  const record = JSON.stringify({ inputs: [{ sha256: 'a'.repeat(64) }] });
  writeFileSync(join(existing, 'project.json'), record);
  expect(() => sameArtworkFor(join(dir, 'new'), 'synthetic.png', 'a'.repeat(64), 0)).toThrow(expect.objectContaining({
    code: 'INIT_ARTWORK_EXISTS', message: expect.stringContaining('continue in that existing project as a new version'),
  }));
  try { sameArtworkFor(join(dir, 'new'), 'synthetic.png', 'a'.repeat(64), 0); }
  catch (error) {
    expect(error).toBeInstanceOf(Refusal);
    expect((error as Refusal).message).toContain('restart there inherits its correction ledger');
    expect((error as Refusal).message).toContain('different artwork or a different rig kind');
  }
  expect(readFileSync(join(existing, 'project.json'), 'utf8')).toBe(record);
});

test('unreadable verbatim input explains working-directory resolution without changing its code', () => {
  expect(() => readVerbatim(join(root(), 'missing.txt'))).toThrow(expect.objectContaining({
    code: 'VERBATIM_UNREADABLE', message: expect.stringContaining('current working directory, not the project folder'),
  }));
});

test('rendered guide fits its byte bar and scopes camera choices to the direction format', () => {
  const guide = renderAgentGuide();
  expect(Buffer.byteLength(guide)).toBeLessThan(10_000);
  expect(guide).toContain('Reused opens exit. The page updates in place.');
  expect(guide).toContain('repeat the same open with its reviewer and role');
  expect(guide).toContain('`rig-create job reconcile`');
  expect(guide).toContain('](AGENT-REFERENCE.md)');
  expect(readFileSync(new URL('../docs/AGENT-REFERENCE.md', import.meta.url), 'utf8')).toMatch(/already retained in the recorded\s+assembled parts/);
  expect(`${guide}\n${readFileSync(new URL('../docs/AGENT-REFERENCE.md', import.meta.url), 'utf8')}`).not.toContain('when the plan has a head turn driven by depth');
});

test('#1122 reopen lapse remedies name surviving routes or read-only status without retired commands', () => {
  const warnings = reopenLapseWarnings({
    signoffs: [
      { stage: 'parts', checkpoint: 'seethrough', by: 'owner', at: '2026-11-10T00:00:00.000Z', verbatim: 'ok' },
      { stage: 'parts-review', checkpoint: null, by: 'owner', at: '2026-11-10T00:01:00.000Z', verbatim: 'ok' },
      { stage: 'rig-review', checkpoint: null, by: 'owner', at: '2026-11-10T00:02:00.000Z', verbatim: 'ok' },
      { stage: 'direction-review', checkpoint: null, by: 'owner', at: '2026-11-10T00:03:00.000Z', verbatim: 'ok' },
    ],
    versions: [
      { n: 1, kind: 'rig', at: '2026-11-10T00:01:30.000Z', verdicts: [{ by: 'owner', at: '2026-11-10T00:01:45.000Z', review: 'rig-review', verdict: 'accepted', verbatim: 'ok' }] },
      { n: 2, kind: 'post', rig_version: 1, at: '2026-11-10T00:02:30.000Z', verdicts: [{ by: 'owner', at: '2026-11-10T00:02:45.000Z', review: 'direction-review', verdict: 'accepted', verbatim: 'ok' }] },
    ],
    reopens: [
      { stage: 'parts', from_stage: 'accepted', by: 'owner', at: '2026-11-11T00:00:00.000Z', verbatim: 'reopen', steps_before: [] },
    ],
  });
  expect(warnings.map((w) => [w.code, w.path])).toEqual([
    ['REOPEN_SIGNOFF_LAPSED', 'signoffs[0]'],
    ['REOPEN_SIGNOFF_LAPSED', 'signoffs[1]'],
    ['REOPEN_SIGNOFF_LAPSED', 'signoffs[2]'],
    ['REOPEN_SIGNOFF_LAPSED', 'signoffs[3]'],
    ['REOPEN_VERDICT_LAPSED', 'versions[v1].verdicts[0]'],
    ['REOPEN_VERDICT_LAPSED', 'versions[v2].verdicts[0]'],
  ]);
  for (const warning of warnings) {
    for (const retired of Object.keys(RETIRED_NUMBERED_COMMANDS)) {
      expect(warning.message).not.toContain(`rig-create ${retired}`);
    }
    expect(warning.message).not.toContain('--from-review');
    expect(warning.message).not.toContain('--draft');
    expect(warning.message).not.toContain('--version');
    if (warning.code === 'REOPEN_SIGNOFF_LAPSED') expect(warning.message).toContain('--owner-chat');
    else expect(warning.message).toContain('read-only');
  }
});

test('#1122 reopen-lapse and signoff-target remedies never offer --adopt or record post', () => {
  const dir = root();
  const reopenedProject: JsonObject = {
    schema: 'rig-create/project@0',
    stage: 'parts',
    signoffs: [
      { stage: 'parts', checkpoint: 'seethrough', by: 'owner', at: '2026-11-10T00:00:00.000Z', verbatim: 'ok' },
      { stage: 'parts-review', checkpoint: null, by: 'owner', at: '2026-11-10T00:01:00.000Z', verbatim: 'ok' },
      { stage: 'rig-review', checkpoint: null, by: 'owner', at: '2026-11-10T00:02:00.000Z', verbatim: 'ok' },
      { stage: 'direction-review', checkpoint: null, by: 'owner', at: '2026-11-10T00:03:00.000Z', verbatim: 'ok' },
    ],
    versions: [
      { n: 1, kind: 'rig', at: '2026-11-10T00:01:30.000Z', verdicts: [{ by: 'owner', at: '2026-11-10T00:01:45.000Z', review: 'rig-review', verdict: 'accepted', verbatim: 'ok' }] },
      { n: 2, kind: 'post', rig_version: 1, at: '2026-11-10T00:02:30.000Z', verdicts: [{ by: 'owner', at: '2026-11-10T00:02:45.000Z', review: 'direction-review', verdict: 'accepted', verbatim: 'ok' }] },
    ],
    reopens: [
      { stage: 'parts', from_stage: 'accepted', by: 'owner', at: '2026-11-11T00:00:00.000Z', verbatim: 'reopen', steps_before: [] },
    ],
  };

  const reopenFindings = reopenLapseWarnings(reopenedProject);
  expect(reopenFindings.map((f) => f.code)).toEqual([
    'REOPEN_SIGNOFF_LAPSED',
    'REOPEN_SIGNOFF_LAPSED',
    'REOPEN_SIGNOFF_LAPSED',
    'REOPEN_SIGNOFF_LAPSED',
    'REOPEN_VERDICT_LAPSED',
    'REOPEN_VERDICT_LAPSED',
  ]);
  for (const finding of reopenFindings) {
    expect(finding.code).toMatch(/^REOPEN_(?:SIGNOFF|VERDICT)_LAPSED$/);
    expect(finding.message).not.toContain('--adopt');
    expect(finding.message).not.toContain('record post');
  }

  writeFileSync(join(dir, 'project.json'), `${JSON.stringify(reopenedProject, null, 2)}\n`);
  writeFileSync(join(dir, 'words.txt'), 'Owner approval words.\n');

  let handoffRefusal: Refusal | undefined;
  try { handoff(dir, null, Date.parse('2026-11-12T00:00:00.000Z')); }
  catch (error) { handoffRefusal = error as Refusal; }
  expect(handoffRefusal?.code).toBe('RIG_VERSION_UNACCEPTED');
  expect(handoffRefusal?.message).not.toContain('--adopt');
  expect(handoffRefusal?.message).not.toContain('record post');

  for (const stage of ['parts-review', 'rig-review', 'direction-review'] as const) {
    let numberedSignoffRefusal: Refusal | undefined;
    try { signoffCommand([stage, dir, '--by', 'owner', '--verbatim-file', join(dir, 'words.txt')], Date.parse('2026-11-12T00:00:00.000Z')); }
    catch (error) { numberedSignoffRefusal = error as Refusal; }
    expect(numberedSignoffRefusal?.code).toBe(NUMBERED_WRITER_REMOVED);
    expect(numberedSignoffRefusal?.message).not.toContain('--adopt');
    expect(numberedSignoffRefusal?.message).not.toContain('record post');
  }

  const targetFindings: Finding[] = [];
  for (const stage of ['rig-review', 'direction-review'] as const) {
    // checkSignoffTarget: numbered missing/stale (current & legacy) + current missing/stale
    const targetCases: [JsonObject, JsonObject][] = [
      [{ versions: [] }, { stage, at: SIGNOFF_TARGET_SINCE }],
      [{ versions: [] }, { stage, at: SIGNOFF_TARGET_SINCE, target: { version: 99, verdict: 'versions[0].verdicts[0]' } }],
      [{ versions: [] }, { stage, at: '2026-11-01T00:00:00.000Z' }],
      [{ versions: [] }, { stage, at: '2026-11-01T00:00:00.000Z', target: { version: 99, verdict: 'versions[0].verdicts[0]' } }],
      [{ current: {} }, { stage, at: SIGNOFF_TARGET_SINCE }],
      [{ current: {} }, { stage, at: SIGNOFF_TARGET_SINCE, target: {} }],
    ];
    for (const [project, signoff] of targetCases) {
      checkSignoffTarget(dir, project, signoff, 'signoffs[0]', targetFindings, targetFindings);
    }

    // selectSignoffTarget: numbered stale, current adopted missing, current missing-node stale
    const selectCases: [JsonObject, string][] = [
      [{ versions: [] }, 'SIGNOFF_TARGET_STALE'],
      [{ current: { rig: { adopted: { version: 1 } }, direction: { adopted: { version: 2 } } } }, 'SIGNOFF_TARGET_MISSING'],
      [{ current: {} }, 'SIGNOFF_TARGET_STALE'],
    ];
    for (const [project, expectedCode] of selectCases) {
      let caught: Refusal | undefined;
      try { selectSignoffTarget(dir, project, stage); }
      catch (error) { caught = error as Refusal; }
      expect(caught?.code).toBe(expectedCode);
      expect(caught?.message).not.toContain('--adopt');
      expect(caught?.message).not.toContain('record post');
    }
  }
  checkSignoffTarget(dir, { current: {} }, { stage: 'parts-review', at: SIGNOFF_TARGET_SINCE, target: { subject: 'current.parts' } }, 'signoffs[0]', targetFindings, targetFindings);

  expect(targetFindings.length).toBe(13);
  for (const finding of targetFindings) {
    expect(finding.code).toMatch(/^SIGNOFF_TARGET_(?:MISSING|STALE)(?:_LEGACY)?$/);
    expect(finding.message).not.toContain('--adopt');
    expect(finding.message).not.toContain('record post');
  }
});

const retiredReview5Phrases = [
  'sign it again in Review',
  'accept and sign the intended version in Review',
  'record an approval of the corrected draft in Review',
  'publish and sign the current stage in Review',
  'ask for it in Review',
  'in the Review tool',
  'select it through the Review',
  'have the owner pick from the registered set',
  'query the labelled draft with rig-review parts',
  'review the labelled draft',
  'record a separate approval',
  'review a new draft id',
  'review the amended draft',
];

function expectNoRetiredReview5Control(message: string): void {
  for (const phrase of retiredReview5Phrases) {
    expect(message).not.toContain(phrase);
  }
}

test('#1157 SIGNOFF_PAIR_MISMATCH and _LEGACY remedies name historical status and check exits 0', () => {
  const dir = realpathSync(root());
  cpSync(join(import.meta.dir, '../templates/example-chain/checkpoints/4-direction-post'), dir, { recursive: true });
  const projectPath = join(dir, 'project.json');
  const cleanBytes = readFileSync(projectPath);

  // Build pre-cutoff legacy pair mismatch: signoff predates verdict without same-publication pair.
  const legacyProject = JSON.parse(cleanBytes.toString('utf8')) as JsonObject;
  const rigSignoff = (legacyProject.signoffs as JsonObject[]).find(s => s.stage === 'rig-review')!;
  const targetVerdict = /^versions\[(\d+)\]\.verdicts\[(\d+)\]$/.exec(String((rigSignoff.target as JsonObject).verdict))!;
  const version = (legacyProject.versions as JsonObject[])[Number(targetVerdict[1])]!;
  const verdict = (version.verdicts as JsonObject[])[Number(targetVerdict[2])]!;
  rigSignoff.at = '2026-11-12T00:00:00Z';
  rigSignoff.source = 'owner chat, relayed';
  verdict.at = '2026-11-12T00:05:00Z';

  const legacyFinding = signoffPairFinding(legacyProject, rigSignoff, 'signoffs[0]');
  expect(legacyFinding).toMatchObject({
    code: 'SIGNOFF_PAIR_MISMATCH_LEGACY',
    path: 'signoffs[0].target.verdict',
  });
  expect(legacyFinding!.message).toContain('this is a historical record; nothing to do');
  expectNoRetiredReview5Control(legacyFinding!.message);

  // Post-cutoff pair mismatch refuses until original matching records are restored.
  rigSignoff.at = SIGNOFF_PAIR_SINCE;
  verdict.at = '2026-11-13T00:05:00Z';
  writeFileSync(projectPath, `${JSON.stringify(legacyProject, null, 2)}\n`);
  const failedCheck = interviewCommand(['--check', dir, '--json'], EXAMPLE_NOW + 60_000);
  expect(failedCheck.exit).toBe(1);
  const failedReport = JSON.parse(failedCheck.stdout) as { refusals: Finding[] };
  const mismatch = failedReport.refusals.find(f => f.code === 'SIGNOFF_PAIR_MISMATCH')!;
  expect(mismatch).toBeDefined();
  expect(mismatch.message).toContain('numbered verdicts and signoffs are historical — restore the original matching signoff and verdict records');
  expectNoRetiredReview5Control(mismatch.message);

  // Remedy action: restore the original matching signoff and verdict records, then check exits 0.
  writeFileSync(projectPath, cleanBytes);
  const restoredCheck = interviewCommand(['--check', dir, '--json'], EXAMPLE_NOW + 60_000);
  expect(restoredCheck.exit).toBe(0);
});

test('#1157 PARTS_VERDICT_NOT_APPROVED, PARTS_REVIEW_CLI_INVALID, and STRUCTURE_DECISIONS_INVALID remedies work without retired Review controls', () => {
  const dir = realpathSync(root());
  cpSync(join(import.meta.dir, '../templates/example-chain/checkpoints/4-direction-post'), dir, { recursive: true });
  const projectPath = join(dir, 'project.json');
  const cleanBytes = readFileSync(projectPath);
  const cleanProject = JSON.parse(cleanBytes.toString('utf8')) as JsonObject;

  const unapprovedAct = {
    schema: 'rig-review/act@2',
    kind: 'parts-verdict',
    jobId: 'synthetic-job',
    actId: 'synthetic-parts-act',
    askId: 'synthetic-ask',
    publicationId: 'synthetic-pub',
    at: '2026-11-10T00:00:00Z',
    authority: { actor: 'human', channel: 'review-ui', reviewer: { id: 'owner', role: 'owner' } },
    source: {
      sourceHash: '1'.repeat(64),
      projectHash: '2'.repeat(64),
      package: { id: 'create-draft-chain', revision: 'rev' },
      selector: { kind: 'draft', id: 'chain' },
      model: null,
      direction: null,
      optionSet: null,
      appliedResult: null,
      plan: null,
      parts: { enumeratorVersion: '2.34.0', manifest: { path: 'derived/drafts/chain/input/parts.json', sha256: '3'.repeat(64) }, images: [] },
    },
    value: { verdict: 'changes-requested', words: 'Adjust part edge.', parts: [{ partId: 'body', outcome: 'flagged', note: 'fix' }] },
  } as unknown as PartsVerdictAct;
  let carryErr: Refusal | undefined;
  try {
    partsCarryAmendment(cleanProject, 'chain', unapprovedAct, {}, Date.now());
  } catch (error) {
    carryErr = error as Refusal;
  }
  expect(carryErr?.code).toBe('PARTS_VERDICT_NOT_APPROVED');
  expect(carryErr?.message).toContain('numbered parts verdicts are historical — restore the approved parts-verdict receipt on the historical signoff');
  expectNoRetiredReview5Control(carryErr!.message);

  // Retained parts-verdict receipt with status=changes-requested raises PARTS_VERDICT_NOT_APPROVED; restoring approved receipt exits 0.
  const tamperedCliProj = JSON.parse(cleanBytes.toString('utf8')) as JsonObject;
  const partFiles = (((tamperedCliProj.drafts as JsonObject[])[0]!.parts as JsonObject).files as JsonObject[]).map(f => ({
    path: 'opaque/frame',
    sha256: String(f.sha256),
  }));
  const unapprovedCliPayload = Buffer.from(JSON.stringify({
    schema: 'rig-review-parts-verdict/2',
    status: 'changes-requested',
    tool: { name: '@rig-c/review', version: '4.24.0' },
    source: { sha256: 'a'.repeat(64), files: partFiles },
    parts: { 'synthetic part': { outcome: 'flagged', note: 'fix' } },
  }));
  const storedRead = storeReviewRead(dir, unapprovedCliPayload);
  (tamperedCliProj.review_acts as JsonObject[]).push({
    schema: PARTS_CLI_RECEIPT,
    kind: 'parts-verdict',
    route: 'cli',
    draft_id: 'chain',
    argv: ['opaque/input', '--verdict', 'never-created.json'],
    evidence: { path: storedRead.file.path, sha256: storedRead.file.sha256 },
    tool: { name: '@rig-c/review', version: '4.24.0' },
    status: 'changes-requested',
    flagged: ['synthetic part'],
    noted: ['synthetic part'],
    by: 'user',
    at: new Date(EXAMPLE_NOW).toISOString(),
  });
  const unapprovedFinding = recordedPartsFinding(dir, tamperedCliProj, {
    stage: 'parts-review',
    draft_id: 'chain',
    at: new Date(EXAMPLE_NOW).toISOString(),
    evidence: { kind: 'parts-verdict', path: storedRead.file.path, sha256: storedRead.file.sha256, spec: PARTS_CLI_RECEIPT },
  }, 'signoffs[0]');
  expect(unapprovedFinding?.code).toBe('PARTS_VERDICT_NOT_APPROVED');
  expect(unapprovedFinding?.message).toContain('numbered parts verdicts are historical — restore the retained parts-verdict receipt and response');
  expectNoRetiredReview5Control(unapprovedFinding!.message);
  rmSync(join(dir, storedRead.file.path), { force: true });

  let cliErr: Refusal | undefined;
  try { decodePartsRead(Buffer.from('not-json')); }
  catch (error) { cliErr = error as Refusal; }
  expect(cliErr?.code).toBe('PARTS_REVIEW_CLI_INVALID');
  expect(cliErr?.message).toContain('numbered parts verdicts are historical — restore the retained parts-verdict receipt and response');
  expectNoRetiredReview5Control(cliErr!.message);

  let actInvalidErr: Refusal | undefined;
  try { checkPartsActEvidence(dir, Buffer.from(JSON.stringify(unapprovedAct)), jobHash(JSON.stringify(unapprovedAct)), cleanProject); }
  catch (error) { actInvalidErr = error as Refusal; }
  expect(actInvalidErr?.code).toBe('REVIEW_ACT_INVALID');
  expect(actInvalidErr?.message).toContain('restore the original act evidence, or submit a new comment in the live Review job');
  expectNoRetiredReview5Control(actInvalidErr!.message);

  // Structure snapshot invalid on historical draft -> remedy points to restore or current.parts; restoring checks at exit 0.
  const structErrors: Finding[] = [];
  const badSignoff = { stage: 'parts-review', draft_id: 'chain', structure: { path: 'project.json', sha256: jobHash(cleanBytes) } };
  checkStructure(dir, cleanProject, badSignoff, 'signoffs[0]', structErrors);
  expect(structErrors[0]?.code).toBe('STRUCTURE_DECISIONS_INVALID');
  expect(structErrors[0]?.message).toContain('numbered draft structure snapshots are historical');
  expectNoRetiredReview5Control(structErrors[0]!.message);

  const draftCfgPath = join(dir, String(((cleanProject.drafts as JsonObject[])[0]!.config as JsonObject).path));
  const cleanDraftCfg = readFileSync(draftCfgPath);
  const badCfg = { ...(JSON.parse(cleanDraftCfg.toString('utf8')) as JsonObject), meshes: 'invalid' };
  writeFileSync(draftCfgPath, `${JSON.stringify(badCfg, null, 2)}\n`);
  const tamperedProj = JSON.parse(cleanBytes.toString('utf8')) as JsonObject;
  ((tamperedProj.drafts as JsonObject[])[0]!.config as JsonObject).sha256 = sha256(readFileSync(draftCfgPath));
  writeFileSync(projectPath, `${JSON.stringify(tamperedProj, null, 2)}\n`);
  let snapErr: Refusal | undefined;
  try { structureSnapshotCommand([dir, '--draft', 'chain', '--out', 'evidence/structure-chain-1.json']); }
  catch (error) { snapErr = error as Refusal; }
  expect(snapErr?.code).toBe('STRUCTURE_DECISIONS_INVALID');
  expectNoRetiredReview5Control(snapErr!.message);

  writeFileSync(draftCfgPath, cleanDraftCfg);
  writeFileSync(projectPath, cleanBytes);
  expect(interviewCommand(['--check', dir, '--json'], EXAMPLE_NOW + 60_000).exit).toBe(0);
});

test('#1157 REVIEW_ACT_TARGET_MISMATCH, REVIEW_ACT_SUBJECT_UNDECLARED, INTERVIEW_REASK_PENDING and SIGNOFF_REASK_PENDING remedies resolve with exit 0 via owner-chat writers', () => {
  const dir = realpathSync(root());
  cpSync(join(import.meta.dir, '../templates/example-current'), dir, { recursive: true });
  const now = EXAMPLE_ANCHOR + 120_000;
  const read = (): JsonObject => JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;

  // 1. REVIEW_ACT_TARGET_MISMATCH on assertInterviewRecordSignable -> signoff --owner-chat exits 0.
  let targetErr: Refusal | undefined;
  try {
    assertInterviewRecordSignable(read(), checkProject(dir, undefined, { now }));
  } catch (error) {
    targetErr = error as Refusal;
  }
  expect(targetErr?.code).toBe('REVIEW_ACT_TARGET_MISMATCH');
  expect(targetErr?.message).toContain('relay any owner chat sign-off for the current stage with rig-create signoff <stage>');
  expectNoRetiredReview5Control(targetErr!.message);

  const wordsFile = join(dir, 'owner-words.txt');
  writeFileSync(wordsFile, 'Looks great in chat.\n');
  const signRes = signoffCommand([
    'direction-review', dir, '--by', 'owner', '--owner-chat', wordsFile,
    '--said-at', new Date(now).toISOString(), '--relayed-by', 'example-agent',
  ], now + 1000);
  expect(signRes.exit).toBe(0);

  // 2. REVIEW_ACT_SUBJECT_UNDECLARED on assertActSubjectDeclared -> interview-answer --owner-chat exits 0.
  const identity = currentJobIdentity({ root: dir, stateDir: join(dir, 'state'), fingerprint: 'synthetic', reviewer: { id: 'owner', role: 'owner' } }, dir);
  acknowledgePublication({
    schema: 'rig-create/job-pending@1', root: dir, jobId: 'job-1', origin: 'http://127.0.0.1:43123',
    id: 'intent-1', identity, recordHash: '1'.repeat(64), versionHash: '1'.repeat(64),
    result: { kind: 'plan' }, failure: null,
  }, 'pub-1', 1, 'req-1', []);
  const undeclaredAct = {
    kind: 'interview-picks', jobId: 'job-1', actId: 'act-1', publicationId: 'pub-1',
    source: { optionSet: { id: 'reask-camera-depth', sha256: '2'.repeat(64) } },
    value: { questionId: 'camera_depth' },
  } as unknown as InterviewPicksAct;
  let undeclaredErr: Refusal | undefined;
  try {
    assertActSubjectDeclared(dir, undeclaredAct, 'interview.post.items[camera_depth]');
  } catch (error) {
    undeclaredErr = error as Refusal;
  }
  expect(undeclaredErr?.code).toBe('REVIEW_ACT_SUBJECT_UNDECLARED');
  expect(undeclaredErr?.message).toContain('relay owner choices with rig-create interview-answer --owner-chat');
  expectNoRetiredReview5Control(undeclaredErr!.message);

  // 3. Register a pending re-ask at post-interview -> raises INTERVIEW_REASK_PENDING and SIGNOFF_REASK_PENDING -> resolve via interview-answer --owner-chat + signoff --owner-chat (both exit 0).
  const p = read();
  p.stage = 'post-interview';
  writeFileSync(join(dir, 'project.json'), `${JSON.stringify(p, null, 2)}\n`);
  const setRel = 'evidence/interview/reask-camera.json';
  const existingItem = collectItems(read(), { collection: null }).find(item => item.id === 'camera_depth')!;
  const existingFragment = (existingItem.raw as JsonObject).value;
  const setBytes = `${JSON.stringify({
    schema: OPTIONS_SPEC, id: 'reask-camera-depth', question: 'camera_depth', stage: 'post-interview',
    drafted_by: 'agent', drafted_at: new Date(now + 2000).toISOString(),
    context: optionContext(read(), 'post-interview', now + 2000, dir),
    assembly: { rule: 'single' },
    asks: [{ id: 'camera_depth', prompt: 'Confirm camera framing.', options: [
      { id: 'keep', kind: 'value', label: 'Keep framing', effect: 'Keep current framing.', fragment: existingFragment, recommended: true, reason: 'Matches scene.' },
      { id: 'alt', kind: 'value', label: 'Tighter framing', effect: 'Crop slightly.', fragment: existingFragment, recommended: false },
      { id: 'other', kind: 'other', label: 'Other', effect: 'Custom framing.', recommended: false },
      { id: 'auto', kind: 'auto', label: 'Delegate', effect: 'Ask the agent to decide.', recommended: false },
    ] }],
  }, null, 2)}\n`;
  writeFileSync(join(dir, setRel), setBytes);
  expect(main(['interview-options', 'camera_depth', dir, '--file', setRel], now + 2000)).toBe(0);

  const reaskReport = checkProject(dir, undefined, { now: now + 3000 });
  const reaskWarn = reaskReport.warnings.find(w => w.code === 'INTERVIEW_REASK_PENDING')!;
  expect(reaskWarn).toBeDefined();
  expect(reaskWarn.message).toContain('relay the pick with rig-create interview-answer camera_depth --owner-chat');
  expectNoRetiredReview5Control(reaskWarn.message);

  let signReaskErr: Refusal | undefined;
  try {
    signoffCommand(['post-interview', dir, '--by', 'owner', '--owner-chat', wordsFile,
      '--said-at', new Date(now + 3000).toISOString(), '--relayed-by', 'example-agent'], now + 3000);
  } catch (error) {
    signReaskErr = error as Refusal;
  }
  expect(signReaskErr?.code).toBe('SIGNOFF_REASK_PENDING');
  expect(signReaskErr?.message).toContain('relay the owner\'s pick with rig-create interview-answer camera_depth --owner-chat before signing');
  expectNoRetiredReview5Control(signReaskErr!.message);

  // Run the named remedies: interview-answer --owner-chat (exit 0), then signoff --owner-chat (exit 0).
  writeFileSync(wordsFile, 'Keep the framing.\n');
  const ansExit = main([
    'interview-answer', 'camera_depth', dir, '--set', setRel, '--sha256', sha256(Buffer.from(setBytes)),
    '--pick', 'camera_depth=keep', '--by', 'owner', '--owner-chat', wordsFile,
    '--said-at', new Date(now + 4000).toISOString(), '--relayed-by', 'example-agent',
  ], now + 4000);
  expect(ansExit).toBe(0);

  const signPostExit = main([
    'signoff', 'post-interview', dir, '--by', 'owner', '--owner-chat', wordsFile,
    '--said-at', new Date(now + 5000).toISOString(), '--relayed-by', 'example-agent',
  ], now + 5000);
  expect(signPostExit).toBe(0);
  expect(checkProject(dir, undefined, { now: now + 6000 }).warnings.filter(w => w.code === 'INTERVIEW_REASK_PENDING')).toEqual([]);
});

test('#1157 scene, compose, and discarded/record-target remedies name current CLI routes and succeed with exit 0', () => {
  const dir = realpathSync(root());
  cpSync(join(import.meta.dir, '../templates/example-current'), dir, { recursive: true });
  const now = EXAMPLE_ANCHOR + 180_000;
  const load = (): JsonObject => JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
  const save = (p: JsonObject): void => writeFileSync(join(dir, 'project.json'), `${JSON.stringify(p, null, 2)}\n`);

  const bgPath = 'inputs/painting.png';
  const fgPath = 'inputs/fg.png';
  const pngBytes = readFileSync(join(dir, bgPath));
  const dims = pngDimensions(pngBytes, bgPath);
  const stageRect = { x: 0, y: 0, width: dims.width, height: dims.height };
  writeFileSync(join(dir, fgPath), Buffer.concat([pngBytes, Buffer.from('\n')]));
  expect(main(['input', 'add', fgPath, dir, '--origin', 'Synthetic foreground'], now)).toBe(0);

  // 1. SCENE_AUTHOR_TYPED -> omit --by and run scene write (exit 0).
  let typedErr: Error | undefined;
  try {
    sceneCommand(['write', dir, '--compose-scene', 'specs/direction/compose-scene.json', '--by', 'owner']);
  } catch (error) {
    typedErr = error as Error;
  }
  expect((typedErr as { code?: string })?.code).toBe('SCENE_AUTHOR_TYPED');
  expect(typedErr?.message).toContain('omit --by and cite the current recorded post_composition choice');
  expectNoRetiredReview5Control(typedErr!.message);
  expect(sceneCommand(['write', dir, '--compose-scene', 'specs/direction/compose-scene.json']).exit).toBe(0);

  // 2. SCENE_CHOICE_MISMATCH -> match cited post_composition choice and run scene write (exit 0).
  const pBefore = load();
  pBefore.stage = 'post-interview';
  save(pBefore);
  const singleSetRel = 'evidence/interview/post-single.json';
  const singleSetBytes = `${JSON.stringify({
    schema: OPTIONS_SPEC, id: 'post-single', question: 'post_composition', stage: 'post-interview',
    drafted_by: 'agent', drafted_at: new Date(now + 1000).toISOString(),
    context: optionContext(load(), 'post-interview', now + 1000, dir),
    assembly: { rule: 'single' },
    asks: [{ id: 'post_composition', prompt: 'Choose scene plates.', options: [
      { id: 'bg-only', kind: 'value', label: 'Background only', effect: 'Use background only.',
        fragment: { scene: { background: { path: bgPath, rect: stageRect } } }, recommended: true, reason: 'Clean.' },
      { id: 'with-fg', kind: 'value', label: 'Background and foreground', effect: 'Include foreground.',
        fragment: { scene: { background: { path: bgPath, rect: stageRect }, foreground: { path: fgPath, rect: stageRect } } }, recommended: false },
      { id: 'other', kind: 'other', label: 'Other', effect: 'Custom.', recommended: false },
      { id: 'auto', kind: 'auto', label: 'Delegate', effect: 'Ask the agent.', recommended: false },
    ] }],
  }, null, 2)}\n`;
  writeFileSync(join(dir, singleSetRel), singleSetBytes);
  const wordsPath = join(dir, 'scene-words.txt');
  writeFileSync(wordsPath, 'Background only first.\n');
  expect(main(['interview-options', 'post_composition', dir, '--file', singleSetRel], now + 1000)).toBe(0);
  expect(main([
    'interview-answer', 'post_composition', dir, '--set', singleSetRel, '--sha256', sha256(Buffer.from(singleSetBytes)),
    '--pick', 'post_composition=bg-only', '--by', 'owner', '--owner-chat', wordsPath,
    '--said-at', new Date(now + 2000).toISOString(), '--relayed-by', 'example-agent',
  ], now + 2000)).toBe(0);
  const ansQuote = String((collectItems(load(), { collection: null }).find(i => i.id === 'post_composition')!.raw as JsonObject).verbatim);
  const citeFile = 'evidence/mismatch-citations.json';
  writeFileSync(join(dir, citeFile), JSON.stringify({
    background: { guide: 'post_composition', asks: ['post_composition'], quote: ansQuote },
    foreground: { guide: 'post_composition', asks: ['post_composition'], quote: ansQuote },
  }));
  let mismatchErr: Error | undefined;
  try {
    sceneCommand(['write', dir, '--background', bgPath, '--foreground', fgPath, '--citations-file', citeFile]);
  } catch (error) {
    mismatchErr = error as Error;
  }
  expect((mismatchErr as { code?: string })?.code).toBe('SCENE_CHOICE_MISMATCH');
  expect(mismatchErr?.message).toContain('rig-create interview-answer post_composition --owner-chat');
  expectNoRetiredReview5Control(mismatchErr!.message);

  // Follow the remedy: match the cited choice (background only) and run scene write -> exit 0.
  writeFileSync(join(dir, 'evidence/matched-citation.json'), JSON.stringify({
    background: { guide: 'post_composition', asks: ['post_composition'], quote: ansQuote },
  }));
  expect(main(['scene', 'write', dir, '--background', bgPath, '--citations-file', 'evidence/matched-citation.json'], now + 3000)).toBe(0);

  // 3. SCENE_INPUT_RECEIPT_MISSING -> input add + interview-options + interview-answer --owner-chat + scene write -> exit 0.
  const legacyPlate = 'inputs/legacy-bg.png';
  const legacyBytes = Buffer.concat([pngBytes, Buffer.from('legacy')]);
  writeFileSync(join(dir, legacyPlate), legacyBytes);
  const pLegacy = load();
  (pLegacy.inputs as JsonObject[]).push({ path: legacyPlate, sha256: sha256(legacyBytes) });
  save(pLegacy);
  const legacySetRel = 'evidence/interview/post-legacy.json';
  const legacySetBytes = `${JSON.stringify({
    schema: OPTIONS_SPEC, id: 'post-legacy', question: 'post_composition', stage: 'post-interview',
    drafted_by: 'agent', drafted_at: new Date(now + 4000).toISOString(),
    context: optionContext(load(), 'post-interview', now + 4000, dir),
    assembly: { rule: 'single' },
    asks: [{ id: 'post_composition', prompt: 'Choose legacy bg.', options: [
      { id: 'legacy', kind: 'value', label: 'Legacy plate', effect: 'Use legacy.',
        fragment: { scene: { background: { path: legacyPlate, rect: stageRect } } }, recommended: true, reason: 'Test.' },
      { id: 'std', kind: 'value', label: 'Standard plate', effect: 'Use standard.',
        fragment: { scene: { background: { path: bgPath, rect: stageRect } } }, recommended: false },
      { id: 'other', kind: 'other', label: 'Other', effect: 'Custom.', recommended: false },
      { id: 'auto', kind: 'auto', label: 'Delegate', effect: 'Ask the agent.', recommended: false },
    ] }],
  }, null, 2)}\n`;
  writeFileSync(join(dir, legacySetRel), legacySetBytes);
  expect(main(['interview-options', 'post_composition', dir, '--file', legacySetRel], now + 4000)).toBe(0);
  expect(main([
    'interview-answer', 'post_composition', dir, '--set', legacySetRel, '--sha256', sha256(Buffer.from(legacySetBytes)),
    '--pick', 'post_composition=legacy', '--by', 'owner', '--owner-chat', wordsPath,
    '--said-at', new Date(now + 5000).toISOString(), '--relayed-by', 'example-agent',
  ], now + 5000)).toBe(0);
  const legacyQuote = String((collectItems(load(), { collection: null }).find(i => i.id === 'post_composition')!.raw as JsonObject).verbatim);
  writeFileSync(join(dir, 'evidence/legacy-cite.json'), JSON.stringify({ background: { guide: 'post_composition', asks: ['post_composition'], quote: legacyQuote } }));
  let receiptErr: Error | undefined;
  try {
    sceneCommand(['write', dir, '--background', legacyPlate, '--citations-file', 'evidence/legacy-cite.json']);
  } catch (error) {
    receiptErr = error as Error;
  }
  expect((receiptErr as { code?: string })?.code).toBe('SCENE_INPUT_RECEIPT_MISSING');
  expect(receiptErr?.message).toContain('rig-create input add <path> --origin');
  expect(receiptErr?.message).toContain('rig-create interview-answer post_composition --owner-chat');
  expectNoRetiredReview5Control(receiptErr!.message);

  // Remove unreceipted legacy entry, register a fresh plate via input add, relay new choice via interview-answer --owner-chat, and run scene write -> exit 0.
  const pCleanInputs = load();
  pCleanInputs.inputs = (pCleanInputs.inputs as JsonObject[]).filter(entry => entry.path !== legacyPlate);
  save(pCleanInputs);
  const distinctRel = 'inputs/distinct-bg.png';
  writeFileSync(join(dir, distinctRel), Buffer.concat([pngBytes, Buffer.from('distinct')]));
  expect(main(['input', 'add', distinctRel, dir, '--origin', 'Synthetic fresh background'], now + 6000)).toBe(0);
  const freshSetRel = 'evidence/interview/post-fresh.json';
  const freshSetBytes = `${JSON.stringify({
    schema: OPTIONS_SPEC, id: 'post-fresh', question: 'post_composition', stage: 'post-interview',
    drafted_by: 'agent', drafted_at: new Date(now + 7000).toISOString(),
    context: optionContext(load(), 'post-interview', now + 7000, dir),
    assembly: { rule: 'single' },
    asks: [{ id: 'post_composition', prompt: 'Choose fresh bg.', options: [
      { id: 'fresh', kind: 'value', label: 'Fresh plate', effect: 'Use fresh.',
        fragment: { scene: { background: { path: 'inputs/distinct-bg.png', rect: stageRect } } }, recommended: true, reason: 'Receipted.' },
      { id: 'std', kind: 'value', label: 'Standard plate', effect: 'Use standard.',
        fragment: { scene: { background: { path: bgPath, rect: stageRect } } }, recommended: false },
      { id: 'other', kind: 'other', label: 'Other', effect: 'Custom.', recommended: false },
      { id: 'auto', kind: 'auto', label: 'Delegate', effect: 'Ask the agent.', recommended: false },
    ] }],
  }, null, 2)}\n`;
  writeFileSync(join(dir, freshSetRel), freshSetBytes);
  expect(main(['interview-options', 'post_composition', dir, '--file', freshSetRel], now + 7000)).toBe(0);
  expect(main([
    'interview-answer', 'post_composition', dir, '--set', freshSetRel, '--sha256', sha256(Buffer.from(freshSetBytes)),
    '--pick', 'post_composition=fresh', '--by', 'owner', '--owner-chat', wordsPath,
    '--said-at', new Date(now + 8000).toISOString(), '--relayed-by', 'example-agent',
  ], now + 8000)).toBe(0);
  const freshQuote = String((collectItems(load(), { collection: null }).find(i => i.id === 'post_composition')!.raw as JsonObject).verbatim);
  writeFileSync(join(dir, 'evidence/fresh-cite.json'), JSON.stringify({ background: { guide: 'post_composition', asks: ['post_composition'], quote: freshQuote } }));
  expect(main(['scene', 'write', dir, '--background', 'inputs/distinct-bg.png', '--citations-file', 'evidence/fresh-cite.json'], now + 9000)).toBe(0);

  // 4. COMPOSE_VALUE_INVALID, REVIEW_ACT_RECORD_TARGET_INVALID, and REVIEW_ACT_DISCARDED remedies carry no retired Review 5.x control text.
  let composeErr: ComposeValueError | undefined;
  try { composeFail('interview.post.items[post_composition].value.compose', 'invalid canvas'); }
  catch (error) { composeErr = error as ComposeValueError; }
  expect(composeErr?.code).toBe(COMPOSE_VALUE_INVALID);
  expect(composeErr?.message).toContain('rig-create interview-answer post_composition --owner-chat');
  expectNoRetiredReview5Control(composeErr!.message);

  let recordTargetErr: Refusal | undefined;
  try { requireRecordDirectionTarget({ versions: [] }); }
  catch (error) { recordTargetErr = error as Refusal; }
  expect(recordTargetErr?.code).toBe('REVIEW_ACT_RECORD_TARGET_INVALID');
  expect(recordTargetErr?.message).toContain('numbered direction sign-offs are historical');
  expectNoRetiredReview5Control(recordTargetErr!.message);

  const discardDir = root();
  writeFileSync(join(discardDir, 'project.json'), JSON.stringify({
    review_acts: [{ schema: 'rig-create/review-act@1', kind: 'discarded', jobId: 'j1', actId: 'discarded-1', at: '2026-11-20T00:00:00Z', by: 'agent', reason: 'stale' }],
  }));
  let discardErr: Refusal | undefined;
  try { reviewActTransport(discardDir, 'discarded-1'); }
  catch (error) { discardErr = error as Refusal; }
  expect(discardErr?.code).toBe('REVIEW_ACT_DISCARDED');
  expect(discardErr?.message).toContain('submit a fresh comment in Review');
  expectNoRetiredReview5Control(discardErr!.message);
});
