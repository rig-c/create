import { selectAnswerHashes } from './signoff-answers.ts';
import { selectSignoffTarget } from './signoff-target.ts';
import { assertDirectionApproval } from './direction.ts';
import { assertCorrectionApproval } from './correction-writers.ts';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import { asArray, checkProject, classify, isObject, type Finding } from './check.ts';
import { checkDiffMap, diffReportBytes } from './diff-map.ts';
import { readProject } from './feedback.ts';
import { checkPartsVerdict, PARTS_VERDICT_KIND } from './parts-verdict.ts';
import { checkStructure, riggingContext, structurePathIsIgnored } from './structure.ts';
import { readVerbatim } from './record-input.ts';
import { refuse, USAGE_EXIT } from './refusal.ts';
import { approvalStageOfStep, hasStageOrder, PARTS_REVIEW, STAGE_ORDER_SPEC, STAGES, STAGE_VALUES, stageOfStep } from './stages.ts';
import { stepHash } from './step-hash.ts';
import type { JsonObject } from './templates.ts';

export const SIGNOFF_HELP = `signoff:
  <stage> [<project dir>]  record a human signature without moving project.stage
  --version <n>           reviewed rig or post version (single candidate defaults)
  --by <who>              the person signing (agent is refused)
  --verbatim-file <file>  UTF-8 words unchanged, or - for stdin (default: stdin)
  --steps <id,id,...>      narrow parts plan, rigging-interview rig steps, or post steps
  --checkpoint <id>       sign an enabled checkpoint in this execution stage
  --evidence <path>       required on parts-review, the approved parts verdict file
  --draft <id>            labelled draft approved at parts-review
  --structure-file <path> retained structure decisions snapshot
  --diff-report <path>    parts-review difference report, required from 2026-11-06
  --component <id>=<status>:<why>  repeat for every report component (parts-review only)
  --json                  print the signature as JSON
  The clock supplies at. With no --steps, signs all steps of the stage's phase.
  Fills null checkpoints from checkpoint_proposed and hashes covered steps after filling.
  Existing checkpoints are preserved. Parts-review validates evidence and the map before recording.`;

