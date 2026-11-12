/** Resolve only the post approved in a sealed decision record, never a UI selector. */
import { asArray, isObject } from './check.ts';
import { collectReopens, liveSignoff } from './reopen.ts';
import { acceptedReviewVerdict } from './review.ts';
import { refuse } from './refusal.ts';
import type { JsonObject } from './templates.ts';

export function recordDirectionTarget(project: JsonObject, at = Infinity): number | null {
  const reopens = collectReopens(project, []);
  const posts = asArray(project.versions).filter(isObject).filter(version => version.kind === 'post'
    && Number.isSafeInteger(version.n) && Number(version.n) > 0
    && Number.isFinite(Date.parse(String(version.at))) && Date.parse(String(version.at)) <= at
    && liveSignoff(reopens, 'post', Date.parse(String(version.at))));
  const current = posts.at(-1);
  if (!current || asArray(project.versions).filter(isObject).filter(version => version.n === current.n).length !== 1) return null;
  const index = acceptedReviewVerdict(current, 'direction-review');
  const verdict = index >= 0 ? asArray(current.verdicts)[index] : undefined;
  return isObject(verdict) && Number.isFinite(Date.parse(String(verdict.at))) && Date.parse(String(verdict.at)) <= at
    && liveSignoff(reopens, 'direction-review', Date.parse(String(verdict.at))) ? Number(current.n) : null;
}

export function requireRecordDirectionTarget(project: JsonObject, at = Infinity): number {
  const version = recordDirectionTarget(project, at);
  if (version === null) refuse('REVIEW_ACT_RECORD_TARGET_INVALID', 'project.json.versions: the frozen record does not bind one current live post with an accepted direction-review verdict; resolve ambiguous or stale verdicts through the writers and publish the record again');
  return version;
}
