import { asArray, asString, collectSignoffs, isObject, type Finding } from './check.ts';
import { collectAmendments } from './amend.ts';
import { REOPEN_RESTART_OWNER_CHAT_SINCE, ownerChatAuthorityFinding } from './owner-chat.ts';
import { reviewActFindings } from './review-act.ts';
import { stageIndex, STAGE_VALUES } from './stages.ts';
import type { JsonObject } from './templates.ts';

export interface Reopen {
  readonly stage: string;
  readonly at: number;
}

/** Validate history before using it as authority. Invalid entries supersede nothing. */
export function collectReopens(project: JsonObject, refusals: Finding[], warnings?: Finding[]): Reopen[] {
  const out: Reopen[] = [];
  const receipts = asArray(project.review_acts);
  const push = (code: string, path: string, why: string): void => {
    refusals.push({ code, path, message: `${path}: ${why}; restore the original historical reopen and its reached-stage evidence` });
  };
  if (project.reopens !== undefined && !Array.isArray(project.reopens)) {
    push('REOPEN_MALFORMED', 'reopens', 'must be a list');
    return out;
  }
  for (const [index, raw] of asArray(project.reopens).entries()) {
    const path = `reopens[${index}]`;
    if (!isObject(raw) || ['stage', 'from_stage', 'by', 'at', 'verbatim'].some(k => asString(raw[k]) === null)
      || !Number.isFinite(Date.parse(raw.at as string)) || (raw.source !== undefined && typeof raw.source !== 'string')) {
      push('REOPEN_MALFORMED', path, 'needs stage, from_stage, by, a valid at, verbatim and optional text source');
      continue;
    }
    if ((raw.by as string).trim().toLowerCase() === 'agent') {
      push('SIGNOFF_NOT_HUMAN', path, 'signed by agent');
      continue;
    }
    if (!Array.isArray(raw.steps_before) || raw.steps_before.some(s => !isObject(s) || typeof s.id !== 'string'
      || (s.status !== undefined && (typeof s.status !== 'string' || !['pending', 'in-progress', 'at-checkpoint', 'done'].includes(s.status))))) {
      push('REOPEN_MALFORMED', path, 'steps_before must snapshot step ids and original statuses');
      continue;
    }
    const stage = raw.stage as string;
    if (stageIndex(stage) < 0 || stage === 'accepted') {
      push('REOPEN_STAGE_UNKNOWN', path, `target ${stage} is not a reopenable stage`);
      continue;
    }
    const fromStage = raw.from_stage as string;
    if (!STAGE_VALUES.includes(fromStage)) {
      push('REOPEN_MALFORMED', `${path}.from_stage`, 'must be a known project stage');
      continue;
    }
    const at = Date.parse(raw.at as string);
    if (!reopenTargetEligible(project, stage, at, fromStage)) {
      push('REOPEN_NOT_PASSED', path, `target ${stage} was not reached at ${String(raw.at)}`);
      continue;
    }
    const receipt = receipts.find(entry => isObject(entry) && entry.schema === 'rig-create/review-act@1'
      && entry.kind === 'reopen' && entry.reopen === index);
    // Check validates the full ledger separately; only a valid binding can supersede approvals.
    if (receipt !== undefined && reviewActFindings({ ...project, review_acts: [receipt] }).length > 0) continue;
    const authority = ownerChatAuthorityFinding(raw, path, raw.verbatim, receipt !== undefined);
    if (authority) {
      if (authority.code === 'OWNER_CHAT_REQUIRED' && at < Date.parse(REOPEN_RESTART_OWNER_CHAT_SINCE)) warnings?.push(authority);
      else {
        refusals.push(authority);
        continue;
      }
    }
    out.push({ stage, at });
  }
  return [...out, ...collectAmendments(project, refusals)];
}

/** Use the original stage and witnesses dated by the historical act. */
function reopenTargetEligible(project: JsonObject, stage: string, at: number, fromStage: string): boolean {
  const target = stageIndex(stage);
  return target >= 0 && stage !== 'accepted' && Number.isFinite(at) && STAGE_VALUES.includes(fromStage)
    && target <= reachedIndex(project, at, fromStage);
}

/** Historical stages and dated builds witness reach even after stage has moved back. */
function reachedIndex(project: JsonObject, at: number, fromStage: string): number {
  let reached = stageIndex(fromStage);
  for (const raw of asArray(project.signoffs)) {
    if (!isObject(raw) || typeof raw.by !== 'string' || raw.by.toLowerCase() === 'agent'
      || typeof raw.verbatim !== 'string' || typeof raw.at !== 'string' || !(Date.parse(raw.at) <= at)) continue;
    reached = Math.max(reached, stageIndex(asString(raw.stage) ?? ''));
  }
  for (const raw of asArray(project.versions)) {
    if (!isObject(raw) || typeof raw.at !== 'string' || !(Date.parse(raw.at) <= at)) continue;
    if (raw.kind === 'rig') reached = Math.max(reached, stageIndex('rigging'));
    if (raw.kind === 'post') reached = Math.max(reached, stageIndex('post'));
  }
  return reached;
}

/** An acceptance remains authoring authority until a historical reopen or an amendment supersedes it. */
export function directionReviewClosed(project: JsonObject): boolean {
  const reopens = collectReopens(project, []);
  return collectSignoffs(project, []).some(signoff => signoff.stage === 'direction-review'
    && signoff.checkpoint === null && liveSignoff(reopens, signoff.stage, signoff.at))
    || asArray(project.versions).filter(isObject).some(version => version.kind === 'post'
      && asArray(version.verdicts).filter(isObject).some(verdict => verdict.review === 'direction-review'
        && verdict.verdict === 'accepted' && liveSignoff(reopens, 'direction-review', Date.parse(String(verdict.at)))));
}

/** Each reopen invalidates its suffix; a later, narrower reopen cannot resurrect an earlier suffix. */
export function reopenTime(reopens: readonly Reopen[], stage: string): number {
  return Math.max(-Infinity, ...reopens.filter(r => stageIndex(r.stage) <= stageIndex(stage)).map(r => r.at));
}

/** The `reopens[]` index of a validated reopen, matched by its stage and time. */
export function reopenIndex(project: JsonObject, reopen: Reopen): number {
  return asArray(project.reopens).findIndex(r => isObject(r) && r.stage === reopen.stage && Date.parse(asString(r.at) ?? '') === reopen.at);
}

export function liveSignoff(reopens: readonly Reopen[], stage: string, at: number): boolean {
  const since = reopenTime(reopens, stage);
  return since === -Infinity || at > since;
}
