import { checkpointEnabled, checkpointRequired } from './plan-history.ts';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from './check-reads.ts';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import {
  asArray,
  checkProject,
  collectItems,
  collectSignoffs,
  isObject,
  loadCollection,
  postNotPassed,
  type CheckReport,
  type Finding,
} from './check.ts';
import { collectAmendments } from './amend.ts';
import {
  DIFF_MAP_AGENT_SINCE,
  DIFF_MAP_MAX_FLOOR_PX,
  DIFF_MAP_MAX_THRESHOLD,
  diffReportBytes,
  diffStackCandidates,
  reportShape,
  resolveDiffMapPartsFile,
  validateDiffMapRecord,
} from './diff-map.ts';
import { partsStructureSnapshot } from './job-acts.ts';
import { JOB_BINDING_FILE, type WriterBinding } from './job-outbox.ts';
import { isPartsCheckMove, partsCheckRecord } from './parts-check.ts';
import { recordedPartsVerdict } from './parts-verdict-record.ts';
import { pausedFrom } from './pause.ts';
import { carriedRefusals, findingKey, newFindings } from './refusal-baseline.ts';
import { refuse, USAGE_EXIT } from './refusal.ts';
import { reopenLapseWarnings } from './reopen-lapses.ts';
import { collectReopens, liveSignoff } from './reopen.ts';
import { acceptedReviewVerdict } from './review.ts';
import {
  advanceOrder,
  furthestStageSignoff,
  isSignoffIdentity,
  moveOwner,
  signoffIdentity,
  STEP_STATUSES,
} from './stage-progress.ts';
import {
  hasStageOrder,
  interviewStageOfGuide,
  LEGACY_STAGE_VALUES,
  PARTS_REVIEW_SINCE,
  PAUSED_STAGE,
  STAGE_VALUES,
  stageIndex,
  stageOfStep,
} from './stages.ts';
import type { Json, JsonObject } from './templates.ts';
import { sceneCurrentAt } from './scene.ts';

export const NEXT_SCHEMA = 'rig-create/next@1';

export const NEXT_HELP = `next [<project dir>] [--json]
  Derive the next moves and whose they are (agent | producer | human) from project.json.
  Refusals come first with their CHECKS.md remedy; writes nothing.`;

export type NextRole = 'agent' | 'producer' | 'human';

export interface NextRefusal {
  code: string;
  field: string;
  message: string;
  fix: string;
}

export interface NextReviewAct {
  kind: 'parts-verdict' | 'interview-picks' | 'review-verdict' | 'signoff' | 'signoff-checkpoint';
  stage: string;
  draft_id?: string;
  question_id?: string;
  option_set_id?: string;
  version_id?: string;
  review?: string;
  step_id?: string;
  job_id?: string;
}

export interface NextLapse {
  code: string;
  source_field: string;
  target_field: string;
  reopen_id?: string;
  amendment_id?: string;
  message: string;
}

export interface NextMove {
  role: NextRole;
  field: string;
  awaits: string;
  command: string | null;
  act: string;
  review_act?: NextReviewAct;
  lapse?: NextLapse;
  unanswered_by_record?: string;
}

export interface NextReport {
  schema: typeof NEXT_SCHEMA;
  project_id: string;
  stage: string;
  effective_stage: string;
  accepted: boolean;
  refusals: NextRefusal[];
  warnings?: Finding[];
  /** A view of existing answers, never a new project record. */
  answers?: { question_id: string; field: string; by: Json; at: Json; picks: { ask: Json; option_id: Json; label: Json }[]; command?: string }[];
  awaits: string[];
  moves: NextMove[];
}

const FATAL_CODES = new Set([
  'PROJECT_JSON_MISSING',
  'PROJECT_JSON_INVALID',
  'SCHEMA_UNKNOWN',
  'STAGE_UNKNOWN',
]);

let cachedRemedies: Map<string, string> | null = null;

function loadCheckRemedies(): Map<string, string> {
  if (cachedRemedies !== null) return cachedRemedies;
  const map = new Map<string, string>();
  try {
    const text = readFileSync(join(import.meta.dir, '../docs/CHECKS.md'), 'utf8');
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('| `')) continue;
      const cells = trimmed
        .split('|')
        .slice(1, -1)
        .map(cell => cell.trim());
      if (cells.length < 2) continue;
      const codeMatch = /^`([A-Z0-9_]+)`$/.exec(cells[0]!);
      if (!codeMatch) continue;
      const code = codeMatch[1]!;
      const remedy = cells[cells.length - 1]!;
      if (!map.has(code) && remedy.length > 0) map.set(code, remedy);
    }
  } catch {
    // Fallback to message remedy extraction if docs/CHECKS.md is unavailable.
  }
  cachedRemedies = map;
  return map;
}

export function remedyForFinding(code: string, message: string): string {
  const fromDoc = loadCheckRemedies().get(code);
  if (fromDoc !== undefined) return fromDoc;
  const semi = message.lastIndexOf('; ');
  return semi >= 0 ? message.slice(semi + 2).trim() : message;
}

function parseArgs(args: string[]): { dir: string; json: boolean } {
  const positional: string[] = [];
  let json = false;
  for (const arg of args) {
    if (arg === '--json') json = true;
    else if (arg.startsWith('-')) {
      refuse('NEXT_USAGE', `next: unsupported ${arg}; usage: rig-create next [<project dir>] [--json]`, USAGE_EXIT);
    } else {
      positional.push(arg);
    }
  }
  if (positional.length > 1) {
    refuse('NEXT_USAGE', 'next: expected at most one project directory; usage: rig-create next [<project dir>] [--json]', USAGE_EXIT);
  }
  return { dir: resolve(positional[0] ?? process.cwd()), json };
}

function readOptionalJobId(dir: string): string | undefined {
  try {
    const file = join(dir, JOB_BINDING_FILE);
    if (!existsSync(file)) return undefined;
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<WriterBinding>;
    return typeof raw?.jobId === 'string' && raw.jobId.length > 0 ? raw.jobId : undefined;
  } catch {
    return undefined;
  }
}

function isOpenInterviewStage(stage: string): boolean {
  return stage === 'interview' || stage === 'rigging-interview' || stage === 'post-interview';
}

function isOpenInterviewTodo(finding: Finding, effectiveStage: string): boolean {
  return isOpenInterviewStage(effectiveStage) && finding.code === 'INTERVIEW_INCOMPLETE';
}

