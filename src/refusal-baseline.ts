/**
 * The refusals a record already carries (docs/PROJECT.md § Refusals a record already carries).
 *
 * A writer's baseline is `checkProject` on the record as read, at write time. It is never stored
 * in the record. A candidate refusal is new when the baseline does not cover it: findings match
 * by code and path, counting multiplicity, so the same code at a different path is new. Removing
 * a carried refusal is always allowed. A check that stopped early (an unreadable record, schema or
 * stage) validated nothing, so it supplies no baseline. `advance` does not use this: it still needs
 * 0 refusals. The writers that kept a baseline before this rule (choices, corrections, direction,
 * plan, scene, rig-version) count their baseline with `countFindings`, stopped-early check included.
 */
import { checkProject, type CheckReport, type Finding } from './check.ts';
import type { JsonObject } from './templates.ts';

type CheckOptions = Parameters<typeof checkProject>[2];

export const findingKey = (finding: Pick<Finding, 'code' | 'path'>): string => JSON.stringify([finding.code, finding.path]);

/** Count findings by code and path. */
export function countFindings(findings: Iterable<Pick<Finding, 'code' | 'path'>>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const finding of findings) counts.set(findingKey(finding), (counts.get(findingKey(finding)) ?? 0) + 1);
  return counts;
}

/** The baseline a check report supplies: its refusals counted by code and path, or none when the check stopped early. */
export function baselineOf(report: CheckReport): Map<string, number> {
  return report.stage === null ? new Map() : countFindings(report.refusals);
}

/** The baseline of a record as read, at write time. */
export function carriedRefusals(dir: string, before: JsonObject, options: CheckOptions): Map<string, number> {
  return baselineOf(checkProject(dir, structuredClone(before), options));
}

/** The findings in `after` that `baseline` does not cover, in check order. The baseline is not changed. */
export function newFindings(baseline: ReadonlyMap<string, number>, after: readonly Finding[]): Finding[] {
  const left = new Map(baseline);
  return after.filter(finding => {
    const count = left.get(findingKey(finding)) ?? 0;
    left.set(findingKey(finding), count - 1);
    return count <= 0;
  });
}

/** The candidate's check refusals that the record as read did not already carry. */
export function newRefusals(dir: string, before: JsonObject, candidate: JsonObject, options: CheckOptions): Finding[] {
  const baseline = carriedRefusals(dir, before, options);
  return newFindings(baseline, checkProject(dir, candidate, options).refusals);
}
