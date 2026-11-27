/** Shared candidate gate for recorded signatures. */
import { checkProject, type CheckReport, type Finding } from './check.ts';
import { baselineOf, newFindings } from './refusal-baseline.ts';
import { refuse } from './refusal.ts';
import { hasStageOrder } from './stages.ts';
import type { JsonObject } from './templates.ts';

/** Same candidate gate for all signatures. */
export function assertSignoffCandidate(dir: string, asRead: CheckReport, project: JsonObject, signoff: JsonObject, covered: JsonObject[], now: number): readonly Finding[] {
  const signoffs = project.signoffs as JsonObject[];
  const candidateRefusals = checkProject(dir, project, { now, readOnly: true }).refusals;
  // This signature approves the depth plan itself: carrying its refusal is not an approval waiver.
  if (signoff.stage === 'rigging-interview' && signoff.checkpoint === null) {
    const depth = candidateRefusals.find(finding => finding.code === 'RIG_DEPTH_PLAN_MISSING');
    if (depth) refuse(depth.code, depth.message);
  }
  // A signature in the candidate settles chronology, so check the covered steps before it was added.
  const stale = asRead.refusals.find(f => f.code === 'PLAN_STEP_PREDATES_ANSWER'
    && covered.some(step => f.path === `plan.steps[${String(step.id)}]`));
  if (stale) refuse(stale.code, stale.message);
  // Refusals the record already carried do not block the signature (docs/PROJECT.md); a new one does.
  const fresh = new Set(newFindings(baselineOf(asRead), candidateRefusals));
  const progress = candidateRefusals.find(f => ['ADVANCE_MALFORMED', 'STEP_STATUS_TRANSITION', 'STEP_STATUS_SIGNOFF'].includes(f.code) && fresh.has(f));
  if (progress !== undefined) refuse(progress.code, progress.message);
  if (hasStageOrder(project) || signoff.structure !== undefined || project.amendments !== undefined) {
    const path = `signoffs[${signoffs.length - 1}]`;
    const first = candidateRefusals.find(f => {
      if (f.code.startsWith('SIGNOFF_ANSWERS_')) return f.path.startsWith(`${path}.`);
      return fresh.has(f);
    });
    if (first !== undefined) refuse(first.code, first.message);
  }
  return candidateRefusals;
}