function shellWord(value: string): string {
  return /^[A-Za-z0-9_./:-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

function optionCommand(id: string, dir: string): string {
  return `rig-create interview-options ${shellWord(id)} ${shellWord(dir)} --file '<option-set.json>'`;
}

function candidateAdvance(
  dir: string,
  project: JsonObject,
  targetStage: string,
  now: number,
  partsCheck?: { report: string; root: string },
): string | null {
  const clone = structuredClone(project);
  const history: Finding[] = [];
  const reopens = collectReopens(clone, history);
  const latest = furthestStageSignoff(
    collectSignoffs(clone, history).filter(s => liveSignoff(reopens, s.stage, s.at)),
  );
  if (latest === undefined || !Number.isFinite(latest.at)) return null;
  const preParts =
    !hasStageOrder(clone) &&
    stageIndex(String(clone.stage)) > stageIndex('parts-review') &&
    collectSignoffs(clone, []).some(
      s => s.stage === 'plan-approved' && s.checkpoint === null && s.at < Date.parse(PARTS_REVIEW_SINCE),
    );
  const steps = asArray(isObject(clone.plan) ? clone.plan.steps : undefined).filter(isObject);
  const entry: JsonObject = {
    stage: targetStage,
    from_stage: clone.stage ?? null,
    at: new Date(now).toISOString(),
    post_not_passed: postNotPassed({ items: collectItems(clone, { collection: loadCollection(dir) }) }),
    order: preParts ? 'pre-parts' : hasStageOrder(clone) ? 'split' : 'legacy',
    signoffs_before: asArray(clone.signoffs).filter(isObject).map(signoffIdentity).filter(isSignoffIdentity),
    signoff: signoffIdentity(latest.record),
    steps_before: steps.map(s => ({
      id: s.id ?? null,
      phase: s.phase ?? null,
      ...(s.status === undefined ? {} : { status: s.status }),
    })),
  };
  const order = advanceOrder(entry.order);
  const owner = moveOwner(order, entry.from_stage);
  if (
    history.length === 0 &&
    owner !== undefined &&
    order.findIndex(s => s.id === latest.stage) < order.findIndex(s => s.id === owner)
  ) {
    return null;
  }
  if (clone.advances !== undefined && !Array.isArray(clone.advances)) return null;
  const checkPath = `advances[${asArray(clone.advances).length}].parts_check`;
  if (isPartsCheckMove(entry)) {
    if (!partsCheck) return null;
    const read = partsCheckRecord(dir, partsCheck.report, partsCheck.root, checkPath);
    if ('refusal' in read) return null;
    entry.parts_check = read.record;
  } else if (partsCheck) {
    return null;
  }
  clone.advances = [...asArray(clone.advances), entry];
  clone.stage = targetStage;
  clone.stage_values = [...(hasStageOrder(clone) ? STAGE_VALUES : LEGACY_STAGE_VALUES)];
  const allowed = new Map<string, number>();
  if (['rigging-interview', 'post-interview'].includes(targetStage)) {
    for (const item of collectItems(clone, { collection: loadCollection(dir) })) {
      if (
        item.state.state !== 'silent' ||
        interviewStageOfGuide(item.id, item.kind === 'post', hasStageOrder(clone)) !== targetStage
      ) {
        continue;
      }
      const key = findingKey({ code: 'INTERVIEW_INCOMPLETE', path: item.path });
      allowed.set(key, (allowed.get(key) ?? 0) + 1);
    }
  }
  const checked = checkProject(dir, clone, { now, forwardWrite: true, readOnly: true });
  if (newFindings(allowed, checked.refusals).length > 0) return null;
  return partsCheck
    ? `rig-create advance ${targetStage} ${shellWord(dir)} --parts-check ${shellWord(partsCheck.report)} --parts ${shellWord(partsCheck.root)}`
    : `rig-create advance ${targetStage} ${shellWord(dir)}`;
}

function candidateStepStatus(
  dir: string,
  project: JsonObject,
  stepId: string,
  nextStatus: string,
  now: number,
): string | null {
  const before = structuredClone(project);
  const clone = structuredClone(project);
  const matches = asArray(isObject(clone.plan) ? clone.plan.steps : undefined).filter(
    (s): s is JsonObject => isObject(s) && s.id === stepId,
  );
  const step = matches[0];
  if (matches.length !== 1 || step === undefined || (step.phase !== 'rig' && step.phase !== 'post')) return null;
  const stage = stageOfStep(step.phase, String(step.id));
  const resumes =
    clone.stage !== PAUSED_STAGE && collectAmendments(clone, []).length > 0
      ? checkProject(dir, structuredClone(clone), { now, readOnly: true }).effective_stage
      : null;
  const running =
    resumes !== null && resumes !== clone.stage ? [String(clone.stage), resumes] : [String(clone.stage)];
  const oldOrder =
    !hasStageOrder(clone) &&
    running.includes('rigging') &&
    collectSignoffs(clone, []).some(s => s.stage === 'plan-approved' && s.at < Date.parse(PARTS_REVIEW_SINCE));
  if (!running.includes(stage) && !(oldOrder && step.phase === 'rig')) return null;

  const enabled = checkpointRequired(clone, step, now);
  const entry: JsonObject = {
    from_status: step.status ?? 'pending',
    status: nextStatus,
    by: 'agent',
    at: new Date(now).toISOString(),
    checkpoint_required: enabled,
    signoff: null,
  };
  const from = STEP_STATUSES.indexOf(entry.from_status as (typeof STEP_STATUSES)[number]);
  if (from < 0 || STEP_STATUSES.indexOf(nextStatus as (typeof STEP_STATUSES)[number]) !== from + 1) return null;
  if (nextStatus === 'done' && enabled) {
    const reopens = collectReopens(clone, []);
    const signature = collectSignoffs(clone, [])
      .filter(
        s =>
          s.checkpoint === step.id &&
          (s.stage === stage || (oldOrder && s.stage === 'rigging')) &&
          liveSignoff(reopens, s.stage, s.at) &&
          s.at <= Date.parse(String(entry.at)),
      )
      .sort((a, b) => b.at - a.at || b.index - a.index)[0];
    if (signature === undefined) return null;
    entry.signoff = signoffIdentity(signature.record);
  }
  if (step.status_history !== undefined && !Array.isArray(step.status_history)) return null;
  step.status_history = [...asArray(step.status_history), entry];
  step.status = nextStatus;
  clone.stage_values = [...(hasStageOrder(clone) ? STAGE_VALUES : LEGACY_STAGE_VALUES)];
  const allowed = carriedRefusals(dir, before, { now, forwardWrite: false });
  const checked = checkProject(dir, clone, { now, forwardWrite: false, readOnly: true });
  if (newFindings(allowed, checked.refusals).length > 0) return null;
  return `rig-create step-status ${shellWord(stepId)} ${nextStatus} ${shellWord(dir)} --by agent`;
}

function nextStageInOrder(project: JsonObject, currentStage: string): string | null {
  const order = hasStageOrder(project) ? STAGE_VALUES : LEGACY_STAGE_VALUES;
  const idx = order.indexOf(currentStage);
  if (idx < 0 || idx + 1 >= order.length) return null;
  const candidate = order[idx + 1]!;
  return candidate === PAUSED_STAGE ? null : candidate;
}

function resolveLaggingAdvance(
  dir: string,
  project: JsonObject,
  stage: string,
  now: number,
): { targetStage: string; command: string } | null {
  const nextStage = nextStageInOrder(project, stage);
  if (nextStage === null) return null;
  if (stage === 'parts' && nextStage === 'parts-review') {
    const drafts = asArray(project.drafts).filter(isObject);
    const latestDraft = drafts[drafts.length - 1];
    const partsRoot =
      isObject(latestDraft?.parts) && typeof latestDraft.parts.path === 'string'
        ? latestDraft.parts.path
        : undefined;
    if (partsRoot !== undefined && existsSync(join(dir, 'evidence/parts-check.json'))) {
      const cmd = candidateAdvance(dir, project, nextStage, now, {
        report: 'evidence/parts-check.json',
        root: partsRoot,
      });
      if (cmd !== null) return { targetStage: nextStage, command: cmd };
    }
    return null;
  }
  if (stage === 'post' && (!asArray(project.scenes).length || !asArray(project.versions).some(v => isObject(v) && v.kind === 'post'))) return null;
  const cmd = candidateAdvance(dir, project, nextStage, now);
  return cmd !== null ? { targetStage: nextStage, command: cmd } : null;
}

function hasApprovedPartsVerdictReceipt(dir: string, project: JsonObject, draftId: string | undefined): boolean {
  if (draftId === undefined) return false;
  try {
    recordedPartsVerdict(dir, project, draftId);
    return true;
  } catch {
    return false;
  }
}

function resolveDraftStackPath(
  dir: string,
  partsRoot: string,
  draftReport: JsonObject | null,
): { stackPath: string; singleCandidate: boolean } {
  const candidates = diffStackCandidates(resolve(dir, partsRoot, 'parts.json'));
  const present = candidates.filter(file => existsSync(file));
  if (present.length === 1) {
    return {
      stackPath: relative(dir, present[0]!).split(sep).join('/'),
      singleCandidate: true,
    };
  }
  if (isObject(draftReport?.stack) && typeof draftReport.stack.path === 'string') {
    const recorded = draftReport.stack.path.trim();
    if (recorded.length > 0 && existsSync(join(dir, recorded))) {
      return { stackPath: recorded, singleCandidate: false };
    }
  }
  if (basename(partsRoot) === 'rig' && existsSync(resolve(dir, partsRoot, '..', 'render'))) {
    return {
      stackPath: relative(dir, resolve(dir, partsRoot, '..', 'render', 'recomposite_rig.png')).split(sep).join('/'),
      singleCandidate: false,
    };
  }
  return { stackPath: `${partsRoot}/recomposite_rig.png`, singleCandidate: false };
}

function resolveDraftFigureMaskPath(dir: string, partsRoot: string, stackPath: string): string | undefined {
  let maskName: string | undefined;
  try {
    const rawParts = JSON.parse(readFileSync(resolve(dir, partsRoot, 'parts.json'), 'utf8')) as Json;
    if (isObject(rawParts) && isObject(rawParts.scene) && typeof rawParts.scene.figure_mask === 'string') {
      const trimmed = rawParts.scene.figure_mask.trim();
      if (trimmed.length > 0) maskName = trimmed;
    }
  } catch {
    // Fallback to checking figure_rig.png presence if parts.json is unreadable.
  }
  const names = maskName ? [maskName] : ['figure_rig.png'];
  const searchDirs = [dirname(stackPath), partsRoot];
  for (const name of names) {
    for (const base of searchDirs) {
      const candidate = resolve(dir, base, name);
      if (existsSync(candidate)) {
        return relative(dir, candidate).split(sep).join('/');
      }
    }
  }
  if (maskName !== undefined) {
    return relative(dir, resolve(dir, dirname(stackPath), maskName)).split(sep).join('/');
  }
  return undefined;
}

function resolveDiffComponentsMove(
  dir: string,
  draftId: string,
  partsRoot: string,
  paintingPath: string,
): { command: string; act: string } {
  const draftReportPath = `derived/drafts/${draftId}/diff-components.json`;
  let draftReport: JsonObject | null = null;
  if (existsSync(join(dir, draftReportPath))) {
    try {
      const bytes = diffReportBytes(dir, draftReportPath);
      const parsed = JSON.parse(bytes.toString('utf8')) as Json;
      if (isObject(parsed) && reportShape(parsed)) {
        draftReport = parsed;
      }
    } catch {
      draftReport = null;
    }
  }

  const { stackPath, singleCandidate } = resolveDraftStackPath(dir, partsRoot, draftReport);
  const figureMaskPath = resolveDraftFigureMaskPath(dir, partsRoot, stackPath);

  if (draftReport !== null && singleCandidate) {
    try {
      const components = draftReport.components as { id: string }[];
      const uniqueIds = new Set(components.map(c => c.id)).size === components.length;
      const definition = draftReport.definition as {
        floor_px: number;
        threshold: number;
        inside_sha256: string | null;
      };
      const withinPolicy =
        definition.floor_px <= DIFF_MAP_MAX_FLOOR_PX && definition.threshold <= DIFF_MAP_MAX_THRESHOLD;
      const maskSatisfied = figureMaskPath === undefined || definition.inside_sha256 !== null;
      if (uniqueIds && withinPolicy && maskSatisfied) {
        const stackSha = createHash('sha256').update(diffReportBytes(dir, stackPath)).digest('hex');
        const paintingSha = createHash('sha256').update(diffReportBytes(dir, paintingPath)).digest('hex');
        const recordedStackSha = (draftReport.stack as { sha256: string }).sha256;
        const recordedPaintingSha = (draftReport.painting as { sha256: string }).sha256;
        if (stackSha === recordedStackSha && paintingSha === recordedPaintingSha) {
          return {
            command: `cp ${shellWord(resolve(dir, draftReportPath))} ${shellWord(resolve(dir, 'evidence/diff-components.json'))}`,
            act: `copy ${draftReportPath} for drafts[${draftId}] to evidence/diff-components.json`,
          };
        }
      }
    } catch {
      // Fall through to rig-parts diff-components command if verification fails.
    }
  }

  const figureFlag = figureMaskPath !== undefined ? ` --figure ${shellWord(resolve(dir, figureMaskPath))}` : '';
  return {
    command: `rig-parts diff-components --stack ${shellWord(resolve(dir, stackPath))} --painting ${shellWord(resolve(dir, paintingPath))} --parts ${shellWord(resolve(dir, partsRoot, 'parts.json'))}${figureFlag} --floor 2 --threshold 40 --out ${shellWord(resolve(dir, 'evidence/diff-components.json'))}`,
    act: `run rig-parts diff-components for drafts[${draftId}]`,
  };
}

function hasValidDiffMap(dir: string, project: JsonObject): boolean {
  const partsFile = resolveDiffMapPartsFile(dir, project);
  if (isObject(project.diff_map)) {
    const errors: Finding[] = [];
    validateDiffMapRecord(dir, project.diff_map, 'diff_map', partsFile, errors, {
      requireAgent: true,
    });
    if (errors.length === 0) return true;
  }
  const reopens = collectReopens(project, []);
  const livePartsReview = collectSignoffs(project, []).filter(
    s => s.stage === 'parts-review' && s.checkpoint === null && liveSignoff(reopens, s.stage, s.at),
  );
  const latest = livePartsReview[livePartsReview.length - 1];
  if (
    latest !== undefined &&
    latest.at < Date.parse(DIFF_MAP_AGENT_SINCE) &&
    isObject(latest.record.diff_map)
  ) {
    const errors: Finding[] = [];
    validateDiffMapRecord(dir, latest.record.diff_map, `signoffs[${latest.index}].diff_map`, partsFile, errors, {
      requireAgent: false,
    });
    if (errors.length === 0) return true;
  }
  return false;
}

function resolveDiffClassesCommand(dir: string): string {
  if (!existsSync(join(dir, 'evidence/diff-triage.json'))) {
    try {
      const bytes = diffReportBytes(dir, 'evidence/diff-components.json');
      const parsed = JSON.parse(bytes.toString('utf8')) as Json;
      if (isObject(parsed) && reportShape(parsed) && (parsed.components as unknown[]).length === 0) {
        return `rig-create diff-classes ${shellWord(dir)} --diff-report evidence/diff-components.json --by agent`;
      }
    } catch {
      // Fall through to default command with --triage-file.
    }
  }
  return `rig-create diff-classes ${shellWord(dir)} --diff-report evidence/diff-components.json --triage-file evidence/diff-triage.json --by agent`;
}

export function nextProject(projectDirArg: string, now: number = Date.now()): NextReport {
  const dir = resolve(projectDirArg);
  const report: CheckReport = checkProject(dir, undefined, { now, readOnly: true });
  const fatal = report.refusals.find(r => FATAL_CODES.has(r.code));
  if (fatal !== undefined) refuse(fatal.code, fatal.message);

  const project = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
  const stage = String(project.stage ?? '');
  const effectiveStage = String(report.effective_stage ?? stage);
  const structureWarnings = report.warnings.filter(w => w.code === 'STRUCTURE_DELTA_REVIEW');
  const answers = collectItems(project, { collection: loadCollection(dir) }).flatMap(item => {
    const answer = item.state.state === 'user' || item.state.state === 'delegated' || item.state.state === 'not_applicable'
      ? item.state.answer : isObject(item.raw) ? item.raw : null;
    if (!answer) return [];
    return [{ question_id: item.id, field: item.path, by: answer.by ?? null, at: answer.at ?? null,
      picks: asArray(isObject(answer.choice) ? answer.choice.picks : undefined).filter(isObject).map(pick => ({
        ask: pick.ask ?? null, option_id: pick.option_id ?? null, label: isObject(pick.shown) ? pick.shown.label ?? null : null,
      })),
      ...(interviewStageOfGuide(item.id, item.kind === 'post', hasStageOrder(project)) === effectiveStage
        ? { command: optionCommand(item.id, dir) } : {}) }];
  });
  const warningFields = { ...(structureWarnings.length ? { warnings: structureWarnings } : {}), answers };
  const jobId = readOptionalJobId(dir);
  const holes = report.holes ?? [];

  const allRefusalFindings: Finding[] = [...report.refusals, ...holes];
  const refusals: NextRefusal[] = allRefusalFindings.map(r => ({
    code: r.code,
    field: r.path,
    message: r.message,
    fix: remedyForFinding(r.code, r.message),
  }));

  const laggingAdvance = report.refusals.some(r => r.code === 'STAGE_LAGGING')
    ? resolveLaggingAdvance(dir, project, stage, now)
    : null;
  const isResolvableLagging = (finding: Finding): boolean =>
    finding.code === 'STAGE_LAGGING' && (laggingAdvance !== null || stage === 'post' && (!asArray(project.scenes).length || !asArray(project.versions).some(v => isObject(v) && v.kind === 'post')));

  const hasBlockingRefusal =
    holes.length > 0 ||
    report.refusals.some(r => !isOpenInterviewTodo(r, effectiveStage) && !isResolvableLagging(r));
  if (hasBlockingRefusal) {
    return {
      schema: NEXT_SCHEMA,
      project_id: String(project.name ?? ''),
      stage,
      effective_stage: effectiveStage,
      accepted: false,
      refusals,
      ...warningFields,
      awaits: [],
      moves: [],
    };
  }

  const awaitsList: string[] = [];
  const addAwait = (target: string): void => {
    if (!awaitsList.includes(target)) awaitsList.push(target);
  };
  const moves: NextMove[] = [];
  // The check owns bounce/withdrawal/answer logic; consume its open findings.
  const openFeedback = report.warnings.filter(w => w.code === 'FEEDBACK_OPEN');
  if (openFeedback.length > 0) {
    const versions = asArray(project.versions).filter(isObject);
    const n = Math.max(0, ...versions.map(v => Number(v.n) || 0)) + 1;
    const groups = new Map<string, { version: number; verdict: number }[]>();
    for (const finding of openFeedback) {
      const summary = report.feedback.find(f => f.verdict === finding.path);
      if (!summary) continue;
      const kind = versions.find(v => v.n === summary.version)?.kind;
      if (kind !== 'rig' && kind !== 'post') continue;
      groups.set(kind, [...(groups.get(kind) ?? []), { version: summary.version, verdict: summary.index }]);
    }
    for (const [kind, refs] of groups) {
      const field = `versions[n=${n}]`;
      addAwait(field);
      const writer = kind === 'rig' ? `rig-version ${n}` : `direction write ${n}`;
      const inputs = kind === 'rig'
        ? '--parts <dir> --rig <dir> --build <dir> --idle <dir> --config <file> --path-adapter <file> --compile-report <file> --toolchain-lock <file> --run-record <run.json> --at-source <file> --at-pointer <pointer> --by <agent>'
        : '--file <direction.json> --rig <rig-version>';
      moves.push({ role: 'agent', field: 'versions', awaits: field,
        command: `rig-create ${writer} ${shellWord(dir)} ${inputs.replace(/<[^>]+>/g, shellWord)} ${refs.map(r => `--answers ${r.version}:${r.verdict}`).join(' ')}`,
        act: `build the next ${kind} version with ${writer}, recording answers_feedback ${JSON.stringify(refs)}` });
    }
    if (moves.length > 0) return { schema: NEXT_SCHEMA, project_id: String(project.name ?? ''), stage, effective_stage: effectiveStage, accepted: false, refusals, ...warningFields, awaits: awaitsList, moves };
  }
  const recordedLapseTargets = new Set<string>();
  const steps = asArray(isObject(project.plan) ? project.plan.steps : undefined).filter(isObject);
  const withdrawnCheckpoint = (id: string): boolean => steps.some(step => step.id === id
    && checkpointEnabled(step) && !checkpointRequired(project, step, now));

  // 1. Derive lapsed approvals from reopens[] and amendments[].
  const rawSignoffs = asArray(project.signoffs).filter(isObject);
  const rawReopens = asArray(project.reopens).filter(isObject);
  for (const warning of reopenLapseWarnings(project)) {
    const reopenMatch = /\(reopens\[(\d+)\]\)/.exec(warning.message);
    const reopenIdx = reopenMatch ? Number(reopenMatch[1]) : Math.max(0, rawReopens.length - 1);
    const reopenEntry = rawReopens[reopenIdx];
    const reopenId = typeof reopenEntry?.id === 'string' ? reopenEntry.id : undefined;
    const reopenField = `reopens[${reopenIdx}]`;

    if (warning.code === 'REOPEN_SIGNOFF_LAPSED') {
      const signoffMatch = /^signoffs\[(\d+)\]$/.exec(warning.path);
      const signoffEntry = signoffMatch ? rawSignoffs[Number(signoffMatch[1])] : undefined;
      const lapsedStage = typeof signoffEntry?.stage === 'string' ? signoffEntry.stage : effectiveStage;
      const checkpoint = typeof signoffEntry?.checkpoint === 'string' ? signoffEntry.checkpoint : null;
      if (checkpoint !== null && withdrawnCheckpoint(checkpoint)) continue;
      const awaitTarget = checkpoint
        ? `signoffs[checkpoint=${checkpoint}]`
        : `signoffs[stage=${lapsedStage}]`;
      addAwait(awaitTarget);
      recordedLapseTargets.add(awaitTarget);
      moves.push({
        role: 'human',
        field: reopenField,
        awaits: awaitTarget,
        command: null,
        act: checkpoint
          ? `re-approve lapsed checkpoint ${checkpoint} (${warning.path}, lapsed by ${reopenField}${reopenId ? ` ${reopenId}` : ''}: ${warning.code}) via review-tool act signoff-checkpoint`
          : `re-approve lapsed stage ${lapsedStage} (${warning.path}, lapsed by ${reopenField}${reopenId ? ` ${reopenId}` : ''}: ${warning.code}) via review-tool act signoff`,
        review_act: {
          kind: checkpoint ? 'signoff-checkpoint' : 'signoff',
          stage: lapsedStage,
          ...(checkpoint ? { step_id: checkpoint } : {}),
          ...(jobId ? { job_id: jobId } : {}),
        },
        lapse: {
          code: warning.code,
          source_field: reopenField,
          target_field: warning.path,
          ...(reopenId ? { reopen_id: reopenId } : {}),
          message: warning.message,
        },
      });
    } else if (warning.code === 'REOPEN_VERDICT_LAPSED') {
      const vMatch = /^versions\[v(\d+)\]\.verdicts\[(\d+)\]$/.exec(warning.path);
      const n = vMatch ? Number(vMatch[1]) : 1;
      const versionEntry = asArray(project.versions)
        .filter(isObject)
        .find(v => v.n === n);
      const verdictIdx = vMatch ? Number(vMatch[2]) : 0;
      const verdictEntry = isObject(versionEntry)
        ? asArray(versionEntry.verdicts).filter(isObject)[verdictIdx]
        : undefined;
      const reviewStage =
        typeof verdictEntry?.review === 'string'
          ? verdictEntry.review
          : versionEntry?.kind === 'post'
            ? 'direction-review'
            : 'rig-review';
      const awaitTarget = `versions[n=${n}].verdicts[review=${reviewStage}]`;
      addAwait(awaitTarget);
      recordedLapseTargets.add(awaitTarget);
      moves.push({
        role: 'human',
        field: reopenField,
        awaits: awaitTarget,
        command: null,
        act: `re-approve lapsed ${reviewStage} verdict on versions[v${n}] (${warning.path}, lapsed by ${reopenField}${reopenId ? ` ${reopenId}` : ''}: ${warning.code}) via review-tool act review-verdict`,
        review_act: {
          kind: 'review-verdict',
          stage: reviewStage,
          version_id: `v${n}`,
          review: reviewStage,
          ...(jobId ? { job_id: jobId } : {}),
        },
        lapse: {
          code: warning.code,
          source_field: reopenField,
          target_field: warning.path,
          ...(reopenId ? { reopen_id: reopenId } : {}),
          message: warning.message,
        },
      });
    }
  }

  for (const amendment of report.amendments ?? []) {
    const amendField = amendment.path;
    const targetId = typeof amendment.target.id === 'string' ? amendment.target.id : undefined;
    for (const lapsedApproval of amendment.lapsed) {
      const targetStage = lapsedApproval.stage;
      const checkpoint = lapsedApproval.checkpoint ?? null;
      if (checkpoint !== null && withdrawnCheckpoint(checkpoint)) continue;
      const awaitTarget = checkpoint
        ? `signoffs[checkpoint=${checkpoint}]`
        : `signoffs[stage=${targetStage}]`;
      if (recordedLapseTargets.has(awaitTarget)) continue;
      addAwait(awaitTarget);
      recordedLapseTargets.add(awaitTarget);
      moves.push({
        role: 'human',
        field: amendField,
        awaits: awaitTarget,
        command: null,
        act: `re-approve ${lapsedApproval.path} (${targetStage}) lapsed by ${amendField}${targetId ? ` (${targetId})` : ''} via review-tool act ${checkpoint ? 'signoff-checkpoint' : 'signoff'}`,
        review_act: {
          kind: checkpoint ? 'signoff-checkpoint' : 'signoff',
          stage: targetStage,
          ...(checkpoint ? { step_id: checkpoint } : {}),
          ...(jobId ? { job_id: jobId } : {}),
        },
        lapse: {
          code: 'AMENDED_STEP',
          source_field: amendField,
          target_field: lapsedApproval.path,
          ...(targetId ? { amendment_id: targetId } : {}),
          message: lapsedApproval.reason,
        },
      });
    }
  }

  // 2. If accepted and no lapses remain, there are no remaining moves.
  if (effectiveStage === 'accepted' && moves.length === 0) {
    return {
      schema: NEXT_SCHEMA,
      project_id: String(project.name ?? ''),
      stage,
      effective_stage: effectiveStage,
      accepted: true,
      refusals,
      ...warningFields,
      awaits: [],
      moves: [],
    };
  }

  // 3. Stage-specific derivation from project.json.
  const reopens = collectReopens(project, []);
  const signoffs = collectSignoffs(project, []);
  const hasLiveStageSignoff = (targetStage: string): boolean =>
    signoffs.some(s => s.stage === targetStage && s.checkpoint === null && liveSignoff(reopens, s.stage, s.at));
  const hasLiveCheckpointSignoff = (targetStage: string, stepId: string): boolean =>
    signoffs.some(s => s.stage === targetStage && s.checkpoint === stepId && liveSignoff(reopens, s.stage, s.at));

  const collection = loadCollection(dir);
  const items = collectItems(project, { collection });
  const splitOrder = hasStageOrder(project);
  const drafts = asArray(project.drafts).filter(isObject);
  const versions = asArray(project.versions).filter(isObject);

  if (stage === PAUSED_STAGE) {
    const resumeTarget = pausedFrom(project);
    addAwait('project.stage');
    moves.push({
      role: 'human',
      field: 'pauses',
      awaits: 'project.stage',
      command: null,
      act: `resume paused project to ${resumeTarget} via human pause/resume act`,
      review_act: {
        kind: 'signoff',
        stage: resumeTarget,
        ...(jobId ? { job_id: jobId } : {}),
      },
    });
  } else if (isOpenInterviewStage(effectiveStage)) {
    const stageItems = items.filter(
      item => interviewStageOfGuide(item.id, item.kind === 'post', splitOrder) === effectiveStage,
    );
    for (const item of stageItems) {
      const answerField = item.path;
      const questionPath = item.path.replace(/\.(answer|guide)$/, '');
      if (item.state.state === 'silent') {
        addAwait(answerField);
        const pendingOpts = isObject(item.record.pending_options) ? item.record.pending_options : null;
        if (pendingOpts !== null) {
          let optSetId = typeof pendingOpts.id === 'string' ? pendingOpts.id : '';
          if (!optSetId && typeof pendingOpts.path === 'string') {
            try {
              const rawSet = JSON.parse(readFileSync(join(dir, pendingOpts.path), 'utf8')) as JsonObject;
              if (typeof rawSet.id === 'string') optSetId = rawSet.id;
            } catch {
              optSetId = pendingOpts.path;
            }
          }
          moves.push({
            role: 'human',
            field: `${questionPath}.pending_options`,
            awaits: answerField,
            command: null,
            act: `review-tool act interview-picks for ${questionPath} (option set ${optSetId})`,
            review_act: {
              kind: 'interview-picks',
              stage: effectiveStage,
              question_id: item.id,
              option_set_id: optSetId,
              ...(jobId ? { job_id: jobId } : {}),
            },
          });
        } else {
          moves.push({
            role: 'agent',
            field: answerField,
            awaits: answerField,
            command: optionCommand(item.id, dir),
            act: `draft an option-set file for ${item.id}, then register it for a Review pick`,
            unanswered_by_record: `${questionPath}.pending_options`,
          });
        }
      } else if (item.state.state === 'delegated' && !item.state.decided) {
        const decisionField = `${answerField}.agent_decision`;
        addAwait(decisionField);
        moves.push({
          role: 'human',
          field: answerField,
          awaits: decisionField,
          command: null,
          act: `unanswered by record: ${decisionField} requires authored decision and rationale`,
          unanswered_by_record: decisionField,
        });
      }
    }

    const planIds = effectiveStage === 'rigging-interview' ? ['bones', 'meshes', 'constraints', 'motion']
      : effectiveStage === 'post-interview' ? ['camera', 'timing'] : ['seethrough', 'assemble'];
    const missingPlanIds = planIds.filter(id => {
      const guide = id === 'camera' ? 'camera_depth' : id === 'timing' ? 'post_timing' : id;
      const phase = effectiveStage === 'post-interview' ? 'post' : 'rig';
      return !steps.some(step => step.phase === phase && (step.id === id
        || phase === 'post' && asArray(step.rests_on).includes(guide)));
    });
    const needsPlanSteps = missingPlanIds.length > 0;
    if (needsPlanSteps) {
      addAwait('plan.steps');
      for (const [index, id] of missingPlanIds.entries()) {
        const guideId = id === 'camera' ? 'camera_depth' : id === 'timing' ? 'post_timing' : id;
        const item = stageItems.find(item => item.id === guideId);
        if (!item || item.state.state === 'silent' || (item.state.state === 'delegated' && !item.state.decided)) continue;
        const order = Math.max(0, ...steps.map(step => Number(step.order) || 0)) + index + 1;
        moves.push({ role: 'agent', field: 'plan.steps', awaits: 'plan.steps',
          command: `rig-create plan add ${id} ${shellWord(dir)} --by agent --phase ${effectiveStage === 'post-interview' ? 'post' : 'rig'} --order ${order} --does '<work>' --produces '<result>' --rests-on ${guideId} --bar '<acceptance bar>' --checkpoint-proposed false`,
          act: `author the ${id} plan step for approval at ${effectiveStage}; replace the work, result and acceptance bar placeholders`,
          unanswered_by_record: 'plan.steps' });
      }
    }

    const signoffAwait = `signoffs[stage=${effectiveStage}]`;
    if (!hasLiveStageSignoff(effectiveStage) && !recordedLapseTargets.has(signoffAwait)) {
      addAwait(signoffAwait);
      moves.push({
        role: 'human',
        field: 'signoffs',
        awaits: signoffAwait,
        command: null,
        act: needsPlanSteps
          ? effectiveStage === 'rigging-interview'
            ? 'review-tool act signoff for stage rigging-interview (unanswered by record: plan.steps has no rig steps approved at rigging-interview)'
            : `review-tool act signoff for stage ${effectiveStage} (unanswered by record: ${effectiveStage === 'post-interview' ? 'plan.steps has no post steps' : steps.length === 0 ? 'plan.steps is empty' : 'plan.steps has uncovered parts guides'} in project.json)`
          : effectiveStage === 'interview'
            ? 'review-tool act signoff for stage interview on the record page with job open --plan (source-linked Review); ingest signoff interview --from-review <actId>, then advance plan-approved'
            : `review-tool act signoff for stage ${effectiveStage}`,
        review_act: {
          kind: 'signoff',
          stage: effectiveStage,
          ...(jobId ? { job_id: jobId } : {}),
        },
        ...(needsPlanSteps ? { unanswered_by_record: 'plan.steps' } : {}),
      });
    } else if (hasLiveStageSignoff(effectiveStage)) {
      const nextStage = nextStageInOrder(project, stage);
      if (nextStage !== null) {
        const cmd = candidateAdvance(dir, project, nextStage, now);
        if (cmd !== null) {
          addAwait('project.stage');
          moves.push({
            role: 'agent',
            field: 'stage',
            awaits: 'project.stage',
            command: cmd,
            act: `advance stage from ${stage} to ${nextStage}`,
          });
        }
      }
    }
  } else if (effectiveStage === 'plan-approved') {
    const signoffAwait = 'signoffs[stage=plan-approved]';
    if (!hasLiveStageSignoff('plan-approved') && !recordedLapseTargets.has(signoffAwait)) {
      addAwait(signoffAwait);
      moves.push({
        role: 'human',
        field: 'signoffs',
        awaits: signoffAwait,
        command: null,
        act: 'review-tool act signoff for stage plan-approved',
        review_act: {
          kind: 'signoff',
          stage: 'plan-approved',
          ...(jobId ? { job_id: jobId } : {}),
        },
      });
    } else if (hasLiveStageSignoff('plan-approved')) {
      const nextStage = nextStageInOrder(project, stage);
      if (nextStage !== null) {
        const cmd = candidateAdvance(dir, project, nextStage, now);
        if (cmd !== null) {
          addAwait('project.stage');
          moves.push({
            role: 'agent',
            field: 'stage',
            awaits: 'project.stage',
            command: cmd,
            act: `advance stage from ${stage} to ${nextStage}`,
          });
        }
      }
    }
  } else if (effectiveStage === 'parts' || effectiveStage === 'parts-review') {
    const partsSteps = steps.filter(
      s => (s.phase === 'rig' || s.phase === 'post') && stageOfStep(s.phase, String(s.id)) === 'parts',
    );
    const openPartsSteps = partsSteps.filter(s => s.status !== 'done');

    if (effectiveStage === 'parts' && openPartsSteps.length > 0) {
      for (const step of openPartsSteps) {
        const stepId = String(step.id);
        const currentStatus = String(step.status ?? 'pending');
        const fromIdx = STEP_STATUSES.indexOf(currentStatus as (typeof STEP_STATUSES)[number]);
        const nextStatus = fromIdx >= 0 ? STEP_STATUSES[fromIdx + 1] : undefined;
        if (nextStatus === undefined) continue;
        const checkpointEnabled = checkpointRequired(project, step, now);
        if (nextStatus === 'done' && checkpointEnabled && !hasLiveCheckpointSignoff('parts', stepId)) {
          const cpAwait = `signoffs[checkpoint=${stepId}]`;
          addAwait(cpAwait);
          if (!recordedLapseTargets.has(cpAwait)) {
            moves.push({
              role: 'human',
              field: `plan.steps[${stepId}].checkpoint`,
              awaits: cpAwait,
              command: null,
              act: `review-tool act signoff-checkpoint for plan.steps[${stepId}]`,
              review_act: {
                kind: 'signoff-checkpoint',
                stage: 'parts',
                step_id: stepId,
                ...(jobId ? { job_id: jobId } : {}),
              },
            });
          }
          continue;
        }
        const cmd = candidateStepStatus(dir, project, stepId, nextStatus, now);
        if (cmd !== null) {
          const statusField = `plan.steps[${stepId}].status`;
          addAwait(statusField);
          moves.push({
            role: 'agent',
            field: statusField,
            awaits: statusField,
            command: cmd,
            act: `advance plan.steps[${stepId}].status from ${currentStatus} to ${nextStatus}`,
          });
        }
      }
    } else {
      const latestDraft = drafts[drafts.length - 1];
      const draftId = typeof latestDraft?.id === 'string' ? latestDraft.id : undefined;
      const partsRoot =
        isObject(latestDraft?.parts) && typeof latestDraft.parts.path === 'string'
          ? latestDraft.parts.path
          : undefined;
      const hasApprovedPartsVerdict = hasApprovedPartsVerdictReceipt(dir, project, draftId);

      if (effectiveStage === 'parts' && partsRoot !== undefined
        && candidateAdvance(dir, project, 'parts-review', now, { report: 'evidence/parts-check.json', root: partsRoot }) === null) {
        addAwait('evidence/parts-check.json');
        moves.push({ role: 'producer', field: 'drafts', awaits: 'evidence/parts-check.json',
          command: `rig-parts check-parts --parts ${shellWord(resolve(dir, partsRoot))} --out ${shellWord(resolve(dir, 'evidence'))}`,
          act: 'produce and retain evidence/parts-check.json before advance parts-review' });
      }

      if (effectiveStage === 'parts' && partsRoot !== undefined && existsSync(join(dir, 'evidence/parts-check.json'))) {
        const advCmd = candidateAdvance(dir, project, 'parts-review', now, {
          report: 'evidence/parts-check.json',
          root: partsRoot,
        });
        if (advCmd !== null) {
          moves.push({
            role: 'agent',
            field: 'stage',
            awaits: 'project.stage',
            command: advCmd,
            act: 'advance stage from parts to parts-review',
          });
        }
      }

      if (draftId !== undefined && !hasApprovedPartsVerdict) {
        const verdictAwait = `review_acts[kind=parts-verdict,draft_id=${draftId}]`;
        addAwait(verdictAwait);
        moves.push({
          role: 'human',
          field: 'review_acts',
          awaits: verdictAwait,
          command: null,
          act: `review-tool act parts-verdict for drafts[${draftId}]`,
          review_act: {
            kind: 'parts-verdict',
            stage: 'parts-review',
            draft_id: draftId,
            ...(jobId ? { job_id: jobId } : {}),
          },
        });
      }

      const structure = draftId === undefined ? undefined : partsStructureSnapshot(dir, project, draftId);
      if (draftId !== undefined && hasApprovedPartsVerdict && structure !== undefined && !structure.valid) {
        addAwait(structure.path);
        moves.push({
          role: 'agent',
          field: `drafts[${draftId}]`,
          awaits: structure.path,
          command: `rig-create structure-snapshot ${shellWord(dir)} --draft ${shellWord(draftId)} --out ${shellWord(structure.path)}`,
          act: `write structure-snapshot for drafts[${draftId}] to ${structure.path}`,
        });
      }

      const inputsList = asArray(project.inputs).filter(isObject);
      const paintingPath =
        typeof inputsList[0]?.path === 'string'
          ? inputsList[0].path
          : existsSync(join(dir, 'inputs/painting.png'))
            ? 'inputs/painting.png'
            : undefined;
      if (
        draftId !== undefined &&
        partsRoot !== undefined &&
        paintingPath !== undefined &&
        !existsSync(join(dir, 'evidence/diff-components.json'))
      ) {
        const diffMove = resolveDiffComponentsMove(dir, draftId, partsRoot, paintingPath);
        addAwait('evidence/diff-components.json');
        moves.push({
          role: 'producer',
          field: `drafts[${draftId}].parts`,
          awaits: 'evidence/diff-components.json',
          command: diffMove.command,
          act: diffMove.act,
        });
      } else if (
        existsSync(join(dir, 'evidence/diff-components.json')) &&
        !hasValidDiffMap(dir, project)
      ) {
        addAwait('diff_map');
        moves.push({
          role: 'agent',
          field: 'diff_map',
          awaits: 'diff_map',
          command: resolveDiffClassesCommand(dir),
          act: 'record agent component classification for evidence/diff-components.json in diff_map',
        });
      }

      const signoffAwait = 'signoffs[stage=parts-review]';
      if (!hasLiveStageSignoff('parts-review') && !recordedLapseTargets.has(signoffAwait)) {
        addAwait(signoffAwait);
        moves.push({
          role: 'human',
          field: 'signoffs',
          awaits: signoffAwait,
          command: null,
          act: hasApprovedPartsVerdict
            ? `review-tool act signoff for stage parts-review; after structure-snapshot, ingest rig-create signoff parts-review ${shellWord(dir)} --draft ${shellWord(draftId!)} --structure-file ${shellWord(structure!.path)} --from-review '<actId>'`
            : `review-tool act signoff for stage parts-review (unanswered by record: review_acts[kind=parts-verdict,draft_id=${draftId ?? 'unknown'}] is absent)`,
          review_act: {
            kind: 'signoff',
            stage: 'parts-review',
            ...(draftId ? { draft_id: draftId } : {}),
            ...(jobId ? { job_id: jobId } : {}),
          },
          ...(!hasApprovedPartsVerdict
            ? {
                unanswered_by_record: `review_acts[kind=parts-verdict,draft_id=${draftId ?? 'unknown'}], ${structure?.path ?? 'structure snapshot'}`,
              }
            : {}),
        });
      }

      if (effectiveStage === 'parts') {
        addAwait('project.stage');
      } else if (hasLiveStageSignoff('parts-review')) {
        const nextStage = nextStageInOrder(project, stage);
        if (nextStage !== null) {
          const cmd = candidateAdvance(dir, project, nextStage, now);
          if (cmd !== null) {
            addAwait('project.stage');
            moves.push({
              role: 'agent',
              field: 'stage',
              awaits: 'project.stage',
              command: cmd,
              act: `advance stage from ${stage} to ${nextStage}`,
            });
          }
        }
      }
    }
  } else if (effectiveStage === 'rigging' || effectiveStage === 'rig-review') {
    const rigSteps = steps.filter(
      s => (s.phase === 'rig' || s.phase === 'post') && stageOfStep(s.phase, String(s.id)) === 'rigging',
    );
    const openRigSteps = rigSteps.filter(s => s.status !== 'done');

    if (effectiveStage === 'rigging' && openRigSteps.length > 0) {
      for (const step of openRigSteps) {
        const stepId = String(step.id);
        const currentStatus = String(step.status ?? 'pending');
        const fromIdx = STEP_STATUSES.indexOf(currentStatus as (typeof STEP_STATUSES)[number]);
        const nextStatus = fromIdx >= 0 ? STEP_STATUSES[fromIdx + 1] : undefined;
        if (nextStatus === undefined) continue;
        const checkpointEnabled = checkpointRequired(project, step, now);
        if (nextStatus === 'done' && checkpointEnabled && !hasLiveCheckpointSignoff('rigging', stepId)) {
          const cpAwait = `signoffs[checkpoint=${stepId}]`;
          addAwait(cpAwait);
          if (!recordedLapseTargets.has(cpAwait)) {
            moves.push({
              role: 'human',
              field: `plan.steps[${stepId}].checkpoint`,
              awaits: cpAwait,
              command: null,
              act: `review-tool act signoff-checkpoint for plan.steps[${stepId}]`,
              review_act: {
                kind: 'signoff-checkpoint',
                stage: 'rigging',
                step_id: stepId,
                ...(jobId ? { job_id: jobId } : {}),
              },
            });
          }
          continue;
        }
        const cmd = candidateStepStatus(dir, project, stepId, nextStatus, now);
        if (cmd !== null) {
          const statusField = `plan.steps[${stepId}].status`;
          addAwait(statusField);
          moves.push({
            role: 'agent',
            field: statusField,
            awaits: statusField,
            command: cmd,
            act: `advance plan.steps[${stepId}].status from ${currentStatus} to ${nextStatus}`,
          });
        }
      }
    } else {
      const rigVersions = versions.filter(v => v.kind === 'rig' && typeof v.n === 'number');
      const latestRig = rigVersions[rigVersions.length - 1];
      const rigN = typeof latestRig?.n === 'number' ? latestRig.n : null;

      if (effectiveStage === 'rigging' && rigN !== null) {
        const advCmd = candidateAdvance(dir, project, 'rig-review', now);
        if (advCmd !== null) {
          addAwait('project.stage');
          moves.push({
            role: 'agent',
            field: 'stage',
            awaits: 'project.stage',
            command: advCmd,
            act: 'advance stage from rigging to rig-review',
          });
        }
      }

      if (rigN === null) {
        const verdictAwait = 'versions[kind=rig].verdicts[review=rig-review]';
        addAwait(verdictAwait);
        moves.push({
          role: 'human',
          field: 'versions',
          awaits: verdictAwait,
          command: null,
          act: 'review-tool act review-verdict for rig-review (unanswered by record: versions[kind=rig] is not recorded in project.json)',
          review_act: {
            kind: 'review-verdict',
            stage: 'rig-review',
            review: 'rig-review',
            ...(jobId ? { job_id: jobId } : {}),
          },
          unanswered_by_record: 'versions[kind=rig]',
        });
      } else {
        const acceptedIdx = latestRig !== undefined ? acceptedReviewVerdict(latestRig, 'rig-review') : -1;
        const acceptedEntry = acceptedIdx >= 0 ? asArray(latestRig?.verdicts)[acceptedIdx] : undefined;
        const hasLiveAcceptedRigVerdict =
          isObject(acceptedEntry) &&
          liveSignoff(reopens, 'rigging', Date.parse(String(acceptedEntry.at)));
        const verdictAwait = `versions[n=${rigN}].verdicts[review=rig-review]`;
        if (!hasLiveAcceptedRigVerdict && !recordedLapseTargets.has(verdictAwait)) {
          addAwait(verdictAwait);
          moves.push({
            role: 'human',
            field: `versions[v${rigN}].verdicts`,
            awaits: verdictAwait,
            command: null,
            act: `review-tool act review-verdict for versions[v${rigN}] (rig-review)${structureWarnings.some(w => w.path === `versions[v${rigN}].provenance.structure_delta`) ? '; verdict covers changed structure' : ''}`,
            review_act: {
              kind: 'review-verdict',
              stage: 'rig-review',
              version_id: `v${rigN}`,
              review: 'rig-review',
              ...(jobId ? { job_id: jobId } : {}),
            },
          });
        }
      }

      const signoffAwait = 'signoffs[stage=rig-review]';
      if (!hasLiveStageSignoff('rig-review') && !recordedLapseTargets.has(signoffAwait)) {
        addAwait(signoffAwait);
        moves.push({
          role: 'human',
          field: 'signoffs',
          awaits: signoffAwait,
          command: null,
          act: 'review-tool act signoff for stage rig-review',
          review_act: {
            kind: 'signoff',
            stage: 'rig-review',
            ...(rigN !== null ? { version_id: `v${rigN}` } : {}),
            ...(jobId ? { job_id: jobId } : {}),
          },
          ...(rigN === null ? { unanswered_by_record: 'versions[kind=rig]' } : {}),
        });
      } else if (effectiveStage === 'rig-review' && hasLiveStageSignoff('rig-review')) {
        const nextStage = nextStageInOrder(project, stage);
        if (nextStage !== null) {
          const cmd = candidateAdvance(dir, project, nextStage, now);
          if (cmd !== null) {
            addAwait('project.stage');
            moves.push({
              role: 'agent',
              field: 'stage',
              awaits: 'project.stage',
              command: cmd,
              act: `advance stage from ${stage} to ${nextStage}`,
            });
          }
        }
      }
    }
  } else if (effectiveStage === 'post' || effectiveStage === 'direction-review') {
    const postSteps = steps.filter(
      s => (s.phase === 'rig' || s.phase === 'post') && stageOfStep(s.phase, String(s.id)) === 'post',
    );
    const openPostSteps = postSteps.filter(s => s.status !== 'done');

    if (effectiveStage === 'post' && openPostSteps.length > 0) {
      for (const step of openPostSteps) {
        const stepId = String(step.id);
        const currentStatus = String(step.status ?? 'pending');
        const fromIdx = STEP_STATUSES.indexOf(currentStatus as (typeof STEP_STATUSES)[number]);
        const nextStatus = fromIdx >= 0 ? STEP_STATUSES[fromIdx + 1] : undefined;
        if (nextStatus === undefined) continue;
        const checkpointEnabled = checkpointRequired(project, step, now);
        if (nextStatus === 'done' && checkpointEnabled && !hasLiveCheckpointSignoff('post', stepId)) {
          const cpAwait = `signoffs[checkpoint=${stepId}]`;
          addAwait(cpAwait);
          if (!recordedLapseTargets.has(cpAwait)) {
            moves.push({
              role: 'human',
              field: `plan.steps[${stepId}].checkpoint`,
              awaits: cpAwait,
              command: null,
              act: `review-tool act signoff-checkpoint for plan.steps[${stepId}]`,
              review_act: {
                kind: 'signoff-checkpoint',
                stage: 'post',
                step_id: stepId,
                ...(jobId ? { job_id: jobId } : {}),
              },
            });
          }
          continue;
        }
        const cmd = candidateStepStatus(dir, project, stepId, nextStatus, now);
        if (cmd !== null) {
          const statusField = `plan.steps[${stepId}].status`;
          addAwait(statusField);
          moves.push({
            role: 'agent',
            field: statusField,
            awaits: statusField,
            command: cmd,
            act: `advance plan.steps[${stepId}].status from ${currentStatus} to ${nextStatus}`,
          });
        }
      }
    } else {
      const scenes = asArray(project.scenes).filter(isObject);
      const postVersions = versions.filter(
        v => v.kind === 'post' && typeof v.n === 'number' && liveSignoff(reopens, 'post', Date.parse(String(v.at))),
      );
      const latestPost = postVersions[postVersions.length - 1];
      const postN = typeof latestPost?.n === 'number' ? latestPost.n : null;
      const maxVersionN = Math.max(
        0,
        ...versions.map(v => (typeof v.n === 'number' ? v.n : 0)),
      );
      const nextPostN = postN ?? maxVersionN + 1;

      if (effectiveStage === 'post' && postN !== null && scenes.length > 0) {
        const advCmd = candidateAdvance(dir, project, 'direction-review', now);
        if (advCmd !== null) {
          moves.push({
            role: 'agent',
            field: 'stage',
            awaits: 'project.stage',
            command: advCmd,
            act: 'advance stage from post to direction-review',
          });
        }
      }

      if (postN === null) {
        const rig = versions.filter(v => v.kind === 'rig').at(-1);
        const rigN = typeof rig?.n === 'number' ? String(rig.n) : '<rig-version>';
        const currentScene = sceneCurrentAt(dir, project, now);
        if (!isObject(project.direction_contract)) {
          addAwait('direction_contract');
          moves.push({ role: 'agent', field: 'direction_contract', awaits: 'direction_contract',
            command: `rig-create direction --adopt ${shellWord(dir)}`, act: 'adopt direction before authoring the post' });
        } else if (currentScene === undefined) {
          addAwait('scenes[n=1]');
          moves.push({ role: 'agent', field: 'scenes', awaits: 'scenes[n=1]',
            command: `rig-create scene write ${shellWord(dir)} --rig ${shellWord(rigN)} --background '<background.png>' --citations-file '<scene-citations.json>'`,
            act: 'author scene inputs matching the current post_composition Review choice, then write the scene' });
        } else {
          addAwait(`versions[n=${nextPostN}]`);
          moves.push({ role: 'agent', field: 'versions', awaits: `versions[n=${nextPostN}]`,
            command: `rig-create direction write ${nextPostN} ${shellWord(dir)} --file '<direction.json>' --rig ${shellWord(rigN)}`,
            act: 'author a direction document binding the current scene, then record the post version' });
        }
      }
      if (scenes.length === 0) addAwait('scenes[n=1]');
      if (postN === null) {
        addAwait(`versions[n=${nextPostN}]`);
        const verdictAwait = `versions[n=${nextPostN}].verdicts[review=direction-review]`;
        addAwait(verdictAwait);
        moves.push({
          role: 'human',
          field: 'versions',
          awaits: verdictAwait,
          command: null,
          act: `review-tool act review-verdict for direction-review (unanswered by record: ${scenes.length === 0 ? 'scenes[n=1] and ' : ''}versions[n=${nextPostN}] are not recorded in project.json)`,
          review_act: {
            kind: 'review-verdict',
            stage: 'direction-review',
            version_id: `v${nextPostN}`,
            review: 'direction-review',
            ...(jobId ? { job_id: jobId } : {}),
          },
          unanswered_by_record: scenes.length === 0 ? `scenes[n=1], versions[n=${nextPostN}]` : `versions[n=${nextPostN}]`,
        });
      } else {
        const acceptedIdx = latestPost !== undefined ? acceptedReviewVerdict(latestPost, 'direction-review') : -1;
        const acceptedEntry = acceptedIdx >= 0 ? asArray(latestPost?.verdicts)[acceptedIdx] : undefined;
        const hasLiveAcceptedPostVerdict =
          isObject(acceptedEntry) &&
          liveSignoff(reopens, 'post', Date.parse(String(acceptedEntry.at)));
        const verdictAwait = `versions[n=${postN}].verdicts[review=direction-review]`;
        if (!hasLiveAcceptedPostVerdict && !recordedLapseTargets.has(verdictAwait)) {
          addAwait(verdictAwait);
          moves.push({
            role: 'human',
            field: `versions[v${postN}].verdicts`,
            awaits: verdictAwait,
            command: null,
            act: `review-tool act review-verdict for versions[v${postN}] (direction-review) on the post page: job open --rig ${postN}; ingest with review ${postN} --from-review <actId>; then request record-page sign-off with job open --plan (source-linked Review)`,
            review_act: {
              kind: 'review-verdict',
              stage: 'direction-review',
              version_id: `v${postN}`,
              review: 'direction-review',
              ...(jobId ? { job_id: jobId } : {}),
            },
          });
        }
      }

      const signoffAwait = 'signoffs[stage=direction-review]';
      if (!hasLiveStageSignoff('direction-review') && !recordedLapseTargets.has(signoffAwait)) {
        addAwait(signoffAwait);
        moves.push({
          role: 'human',
          field: 'signoffs',
          awaits: signoffAwait,
          command: null,
          act:
            postN === null
              ? `after recording the current post and accepted direction verdict, request review-tool act signoff for direction-review on the record page with job open --plan (source-linked Review; unanswered by record: ${scenes.length === 0 ? 'scenes[n=1] and ' : ''}versions[n=${nextPostN}] are not recorded in project.json)`
              : `after ingesting the accepted direction-review verdict for v${postN}, request review-tool act signoff on the record page with job open --plan (source-linked Review), ingest signoff direction-review --from-review <actId>, then advance accepted`,
          review_act: {
            kind: 'signoff',
            stage: 'direction-review',
            version_id: `v${nextPostN}`,
            ...(jobId ? { job_id: jobId } : {}),
          },
          ...(postN === null
            ? {
                unanswered_by_record:
                  scenes.length === 0 ? `scenes[n=1], versions[n=${nextPostN}]` : `versions[n=${nextPostN}]`,
              }
            : {}),
        });
      }

      if (effectiveStage === 'post') {
        addAwait('project.stage');
      } else if (hasLiveStageSignoff('direction-review')) {
        const nextStage = nextStageInOrder(project, stage);
        if (nextStage !== null) {
          const cmd = candidateAdvance(dir, project, nextStage, now);
          if (cmd !== null) {
            addAwait('project.stage');
            moves.push({
              role: 'agent',
              field: 'stage',
              awaits: 'project.stage',
              command: cmd,
              act: `advance stage from ${stage} to ${nextStage}`,
            });
          }
        }
      }
    }
  }

  if (laggingAdvance !== null && !moves.some(m => m.role === 'agent' && m.command === laggingAdvance.command)) {
    addAwait('project.stage');
    moves.unshift({
      role: 'agent',
      field: 'stage',
      awaits: 'project.stage',
      command: laggingAdvance.command,
      act: `advance stage from ${stage} to ${laggingAdvance.targetStage}`,
    });
  }

  return {
    schema: NEXT_SCHEMA,
    project_id: String(project.name ?? ''),
    stage,
    effective_stage: effectiveStage,
    accepted: false,
    refusals,
    ...warningFields,
    awaits: awaitsList,
    moves,
  };
}

export function formatNext(report: NextReport): string {
  const lines: string[] = [];
  lines.push(
    `next: ${report.project_id || '(unnamed)'} — stage: ${report.stage}${
      report.effective_stage !== report.stage ? ` (effective: ${report.effective_stage})` : ''
    }`,
  );
  for (const w of report.warnings ?? []) lines.push(`  WARN [${w.code}]: ${w.message}`);
  if (report.refusals.length > 0) {
    lines.push(`refusals (${report.refusals.length}):`);
    for (const r of report.refusals) {
      lines.push(`  [${r.code}] ${r.field}: ${r.message}`);
      lines.push(`    fix: ${r.fix}`);
    }
  }
  if (report.accepted && report.moves.length === 0 && report.refusals.length === 0) {
    lines.push('no remaining move (project is accepted)');
    return lines.join('\n');
  }
  if (report.moves.length === 0) {
    lines.push('no forward move (resolve refusals first)');
    return lines.join('\n');
  }
  if (report.awaits.length > 0) {
    lines.push(`awaits: ${report.awaits.join(', ')}`);
  }
  lines.push(`moves (${report.moves.length}):`);
  for (const move of report.moves) {
    const label = move.command ?? move.act;
    lines.push(`  [${move.role}] (${move.field} -> ${move.awaits}) ${label}`);
    if (move.unanswered_by_record) {
      lines.push(`    unanswered by record: ${move.unanswered_by_record}`);
    }
    if (move.lapse) {
      lines.push(`    lapse [${move.lapse.code}]: ${move.lapse.source_field} -> ${move.lapse.target_field}`);
    }
  }
  return lines.join('\n');
}

export function nextCommand(args: string[], now: number = Date.now()): { stdout: string; exit: number } {
  const { dir, json } = parseArgs(args);
  const report = nextProject(dir, now);
  return {
    stdout: json ? JSON.stringify(report, null, 2) : formatNext(report),
    exit: 0,
  };
}
