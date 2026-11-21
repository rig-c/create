import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { readFileSync, realpathSync } from './check-reads.ts';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { asArray, asString, checkProject, collectItems, collectSignoffs, isObject, loadCollection, type Finding } from './check.ts';
import { relativeInventory } from './draft-reuse.ts';
import { readProject } from './feedback.ts';
import { publicationFile } from './job-publication.ts';
import { OWNER_CHAT_FLAGS, ownerChatAuthorityFinding, ownerChatFinding, readOwnerChat } from './owner-chat.ts';
import { readVerbatim } from './record-input.ts';
import { refuse, USAGE_EXIT } from './refusal.ts';
import { newRefusals } from './refusal-baseline.ts';
import { liveSignoff, type Reopen } from './reopen.ts';
import { stageIndex, stageOfStep } from './stages.ts';
import { latestPartsApproval } from './structure.ts';
import type { Json, JsonObject } from './templates.ts';

/** Fixed approval-kind → step-0 gap mapping. These are missing proofs, not inferred dependencies. */
export const AMENDMENT_APPROVAL_GAPS: Readonly<Record<string, string>> = {
  interview: 'G1',
  'plan-approved': 'G2',
  parts: 'G3',
  'parts-review': 'G5',
  'rigging-interview': 'G2',
  rigging: 'G3',
  'rig-review': 'G7',
  'post-interview': 'G2',
  post: 'G3',
  'direction-review': 'G7',
  accepted: 'G9',
};

export interface Amendment extends Reopen {
  readonly index: number;
  readonly target: JsonObject;
}

export interface AmendmentApproval {
  readonly path: string;
  readonly stage: string;
  readonly checkpoint?: string;
  readonly reason: string;
  readonly gap?: string;
}

export interface AmendmentSummary {
  readonly path: string;
  readonly target: JsonObject;
  readonly lapsed: AmendmentApproval[];
  readonly upstream: AmendmentApproval[];
  readonly keep_by_binding: AmendmentApproval[];
}

/**
 * Approvals an amendment leaves live because a binding proves independence. An interview-answer
 * amendment keeps the checkpoint approval of a step that does not rest on the changed answer.
 */
export function keepByBinding(project: JsonObject, target: JsonObject, approval: { stage: string; checkpoint?: string }): boolean {
  if (target.kind !== 'interview-answer' || approval.checkpoint === undefined) return false;
  const steps = asArray(isObject(project.plan) ? project.plan.steps : undefined).filter(isObject)
    .filter(step => step.id === approval.checkpoint && stageOfStep(step.phase as 'rig' | 'post', approval.checkpoint) === approval.stage);
  return steps.length === 1 && !amendmentResetsStep(target, steps[0]!.phase, steps[0]!.id, steps[0]!.rests_on);
}

/** The question id an interview-answer target names: the id itself, or the answer path check reports for it. */
export function amendedAnswerId(target: JsonObject): string {
  const id = String(target.id);
  return /^interview\.(?:framing|waypoints|post\.items)\[([^\]]+)\]\.(?:answer|guide)$/.exec(id)?.[1] ?? id;
}

/** An amendment resets a rig or post step at or after its owning stage; an interview-answer only one resting on that answer. */
export function amendmentResetsStep(target: JsonObject, phase: Json | undefined, id: Json | undefined, restsOn: Json | undefined): boolean {
  return typeof id === 'string' && (phase === 'rig' || phase === 'post')
    && stageIndex(stageOfStep(phase, id)) >= stageIndex(String(target.stage))
    && (target.kind !== 'interview-answer' || asArray(restsOn).includes(amendedAnswerId(target)));
}

/** The plan steps an amendment resets; the other steps keep their status. */
export function amendmentLapsedSteps(project: JsonObject, target: JsonObject): JsonObject[] {
  return asArray(isObject(project.plan) ? project.plan.steps : undefined).filter(isObject)
    .filter(step => amendmentResetsStep(target, step.phase, step.id, step.rests_on));
}

/** The reopens and amendments that cut a step's approvals: all but interview-answer amendments of answers it does not rest on. */
export function stepLapseEvents(events: readonly Reopen[], restsOn: Json | undefined): Reopen[] {
  return events.filter(event => {
    const target = (event as Partial<Amendment>).target;
    return target?.kind !== 'interview-answer' || asArray(restsOn).includes(amendedAnswerId(target));
  });
}