export function signoffCommand(args: string[]): { stdout: string; exit: number } {
  const opts: Record<string, string> = {};
  const positional: string[] = [];
  let json = false;
  const components: JsonObject[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') json = true;
    else if (arg === '--component') {
      const value = args[++i] ?? '';
      const eq = value.indexOf('=');
      const colon = value.indexOf(':', eq + 1);
      if (eq < 1 || colon < eq + 2) refuse('SIGNOFF_OPTION_INVALID', '--component needs <id>=<status>:<why>', USAGE_EXIT);
      const id = value.slice(0, eq);
      if (components.some((c) => c.id === id)) refuse('SIGNOFF_OPTION_INVALID', `duplicate component ${id}`, USAGE_EXIT);
      components.push({ id, status: value.slice(eq + 1, colon), why: value.slice(colon + 1) });
    } else if (['--version', '--draft', '--structure-file', '--diff-report', '--by', '--verbatim-file', '--steps', '--checkpoint', '--evidence'].includes(arg)) {
      const value = args[++i];
      if (arg in opts || value === undefined || value === '') refuse('SIGNOFF_OPTION_INVALID', `${arg} needs one non-empty value`, USAGE_EXIT);
      opts[arg] = value;
    } else if (arg.startsWith('-')) refuse('UNKNOWN_OPTION', `signoff does not take ${arg}`, USAGE_EXIT);
    else positional.push(arg);
  }
  const stage = positional[0];
  if (positional.length > 2 || stage === undefined || !STAGE_VALUES.includes(stage)) refuse('SIGNOFF_OPTION_INVALID', 'signoff takes a known stage and one optional project folder', USAGE_EXIT);
  const by = opts['--by'];
  if (by === undefined) refuse('SIGNOFF_OPTION_INVALID', 'signoff needs --by', USAGE_EXIT);
  if (by.toLowerCase() === 'agent') refuse('SIGNOFF_NOT_HUMAN', `stage ${stage}: signed by agent`);
  const dir = resolve(positional[1] ?? process.cwd());
  const { file, project } = readProject(dir);
  if (!Array.isArray(project.signoffs)) refuse('SIGNOFF_MALFORMED', 'signoffs must be a list');
  const checkpointId = opts['--checkpoint'];
  if (checkpointId !== undefined) {
    if (opts['--steps'] !== undefined) refuse('SIGNOFF_OPTION_INVALID', '--checkpoint and --steps cannot be combined', USAGE_EXIT);
    const spec = STAGES.find((spec) => spec.id === stage);
    const matches = asArray(isObject(project.plan) ? project.plan.steps : undefined)
      .filter((step): step is JsonObject => isObject(step) && step.id === checkpointId);
    const step = matches[0];
    if (matches.length !== 1 || spec?.phase === undefined || step.phase !== spec.phase || stageOfStep(spec.phase, checkpointId) !== stage) {
      refuse('SIGNOFF_CHECKPOINT_INVALID', `${checkpointId}: no unique step runs in stage ${stage}`);
    }
    const checkpoint = classify(step.checkpoint, { collection: null });
    const on = checkpoint.state === 'user' ? checkpoint.answer.value
      : checkpoint.state === 'delegated' && checkpoint.decided && isObject(checkpoint.answer.agent_decision) ? checkpoint.answer.agent_decision.value : undefined;
    if (on !== true) refuse('SIGNOFF_CHECKPOINT_INVALID', `${checkpointId}: checkpoint must be enabled before it can be signed`);
  }
  if ((stage === PARTS_REVIEW) !== (opts['--evidence'] !== undefined)) {
    refuse('SIGNOFF_OPTION_INVALID', '--evidence is required on parts-review and only accepted there', USAGE_EXIT);
  }
  if ((opts['--diff-report'] !== undefined || components.length > 0) && stage !== PARTS_REVIEW) {
    refuse('SIGNOFF_OPTION_INVALID', '--diff-report and --component are only accepted on parts-review', USAGE_EXIT);
  }
  if (components.length > 0 && opts['--diff-report'] === undefined) refuse('SIGNOFF_OPTION_INVALID', '--component requires --diff-report', USAGE_EXIT);
  let diffMap: JsonObject | undefined;
  if (opts['--diff-report'] !== undefined) {
    const path = opts['--diff-report'];
    try {
      const bytes = diffReportBytes(dir, path);
      diffMap = { report: { path, sha256: createHash('sha256').update(bytes).digest('hex') }, components };
    } catch (error) {
      refuse('DIFF_MAP_REPORT', `signoffs[${project.signoffs.length}].diff_map ${path}: ${error instanceof Error ? error.message : String(error)}; generate the report under the project and sign again with --diff-report`);
    }
  }
  let evidence: JsonObject | undefined;
  if (opts['--evidence'] !== undefined) {
    let verdictFile: string;
    try {
      verdictFile = realpathSync(resolve(dir, opts['--evidence']));
    } catch (error) {
      refuse('PARTS_VERDICT_UNREAD', `${opts['--evidence']}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const path = relative(realpathSync(dir), verdictFile).split(sep).join('/');
    if (path === '' || path.startsWith('..') || isAbsolute(path)) refuse('PARTS_VERDICT_UNREAD', 'the verdict must be under the project');
    let bytes: Buffer;
    try {
      bytes = readFileSync(verdictFile);
    } catch (error) {
      refuse('PARTS_VERDICT_UNREAD', `${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    evidence = { kind: PARTS_VERDICT_KIND, path, sha256: createHash('sha256').update(bytes).digest('hex') };
  }
  if ((opts['--draft'] !== undefined || opts['--structure-file'] !== undefined) && stage !== PARTS_REVIEW) refuse('SIGNOFF_OPTION_INVALID', '--draft and --structure-file require parts-review', USAGE_EXIT);
  if ((opts['--draft'] === undefined) !== (opts['--structure-file'] === undefined)) refuse('SIGNOFF_OPTION_INVALID', 'parts-review requires --draft and --structure-file together', USAGE_EXIT);
  const phase = stage === 'post-interview' ? 'post' : ['plan-approved', 'rigging-interview'].includes(stage) ? 'rig' : undefined;
  if (phase === undefined && opts['--steps'] !== undefined) refuse('SIGNOFF_OPTION_INVALID', '--steps requires plan-approved, rigging-interview or post-interview', USAGE_EXIT);
  const requested = opts['--steps']?.split(',');
  if (requested !== undefined && (requested.some((id) => id === '') || new Set(requested).size !== requested.length)) refuse('SIGNOFF_STEP_INVALID', '--steps needs distinct non-empty step ids', USAGE_EXIT);
  const steps = phase === undefined ? [] : asArray(isObject(project.plan) ? project.plan.steps : undefined)
    .filter((step): step is JsonObject => isObject(step) && step.phase === phase && approvalStageOfStep(phase as 'rig' | 'post', String(step.id), hasStageOrder(project) || stage === 'rigging-interview') === stage);
  for (const id of requested ?? []) {
    if (!steps.some((step) => step.id === id)) refuse('SIGNOFF_STEP_INVALID', `${id}: no step in phase ${phase}`);
  }
  const covered = steps.filter((step) => requested === undefined || requested.includes(step.id as string));
  if (phase !== undefined && covered.length === 0) refuse('SIGNOFF_STEP_INVALID', `no ${phase} steps to sign`);
  const ids = covered.map((step) => step.id);
  if (ids.some((id) => typeof id !== 'string' || id === '') || new Set(ids).size !== ids.length) refuse('SIGNOFF_STEP_INVALID', 'covered steps need distinct non-empty string ids');
  for (const step of covered) {
    if (typeof step.checkpoint_proposed !== 'boolean') refuse('SIGNOFF_CHECKPOINT_INVALID', `${String(step.id)}: checkpoint_proposed must be boolean`);
    const checkpoint = classify(step.checkpoint, { collection: null });
    if (checkpoint.state === 'silent') continue;
    const value = checkpoint.state === 'user' ? checkpoint.answer.value
      : checkpoint.state === 'delegated' && checkpoint.decided && isObject(checkpoint.answer.agent_decision) ? checkpoint.answer.agent_decision.value : undefined;
    if (typeof value !== 'boolean') refuse('SIGNOFF_CHECKPOINT_INVALID', `${String(step.id)}: checkpoint needs a boolean user answer or a decided boolean delegation`);
  }
  const verbatim = readVerbatim(opts['--verbatim-file'] ?? '-');
  const at = new Date().toISOString();
  if (evidence !== undefined) {
    const refusals: Finding[] = [];
    const record = { evidence, at, ...(diffMap === undefined ? {} : { diff_map: diffMap }) };
    const partsFile = checkPartsVerdict(dir, record, `signoffs[${project.signoffs.length}]`, refusals);
    checkDiffMap(dir, record, `signoffs[${project.signoffs.length}]`, partsFile, refusals, []);
    const first = refusals[0];
    if (first !== undefined) refuse(first.code, first.message);
  }
  const hashes: JsonObject = Object.create(null) as JsonObject;
  for (const step of covered) {
    if (step.checkpoint === null || step.checkpoint === undefined) {
      step.checkpoint = { delegated: false, by, at, verbatim, value: step.checkpoint_proposed };
    }
    hashes[step.id as string] = stepHash(step);
  }
  const signoff: JsonObject = { stage, checkpoint: checkpointId ?? null, by, at, verbatim };
  if (evidence !== undefined) signoff.evidence = evidence;
  if (diffMap !== undefined) signoff.diff_map = diffMap;
  if (phase !== undefined) {
    signoff.steps = ids;
    signoff.step_hashes = hashes;
  }
  const answerHashes = selectAnswerHashes(dir, project, signoff);
  if (answerHashes !== undefined) signoff.answer_hashes = answerHashes;
  if (stage === PARTS_REVIEW && (hasStageOrder(project) || opts['--structure-file'] !== undefined)) {
    signoff.draft_id = opts['--draft'] ?? null;
    const path = opts['--structure-file'];
    if (path !== undefined) {
      try {
        if (structurePathIsIgnored(dir, path)) throw new Error('structure snapshots must survive a clone; retain the file outside ignored roots, for example evidence/');
        const canonical = realpathSync(resolve(dir, path));
        const rel = relative(realpathSync(dir), canonical).split(sep).join('/');
        if (isAbsolute(path) || rel === '' || rel === '..' || rel.startsWith('../')) throw new Error('structure file must stay under the project');
        signoff.structure = { path: rel, sha256: createHash('sha256').update(readFileSync(canonical)).digest('hex') };
      } catch (error) { refuse('STRUCTURE_DECISIONS_INVALID', `signoffs.structure: ${error instanceof Error ? error.message : String(error)}; retain the structure snapshot under the project`); }
    }
    const errors: Finding[] = [];
    checkStructure(dir, project, signoff, `signoffs[${project.signoffs.length}]`, errors);
    if (errors[0] !== undefined) refuse(errors[0].code, errors[0].message);
  }
  if (stage === 'rigging-interview') {
    const errors: Finding[] = [];
    const context = riggingContext(dir, project, at, errors);
    if (errors[0] !== undefined) refuse(errors[0].code, errors[0].message);
    if (context !== null) { signoff.accepted_parts = context.accepted_parts as JsonObject; signoff.structure = context.structure as JsonObject; }
    if (!isObject(project.interview)) refuse('RIGGING_INTERVIEW_CONTEXT', 'interview: restore the interview record before adoption');
    project.interview.rigging_context = context;
    if (!hasStageOrder(project)) project.interview.order = { spec: STAGE_ORDER_SPEC, adopted_at: at };
    project.stage_values = [...STAGE_VALUES];
  }
  assertDirectionApproval(dir, project, stage);
  assertCorrectionApproval(dir, project, stage, signoff);
  const target = selectSignoffTarget(dir, project, stage, opts['--version']);
  if (target !== undefined) signoff.target = target;
  project.signoffs.push(signoff);
  if (hasStageOrder(project) || signoff.structure !== undefined || project.amendments !== undefined) {
    const first = checkProject(dir, project).refusals[0];
    if (first !== undefined) refuse(first.code, first.message);
  }
  writeFileSync(file, `${JSON.stringify(project, null, 2)}\n`);
  return { stdout: json ? JSON.stringify(signoff, null, 2) : `signoff: recorded ${stage} by ${by} at ${at}; stage unchanged`, exit: 0 };
}
