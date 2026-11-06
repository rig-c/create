import { refuse } from './refusal.ts';
import type { JsonObject } from './templates.ts';

/** A date that cannot be read cannot establish eligibility for a legacy gate. */
export function rigVersionDateFinding(version: JsonObject) {
  if (version.kind !== 'rig' || typeof version.at === 'string' && Number.isFinite(Date.parse(version.at))) return null;
  const path = `versions[v${String(version.n)}].at`;
  return {
    code: 'RIG_VERSION_AT_INVALID', path,
    message: `${path}: unreadable rig build date ${JSON.stringify(version.at) ?? 'undefined'}; restore a readable date from the build record before packaging, acceptance or handoff`,
  };
}

export function assertRigVersionDate(version: JsonObject): void {
  const finding = rigVersionDateFinding(version);
  if (finding) refuse(finding.code, finding.message);
}