/** Only well-formed human amendments can invalidate approvals. Historical bindings name recorded bytes. */
export function collectAmendments(project: JsonObject, refusals: Finding[]): Amendment[] {
  const out: Amendment[] = [];
  const invalid = (code: string, path: string, why: string): void => {
    refusals.push({ code, path, message: `${path}: ${why}; record a human amend with an artifact, its owning stage and new input hashes` });
  };
  if (project.amendments !== undefined && !Array.isArray(project.amendments)) {
    invalid('AMENDMENT_MALFORMED', 'amendments', 'must be a list');
    return out;
  }
  for (const [index, raw] of asArray(project.amendments).entries()) {
    const path = `amendments[${index}]`;
    if (!isObject(raw) || ['by', 'at', 'verbatim'].some(k => asString(raw[k]) === null)
      || !(raw.by as string).trim() || !Number.isFinite(Date.parse(raw.at as string))
      || (raw.source !== undefined && typeof raw.source !== 'string')) {
      invalid('AMENDMENT_MALFORMED', path, 'needs by, a valid at, verbatim and optional text source');
      continue;
    }
    if ((raw.by as string).trim().toLowerCase() === 'agent') {
      invalid('SIGNOFF_NOT_HUMAN', path, 'signed by agent');
      continue;
    }
    const target = raw.target;
    if (!isObject(target) || !['part', 'config-field', 'motion-track', 'interview-answer', 'draft'].includes(String(target.kind))
      || typeof target.id !== 'string' || !target.id.trim() || typeof target.stage !== 'string'
      || target.stage === 'accepted' || !Object.hasOwn(AMENDMENT_APPROVAL_GAPS, target.stage)) {
      invalid('AMENDMENT_TARGET_INVALID', `${path}.target`, 'needs kind, non-empty artifact id and a non-terminal owning stage');
      continue;
    }
    if (target.kind === 'draft' && (target.stage !== 'parts-review'
      || asArray(project.drafts).filter(draft => isObject(draft) && draft.id === target.id).length !== 1)) {
      invalid('AMENDMENT_TARGET_INVALID', `${path}.target`, 'a draft target needs parts-review and one registered draft id');
      continue;
    }
    const authority = target.kind === 'draft' ? ownerChatAuthorityFinding(raw, path, raw.verbatim) : ownerChatFinding(raw, path);
    if (authority) { refusals.push(authority); continue; }
    if (!Array.isArray(raw.changes) || raw.changes.length === 0 || raw.changes.some(c => !isObject(c)
      || typeof c.path !== 'string' || !c.path.trim() || typeof c.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(c.sha256))
      || new Set(raw.changes.map(c => (c as JsonObject).path)).size !== raw.changes.length) {
      invalid('AMENDMENT_CHANGES_INVALID', `${path}.changes`, 'needs distinct new input paths and lowercase SHA-256 hashes');
      continue;
    }
    out.push({ index, target, stage: target.stage, at: Date.parse(raw.at as string) });
  }
  return out;
}

export function draftAmendmentTime(project: JsonObject, draftId: string): number {
  return Math.max(-Infinity, ...collectAmendments(project, [])
    .filter(amendment => amendment.target.kind === 'draft' && amendment.target.id === draftId)
    .map(amendment => amendment.at));
}

/** The changes must name the actual new parts inputs, including the target's manifest. */
export function assertDraftAmendmentChanges(draft: JsonObject, changes: Json | undefined, path: string): { path: string; sha256: string } {
  const parts = draft.parts;
  if (!isObject(parts)) refuse('AMENDMENT_TARGET_INVALID', `${path}: target draft must retain its parts inventory; register the corrected draft`);
  const inventory = new Map(relativeInventory(parts, path).map(file => [`${parts.path}/${file.path}`, file.sha256]));
  const manifest = `${parts.path}/parts.json`;
  if (!Array.isArray(changes) || !changes.some(change => isObject(change) && change.path === manifest)
    || changes.some(change => !isObject(change) || typeof change.path !== 'string' || typeof change.sha256 !== 'string'
      || inventory.get(change.path) !== change.sha256)) {
    refuse('AMENDMENT_CHANGES_INVALID', `${path}: changes must bind the target draft's recorded parts bytes; use --change ${manifest} with the registered draft`);
  }
  return { path: manifest, sha256: inventory.get(manifest)! };
}

/** A draft amendment changes the inventory bound by the parts approval it lapses. */
export function changedDraftInventory(project: JsonObject, draft: JsonObject, at: number): ReturnType<typeof relativeInventory> {
  const approvedId = latestPartsApproval(project, at)?.draft_id;
  const approved = asArray(project.drafts).filter(isObject).filter(row => row.id === approvedId);
  const approvedParts = approved[0]?.parts;
  if (!(Date.parse(String(draft.at)) <= at) || !isObject(draft.parts) || approved.length !== 1 || !isObject(approvedParts)) {
    refuse('AMENDMENT_TARGET_INVALID', 'amendments.target: a registered draft and a live prior parts-review signoff are required; restore their records before amending');
  }
  const inventory = relativeInventory(draft.parts, 'amendments.target');
  if (isDeepStrictEqual(relativeInventory(approvedParts, 'amendments.target'), inventory)) {
    refuse('AMENDMENT_CHANGES_INVALID', 'amendments.changes: the target parts match the live parts-review signoff; amend a draft with changed parts bytes');
  }
  return inventory;
}

