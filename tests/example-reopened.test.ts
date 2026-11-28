import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { collectSignoffs } from '../src/check.ts';
import { validateCorrectionIdentity } from '../src/corrections.ts';
import { collectReopens, liveSignoff } from '../src/reopen.ts';
import { stageIndex } from '../src/stages.ts';
import type { JsonObject } from '../src/templates.ts';
import { correctionFixture } from './correction-fixture.ts';
import { arr, fixture, obj, PARTS_REVIEW_LAPSES, plantLegacyReopen } from './fixtures.ts';
import { tempDir } from './helpers.ts';
import { checkProject, correctionCommand, testClock } from './clock.ts';
import { seedRetainedDraft } from './numbered-seed.ts';

const roots: string[] = [];
function scratch(): string { const dir = tempDir(); roots.push(dir); return dir; }
const load = (dir: string): JsonObject => JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
const FROZEN_ANCHOR = Date.parse('2026-11-27T00:00:00Z');
const FROZEN_REOPEN_AT = '2026-11-27T00:01:07.000Z';
afterEach(() => { testClock.reset(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('reopened example retains history and supersedes exactly the parts-review suffix', () => {
  const plainDir = fixture(() => {}, 'example-numbered/example-project.json'); roots.push(join(plainDir, '..'));
  const dir = fixture(() => {}, 'example-numbered/example-project.json'); roots.push(join(dir, '..'));
  plantLegacyReopen(dir, 'parts-review', { by: 'user', at: FROZEN_REOPEN_AT });
  const plain = load(plainDir); const reopened = load(dir);
  expect(checkProject(plainDir)).toMatchObject({ refusals: [], warnings: [] });
  expect(checkProject(dir)).toMatchObject({ refusals: [] });
  expect(checkProject(dir).warnings.map(f => [f.code, f.path])).toEqual(PARTS_REVIEW_LAPSES);
  const reopens = collectReopens(reopened, []);
  expect(reopens).toHaveLength(1);
  expect(reopened.stage).toBe('parts-review');
  expect(reopened.signoffs).toEqual(plain.signoffs);
  expect(obj(arr(reopened.reopens)[0])).toMatchObject({ by: 'user', at: FROZEN_REOPEN_AT, stage: 'parts-review', from_stage: plain.stage });
  expect(Date.parse(FROZEN_REOPEN_AT)).toBeGreaterThan(FROZEN_ANCHOR);
  expect(Date.parse(FROZEN_REOPEN_AT) - FROZEN_ANCHOR).toBeLessThanOrEqual(120_000);
  for (const signoff of collectSignoffs(reopened, [])) {
    const affected = stageIndex(signoff.stage) >= stageIndex('parts-review');
    expect(liveSignoff(reopens, signoff.stage, signoff.at)).toBe(!affected);
    if (affected) expect(Date.parse(FROZEN_REOPEN_AT)).toBeGreaterThan(signoff.at);
  }
  const changed = Object.keys(reopened).filter(key => JSON.stringify(reopened[key]) !== JSON.stringify(plain[key]));
  expect(changed.sort()).toEqual(['plan', 'reopens', 'stage']);
  expect({ ...reopened, stage: plain.stage, plan: plain.plan, reopens: undefined }).toEqual({ ...plain, stage: plain.stage, plan: plain.plan, reopens: undefined });
  const oldSteps = arr(obj(plain.plan).steps).map(obj);
  const newSteps = arr(obj(reopened.plan).steps).map(obj);
  expect(obj(reopened.plan)).toEqual({ ...obj(plain.plan), steps: newSteps });
  expect(obj(arr(reopened.reopens)[0]).steps_before).toEqual(oldSteps.filter(step => !['seethrough', 'assemble'].includes(String(step.id))).map(step => ({ id: step.id!, status: step.status! })));
  for (const [index, step] of newSteps.entries()) {
    expect({ ...step, status: oldSteps[index]!.status }).toEqual({ ...oldSteps[index]!, status: oldSteps[index]!.status });
    expect(step.status).toBe(['seethrough', 'assemble'].includes(String(step.id)) ? 'done' : 'pending');
  }
});

test('a parts-review made correction records and resolves against the reopened example draft', () => {
  const dir = fixture(() => {}, 'example-numbered/example-project.json'); roots.push(join(dir, '..'));
  plantLegacyReopen(dir, 'parts-review', { by: 'user', at: FROZEN_REOPEN_AT });
  const source = obj(arr(load(dir).drafts)[0]);
  // Reuse the synthetic consumer-shape Apply control. No producer measurement is claimed.
  const controlDir = scratch(); correctionFixture(controlDir, 'rig');
  const feedback = JSON.parse(readFileSync(join(controlDir, 'evidence/feedback.json'), 'utf8')) as JsonObject;
  const applied = obj(obj(obj(arr(feedback.feedback)[0]).context).applied);
  obj(applied.patch).config_sha256 = obj(source.config).sha256!;
  applied.configHash = obj(source.config).sha256!;
  const model = arr(source.files).map(obj).find(file => String(file.path).endsWith('/skeleton.model.json'))!;
  // Review writes handoff paths relative to the package it opened, the draft's check package.
  const PACKAGE = 'derived/drafts/example/out/check';
  feedback.reviewedSource = { rig: { path: model.path!, sha256: model.sha256! }, motion: null,
    handoff: { config: { path: posix.relative(PACKAGE, String(obj(source.config).path)), sha256: obj(source.config).sha256! }, files: [source.config!, ...arr(source.config_inputs), ...arr(obj(source.parts).files), ...arr(source.files)].map(obj).map(file => ({ path: posix.relative(PACKAGE, String(file.path)), sha256: file.sha256! })), missing: [] } };
  writeFileSync(join(dir, 'evidence/correction-session.json'), JSON.stringify(feedback));
  const at = Date.parse(FROZEN_REOPEN_AT);
  testClock.set(new Date(at + 1000));
  expect(correctionCommand(['record', dir, '--id', 'example-fix', '--path', 'made', '--stage', 'parts-review', '--by', 'user', '--draft', 'example', '--feedback-file', PACKAGE, '--item', 'synthetic-apply'],()=>({stdout:readFileSync(join(dir,'evidence/correction-session.json')),stderr:'',exitCode:0,tool:{name:'@rig-c/review',version:'2.5.0'}})).exit).toBe(0);
  const record = obj(arr(load(dir).corrections)[0]);
  expect(validateCorrectionIdentity(dir, load(dir), record.on, 'parts-review')).toEqual(obj(record.on));
  expect(checkProject(dir).warnings.map(finding => finding.code)).toEqual(['CORRECTION_OPEN', ...PARTS_REVIEW_LAPSES.map(([code]) => code)]);
  cpSync(join(dir, 'derived/drafts/example'), join(dir, 'derived/drafts/corrected'), { recursive: true });
  const modelBytes = readFileSync(join(controlDir, 'evidence/outcome.model.json'));
  writeFileSync(join(dir, String(model.path).replace('/example/', '/corrected/')), modelBytes);
  testClock.set(new Date(at + 2000));
  writeFileSync(join(dir, 'derived/drafts/corrected/input/recomposite_rig.png'), 'synthetic stack bytes');
  // The example's ledger has a live row, so the corrected draft binds the project's (synthetic) ledger report.
  const ledgerReport = JSON.parse(readFileSync(join(dir, 'evidence/fix-ledger/lantern.json'), 'utf8'));
  const manifest = readFileSync(join(dir, 'derived/drafts/corrected/input/parts.json'));
  ledgerReport.build = { dir: 'derived/drafts/corrected/out', manifest_sha256: createHash('sha256').update(manifest).digest('hex') };
  writeFileSync(join(dir, 'evidence/fix-ledger/corrected.json'), `${JSON.stringify(ledgerReport, null, 2)}\n`);
  seedRetainedDraft(['corrected', dir, '--config', 'derived/drafts/corrected/config.json', '--from', 'derived/drafts/corrected/out', '--parts', 'derived/drafts/corrected/input', '--ledger-report', 'evidence/fix-ledger/corrected.json'], testClock.now());
  writeFileSync(join(dir, 'reasoning.txt'), 'Declare the synthetic corrected draft.');
  testClock.set(new Date(at + 3000));
  expect(correctionCommand(['resolve', 'example-fix', dir, '--by', 'agent', '--reasoning-file', join(dir, 'reasoning.txt'), '--draft', 'corrected']).exit).toBe(0);
  const closed = obj(arr(load(dir).corrections)[0]);
  expect(validateCorrectionIdentity(dir, load(dir), closed.outcome, 'parts-review')).toEqual(obj(closed.outcome));
  expect(obj(closed.artifact).state).toBe('applied-and-checked');
  expect(checkProject(dir)).toMatchObject({ refusals: [] });
  expect(checkProject(dir).warnings.map(f => [f.code, f.path])).toEqual(PARTS_REVIEW_LAPSES);
});
