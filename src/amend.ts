import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import { asArray, asString, checkProject, collectSignoffs, isObject, type Finding } from './check.ts';
import { readProject } from './feedback.ts';
import { readVerbatim } from './record-input.ts';
import { refuse, USAGE_EXIT } from './refusal.ts';
import { liveSignoff, type Reopen } from './reopen.ts';
import { stageIndex, stageOfStep } from './stages.ts';
import type { JsonObject } from './templates.ts';

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

/** Future binding cards may populate this list with independently proved approvals. Ships empty. */
export function keepByBinding(): AmendmentApproval[] {
  return [];
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
    if (!isObject(target) || !['part', 'config-field', 'motion-track', 'interview-answer'].includes(String(target.kind))
      || typeof target.id !== 'string' || !target.id.trim() || typeof target.stage !== 'string'
      || target.stage === 'accepted' || !Object.hasOwn(AMENDMENT_APPROVAL_GAPS, target.stage)) {
      invalid('AMENDMENT_TARGET_INVALID', `${path}.target`, 'needs kind, non-empty artifact id and a non-terminal owning stage');
      continue;
    }
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
    for (const approval of approvals) {
      if (approval.at > a.at || stageIndex(approval.stage) < 0) continue;
      const named = { path: approval.path, stage: approval.stage, ...('checkpoint' in approval ? { checkpoint: approval.checkpoint } : {}) };
      if (stageIndex(approval.stage) >= stageIndex(a.stage)) {
        lapsed.push({ ...named, reason: 'no binding proves independence', gap: AMENDMENT_APPROVAL_GAPS[approval.stage] });
      } else if (liveSignoff(events, approval.stage, approval.at)) {
        upstream.push({ ...named, reason: 'stage precedes amended stage' });
      }
    }
    return { path: `amendments[${a.index}]`, target: a.target, lapsed, upstream, keep_by_binding: keepByBinding() };
  });
}

export const AMEND_HELP = `amend:
  <stage> [<project dir>]  record a forward amendment, retaining project.stage
  --kind <kind>           part, config-field, motion-track or interview-answer
  --target <id>           artifact id, config pointer, track id or answer path
  --change <file>         new input under the project, hashed by the writer (repeatable)
  --by <who>              human signer (agent is refused)
  --verbatim-file <file>  unchanged UTF-8 words, or - for stdin (default)
  --source <text>         optional origin, separate from verbatim
  --json                  print the amendment record
  The clock supplies at. The owning stage and every later approval lapse.
  Upstream steps keep their state. keep-by-binding ships empty.`;

export function amendCommand(args: string[]): { stdout: string; exit: number } {
  const opts: Record<string, string> = {};
  const positional: string[] = [];
  const files: string[] = [];
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === '--json') json = true;
    else if (['--kind', '--target', '--change', '--by', '--verbatim-file', '--source'].includes(arg)) {
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
  const errors: Finding[] = [];
  collectAmendments(project, errors);
  if (errors[0] !== undefined) refuse(errors[0].code, errors[0].message);
  const entry: JsonObject = {
    target: { stage: positional[0] as string, kind: opts['--kind'], id: opts['--target'] },
    by: opts['--by'], at: new Date().toISOString(), verbatim: '', changes: [],
  };
  if (opts['--source'] !== undefined) entry.source = opts['--source'];
  // Check signer and target before reading stdin or any input file.
  entry.changes = files.map(path => ({ path, sha256: '0'.repeat(64) }));
  const entryErrors: Finding[] = [];
  collectAmendments({ amendments: [entry] }, entryErrors);
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
  entry.verbatim = readVerbatim(opts['--verbatim-file'] ?? '-');
  project.amendments = [...asArray(project.amendments), entry];
  for (const raw of asArray(isObject(project.plan) ? project.plan.steps : undefined)) {
    if (isObject(raw) && typeof raw.id === 'string' && (raw.phase === 'rig' || raw.phase === 'post')
      && stageIndex(stageOfStep(raw.phase, raw.id)) >= stageIndex(positional[0] as string)) raw.status = 'pending';
  }
  const rejected = checkProject(dir, project).refusals[0];
  if (rejected !== undefined) refuse(rejected.code, rejected.message);
  writeFileSync(file, `${JSON.stringify(project, null, 2)}\n`);
  return { stdout: json ? JSON.stringify(entry, null, 2) : `amend: ${String(positional[0])} ${String(opts['--target'])} by ${String(entry.by)} at ${String(entry.at)}; stage retained`, exit: 0 };
}