/** Name each recorded approval act. Re-signatures remain separate acts in history. */
export function amendmentSummaries(project: JsonObject, amendments: readonly Amendment[], events: readonly Reopen[]): AmendmentSummary[] {
  const approvals = collectSignoffs(project, []).map(s => ({
    path: `signoffs[${s.index}]`, stage: s.stage, at: s.at,
    ...(s.checkpoint === null ? {} : { checkpoint: s.checkpoint }),
  }));
  for (const [vi, raw] of asArray(project.versions).entries()) {
    if (!isObject(raw)) continue;
    for (const [di, verdict] of asArray(raw.verdicts).entries()) {
      if (!isObject(verdict) || verdict.verdict !== 'accepted' || typeof verdict.by !== 'string'
        || verdict.by.toLowerCase() === 'agent' || !['rig-review', 'direction-review'].includes(String(verdict.review))) continue;
      approvals.push({ path: `versions[${vi}].verdicts[${di}]`, stage: String(verdict.review), at: Date.parse(String(verdict.at)) });
    }
  }
  return amendments.map(a => {
    const lapsed: AmendmentApproval[] = [];
    const upstream: AmendmentApproval[] = [];
    const kept: AmendmentApproval[] = [];
    for (const approval of approvals) {
      if (approval.at > a.at || stageIndex(approval.stage) < 0) continue;
      const named = { path: approval.path, stage: approval.stage, ...('checkpoint' in approval ? { checkpoint: approval.checkpoint } : {}) };
      if (stageIndex(approval.stage) >= stageIndex(a.stage) && keepByBinding(project, a.target, named)) {
        kept.push({ ...named, reason: `step does not rest on ${amendedAnswerId(a.target)}` });
      } else if (stageIndex(approval.stage) >= stageIndex(a.stage)) {
        lapsed.push({ ...named, reason: 'no binding proves independence', gap: AMENDMENT_APPROVAL_GAPS[approval.stage] });
      } else if (liveSignoff(events, approval.stage, approval.at)) {
        upstream.push({ ...named, reason: 'stage precedes amended stage' });
      }
    }
    return { path: `amendments[${a.index}]`, target: a.target, lapsed, upstream, keep_by_binding: kept };
  });
}

export const AMEND_HELP = `amend:
  <stage> [<project dir>]  record a forward amendment, retaining project.stage
  --kind <kind>           part, config-field, motion-track, interview-answer or draft
  --target <id>           artifact id, config pointer, track id, answer id or path, or draft id
  --change <file>         new input under the project, hashed by the writer (repeatable)
  --by <who>              human signer (agent is refused)
  --verbatim-file <file>  unchanged UTF-8 words, or - for stdin (default)
  --source <text>         optional origin, separate from verbatim
  --owner-chat <file> --said-at <ISO> --relayed-by <who>
                          required for a registered draft at parts-review or changed parts at rigging
  --json                  print the amendment record
  The clock supplies at. The owning stage and every later approval lapse.
  Upstream steps keep their state. An interview-answer amendment resets only
  the steps that rest on that answer and keeps the other steps' checkpoints.`;

