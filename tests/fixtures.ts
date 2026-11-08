import { isSignoffIdentity, matchesSignoff } from '../src/stage-progress.ts';
import { approvalStageOfStep, hasStageOrder, LEGACY_STAGES, STAGES, stageIndex, stageOfStep } from '../src/stages.ts';
import { expect } from 'bun:test';
import { selectAnswerHashes } from '../src/signoff-answers.ts';
import { asArray, collectItems, isObject, loadCollection, postNotPassed } from '../src/check.ts';
import { acceptedReviewVerdict } from '../src/review.ts';
import { outputsHash, reviewPackageHash } from '../src/signoff-target.ts';
/**
 * Project fixtures for `interview --check` tests: the filled example (or any
 * template) written to a fresh folder under the OS temp dir, mutated in place
 * first. Nothing is copied into the repository.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { CheckReport } from '../src/check.ts';
import { stepHash } from '../src/step-hash.ts';
import { readTemplate, type Json, type JsonObject } from '../src/templates.ts';
import { tempDir } from './helpers.ts';
import { EXAMPLE_VERDICT, partsPackage } from './parts-package.ts';
import { newOrderExampleFiles } from './draft-fixture.ts';
import { preparedExampleFiles } from './prepared-fixture.ts';
import { alignLegacyBuilds, materializeLegacyPartPackages, reviewExampleFiles } from './review-fixture.ts';
import { reopenCommand, advanceCommand, signoffCommand, checkProject, testClock } from './clock.ts';

export type Mutate = (project: JsonObject) => void;

/**
 * A project folder holding `template` (default: the filled example) after
 * `mutate`; `files` are written under it (path → content). The filled example
 * also gets the assembled parts and the approved verdict its parts-review
 * sign-off rests on (tests/parts-package.ts), unless `files` replaces them.
 */
export function fixture(mutate: Mutate = () => {}, template = 'legacy-example-project.json', files: Record<string, string | Uint8Array> = {}, rawLegacy = false): string {
  return materializeFixture(join(tempDir(), 'project'), mutate, template, files, rawLegacy);
}

