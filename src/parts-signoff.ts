/** Parts approval construction shared by verdict ingestion and the separate signoff writer. */
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from './check-reads.ts';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { asArray, checkProject, collectSignoffs, isObject, type CheckReport, type Finding } from './check.ts';
import { isPartsCheckMove, partsCheckFindings } from './parts-check.ts';
import { checkDiffMap } from './diff-map.ts';
import { latestPartsVerdictFinding, recordedPartsVerdict } from './parts-verdict-record.ts';
import { baselineOf, newFindings } from './refusal-baseline.ts';
import { refuse } from './refusal.ts';
import { collectReopens, liveSignoff } from './reopen.ts';
import { furthestStageSignoff } from './stage-progress.ts';
import { PARTS_REVIEW, hasStageOrder } from './stages.ts';
import { checkStructure, structurePathIsIgnored } from './structure.ts';
import { assertCorrectionApproval } from './correction-writers.ts';
import { partsStructureSnapshot } from './job-acts.ts';
import { jobHash } from './job-outbox.ts';
import { partsVerdictSignoff, type PartsVerdictAct } from './review-act.ts';
import type { JsonObject } from './templates.ts';

export function bindPartsSignoff(dir: string, project: JsonObject, signoff: JsonObject, structureFile?: string): void {
  const path = `signoffs[${(project.signoffs as JsonObject[]).length}]`;
  const latest = latestPartsVerdictFinding(project, String(signoff.draft_id), `${path}.draft_id`);
  if (latest) refuse(latest.code, latest.message);
  const recorded = recordedPartsVerdict(dir, project, signoff.draft_id);
  // Preserve the existing signature's property order as well as its values:
  // generated examples and captions bind the serialized project bytes.
  const draftId = signoff.draft_id!;
  delete signoff.draft_id;
  signoff.evidence = recorded.evidence;
  signoff.draft_id = draftId;
  if (signoff.checkpoint === null) {
    const errors: Finding[] = [];
    checkDiffMap(dir, signoff, path, recorded.partsFile, errors, [], project);
    if (errors[0]) refuse(errors[0].code, errors[0].message);
  }
  if (hasStageOrder(project) || structureFile !== undefined) {
    if (structureFile !== undefined) {
      try {
        if (structurePathIsIgnored(dir, structureFile)) throw new Error('structure snapshots must survive a clone; retain the file outside ignored roots, for example evidence/');
        const canonical = realpathSync(resolve(dir, structureFile));
        const rel = relative(realpathSync(dir), canonical).split(sep).join('/');
        if (isAbsolute(structureFile) || rel === '' || rel === '..' || rel.startsWith('../')) throw new Error('structure file must stay under the project');
        signoff.structure = { path: rel, sha256: createHash('sha256').update(readFileSync(canonical)).digest('hex') };
      } catch (error) { refuse('STRUCTURE_DECISIONS_INVALID', `signoffs.structure: ${error instanceof Error ? error.message : String(error)}; retain the structure snapshot under the project`); }
    }
    const errors: Finding[] = [];
    checkStructure(dir, project, signoff, path, errors);
    if (errors[0]) refuse(errors[0].code, errors[0].message);
  }
}