export function amendCommand(args: string[], now: number): { stdout: string; exit: number } {
  const opts: Record<string, string> = {};
  const positional: string[] = [];
  const files: string[] = [];
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === '--json') json = true;
    else if (['--kind', '--target', '--change', '--by', '--verbatim-file', '--source', ...OWNER_CHAT_FLAGS].includes(arg)) {
      const value = args[++i];
      if (value === undefined || !value.trim() || (arg !== '--change' && arg in opts)) refuse('AMENDMENT_OPTION_INVALID', `amendments: ${arg} needs one non-empty value; see amend help`, USAGE_EXIT);
      if (arg === '--change') files.push(value);
      else opts[arg] = value;
    } else if (arg.startsWith('-')) refuse('UNKNOWN_OPTION', `amendments: unsupported ${arg}; see amend help`, USAGE_EXIT);
    else positional.push(arg);
  }
  if (positional.length < 1 || positional.length > 2 || opts['--by'] === undefined || opts['--kind'] === undefined || opts['--target'] === undefined || files.length === 0) {
    refuse('AMENDMENT_OPTION_INVALID', 'amendments: supply an owning stage, --kind, --target, --change and --by; see amend help', USAGE_EXIT);
  }
  const dir = resolve(positional[1] ?? process.cwd());
  const { file, project } = readProject(dir);
  const before = structuredClone(project);
  const errors: Finding[] = [];
  collectAmendments(project, errors);
  if (errors[0] !== undefined) refuse(errors[0].code, errors[0].message);
  const entry: JsonObject = {
    target: { stage: positional[0] as string, kind: opts['--kind'], id: opts['--target'] },
    by: opts['--by'], at: new Date(now).toISOString(), verbatim: '', changes: [],
  };
  if (opts['--source'] !== undefined) entry.source = opts['--source'];
  const riggingDraft = opts['--kind'] === 'draft' && project.stage === 'rigging';
  if (opts['--kind'] === 'interview-answer'
    && !collectItems(project, { collection: loadCollection(dir, project) }).some(item => item.id === opts['--target'] || item.path === opts['--target'])) {
    refuse('AMENDMENT_TARGET_INVALID', `amendments.target: interview-answer ${opts['--target']} names no question of this interview; name the changed answer by its question id or answer path`);
  }
  if (opts['--kind'] === 'draft' && project.stage !== 'parts-review' && !riggingDraft) {
    refuse('AMENDMENT_TARGET_INVALID', 'amendments.target: review a draft correction at parts-review or amend changed parts at rigging');
  }
  const chat = readOwnerChat(opts, opts['--by'], now, 'amendments');
  if (chat) {
    const { owner_words, ...authority } = chat;
    Object.assign(entry, authority, { verbatim: owner_words });
  }
  // Check the entry before reading change files or legacy verbatim words.
  entry.changes = files.map(path => ({ path, sha256: '0'.repeat(64) }));
  const entryErrors: Finding[] = [];
  collectAmendments({ drafts: project.drafts, amendments: [entry] }, entryErrors);
  if (entryErrors[0] !== undefined) refuse(entryErrors[0].code, entryErrors[0].message);
  entry.changes = files.map(path => {
    try {
      const canonical = realpathSync(resolve(dir, path));
      const local = relative(realpathSync(dir), canonical).split(sep).join('/');
      if (isAbsolute(path) || local === '' || local === '..' || local.startsWith('../')) throw new Error('new inputs must stay under the project');
      return { path: local, sha256: createHash('sha256').update(readFileSync(canonical)).digest('hex') };
    } catch (error) {
      refuse('AMENDMENT_INPUT_UNREAD', `amendments.changes ${path}: ${error instanceof Error ? error.message : String(error)}; retain the new input under the project and amend again`);
    }
  });
  if (riggingDraft) {
    if (checkProject(dir, project, { now, readOnly: true }).effective_stage !== 'rigging') {
      refuse('AMENDMENT_TARGET_INVALID', 'amendments.target: a rigging draft amendment needs effective rigging; resume the current review stage before amending');
    }
    const draft = asArray(project.drafts).filter(isObject).find(draft => draft.id === opts['--target'])!;
    assertDraftAmendmentChanges(draft, entry.changes, 'amendments.changes');
    const parts = draft.parts as JsonObject;
    const inventory = changedDraftInventory(project, draft, now);
    const root = realpathSync(dir);
    for (const binding of inventory) {
      const path = `${parts.path}/${binding.path}`;
      let bytes: Buffer;
      try { bytes = publicationFile(root, path); }
      catch { refuse('AMENDMENT_INPUT_UNREAD', `amendments.changes ${path}: restore the target draft's registered parts file before amending`); }
      if (createHash('sha256').update(bytes).digest('hex') !== binding.sha256) {
        refuse('AMENDMENT_CHANGES_INVALID', `amendments.changes ${path}: bytes differ from the registered target draft; restore them or register a new draft`);
      }
    }
  }
  if (!chat) entry.verbatim = readVerbatim(opts['--verbatim-file'] ?? '-');
  project.amendments = [...asArray(project.amendments), entry];
  for (const step of amendmentLapsedSteps(project, entry.target as JsonObject)) step.status = 'pending';
  const rejected = newRefusals(dir, before, project, { now })[0];
  if (rejected !== undefined) refuse(rejected.code, rejected.message);
  writeFileSync(file, `${JSON.stringify(project, null, 2)}\n`);
  return { stdout: json ? JSON.stringify(entry, null, 2) : `amend: ${String(positional[0])} ${String(opts['--target'])} by ${String(entry.by)} at ${String(entry.at)}; stage retained`, exit: 0 };
}
