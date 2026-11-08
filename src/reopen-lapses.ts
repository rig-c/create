/**
 * The approvals a reopen voided and nothing has restored yet (rig-c/create#220). A reopen is
 * legitimate, so each one is a WARN naming the record, the reopen and the act that restores it.
 * Liveness is the same `liveSignoff` and rig-version `live` the gates read; this module only
 * names which reopen did it. Amendment lapses are listed by the report's `amendments[].lapsed`.
 */
import { asArray, collectSignoffs, isObject, type Finding } from './check.ts';
import { collectReopens, liveSignoff, reopenIndex, type Reopen } from './reopen.ts';
import { acceptedReviewVerdict, latestAccepted, readVersions } from './review.ts';
import { PARTS_REVIEW, RIG_REVIEW, stageIndex } from './stages.ts';
import type { JsonObject } from './templates.ts';

const DIRECTION_REVIEW = 'direction-review';

/** The earliest reopen (amendments excluded) that voids an approval of `stage` made at `at`. */
function voidingReopen(project: JsonObject, events: readonly Reopen[], stage: string, at: number): string | null {
  const cutoff = events.filter(e => !('index' in e) && stageIndex(e.stage) <= stageIndex(stage) && !(at > e.at))
    .reduce<Reopen | null>((a, e) => (a === null || e.at < a.at ? e : a), null);
  return cutoff === null ? null
    : `the reopen to ${cutoff.stage} at ${new Date(cutoff.at).toISOString()} (reopens[${reopenIndex(project, cutoff)}])`;
}

function signoffRemedy(stage: string, checkpoint: string | null): string {
  if (checkpoint !== null) return `ask the person to approve checkpoint ${checkpoint} again in the review tool and record it with rig-create signoff ${stage} --steps ${checkpoint}`;
  if (stage === PARTS_REVIEW) return 'ask the person to review the parts again in the review tool and record the verdict with rig-create signoff parts-review --evidence <verdict> --diff-report <report>';
  if (stage === RIG_REVIEW || stage === DIRECTION_REVIEW) return `ask the person to accept a live version again at ${stage} in the review tool, record it with rig-create review <n> --verdict accepted --review ${stage}, and sign with rig-create signoff ${stage}`;
  return `ask the person to sign ${stage} again in the review tool and record it with rig-create signoff ${stage}`;
}

/** One WARN per lapsed approval (the latest record of each), until a live approval of the same kind exists. */
export function reopenLapseWarnings(project: JsonObject): Finding[] {
  const events = collectReopens(project, []);
  if (!events.some(e => !('index' in e))) return [];
  const out: Finding[] = [];
  const latest = new Map<string, { index: number; stage: string; checkpoint: string | null; by: string }>();
  const restored = new Set<string>();
  for (const s of collectSignoffs(project, [])) {
    if (stageIndex(s.stage) < 0) continue;
    const key = `${s.stage}\u0000${s.checkpoint ?? ''}`;
    if (liveSignoff(events, s.stage, s.at)) {
      restored.add(key);
      continue;
    }
    const by = voidingReopen(project, events, s.stage, s.at);
    if (by !== null) latest.set(key, { index: s.index, stage: s.stage, checkpoint: s.checkpoint, by });
  }
  for (const [key, s] of latest) {
    if (restored.has(key)) continue;
    const path = `signoffs[${s.index}]`;
    const what = s.checkpoint === null ? `the ${s.stage} sign-off` : `the ${s.stage} checkpoint ${s.checkpoint} sign-off`;
    out.push({ code: 'REOPEN_SIGNOFF_LAPSED', path, message: `${path}: ${what} was voided by ${s.by}; ${signoffRemedy(s.stage, s.checkpoint)}` });
  }

  const versions = readVersions(project);
  if (latestAccepted(versions) === null) {
    const rig = versions.rigs.filter(r => !r.live && r.accepted !== null).reduce<(typeof versions.rigs)[number] | null>((a, r) => (a === null || r.n > a.n ? r : a), null);
    const by = rig === null ? null : voidingReopen(project, events, RIG_REVIEW, Date.parse(rig.at ?? ''));
    if (rig !== null && rig.accepted !== null && by !== null) {
      const path = `${rig.path}.verdicts[${rig.accepted.verdict}]`;
      out.push({ code: 'REOPEN_VERDICT_LAPSED', path, message: `${path}: the rig-review acceptance of rig v${rig.n} was voided by ${by}; register a new rig version with rig-create rig-version <n>, ask the person to review it in the review tool, and record the acceptance with rig-create review <n> --verdict accepted --review rig-review` });
    }
  }

  let direction: { path: string; n: number; at: number } | null = null;
  let directionLive = false;
  for (const v of asArray(project.versions)) {
    if (!isObject(v) || v.kind !== 'post' || typeof v.n !== 'number') continue;
    const index = acceptedReviewVerdict(v, DIRECTION_REVIEW);
    const verdict = asArray(v.verdicts)[index];
    if (index < 0 || !isObject(verdict)) continue;
    const at = Date.parse(String(verdict.at));
    if (liveSignoff(events, DIRECTION_REVIEW, at)) directionLive = true;
    else if (direction === null || at > direction.at) direction = { path: `versions[v${v.n}].verdicts[${index}]`, n: v.n, at };
  }
  const by = direction === null || directionLive ? null : voidingReopen(project, events, DIRECTION_REVIEW, direction.at);
  if (direction !== null && by !== null) {
    out.push({ code: 'REOPEN_VERDICT_LAPSED', path: direction.path, message: `${direction.path}: the direction-review acceptance of post v${direction.n} was voided by ${by}; ask the person to review a live post version in the review tool and record the acceptance with rig-create review <n> --verdict accepted --review direction-review` });
  }
  return out;
}