/** Same candidate gate for all signatures, including the folded parts signature. */
export function assertSignoffCandidate(dir: string, asRead: CheckReport, project: JsonObject, signoff: JsonObject, covered: JsonObject[], now: number): void {
  const signoffs = project.signoffs as JsonObject[];
  const reopens = collectReopens(project, []);
  const frontier = furthestStageSignoff(collectSignoffs(project, []).filter(s => liveSignoff(reopens, s.stage, s.at)));
  const ownLag = signoff.checkpoint === null && frontier?.index === signoffs.length - 1;
  const candidateRefusals = checkProject(dir, project, { now }).refusals;
  // Refusals the record already carried do not block the signature (docs/PROJECT.md); a new one does.
  const fresh = new Set(newFindings(baselineOf(asRead), candidateRefusals));
  const pendingOwnAdvance = (finding: Finding): boolean => ownLag && finding.code === 'STAGE_LAGGING';
  const progress = candidateRefusals.find(f => ['STAGE_LAGGING', 'STAGE_SKIPPED', 'STAGE_SIGNOFF_DATE_INVALID', 'ADVANCE_MALFORMED', 'STEP_STATUS_TRANSITION', 'STEP_STATUS_SIGNOFF'].includes(f.code) && !pendingOwnAdvance(f) && fresh.has(f));
  if (progress !== undefined) refuse(progress.code, progress.message);
  if (hasStageOrder(project) || signoff.structure !== undefined || project.amendments !== undefined) {
    const path = `signoffs[${signoffs.length - 1}]`;
    const first = candidateRefusals.find(f => {
      if (pendingOwnAdvance(f)) return false;
      if (f.code.startsWith('SIGNOFF_ANSWERS_')) return f.path.startsWith(`${path}.`);
      // A covered step this signature leaves unapproved is its own failure, even when the record carried it.
      if (f.code === 'GUIDE_CHANGED_UNSIGNED') return covered.some(step => f.path === `plan.steps[${String(step.id)}]`);
      return fresh.has(f);
    });
    if (first !== undefined) refuse(first.code, first.message);
  }
}

/** Build and validate in memory. The ingestion writer owns the single project.json rename. */
export function foldPartsSignoff(dir: string, before: JsonObject, candidate: JsonObject, act: PartsVerdictAct, original: Buffer, now: number): void {
  if (act.source.projectHash !== jobHash(original)) refuse('REVIEW_ACT_SOURCE_STALE', 'project.json: parts verdict predates the current record; publish after evidence and advance parts-review, then ask again');
  const asRead = checkProject(dir, before, { now });
  if (asRead.effective_stage !== PARTS_REVIEW) refuse('PARTS_REVIEW_FOLD_NOT_READY', 'project.json.stage: approved parts verdict needs effective parts-review; retain evidence and advance parts-review before publishing and asking for approval');
  const advances = asArray(before.advances);
  let arrivalIndex = -1;
  advances.forEach((move, index) => { if (isObject(move) && isPartsCheckMove(move)) arrivalIndex = index; });
  const arrival = advances[arrivalIndex];
  if (!isObject(arrival) || !isObject(arrival.parts_check)) refuse('PARTS_REVIEW_FOLD_NOT_READY', 'project.json.advances: no parts to parts-review advance retains the stage-entry parts-check; retain its report and advance before publishing and asking for approval');
  const partsCheck = partsCheckFindings(dir, arrival.parts_check, `advances[${arrivalIndex}].parts_check`, true)[0];
  if (partsCheck) refuse(partsCheck.code, partsCheck.message);
  const later = asArray(before.advances).filter(isObject).some(move => move.stage === PARTS_REVIEW && Date.parse(String(move.at)) > Date.parse(act.at))
    || isObject(before.diff_map) && Date.parse(String(before.diff_map.at)) > Date.parse(act.at);
  if (later) refuse('REVIEW_ACT_SOURCE_STALE', 'project.json.advances/diff_map: parts verdict predates its evidence or advance; publish the ready parts-review record and ask again');
  const lag = asRead.refusals.find(f => f.code === 'STAGE_LAGGING');
  if (lag) refuse(lag.code, lag.message);
  if (!Array.isArray(candidate.signoffs)) refuse('SIGNOFF_MALFORMED', 'project.json.signoffs: expected a list; restore recorded signatures before ingesting the verdict');
  const structure = partsStructureSnapshot(dir, candidate, act.source.selector.id);
  if (!structure.valid) refuse('STRUCTURE_DECISIONS_MISSING', `project.json.signoffs.structure: retain the reviewed draft snapshot with structure-snapshot --draft ${act.source.selector.id} --out ${structure.path} before publishing and asking for approval`);
  const signoff = partsVerdictSignoff(act);
  bindPartsSignoff(dir, candidate, signoff, structure.path);
  assertCorrectionApproval(dir, candidate, PARTS_REVIEW, now, signoff);
  const receipt = asArray(candidate.review_acts).filter(isObject).find(entry => entry.jobId === act.jobId && entry.actId === act.actId)!;
  receipt.signoff = candidate.signoffs.length;
  candidate.signoffs.push(signoff);
  assertSignoffCandidate(dir, asRead, candidate, signoff, [], now);
}
