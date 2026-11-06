import { refuse } from './refusal.ts';
import type { JsonObject } from './templates.ts';

/** A date that cannot be read cannot establish eligibility for a legacy gate. */
export function rigVersionDateFinding(version: JsonObject) {
  if (version.kind !== 'rig') return null;
  const at = version.at;
  if (typeof at === 'string'
    && (/^\d{4}-\d\d-\d\d$/.test(at) || /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(at))
    && Number.isFinite(Date.parse(at))
    && new Date(Date.parse(at)).toISOString().slice(0, 10) === at.slice(0, 10)) return null;
  const path = `versions[v${String(version.n)}].at`;
  return {
    code: 'RIG_VERSION_AT_INVALID', path,
    message: `${path}: invalid rig build date ${JSON.stringify(at) ?? 'undefined'}. Restore a calendar date YYYY-MM-DD or an ISO date-time with a zone from the build record, with a matching UTC calendar date, before packaging, acceptance, signoff or handoff`,
  };
}

export function assertRigVersionDate(version: JsonObject): void {
  const finding = rigVersionDateFinding(version);
  if (finding) refuse(finding.code, finding.message);
}