/** Open either example record with the same retained asset bytes. */
export function materializeFixture(dir: string, mutate: Mutate = () => {}, template = 'example-project.json', files: Record<string, string | Uint8Array> = {}, rawLegacy = false, bindAnswers = true): string {
  const suppliedFiles = files;
  const legacyFiles = template === 'legacy-example-project.json'
    ? { ...preparedExampleFiles(), ...reviewExampleFiles(), ...partsPackage({ verdict: EXAMPLE_VERDICT }).files } : null;
  if (legacyFiles) files = { ...legacyFiles, ...suppliedFiles };
  if (template === 'example-project.json' || template === 'example-reopened/project.json') files = { ...preparedExampleFiles(), ...newOrderExampleFiles(), ...files };
  mkdirSync(dir);
  const project = readTemplate(template);
  if (['legacy-example-project.json', 'example-project.json', 'example-reopened/project.json'].includes(template) && !rawLegacy && bindAnswers) bindFixtureAnswers(project, dir);
  if (legacyFiles && !rawLegacy && bindAnswers) {
    materializeLegacyPartPackages(dir, project, legacyFiles);
    files = { ...legacyFiles, ...suppliedFiles };
  }
  if (template === 'legacy-example-project.json' && !rawLegacy && !buildingLegacyAdvances) project.advances = structuredClone(legacySetupAdvances());
  mutate(project);
  if (!rawLegacy) {
    retainSignoffs(project, () => true);
    if (template === 'legacy-example-project.json' && Array.isArray(project.advances)) {
      project.advances = project.advances.filter(raw => !isObject(raw) || stageIndex(String(raw.stage)) <= stageIndex(String(project.stage)));
    }
  }
  if (template === 'legacy-example-project.json' && !rawLegacy) alignLegacyBuilds(project, files);
  if (template === 'legacy-example-project.json' && !rawLegacy) bindFixtureSignoffs(project);
  writeFileSync(join(dir, 'project.json'), `${JSON.stringify(project, null, 2)}\n`);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

// Migrate the retained legacy test setup through the same forward writer as consumers.
// Cache every original stage-level approval so later fixture pruning retains its own move.
let buildingLegacyAdvances = false;
let legacyAdvances: Json[] | undefined;
function legacySetupAdvances(): Json[] {
  if (legacyAdvances !== undefined) return legacyAdvances;
  buildingLegacyAdvances = true;
  const now = testClock.now();
  try {
    const dir = fixture();
    const file = join(dir, 'project.json');
    const original = JSON.parse(readFileSync(file, 'utf8')) as JsonObject;
    const words = join(dir, 'setup-approval.txt');
    writeFileSync(words, 'Migrate the synthetic legacy stage setup through advance.');
    const result: Json[] = [];
    for (const target of LEGACY_STAGES.slice(1)) {
      const from = LEGACY_STAGES[LEGACY_STAGES.indexOf(target) - 1]!;
      const owner = LEGACY_STAGES.slice(0, LEGACY_STAGES.indexOf(target)).filter(s => s.closed_by === 'signoff').at(-1)!;
      for (const approval of asArray(original.signoffs).filter(isObject).filter(s => s.stage === owner.id && s.checkpoint === null)) {
        const project = structuredClone(original);
        project.stage = from.id;
        project.signoffs = asArray(project.signoffs).filter(isObject).filter(s => stageIndex(String(s.stage)) <= stageIndex(from.id)
          && (s.stage !== owner.id || Date.parse(String(s.at)) <= Date.parse(String(approval.at))));
        for (const raw of asArray(isObject(project.plan) ? project.plan.steps : undefined).filter(isObject)) {
          if ((raw.phase === 'rig' || raw.phase === 'post') && stageIndex(stageOfStep(raw.phase, String(raw.id))) >= stageIndex(target.id)) raw.status = 'pending';
        }
        const at = Math.max(...asArray(project.signoffs).filter(isObject).map(s => Date.parse(String(s.at)))) + LEGACY_STAGES.indexOf(target) + 1;
        testClock.set(new Date(at));
        writeFileSync(file, JSON.stringify(project));
        advanceCommand([target.id, dir, '--by', 'owner', '--verbatim-file', words]);
        const advanced = JSON.parse(readFileSync(file, 'utf8')) as JsonObject;
        result.push(asArray(advanced.advances).at(-1)!);
      }
    }
    legacyAdvances = result;
    return result;
  } finally { buildingLegacyAdvances = false; testClock.set(new Date(now)); }
}

/** Retain synthetic event ordering and stable identities inside a specific creation cohort. */
export function retimeFixture(project: JsonObject, before: number): void {
  const timestamp = /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g;
  const text = JSON.stringify(project);
  const instants = [...new Set([...text.matchAll(timestamp)].map(match => Date.parse(match[0])))].sort((a, b) => a - b);
  Object.assign(project, JSON.parse(text.replace(timestamp, value =>
    new Date(before - (instants.length - instants.indexOf(Date.parse(value))) * 1000).toISOString())));
  rehashSignoffs(project);
  for (const raw of asArray(project.signoffs).filter(isObject)) delete raw.answer_hashes;
  bindFixtureAnswers(project);
}

/** Pre-contract source records have no answer binding field, including before any mutation. */
export function historicalFixture(mutate: Mutate = () => {}, template = 'legacy-example-project.json', files: Record<string, string | Uint8Array> = {}): string {
  return materializeFixture(join(tempDir(), 'project'), mutate, template, files, false, false);
}

// Typed access into the record, so a mutation names the object it changes.
export function obj(v: Json | undefined): JsonObject {
  if (v === null || v === undefined || typeof v !== 'object' || Array.isArray(v)) throw new Error('expected an object');
  return v;
}
export function arr(v: Json | undefined): Json[] {
  if (!Array.isArray(v)) throw new Error('expected an array');
  return v;
}
export function byId(list: Json[], id: string): JsonObject {
  const found = list.find((x) => obj(x).id === id);
  if (found === undefined) throw new Error(`no item ${id}`);
  return obj(found);
}
export const waypoint = (p: JsonObject, id: string): JsonObject => byId(arr(obj(p.interview).waypoints), id);
export const framing = (p: JsonObject, id: string): JsonObject => byId(arr(obj(p.interview).framing), id);
export const step = (p: JsonObject, id: string): JsonObject => byId(arr(obj(p.plan).steps), id);
/** The `versions[]` entry numbered `n`. */
export function version(p: JsonObject, n: number): JsonObject {
  const found = arr(p.versions).find((v) => obj(v).n === n);
  if (found === undefined) throw new Error(`no version ${n}`);
  return obj(found);
}
/** `versions[n].provenance.sections`. */
export const citedSections = (p: JsonObject, n: number): JsonObject => obj(obj(version(p, n).provenance).sections);

export const codes = (r: CheckReport): string[] => r.refusals.map((f) => f.code);
export const withCode = (r: CheckReport, code: string) => r.refusals.filter((f) => f.code === code);

/** Replaces an answer the way the record does (INTERVIEW.md § Answer shape): the old one moves whole into `history[]`, so versions built from it still cite it. */
export function supersede(record: JsonObject, field: 'guide' | 'answer', next: Json): void {
  const old = record[field];
  if (old !== null && old !== undefined) record.history = [...(Array.isArray(record.history) ? record.history : []), old];
  record[field] = next;
}

/** Synthetic setup removals also remove only the audit entries that rely on those approvals. */
export function retainSignoffs(project: JsonObject, keep: (signature: JsonObject) => boolean): void {
  if (!Array.isArray(project.signoffs)) return;
  project.signoffs = project.signoffs.filter(raw => !isObject(raw) || keep(raw));
  const signatures = project.signoffs.filter(isObject);
  const retained = (identity: Json | undefined): boolean => !isSignoffIdentity(identity)
    || signatures.some(signature => matchesSignoff(identity, signature) && typeof signature.by === 'string' && signature.by.toLowerCase() !== 'agent');
  if (Array.isArray(project.advances)) {
    project.advances = project.advances.filter(raw => !isObject(raw) || retained(raw.signoff));
    for (const entry of project.advances.filter(isObject)) {
      if (Array.isArray(entry.signoffs_before)) entry.signoffs_before = entry.signoffs_before.filter(retained);
    }
  }
  for (const step of asArray(isObject(project.plan) ? project.plan.steps : undefined).filter(isObject)) {
    if (Array.isArray(step.status_history)) step.status_history = step.status_history.filter(raw => !isObject(raw) || retained(raw.signoff));
  }
}

/** Rebuild existing synthetic approval hashes after setup edits that precede the tested operation. */
export function rehashSignoffs(project: JsonObject): void {
  for (const raw of arr(project.signoffs)) {
    const signoff = obj(raw);
    if (signoff.step_hashes === undefined) continue;
    const hashes = obj(signoff.step_hashes);
    for (const id of Object.keys(hashes)) hashes[id] = stepHash(step(project, id));
  }
}

/** Bind unmodified synthetic source approvals before any mutation; never used for raw history. */
export function bindFixtureAnswers(project: JsonObject, dir = '.'): void {
  for (const signoff of asArray(project.signoffs).filter(isObject)) {
    if (signoff.answer_hashes !== undefined) continue;
    const hashes = selectAnswerHashes(dir, project, signoff);
    if (hashes !== undefined) signoff.answer_hashes = hashes;
  }
}

/** Prepare synthetic review targets after version setup, as the review fixtures require. */
export function bindFixtureSignoffs(project: JsonObject): void {
  const versions = asArray(project.versions);
  for (const signoff of asArray(project.signoffs).filter(isObject)) {
    if (signoff.target !== undefined || !['rig-review', 'direction-review'].includes(String(signoff.stage))) continue;
    const index = versions.findIndex(v => isObject(v) && acceptedReviewVerdict(v, String(signoff.stage)) >= 0);
    if (index < 0) continue;
    const version = versions[index] as JsonObject;
    const verdict = acceptedReviewVerdict(version, String(signoff.stage));
    if (signoff.stage === 'rig-review' && version.pre_interview === true) {
      if (version.outputs_lost !== undefined || !Array.isArray(version.outputs) || !version.outputs.length) continue;
      signoff.target = { version: version.n, verdict: `versions[${index}].verdicts[${verdict}]`, outputs: { path: `versions[${index}].outputs`, sha256: outputsHash(version.outputs) } };
      continue;
    }
    if (signoff.stage === 'rig-review' && !isObject(version.review_package)) continue;
    if (signoff.stage === 'direction-review' && !isObject(version.provenance)) continue;
    signoff.target = { version: version.n, verdict: `versions[${index}].verdicts[${verdict}]`, ...(signoff.stage === 'rig-review'
      ? { review_package: { path: `versions[${index}].review_package`, sha256: reviewPackageHash(version.review_package as JsonObject) } }
      : { post_config: (version.provenance as JsonObject).config! }) };
  }
}


/** Append real approvals for changed synthetic answers, preserving all old signatures. */
export function resignAfterChange(dir: string, eventAt = '2030-01-01T00:00:00Z'): string {
  const file = join(dir, 'project.json');
  const before = JSON.parse(readFileSync(file, 'utf8')) as JsonObject;
  const affected = new Map<string, Set<string>>();
  const steps = asArray(isObject(before.plan) ? before.plan.steps : undefined).filter(isObject);
  const signoffs = asArray(before.signoffs).filter(isObject);
  for (const finding of checkProject(dir).refusals) {
    if (finding.code !== 'SIGNOFF_ANSWERS_STALE') continue;
    const match = /^signoffs\[(\d+)\]\.answer_hashes\[(.+)\]$/.exec(finding.path);
    if (!match) throw new Error(`Unexpected stale binding path ${finding.path}`);
    const signature = signoffs[Number(match[1])];
    if (!signature || signature.stage === 'interview') continue;
    const stage = String(signature.stage);
    const ids = affected.get(stage) ?? new Set<string>();
    for (const step of steps) {
      const covered = Array.isArray(signature.steps) ? signature.steps.includes(step.id as Json)
        : step.phase === (stage === 'post-interview' ? 'post' : 'rig');
      if (covered && asArray(step.rests_on).includes(match[2]!)) ids.add(String(step.id));
    }
    affected.set(stage, ids);
  }
  if (steps.every(step => step.phase !== 'post') && postNotPassed({ items: collectItems(before, { collection: loadCollection(dir) }) })) affected.set('post-interview', new Set<string>());
  const at = Date.parse(eventAt);
  const dates = [...JSON.stringify(before).matchAll(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g)].map(match => Date.parse(match[0]));
  if (dates.some(date => date >= at)) throw new Error('Synthetic re-approval clock must follow every existing dated record');
  const words = join(dir, 'reapproval.txt');
  writeFileSync(words, 'Approve the changed synthetic answers at this new event.\n');
  const clock = testClock.now();
  try {
    testClock.set(new Date(at));
    signoffCommand(['interview', dir, '--by', 'user', '--verbatim-file', words]);
    let tick = 1;
    for (const stage of ['plan-approved', 'rigging-interview', 'post-interview']) {
      const ids = affected.get(stage);
      if (!ids) continue;
      if (!ids.size && stage !== 'post-interview') {
        testClock.set(new Date(at + tick++));
        reopenCommand([stage, dir, '--by', 'user', '--verbatim-file', words]);
        const phase = stage === 'post-interview' ? 'post' : 'rig';
        for (const step of steps) {
          if (step.phase === phase && approvalStageOfStep(phase, String(step.id), hasStageOrder(before)) === stage) ids.add(String(step.id));
        }
      }
      testClock.set(new Date(at + tick++));
      signoffCommand([stage, dir, ...(ids.size ? ['--steps', [...ids].join(',')] : []), '--by', 'user', '--verbatim-file', words]);
      const signed = JSON.parse(readFileSync(file, 'utf8')) as JsonObject;
      if (signed.stage === stage) {
        expect(checkProject(dir).refusals.map(f => f.code)).toContain('STAGE_LAGGING');
        const order = hasStageOrder(signed) ? STAGES : LEGACY_STAGES;
        const noPost = stage === 'post-interview' && postNotPassed({ items: collectItems(signed, { collection: loadCollection(dir) }) });
        const target = noPost ? 'accepted' : order[order.findIndex(s => s.id === stage) + 1]!.id;
        advanceCommand([target, dir, '--by', 'user', '--verbatim-file', words]);
      }
    }
  } finally { testClock.set(new Date(clock)); }
  const after = JSON.parse(readFileSync(file, 'utf8')) as JsonObject;
  if (JSON.stringify(asArray(after.signoffs).slice(0, asArray(before.signoffs).length)) !== JSON.stringify(before.signoffs)) throw new Error('Re-approval rewrote historical signatures');
  return dir;
}
