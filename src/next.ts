import { missingPickSignoffSteps, pickSignoffEvidence, requiredInterviewSteps } from './pick-signoff.ts';
import { ChoiceError, hasPendingOther, isUndecidedDelegation, literalFile, optionFile, pendingInterviewOptions, pendingInterviewOptionsPath, selection } from './choices.ts';
import { reviewVerdictSignable, rigVerdictIngestible } from './signable.ts';
import { ownerChatSignoffAllowed } from './owner-chat.ts';
import { checkpointEnabled, checkpointRequired, completedPlanStepNeedsAmendment, planStepCompleted } from './plan-history.ts';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from './check-reads.ts';
import { isDeepStrictEqual } from 'node:util';
import { CURRENT_KINDS, CURRENT_RIG_MODEL, currentFileBinding, isCurrentProject, outputRoot, RUN_RECORD_NAME, type CurrentKind } from './current.ts';
import { readMotionLoopSeamPolicy } from './motion-loop-seam.ts';
import { COMPOSE_CHECK_PATH, COMPOSE_RUN_PATH, CURRENT_DIRECTION_PATH, currentDirectionSource } from './current-direction.ts';
import { currentAdvanceOutputFinding, isPublishAdvanceStage } from './job-advance.ts';
import { eligibleRigDraftModel, optionPublicationStage, publicationFile, riggingDraftPartsChange, SUPPORTED_CURRENT_PUBLICATION_OUTPUTS } from './job-publication.ts';
import { latestRigDraftVerdict } from './rig-draft-verdict.ts';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import {
  answered,
  activeCurrentSignoffTargetPath,
  asArray,
  checkProject,
  collectItems,
  collectSignoffs,
  isCurrentPathProject,
  isObject,
  loadCollection,
  postNotPassed,
  type CheckReport,
  type Finding,
  type Item,
} from './check.ts';
import { amendedAnswerId, amendmentLapsedSteps, collectAmendments } from './amend.ts';
import { correctionApprovalFindings, pendingMeshDeltaRevision } from './corrections.ts';
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
import { JOB_BINDING_FILE, readWriterBinding, type CurrentPublicationOutput, type WriterBinding } from './job-outbox.ts';
import { beginJobProgress } from './job-writer.ts';
import { isPartsCheckMove, PARTS_CHECK_FILE, partsCheckFindings, partsCheckRecord } from './parts-check.ts';
import { isPartsReviewReceipt, latestPartsVerdictStatus, latestRiggingDraftFeedback, recordedPartsVerdict } from './parts-verdict-record.ts';
import { assertPartsActSource } from './parts-act.ts';
import { pausedFrom } from './pause.ts';
import { checkCollection, collectionDirOf } from './pins-check.ts';
import { carriedRefusals, findingKey, newFindings } from './refusal-baseline.ts';
import { Refusal, refuse, USAGE_EXIT } from './refusal.ts';
import { reopenLapseWarnings } from './reopen-lapses.ts';
import { collectReopens, liveSignoff, type Reopen } from './reopen.ts';
import { resolveAdoptSource } from './record-adopt.ts';
import { acceptedReviewVerdict, humanReviewVerdicts, latestAccepted, readVersions, type Versions } from './review.ts';
import { commentChestAct, decodeReviewAct, SIGNOFF_TARGET_KINDS } from './review-act.ts';
import { selectSignoffTarget } from './signoff-target.ts';
import { currentPartsStructureBinding } from './signoff.ts';
import { bustLandmarkCommands, currentUsesBustVersion } from './review-bust.ts';
import {
  directionReviewPostState,
  furthestStageSignoff,
  isSignoffIdentity,
  nextStepStatus,
  signoffIdentity,
  stepStatusFollows,
} from './stage-progress.ts';
import {
  coveredByStepPlan,
  currentStepPlan,
  hasStageOrder,
  interviewStageOfGuide,
  PLAN_STEPS,
  planStepOfGuide,
  isOpenInterviewArrivalStage,
  isOpenInterviewStage,
  LEGACY_STAGE_VALUES,
  PARTS_REVIEW_SINCE,
  PAUSED_STAGE,
  silentInterviewItems,
  SKIPPED_WHEN_NO_POST,
  STAGE_VALUES,
  stageIndex,
  stageOfStep,
  stepCoveredByApproval,
  stepPlanValue,
  VALUE_QUESTIONS,
  type PlanStep,
} from './stages.ts';
import type { Json, JsonObject } from './templates.ts';
import { CURRENT_SCENE_PATH, currentScene, plateRegistration, sceneBinding, sceneBytes, sceneRig, SceneError, validateCurrentScene } from './scene.ts';
import { depthPlanMoves, nextRigRegistrationNumber, NO_DRAFT_VERDICT, rigRegistrationCommand, RIG_VERSION_INPUTS, turnExtraGroupMoves } from './rig-version.ts';
import { checkVersionDeclarations, type VersionDeclaration } from './version-declarations.ts';
import { checkRigReport, parseRigCheckReport, RIG_CHECK_REPORT_FILE } from './rig-check-report.ts';
import { validateRunRecord } from './run-record.ts';
import { latestPartsApproval, partsApprovalIdentity } from './structure.ts';
import { postCompositionSetOffersScene, resolveAgentCitationSpec } from './scene-authority.ts';
import { DIRECTION_COMPOSE_SPEC } from './direction-compose.ts';
import { DirectionError, directionJson, missingDirectionStepApprovals } from './direction.ts';
import { type NextComment, withCurrentComments } from './comment-closures.ts';
import { currentOutputMove, withStaleOutputs } from './next-stale.ts';

export const NEXT_SCHEMA = 'rig-create/next@1';

const BASELINES_AFTER_FINAL_ASSEMBLE = 'Finalize the assembly inputs (turn.depths and constraints.physics included), assemble again, and only then take edited-part baselines (from_sha256); a baseline from an earlier assembly refuses ASSEMBLE_EDITED_PART_BASELINE.';

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

export interface NextCollectionRefusal {
  code: string;
  path: string;
  message: string;
  remedy: string;
}

export interface NextCollectionMember {
  name: string;
  command: string;
}

export interface NextCollectionReport {
  kind: 'collection';
  collection_dir: string;
  stage: string | null;
  effective_stage: string | null;
  refusals: NextCollectionRefusal[];
  members: NextCollectionMember[];
}

export interface NextReviewAct {
  kind: 'parts-verdict' | 'review-verdict' | 'signoff' | 'signoff-checkpoint';
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
  bust_landmark_commands?: string[];
  /** A view of existing answers, never a new project record. */
  answers?: { question_id: string; field: string; by: Json; at: Json; picks: { ask: Json; option_id: Json; label: Json }[]; command?: string }[];
  /** Current-output comments with live `current` / `earlier` status and closure state (#1064). */
  comments?: NextComment[];
  awaits: string[];
  moves: NextMove[];
}

const FATAL_CODES = new Set([
  'PROJECT_JSON_MISSING',
  'PROJECT_JSON_INVALID',
  'SCHEMA_UNKNOWN',
  'STAGE_UNKNOWN',
]);
const ROUTED_ANSWER_COMMENT_PATH = /^review_acts\[(\d+)\]\.feedback_route\.comments\[(\d+)\]$/;

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

function isOpenInterviewTodo(finding: Finding, effectiveStage: string): boolean {
  return isOpenInterviewStage(effectiveStage)
    && (finding.code === 'INTERVIEW_INCOMPLETE' || finding.code === 'INTERVIEW_CHOICE_REQUIRED');
}

const SCENE_OTHER_FOLLOW_UP = 'use the recorded Other words to draft concrete scene options with fragment.scene. Write each label and effect as one plain 해요체 sentence. Register the new set for an owner pick, then cite that pick in scene write';
const SCENE_OPTIONS_REPAIR_ACT = 'register a post_composition option set whose value options carry value.scene, then have the owner answer it before scene write';

function delegatedAsks(dir: string, item: Item): string[] {
  const answer = item.state.state === 'user' || item.state.state === 'delegated' ? item.state.answer : null;
  if (answer) {
    const fromAsks = asArray(answer.asks)
      .filter((a): a is JsonObject => isObject(a) && a.state === 'delegated' && typeof a.id === 'string')
      .map(a => String(a.id));
    if (fromAsks.length > 0) return fromAsks;
    if (isObject(answer.agent_decision) && typeof answer.agent_decision.covers === 'string') {
      const covers = answer.agent_decision.covers.split(',').map(s => s.trim()).filter(Boolean);
      if (covers.length > 0) return covers;
    }
    if (isObject(answer.choice) && isObject(answer.choice.set)) {
      try {
        const { set } = optionFile(dir, answer.choice.set);
        const selected = selection(set, answer.choice);
        if (selected.autos.length > 0) return selected.autos;
      } catch { /* Fall back to question id. */ }
    }
  }
  return [item.id];
}

function decisionCommand(dir: string, item: Item): string {
  const fragments = delegatedAsks(dir, item)
    .map(ask => ` --fragment ${shellWord(`${ask}=<json>`)}`)
    .join('');
  return `rig-create interview-decision ${shellWord(item.id)} ${shellWord(dir)} --by agent --reasoning-file '<file>'${fragments}`;
}

function shellWord(value: string): string {
  return /^[A-Za-z0-9_./:-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

function adoptionMove(dir: string, project: JsonObject, kind: CurrentKind): NextMove | undefined {
  const source = resolveAdoptSource(project, kind);
  if (!source.ok || !source.files.every(file => producerHashMatches(dir, file.path, file.sha256, file.bytes))) return;
  const field = `current.${kind}`;
  return { role: 'agent', field, awaits: field,
    command: `rig-create record ${kind} --adopt ${shellWord(dir)}`,
    act: `Adopt the bound ${kind} output of v${source.version} in place.` };
}

function completedPlanRepairCommand(step: JsonObject, dir: string): string | null {
  const { id, phase, order, does, produces, bar, checkpoint_proposed: checkpoint } = step;
  const restsOn = asArray(step.rests_on);
  if (typeof id !== 'string' || !id.trim() || id.startsWith('-') || (phase !== 'rig' && phase !== 'post')
    || typeof order !== 'number' || !Number.isFinite(order) || typeof checkpoint !== 'boolean'
    || restsOn.length === 0 || new Set(restsOn).size !== restsOn.length
    || restsOn.some(value => typeof value !== 'string' || !value.trim() || value.includes(','))
    || [does, produces, restsOn.join(','), bar].some(value => typeof value !== 'string' || !value.trim() || value.startsWith('--'))) {
    return null;
  }
  const target = `${shellWord(id)} ${shellWord(dir)} --by agent`;
  const definition = ['--phase', phase, '--order', String(order), '--does', String(does), '--produces', String(produces),
    '--rests-on', restsOn.join(','), '--bar', String(bar), '--checkpoint-proposed', String(checkpoint)].map(shellWord).join(' ');
  return `rig-create plan replace ${target} ${definition}`;
}

interface CheckedRigBuild {
  source: string;
  check: string;
  build: string;
  run: string;
  finished: number;
  config?: string;
  rig?: string;
  idle?: string;
}

function producerHashMatches(dir: string, path: string, sha256: Json | undefined, size?: number): boolean {
  if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) return false;
  try {
    const bytes = readFileSync(literalFile(dir, path));
    return (size === undefined || bytes.length === size) && createHash('sha256').update(bytes).digest('hex') === sha256;
  }
  catch { return false; }
}

function checkedRigBuild(dir: string, source: string, approvedAt: number, reopens: readonly Reopen[], now: number): CheckedRigBuild | undefined {
  const checkDir = `${source}/check`;
  const check = `${checkDir}/${RIG_CHECK_REPORT_FILE}`;
  const build = `${checkDir}/build`;
  const run = `${build}/run.json`;
  try {
    const bytes = readFileSync(literalFile(dir, check));
    const report = parseRigCheckReport(bytes);
    if (report.PASS !== true) return;
    const model = createHash('sha256').update(readFileSync(literalFile(dir, `${build}/skeleton.model.json`))).digest('hex');
    const warnings: Finding[] = [];
    if (checkRigReport({ at: new Date(now).toISOString(), check_report: { path: check, spec: report.spec ?? null } },
      check, check, model, () => bytes, warnings).length || warnings.length) return;

    const stamp = validateRunRecord(readFileSync(literalFile(dir, run)), run);
    if (stamp.spec !== 'rigc-run/1' || !asArray(stamp.record.outputs).some(row =>
      isObject(row) && row.path === 'skeleton.model.json' && row.sha256 === model)) return;
    const finished = Date.parse(String(stamp.record.finished_at));
    if (finished < approvedAt || finished > now || finished < Date.parse(String(stamp.record.started_at))
      || !liveSignoff(reopens, 'rig-review', finished)) return;

    let config: string | undefined;
    if (report.config !== undefined) {
      // Parts records the argument as typed. Resolve only project-local claims with matching bytes.
      if (!isObject(report.config) || typeof report.config.path !== 'string' || !report.config.path
        || report.config.path.includes('\\') || report.config.path.split('/').includes('..')) return;
      const path = relative(dir, resolve(dir, report.config.path)).split(sep).join('/');
      if (isAbsolute(path) || !producerHashMatches(dir, path, report.config.sha256)) return;
      config = path.startsWith('-') ? `./${path}` : path;
    }

    const rigDir = `${source}/rig`;
    const inputs = asArray(stamp.record.inputs).filter(isObject);
    const rig = ['rig', 'motion'].every(role => {
      const path = `${rigDir}/${role}.json`;
      return inputs.some(input => input.role === role && input.path === relative(build, path).split(sep).join('/')
        && producerHashMatches(dir, path, input.sha256));
    }) ? rigDir : undefined;

    const idleDir = `${checkDir}/idle_frames`;
    let idle: string | undefined;
    try {
      const frames: Json = JSON.parse(readFileSync(literalFile(dir, `${idleDir}/frames.json`), 'utf8'));
      if (isObject(frames) && frames.spec === 'rigc-frames/1' && asArray(frames.sets).some(set =>
        isObject(set) && set.animation === 'idle' && typeof set.fps === 'number' && set.fps > 0)) idle = idleDir;
    } catch { /* Keep --idle as an explicit input when the check did not retain the render. */ }
    return { source, check, build, run, finished, config, rig, idle };
  } catch { return undefined; /* Unbound producer output is optional evidence for next. */ }
}

function latestCheckedRigBuild(dir: string, versions: JsonObject[], approvedAt: number, reopens: readonly Reopen[], now: number): CheckedRigBuild | undefined {
  let entries: string[];
  try {
    const outputs = join(dir, 'outputs');
    if (!lstatSync(outputs).isDirectory()) return;
    entries = readdirSync(outputs, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name);
  } catch { return; }
  const registered = new Set(versions.map(v => `v${String(v.n)}`));
  // rig-parts build's numbered output root has check/ directly below it.
  // Registered copies under out/check and arbitrary project directories are outside discovery.
  return entries.filter(entry => /^v[1-9][0-9]*$/.test(entry) && Number.isSafeInteger(Number(entry.slice(1))) && !registered.has(entry))
    .map(entry => checkedRigBuild(dir, `outputs/${entry}`, approvedAt, reopens, now))
    .filter(build => build !== undefined)
    .sort((a, b) => b.finished - a.finished || Number(b.source.slice('outputs/v'.length)) - Number(a.source.slice('outputs/v'.length)))[0];
}

/**
 * The declarations the registration's record check reads from the checked
 * build's config (create#750), so all of them are seen before a rebuild.
 * Sections are cited by --citations, which next does not know; it lists them.
 */
function registrationDeclarations(dir: string, project: JsonObject, n: number, checked: CheckedRigBuild): string {
  if (checked.config === undefined) return '';
  const path = relative(dir, resolve(dir, checked.config)).split(sep).join('/');
  let bytes: Buffer;
  try { bytes = readFileSync(literalFile(dir, path)); } catch { return ''; }
  const version: JsonObject = { n, kind: 'rig', at: new Date(checked.finished).toISOString(),
    provenance: { config: { path, sha256: createHash('sha256').update(bytes).digest('hex') }, sections: {} } };
  const { declarations } = checkVersionDeclarations(dir, project, version);
  const field = (d: VersionDeclaration): string => d.path.replace(/^versions\[v\d+\]\.provenance\.(config |sections\[)/, '').replace(/\]$/, '');
  const sections = declarations.filter(d => d.path.includes('.provenance.sections['));
  const fields = declarations.filter(d => !sections.includes(d));
  const list = (status: VersionDeclaration['status']): string => fields.filter(d => d.status === status)
    .map(d => `${field(d)}${d.codes.length ? ` (${d.codes.join(', ')})` : ''}`).join(', ') || 'none';
  return [
    ` Registration reads these declarations: cite ${sections.map(field).join(', ') || 'no section'} in --citations;`,
    `${checked.config} with its requirements carries ${list('carried')}; missing ${list('missing')}; unread ${list('unread')}.`,
    `Before any rebuild, see every remedy in one run: rig-create rig-version ${n} ${shellWord(dir)} --preflight --config ${shellWord(checked.config)} --citations '<sections JSON>'.`,
  ].join(' ');
}

function rigRegistrationMove(dir: string, n: number, checked?: CheckedRigBuild, declarations = '', pending?: Finding): NextMove {
  const bound: Record<string, string | undefined> = checked ? {
    '--parts': '<checked parts dir>', '--rig': checked.rig ?? '<checked rig dir>', '--idle': checked.idle ?? '<idle render dir>',
    '--build': checked.build, '--check-report': checked.check, '--run-record': checked.run, '--at-source': checked.run,
    '--at-pointer': '/finished_at', '--config': checked.config ?? '<config.json>', '--path-adapter': '<path-adapter.json>',
    '--compile-report': '<build-report.json>', '--toolchain-lock': '<build toolchain lock>',
  } : {};
  const args = [...RIG_VERSION_INPUTS.matchAll(/(--[a-z-]+) (<[^>]+>)/g)]
    .flatMap(([, flag, placeholder]) => [flag!, bound[flag!] ?? placeholder!]);
  if (pending) args.push(NO_DRAFT_VERDICT);
  const act = checked
    ? [
      `Register the checked build from ${checked.source} as v${n}.`,
      "Use --parts from rig-parts assemble or rig-parts build and --rig from rig-parts rig or rig-parts build, both from the checked build's inputs.",
      'Use the --config supplied to Parts (prepared from the interview or rig-parts propose).',
      "Use --check-report and --build from rig-parts check and --idle from its rigc render.",
      "Use the rigc build's run.json for --run-record and --at-source, with --at-pointer /finished_at.",
      `Generate --path-adapter with rig-create rig-version adapter ${shellWord(dir)} --config ${shellWord(checked.config ?? '<config.json>')} --out '<path-adapter.json>'.`,
      `Supply --compile-report from ${checked.source}/check/build-report.json, the build-report/1 rig-parts check writes beside --build (from Parts 2.47.0; an earlier check needs a rigc build --report of the same build), and --toolchain-lock from the build's bun.lock (bun install) or package-lock.json (npm install).`,
      'Supply your identity with --by and include --citations for applicable config sections.',
    ].join(' ') + declarations
    : `register a new rig version built after the reopen or amendment with rig-version ${n}, then publish it for one verdict`;
  return { role: 'agent', field: 'versions', awaits: `versions[n=${n}]`, command: rigRegistrationCommand([String(n), dir, ...args]),
    act: pending ? `${pending.code}: ${pending.message}. Register without carrying the draft verdict. ${act}` : act };
}

function optionCommand(id: string, dir: string): string {
  return `rig-create interview-options ${shellWord(id)} ${shellWord(dir)} --file '<option-set.json>'`;
}

/** Registration precedes every consumer, including a scene blocked on its missing input row. */
function plateInputMoves(dir: string, project: JsonObject, items: Item[], now: number): NextMove[] {
  const paths = new Set<string>();
  const addPath = (path: Json | undefined): void => { if (typeof path === 'string') paths.add(path); };
  const scenePaths = (scene: JsonObject): void => {
    for (const role of ['background', 'foreground']) if (isObject(scene[role])) addPath(scene[role].path);
    for (const plate of asArray(scene.plates).filter(isObject)) addPath(plate.path ?? plate.image);
  };
  const valuePaths = (value: Json | undefined): void => {
    if (Array.isArray(value)) { value.forEach(valuePaths); return; }
    if (!isObject(value)) return;
    if (isObject(value.scene)) scenePaths(value.scene);
    if (isObject(value.compose)) scenePaths(value.compose);
  };
  for (const item of items) {
    const answer = item.state.state === 'user' || item.state.state === 'delegated' ? item.state.answer : null;
    const bindings = [item.record.pending_options, answer && isObject(answer.choice) ? answer.choice.set : undefined];
    for (const binding of bindings) {
      if (!isObject(binding)) continue;
      try {
        const { set } = optionFile(dir, binding);
        for (const ask of asArray(set.asks).filter(isObject)) {
          for (const option of asArray(ask.options).filter(isObject)) if (option.kind === 'value') valuePaths(option.fragment);
        }
      } catch (error) {
        if (!(error instanceof ChoiceError)) throw error;
        // Check already names the invalid option binding; do not use unbound bytes.
      }
    }
    if (answer) {
      valuePaths(answer.value);
      if (isObject(answer.agent_decision)) valuePaths(answer.agent_decision.value);
    }
  }
  try {
    const entry = currentScene(project, now);
    if (entry) {
      const bytes = sceneBytes(dir, String(entry.path), 'SCENE_FILE_CHANGED');
      if (createHash('sha256').update(bytes).digest('hex') === entry.sha256) {
        const scene: Json = JSON.parse(bytes.toString('utf8'));
        if (isObject(scene)) scenePaths(scene);
      }
    }
  } catch (error) {
    if (!(error instanceof SceneError) && !(error instanceof SyntaxError)) throw error;
    // The check owns malformed or changed scene refusals.
  }
  return [...paths].flatMap(path => {
    // A changed registered input needs restoration, never a duplicate input add.
    if (asArray(project.inputs).some(input => isObject(input) && input.path === path)) return [];
    try {
      const bytes = sceneBytes(dir, path, 'SCENE_PLATE_CHANGED');
      if (plateRegistration(project, { path, sha256: createHash('sha256').update(bytes).digest('hex') })) return [];
    } catch (error) {
      if (!(error instanceof SceneError)) throw error;
      return []; // Only existing, readable, project-contained plate files can be registered.
    }
    const field = `inputs[path=${path}]`;
    return [{ role: 'agent' as const, field, awaits: field,
      command: `rig-create input add ${shellWord(path.startsWith('-') ? `./${path}` : path)} ${shellWord(dir)} --origin '<origin>'`,
      act: `register ${path} with its source origin before using it in the option set or scene` }];
  });
}

const OWNER_CHAT_COMMAND_FLAGS = "--by '<owner>' --owner-chat '<words file>' --said-at '<ISO date>' --relayed-by '<operator>'";

function checkpointOwnerChatCommand(dir: string, stage: string, stepId: string): string {
  return `rig-create signoff ${stage} ${shellWord(dir)} --checkpoint ${shellWord(stepId)} ${OWNER_CHAT_COMMAND_FLAGS}`;
}

function checkpointSignoffMove(dir: string, stage: 'parts' | 'rigging' | 'post', stepId: string, awaits: string): NextMove {
  return {
    role: 'human',
    field: `plan.steps[${stepId}].checkpoint`,
    awaits,
    command: checkpointOwnerChatCommand(dir, stage, stepId),
    act: `relay the owner chat checkpoint approval for plan.steps[${stepId}] with exact words, owner date and relay identity`,
  };
}

function currentReviewKind(stage: 'rig-review' | 'direction-review'): 'rig' | 'direction' {
  return stage === 'rig-review' ? 'rig' : 'direction';
}

function currentReviewOutput(dir: string, project: JsonObject, stage: 'rig-review' | 'direction-review'): boolean {
  try { return selectSignoffTarget(dir, project, stage) !== undefined; }
  catch (error) {
    if (!(error instanceof Refusal)) throw error;
    return false;
  }
}

function ownerChatSignoffCommand(dir: string, project: JsonObject, act: NextReviewAct, writer: string): string | undefined {
  if (act.kind === 'signoff' && isCurrentProject(project) && isPublishAdvanceStage(act.stage)) {
    if (!currentReviewOutput(dir, project, act.stage) || correctionApprovalFindings(project, act.stage).length > 0) return;
    return `rig-create ${writer} ${shellWord(dir)} ${OWNER_CHAT_COMMAND_FLAGS}`;
  }
  if (act.kind !== 'signoff' || !ownerChatSignoffAllowed(dir, project, act.stage, act.draft_id, act.version_id?.slice(1))) return;
  const version = act.stage === 'rig-review' || act.stage === 'direction-review'
    ? ` --version ${shellWord(act.version_id?.slice(1) ?? '<current-version>')}` : '';
  return `rig-create ${writer} ${shellWord(dir)}${version} ${OWNER_CHAT_COMMAND_FLAGS}`;
}

interface PendingQuestionMove {
  stage: string;
  questionId: string;
  optionSetId: string;
}

const pendingQuestionMoves = new WeakMap<NextMove, PendingQuestionMove>();

function ownerChatPickMove(dir: string, project: JsonObject, move: NextMove, question: string): NextMove[] {
  const item = collectItems(project, { collection: loadCollection(dir) }).find(item => item.id === question);
  const binding = item?.record.pending_options;
  if (!isObject(binding) || typeof binding.path !== 'string' || typeof binding.sha256 !== 'string') return [];
  try {
    const { set } = optionFile(dir, binding);
    const picks = asArray(set.asks).filter(isObject).map(ask => ` --pick ${shellWord(`${String(ask.id)}=<option-id>`)}`).join('');
    return [{
      ...move,
      command: `rig-create interview-answer ${shellWord(question)} ${shellWord(dir)} --set ${shellWord(binding.path)} --sha256 ${shellWord(binding.sha256)} ${OWNER_CHAT_COMMAND_FLAGS}${picks}`,
      act: `relay the owner chat answer for ${question} and explicit option ids from the displayed set`,
      review_act: undefined,
    }];
  } catch { /* The check's named option-file refusal supplies the repair route. */ }
  return [];
}

const OPEN_REVIEW_HOST = 'run the first open in the background and share its URL once; later opens publish into the running host and exit';

function questionCommands(dir: string, project: JsonObject, move: NextMove, meta: PendingQuestionMove): NextMove[] {
  const root = shellWord(dir);
  return [
    move,
    ...ownerChatPickMove(dir, project, move, meta.questionId),
    {
      role: 'agent',
      field: move.field,
      awaits: move.awaits,
      command: `rig-create job open ${root} --question ${shellWord(meta.questionId)} --reviewer '<reviewer>' --role owner`,
      act: `optional: publish option set ${meta.optionSetId} to Review to show its images for looking and commenting; ${OPEN_REVIEW_HOST}`,
    },
  ];
}

/** The person acts in Review; the agent only hosts and ingests its exported act. */
function reviewCommands(dir: string, project: JsonObject, move: NextMove): NextMove[] {
  const act = move.review_act;
  if (move.role !== 'human' || move.unanswered_by_record || move.field === 'pauses' || !act) return [move];
  if (act.kind === 'signoff') {
    let writer: string | undefined;
    if (['interview', 'plan-approved', 'rigging-interview', 'post-interview', 'direction-review'].includes(act.stage)) {
      writer = `signoff ${act.stage}`;
    } else if (act.stage === 'parts-review' && act.draft_id) {
      const structure = partsStructureSnapshot(dir, project, act.draft_id);
      writer = `signoff parts-review --draft ${shellWord(act.draft_id)} --structure-file ${shellWord(structure.path)}`;
    } else if (act.stage === 'rig-review' && act.version_id) {
      writer = 'signoff rig-review';
    }
    const chatSignoff = writer ? ownerChatSignoffCommand(dir, project, act, writer) : undefined;
    return chatSignoff
      ? [{ ...move, command: chatSignoff, act: 'Relay the owner chat signoff with exact words, owner date and relay identity.', review_act: undefined }]
      : [move];
  }
  if (act.kind === 'signoff-checkpoint') return [move];
  let selector: string;
  let writer: string;
  if (act.kind === 'parts-verdict' && act.draft_id) {
    selector = `--draft ${shellWord(act.draft_id)}`;
    writer = 'parts-review';
  } else if (act.kind === 'review-verdict' && act.stage === 'rig-review' && act.draft_id) {
    selector = `--draft ${shellWord(act.draft_id)}`;
    writer = `review --draft ${shellWord(act.draft_id)}`;
  } else if (['rig-review', 'direction-review'].includes(act.stage) && act.kind === 'review-verdict' && act.version_id) {
    const n = act.version_id.slice(1);
    selector = `--rig ${shellWord(n)}`;
    writer = `review ${shellWord(n)}`;
  } else return [move];
  const agent = (command: string, description: string): NextMove => ({
    role: 'agent', field: move.field, awaits: move.awaits, command, act: description,
  });
  const root = shellWord(dir);
  const publish = `publish this Review page; ${OPEN_REVIEW_HOST}`;
  return [
    agent(`rig-create job open ${root} ${selector} --reviewer '<reviewer>' --role owner`, publish),
    move,
    agent(`rig-create job acts ${root} --json --wait`, `wait in the background for the person to submit in Review, then use the matching actId below${act.kind === 'parts-verdict' ? '; approval also records the prepared parts-review signature' : ''}`),
    agent(`rig-create ${writer} ${root} --from-review '<actId>'`, 'ingest the matching exported Review act; never supply the human answer or words'),
  ];
}

function stageQuestionCommands(dir: string, project: JsonObject, questions: { move: NextMove; meta: PendingQuestionMove }[]): NextMove[] {
  const root = shellWord(dir);
  const names = questions.map(({ meta }) => meta.questionId).join(', ');
  const awaits = questions.map(({ move }) => move.awaits).join(', ');
  return [
    ...questions.flatMap(({ move, meta }) => [move, ...ownerChatPickMove(dir, project, move, meta.questionId)]),
    {
      role: 'agent',
      field: 'interview',
      awaits,
      command: `rig-create job open ${root} --questions --reviewer '<reviewer>' --role owner`,
      act: `optional: publish the pending sets for ${names} on one Review page to show their images for looking and commenting; ${OPEN_REVIEW_HOST}`,
    },
  ];
}

function interviewQuestionMoves(dir: string, stageItems: Item[], effectiveStage: string): NextMove[] {
  const moves: NextMove[] = [];
  for (const item of stageItems) {
    const answerField = item.path;
    const questionPath = item.path.replace(/\.(answer|guide)$/, '');
    const pendingOpts = pendingInterviewOptions(item);
    if (pendingOpts !== undefined || item.state.state === 'silent' || hasPendingOther(item)) {
      if (pendingOpts !== undefined) {
        let optSetId = typeof pendingOpts.id === 'string' ? pendingOpts.id : '';
        if (!optSetId && typeof pendingOpts.path === 'string') {
          try {
            const rawSet = JSON.parse(readFileSync(join(dir, pendingOpts.path), 'utf8')) as JsonObject;
            if (typeof rawSet.id === 'string') optSetId = rawSet.id;
          } catch {
            optSetId = pendingOpts.path;
          }
        }
        const move: NextMove = {
          role: 'human',
          field: pendingInterviewOptionsPath(item),
          awaits: answerField,
          command: null,
          act: `ask the owner in chat for ${questionPath} (option set ${optSetId}), then relay the answer with interview-answer --owner-chat`,
        };
        pendingQuestionMoves.set(move, { stage: effectiveStage, questionId: item.id, optionSetId: optSetId });
        moves.push(move);
      } else if (hasPendingOther(item)) {
        const followUp = item.id === 'post_composition'
          ? SCENE_OTHER_FOLLOW_UP
          : `redraft the option-set file for ${item.id} with a tailored value option and register it for an owner pick, or re-answer with --other-fragment`;
        moves.push({
          role: 'agent',
          field: answerField,
          awaits: answerField,
          command: optionCommand(item.id, dir),
          act: `${answerField} has a pending Other (INTERVIEW_CHOICE_REQUIRED): ${followUp}`,
          unanswered_by_record: answerField,
        });
      } else {
        moves.push({
          role: 'agent',
          field: answerField,
          awaits: answerField,
          command: optionCommand(item.id, dir),
          act: `draft an option-set file for ${item.id}, then register it for an owner pick`,
          unanswered_by_record: pendingInterviewOptionsPath(item),
        });
      }
    } else if (isUndecidedDelegation(item)) {
      const decisionField = `${answerField}.agent_decision`;
      // interview-decision refuses answers without an adopted choice (choice-writers.ts), so a
      // preserved sentence-format delegation keeps the authored-record move it had before.
      const adopted = isObject(item.raw) && isObject(item.raw.choice);
      moves.push(adopted ? {
        role: 'agent',
        field: answerField,
        awaits: decisionField,
        command: decisionCommand(dir, item),
        act: `record agent decision and rationale for ${decisionField}`,
        unanswered_by_record: decisionField,
      } : {
        role: 'human',
        field: answerField,
        awaits: decisionField,
        command: null,
        act: `unanswered by record: ${decisionField} requires authored decision and rationale`,
        unanswered_by_record: decisionField,
      });
    }
  }
  return moves;
}

/**
 * New work gets one plan per step (INTERVIEW.md § Step plans).
 * An untouched current post interview also offers option sets for uncovered questions.
 * A stage with a registered set or a recorded answer keeps its question moves.
 */
function stepPlanQuestions(dir: string, project: JsonObject, stageItems: Item[], allowOptions = false): { questionItems: Item[]; moves: NextMove[] } {
  const started = stageItems.some(item => pendingInterviewOptions(item) !== undefined
    || ((item.state.state === 'user' || item.state.state === 'delegated') && !stepPlanValue(project, item, item.state.answer)));
  const open = stageItems.filter(item => !coveredByStepPlan(project, item));
  if (started) return { questionItems: open, moves: [] };
  // Code reads these values, so a covered question still gets one, stated in the plan's prose.
  const values = stageItems.filter(item => item.state.state === 'silent' && coveredByStepPlan(project, item) && VALUE_QUESTIONS.includes(item.id))
    .map((item): NextMove => ({
      role: 'agent', field: item.path, awaits: item.path,
      command: `rig-create interview-decision ${shellWord(item.id)} ${shellWord(dir)} --by agent --reasoning-file '<why.md>' --value-file '<value.json>' --plan-quote-file '<plan sentence>'`,
      act: `record the ${item.id} value the ${planStepOfGuide(item.id, item.kind === 'post')} plan states in plain words; the quote file holds that sentence of the plan`,
      unanswered_by_record: item.path,
    }));
  const steps = new Set(open.filter(item => item.state.state === 'silent').map(item => planStepOfGuide(item.id, item.kind === 'post')));
  const moves = PLAN_STEPS.filter(step => steps.has(step)).map((step): NextMove => ({
    role: 'agent', field: 'interview.step_plans', awaits: `interview.step_plans[step=${step}]`,
    command: `rig-create plan propose ${step} ${shellWord(dir)} --file '<plans/${step}.md>' --by agent`,
    act: `write one ${step} plan for the whole figure: what you will do and why, in the owner's language. Propose it at once and talk the direction through in chat or Review comments; record what the person says with plan feedback. Feedback is discussion, not a gate`,
    unanswered_by_record: `interview.step_plans[step=${step}]`,
  }));
  return { questionItems: allowOptions ? open : open.filter(item => item.state.state !== 'silent'), moves: [...moves, ...values] };
}

function interviewPlanMoves(dir: string, project: JsonObject, stageItems: Item[], stage: string, steps: JsonObject[]) {
  const phase = stage === 'post-interview' ? 'post' : 'rig';
  const planIds = phase === 'post' ? ['camera', 'timing', 'composition'] : requiredInterviewSteps(stage);
  const guideForStep = (id: string) => id === 'camera' ? 'camera_depth' : id === 'timing' ? 'post_timing' : id === 'composition' ? 'post_composition' : id;
  const missingPlanIds = planIds.filter(id => !steps.some(step => step.phase === phase && (step.id === id
    || phase === 'post' && asArray(step.rests_on).includes(guideForStep(id)))));
  const lastOrder = Math.max(0, ...steps.map(step => Number(step.order) || 0));
  const moves: NextMove[] = [];
  for (const [index, id] of missingPlanIds.entries()) {
    const guideId = guideForStep(id);
    const item = stageItems.find(item => item.id === guideId);
    if (!item || (item.state.state === 'silent' && !coveredByStepPlan(project, item)) || hasPendingOther(item) || isUndecidedDelegation(item)) continue;
    const order = lastOrder + index + 1;
    moves.push({ role: 'agent', field: 'plan.steps', awaits: 'plan.steps',
      command: `rig-create plan add ${id} ${shellWord(dir)} --by agent --phase ${phase} --order ${order} --does '<work>' --produces '<result>' --rests-on ${guideId} --bar '<acceptance bar>' --checkpoint-proposed false`,
      act: `author the ${id} plan step for approval at ${stage}; replace the work, result and acceptance bar placeholders`,
      unanswered_by_record: 'plan.steps' });
  }
  return { planIds, missingPlanIds, moves };
}

function runnableNextMoves(dir: string, project: JsonObject, effectiveStage: string, moves: NextMove[]): NextMove[] {
  const stageQuestions = moves.flatMap(move => {
    const meta = pendingQuestionMoves.get(move);
    return meta && meta.stage === effectiveStage && !move.unanswered_by_record ? [{ move, meta }] : [];
  });
  const groupedQuestions = stageQuestions.length > 1 ? new Set(stageQuestions.map(entry => entry.move)) : null;
  return moves.flatMap(move => {
    if (groupedQuestions?.has(move)) {
      return move === stageQuestions[0]!.move ? stageQuestionCommands(dir, project, stageQuestions) : [];
    }
    const questionMeta = pendingQuestionMoves.get(move);
    if (questionMeta) {
      return questionMeta.stage === effectiveStage && !move.unanswered_by_record
        ? questionCommands(dir, project, move, questionMeta)
        : [move];
    }
    if (move.review_act && move.review_act.stage !== effectiveStage) return [move];
    if (move.review_act?.stage === 'direction-review' && move.review_act.kind === 'signoff'
      && moves.some(other => other.review_act?.stage === 'direction-review' && other.review_act.kind === 'review-verdict')) return [move];
    return reviewCommands(dir, project, move);
  });
}

function answeredPostCompositionSetLacksScene(dir: string, item: Item | undefined): boolean {
  if (!item || (item.state.state !== 'user' && item.state.state !== 'delegated')) return false;
  const answer = item.state.answer;
  const resolved = item.state.state === 'delegated' && isObject(answer.agent_decision)
    ? answer.agent_decision.value
    : answer.value;
  if (isObject(resolved) && isObject(resolved.scene)) return false;
  if (!isObject(answer.choice) || !isObject(answer.choice.set)) return false;
  try {
    const { set } = optionFile(dir, answer.choice.set);
    return !postCompositionSetOffersScene(set);
  } catch {
    return false;
  }
}

function postCompositionSceneRepairMoves(
  dir: string,
  project: JsonObject,
  item: Item | undefined,
  effectiveStage: string,
  now: number,
): NextMove[] {
  if (!item || !answeredPostCompositionSetLacksScene(dir, item)) return [];
  const pending = pendingInterviewOptions(item);
  if (pending !== undefined) {
    if (optionPublicationStage(project, effectiveStage, now) === 'post-interview') {
      return interviewQuestionMoves(dir, [item], effectiveStage);
    }
    let optSetId = typeof pending.id === 'string' ? pending.id : '';
    if (!optSetId && typeof pending.path === 'string') {
      try {
        const rawSet = JSON.parse(readFileSync(join(dir, pending.path), 'utf8')) as JsonObject;
        if (typeof rawSet.id === 'string') optSetId = rawSet.id;
      } catch {
        optSetId = pending.path;
      }
    }
    const questionPath = item.path.replace(/\.(answer|guide)$/, '');
    const humanMove: NextMove = {
      role: 'human',
      field: pendingInterviewOptionsPath(item),
      awaits: item.path,
      command: null,
      act: `ask the owner in chat for ${questionPath} (option set ${optSetId}), then relay the answer with interview-answer --owner-chat`,
    };
    return [humanMove, ...ownerChatPickMove(dir, project, humanMove, item.id)];
  }
  return [{
    role: 'agent',
    field: item.path,
    awaits: item.path,
    command: optionCommand(item.id, dir),
    act: SCENE_OPTIONS_REPAIR_ACT,
  }];
}

function sceneWriteCommand(dir: string, project: JsonObject, rigN: string): string {
  let flags = ` --background '<background.png>'`;
  const item = collectItems(project, { collection: loadCollection(dir) }).find(item => item.id === 'post_composition');
  if (item && (item.state.state === 'user' || item.state.state === 'delegated')) {
    const answer = item.state.answer;
    const citation = { guide: 'post_composition', asks: ['post_composition'],
      ...(item.state.state === 'delegated' ? { delegated: true } : { quote: answer.verbatim! }) };
    try {
      const spec = resolveAgentCitationSpec(dir, project, citation);
      const stage = sceneRig(dir, project, Number(rigN)).stage;
      for (const role of ['background', 'foreground'] as const) {
        const plate = spec[role];
        if (!plate) continue;
        if (role === 'foreground') flags += ` --foreground '<foreground.png>'`;
        const { x, y, width, height } = plate.rect;
        if (x !== stage.x || y !== stage.y || width !== stage.width || height !== stage.height) {
          flags += ` --${role}-rect ${shellWord([x, y, width, height].join(','))}`;
        }
      }
    } catch (error) {
      if (!(error instanceof SceneError)) throw error;
      // The scene writer reports the existing named refusal for an unresolved choice.
    }
  }
  return `rig-create scene write ${shellWord(dir)} --rig ${shellWord(rigN)}${flags} --citations-file '<scene-citations.json>'`;
}

function directionReviewNeedsNumberedPost(dir: string, versions: Versions): boolean {
  return !versions.posts.some(post => post.live) && readWriterBinding(dir) !== null;
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
    collectSignoffs(clone, history).filter(s => liveSignoff(reopens, s.stage, s.at) && Number.isFinite(s.at)),
  );
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
    signoff: latest === undefined ? null : signoffIdentity(latest.record),
    steps_before: steps.map(s => ({
      id: s.id ?? null,
      phase: s.phase ?? null,
      ...(s.status === undefined ? {} : { status: s.status }),
    })),
  };
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
  if (isOpenInterviewArrivalStage(targetStage)) {
    const items = collectItems(clone, { collection: loadCollection(dir) });
    for (const item of silentInterviewItems(clone, items, targetStage)) {
      const key = findingKey({ code: 'INTERVIEW_INCOMPLETE', path: item.path });
      allowed.set(key, (allowed.get(key) ?? 0) + 1);
    }
  }
  const checked = checkProject(dir, clone, { now, forwardWrite: true, readOnly: true });
  if (newFindings(allowed, checked.refusals).length > 0) return null;
  if (isCurrentProject(clone)) {
    if (isPublishAdvanceStage(targetStage)) {
      if (readWriterBinding(dir) && currentAdvanceOutputFinding(dir, clone, targetStage, checked)) return null;
      const path = `current.${currentReviewKind(targetStage)}`;
      if (!currentReviewOutput(dir, clone, targetStage)
        || checked.warnings.some(w => w.code === 'OUTPUT_STALE' && w.path === path)) return null;
    }
  } else if (targetStage === 'direction-review' && directionReviewNeedsNumberedPost(dir, readVersions(clone))) return null;
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
  if (!stepStatusFollows(entry.from_status, nextStatus, enabled)) return null;
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

function nextStageInOrder(project: JsonObject, currentStage: string, noPost = false): string | null {
  const order = hasStageOrder(project) ? STAGE_VALUES : LEGACY_STAGE_VALUES;
  const idx = order.indexOf(currentStage);
  if (idx < 0) return null;
  for (let i = idx + 1; i < order.length; i++) {
    const candidate = order[i]!;
    if (candidate === PAUSED_STAGE) return null;
    if (noPost && SKIPPED_WHEN_NO_POST.includes(candidate)) continue;
    return candidate;
  }
  return null;
}

/** The current stage is at or before the furthest live stage-level signoff in the project's order. */
function stageSignedThrough(project: JsonObject, stage: string): boolean {
  const reopens = collectReopens(project, []);
  const latest = furthestStageSignoff(collectSignoffs(project, []).filter(s => liveSignoff(reopens, s.stage, s.at)));
  const order: readonly string[] = hasStageOrder(project) ? STAGE_VALUES : LEGACY_STAGE_VALUES;
  return latest !== undefined && order.includes(stage) && order.indexOf(stage) <= order.indexOf(latest.stage);
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
  if (stage === 'post' && !isCurrentProject(project) && !directionReviewPostState(dir, project, now).ready) return null;
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
  reportPath = 'evidence/diff-components.json',
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
            command: `cp ${shellWord(resolve(dir, draftReportPath))} ${shellWord(resolve(dir, reportPath))}`,
            act: `copy ${draftReportPath} for drafts[${draftId}] to ${reportPath}`,
          };
        }
      }
    } catch {
      // Fall through to rig-parts diff-components command if verification fails.
    }
  }

  const figureFlag = figureMaskPath !== undefined ? ` --figure ${shellWord(resolve(dir, figureMaskPath))}` : '';
  return {
    command: `rig-parts diff-components --stack ${shellWord(resolve(dir, stackPath))} --painting ${shellWord(resolve(dir, paintingPath))} --parts ${shellWord(resolve(dir, partsRoot, 'parts.json'))}${figureFlag} --floor 2 --threshold 40 --out ${shellWord(resolve(dir, reportPath))}`,
    act: `run rig-parts diff-components for drafts[${draftId}]`,
  };
}

function hasValidDiffMap(dir: string, project: JsonObject, partsFile = resolveDiffMapPartsFile(dir, project)): boolean {
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

function resolveDiffClassesCommand(dir: string, reportPath = 'evidence/diff-components.json', triagePath = 'evidence/diff-triage.json'): string {
  if (!existsSync(join(dir, triagePath))) {
    try {
      const bytes = diffReportBytes(dir, reportPath);
      const parsed = JSON.parse(bytes.toString('utf8')) as Json;
      if (isObject(parsed) && reportShape(parsed) && (parsed.components as unknown[]).length === 0) {
        return `rig-create diff-classes ${shellWord(dir)} --diff-report ${shellWord(reportPath)} --by agent`;
      }
    } catch {
      // Fall through to default command with --triage-file.
    }
  }
  return `rig-create diff-classes ${shellWord(dir)} --diff-report ${shellWord(reportPath)} --triage-file ${shellWord(triagePath)} --by agent`;
}

function partsEvidencePaths(draftId: string, retouch: boolean): { directory: string; check: string; diff: string; triage: string } {
  const directory = retouch ? `evidence/parts-${encodeURIComponent(draftId)}` : 'evidence';
  return { directory, check: `${directory}/parts-check.json`, diff: `${directory}/diff-components.json`, triage: `${directory}/diff-triage.json` };
}

function hasCurrentPartsCheck(dir: string, report: string, partsRoot: string): boolean {
  try {
    const read = partsCheckRecord(dir, report, partsRoot, report);
    return !('refusal' in read) && partsCheckFindings(dir, read.record, report, true).length === 0;
  } catch { return false; }
}

function currentPartsAdvanceMove(dir: string): NextMove {
  const partsRoot = `${outputRoot('parts')}/rig`;
  // Each advance retains its own report, including after a reopen replaces the current parts.
  const command = [
    `cd ${shellWord(dir)}`,
    'test ! -L evidence',
    'check_dir=$(mktemp -d evidence/parts-review.XXXXXXXX)',
    `rig-parts check-parts --parts ${partsRoot} --out "$check_dir"`,
    `rig-create advance parts-review . --parts-check "$check_dir/${PARTS_CHECK_FILE}" --parts ${partsRoot}`,
  ].join(' && ');
  return { role: 'agent', field: 'stage', awaits: 'project.stage', command: `(${command})`,
    act: 'Retain a parts-stage check of the recorded current parts in evidence and advance to parts-review.' };
}

function currentPartsSnapshotMove(dir: string, project: JsonObject, now: number): NextMove | undefined {
  let target: JsonObject | undefined;
  try {
    target = selectSignoffTarget(dir, project, 'parts-review');
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    return;
  }
  if (!target) return;
  const awaits = 'current.parts.structure';
  try {
    currentPartsStructureBinding(dir, project, target, undefined, now);
    return;
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    if (error.code !== 'STRUCTURE_DECISIONS_MISSING') {
      return { role: 'agent', field: 'current.parts.structure', awaits, command: null,
        act: `${error.code}: ${error.message}` };
    }
    return { role: 'agent', field: 'current.parts.structure', awaits, command: `rig-create structure-snapshot ${shellWord(dir)}`,
      act: 'Retain the structure snapshot of the recorded parts.' };
  }
}

const PLAN_STAGES: Readonly<Record<string, readonly PlanStep[]>> = {
  'plan-approved': ['parts'],
  'rigging-interview': ['rigging', 'motion'],
  'post-interview': ['direction'],
};
const OPTIONAL_SIGNOFF_PREFIX = 'optional: if the owner said something about ';

function stagePlanMove(dir: string, project: JsonObject, effectiveStage: string, steps: JsonObject[]): NextMove | undefined {
  const planSteps = PLAN_STAGES[effectiveStage];
  if (!planSteps) return;
  const proposed = planSteps.flatMap(step => {
    const entry = currentStepPlan(project, step);
    if (!entry || typeof entry.path !== 'string') return [];
    try {
      const text = readFileSync(literalFile(dir, entry.path), 'utf8').trim();
      return text ? [{ path: entry.path, text }] : [];
    } catch { return []; }
  });
  if (proposed.length > 0) {
    const source = proposed.map(entry => entry.path).join(', ');
    const quoted = proposed.length === 1
      ? JSON.stringify(proposed[0]!.text)
      : proposed.map(entry => `${entry.path}: ${JSON.stringify(entry.text)}`).join('; ');
    return {
      role: 'agent',
      field: 'interview.step_plans',
      awaits: 'project.stage',
      command: null,
      act: `Tell the owner the plan in chat before advancing (no reply required; from ${source}): ${quoted}`,
    };
  }
  const covered = steps.filter(step => stepCoveredByApproval(project, step, effectiveStage)
    && typeof step.id === 'string' && typeof step.does === 'string' && step.does.trim() !== '');
  if (covered.length === 0) return;
  const ids = covered.map(step => String(step.id)).join(', ');
  const summary = covered.map(step => `${String(step.id)}: ${String(step.does).trim()}`).join(' ');
  return {
    role: 'agent',
    field: 'plan.steps',
    awaits: 'project.stage',
    command: null,
    act: `Tell the owner the plan in chat before advancing (no reply required; from plan.steps ${ids}): ${JSON.stringify(summary)}`,
  };
}

function optionalCurrentSignoffMove(
  dir: string,
  project: JsonObject,
  targetStage: string,
  hasLiveSignoff: boolean,
  now: number,
): NextMove | undefined {
  if (hasLiveSignoff) return;
  let command: string | undefined;
  if (targetStage === 'parts-review') {
    let target: JsonObject | undefined;
    try {
      target = selectSignoffTarget(dir, project, 'parts-review');
      if (!target) return;
      currentPartsStructureBinding(dir, project, target, undefined, now);
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
      return;
    }
    command = `rig-create signoff parts-review ${shellWord(dir)} ${OWNER_CHAT_COMMAND_FLAGS}`;
  } else {
    command = ownerChatSignoffCommand(dir, project, { kind: 'signoff', stage: targetStage }, `signoff ${targetStage}`);
  }
  if (!command) return;
  return {
    role: 'human',
    field: 'signoffs',
    awaits: `signoffs[stage=${targetStage}]`,
    command,
    act: `${OPTIONAL_SIGNOFF_PREFIX}${targetStage}, record it by relay with exact words, owner date and relay identity`,
  };
}

function optionalCurrentOpenMove(
  dir: string,
  project: JsonObject,
  report: CheckReport,
  kind: CurrentPublicationOutput,
): NextMove | undefined {
  if (!SUPPORTED_CURRENT_PUBLICATION_OUTPUTS.has(kind)) return;
  const path = `current.${kind}`;
  if (!isObject(project.current) || !isObject(project.current[kind])) return;
  if (report.refusals.some(r => r.path === path || r.path.startsWith(`${path}.`))) return;
  if (report.warnings.some(w => w.code === 'OUTPUT_STALE' && w.path === path)) return;
  return {
    role: 'agent',
    field: path,
    awaits: path,
    command: `rig-create job open ${shellWord(dir)} --current ${kind} --reviewer '<reviewer>' --role owner`,
    act: `optional: publish the recorded ${kind} output to Review to look together and comment; ${OPEN_REVIEW_HOST}`,
  };
}

function stagedBuild(dir: string, kind: 'parts' | 'rig', from: string): { config: string; packed: boolean } | undefined {
  const runPath = `${from}/${RUN_RECORD_NAME}`;
  const buildPath = `${from}/build-run.json`;
  const packed = kind === 'rig' && retouchPathExists(dir, buildPath);
  if (packed && retouchPathExists(dir, runPath)) return;
  const path = packed ? buildPath : runPath;
  try {
    const { spec, record } = validateRunRecord(readFileSync(literalFile(dir, path)), path, { allowAssembleInputs: kind === 'parts' });
    const command = kind === 'parts' ? 'assemble' : packed ? 'build' : 'rig';
    if (record.command !== command || (packed ? spec !== 'rig-run/2' && spec !== 'rig-run/3' : spec !== 'rig-run/1')
      || !isObject(record.config) || typeof record.config.path !== 'string') return;
    const marker = kind === 'parts' ? 'rig/parts.json' : packed ? 'rig/rig.json' : 'rig.json';
    const product = asArray(record.outputs).filter(isObject).find(file => file.path === marker);
    if (!product || !producerHashMatches(dir, `${from}/${marker}`, product.sha256)) return;
    const { path: named, sha256 } = record.config;
    const config = [posix.join(from, named), named].find(candidate =>
      !candidate.startsWith('outputs/') && producerHashMatches(dir, candidate, sha256));
    if (config) return { config, packed };
  } catch { /* The record writer owns validation and refusal reporting. */ }
}

function hasStagedBuildCheck(dir: string, kind: 'parts' | 'rig', from: string, now: number): boolean {
  const path = `${from}/check/${kind === 'parts' ? PARTS_CHECK_FILE : RIG_CHECK_REPORT_FILE}`;
  try {
    const bytes = readFileSync(literalFile(dir, path));
    if (kind === 'parts') {
      const checked = partsCheckRecord(dir, path, `${from}/rig`, path, () => bytes);
      return !('refusal' in checked) && partsCheckFindings(dir, checked.record, path, true, () => bytes).length === 0;
    }
    const report = parseRigCheckReport(bytes);
    const modelPath = `${from}/check/build/skeleton.model.json`;
    return report.spec === 'rig-parts-check/1' && report.PASS === true && isObject(report.build)
      && producerHashMatches(dir, modelPath, report.build.model_sha256)
      && checkRigReport({ at: new Date(now).toISOString(), check_report: { path, spec: report.spec } },
        path, path, report.build.model_sha256, () => bytes, []).length === 0;
  } catch { return false; }
}

function projectConfig(dir: string, path: string): JsonObject | undefined {
  try {
    const value: Json = JSON.parse(readFileSync(literalFile(dir, path), 'utf8'));
    if (isObject(value)) return value;
  } catch { /* Ask the operator for a readable spec. */ }
}

function currentBuildMove(dir: string, project: JsonObject, kind: 'parts' | 'rig', now: number): NextMove {
  const from = `${outputRoot(kind)}.next`;
  const field = `current.${kind}`;
  const producer = (command: string, act: string): NextMove => ({
    role: 'producer', field, awaits: field, command: `(cd ${shellWord(dir)} && ${command})`, act,
  });
  const staged = stagedBuild(dir, kind, from);
  if (staged && hasStagedBuildCheck(dir, kind, from, now)) return {
    ...currentOutputMove(dir, kind, shellWord, staged.config),
    act: `Record the checked ${kind} in ${from} using its bound config.`,
  };
  if ((!staged && retouchPathExists(dir, from)) || staged?.packed) return {
    role: 'producer', field, awaits: field, command: null,
    act: `Inspect and preserve the incomplete or changed output in ${from}. Restore its matching run, config and green check or set it aside before building a fresh staging tree.`,
  };
  const source = shellWord(typeof project.painting === 'string' ? project.painting : '<painting.png>');
  if (kind === 'parts') {
    if (staged) return producer(`rig-parts check-parts --parts ${from}/rig --out ${from}/check`,
      'Check the staged assembly before recording it.');
    const config = ['specs/rig/assemble.json', 'specs/rig/config.json']
      .find(path => isObject(projectConfig(dir, path)?.assemble));
    const full = existsSync(join(dir, 'derived/layers/layers.json')) ? 'derived/layers' : '<full-layers>';
    const plan = config ? projectConfig(dir, config)?.assemble : undefined;
    const head = isObject(plan) && asArray(plan.plan).some(part => Array.isArray(part) && part[1] === 'head')
      ? ` --head ${shellWord('<head-layers>')}` : '';
    return producer(`rig-parts assemble --source ${source} --full ${shellWord(full)}${head} --config ${shellWord(config ?? '<assemble-config.json>')} --out ${from}`,
      'Supply the registered source painting, prepared layers and assembly spec for any placeholders.');
  }
  const parts = `${outputRoot('parts')}/rig`;
  if (!staged) {
    const config = projectConfig(dir, 'specs/rig/config.json') ? 'specs/rig/config.json' : '<rig-config.json>';
    return producer(`rig-parts rig --config ${shellWord(config)} --parts ${parts} --out ${from}`,
      'Build the staged rig from the recorded parts and supply the authored rig spec if needed.');
  }
  const spec = projectConfig(dir, staged.config);
  const requirements = spec?.requirements;
  const requirementsPath = typeof requirements === 'string' && !posix.isAbsolute(requirements)
    ? posix.join(posix.dirname(staged.config), requirements) : '<requirements-file>';
  const flag = requirements === undefined ? '' : ` --requirements ${shellWord(requirementsPath.startsWith('../') ? '<requirements-file>' : requirementsPath)}`;
  return producer(`rig-parts check --rig ${from} --parts ${parts} --source ${source}${flag} --out ${from}/check`,
    'Check the staged rig against the recorded painting and the requirements named by its spec. Supply any requested check options that the spec leaves open.');
}

function currentPostOutputMove(dir: string, project: JsonObject, kind: 'motion' | 'direction'): NextMove | undefined {
  const inProject = (command: string) => `(cd ${shellWord(dir)} && ${command})`;
  if (kind === 'motion') {
    if (!currentFileBinding(project, 'rig', CURRENT_RIG_MODEL)) return;
    if (existsSync(join(dir, 'outputs/motion.next/frames.json'))) return currentOutputMove(dir, kind, shellWord);
    const { policy: seam } = readMotionLoopSeamPolicy(dir);
    const flags = seam ? ` --loop-seam-bar ${seam.channel_delta},${seam.pixels_above} --loop-seam-cap ${seam.warmup_cap}` : '';
    return { role: 'producer', field: 'current.motion', awaits: 'current.motion',
      command: inProject(`rigc render --candidate outputs/rig/check/build --out outputs/motion.next --animation idle --fps '<frames-per-second>'${flags}`),
      act: 'Render the recorded rig at the requested sample rate, then record the staged motion.' };
  }
  if (!isObject(project.current) || !isObject(project.current.motion)) return;
  try {
    const scene = directionJson(sceneBytes(dir, CURRENT_SCENE_PATH, 'SCENE_FILE_CHANGED'), CURRENT_SCENE_PATH);
    validateCurrentScene(dir, project, scene);
    if (!sceneBinding(scene.compose)) throw new SceneError('SCENE_MALFORMED', CURRENT_SCENE_PATH, 'expected a Parts compose scene');
  } catch (error) {
    if (!(error instanceof SceneError || error instanceof DirectionError)) throw error;
    return { role: 'agent', field: CURRENT_SCENE_PATH, awaits: CURRENT_SCENE_PATH,
      command: `rig-create scene write ${shellWord(dir)} --compose-scene specs/direction/compose-scene.json`,
      act: "Author the Parts scene from the owner's composition choice and registered plate, then seal it against the recorded rig and motion." };
  }

  let sourcePath: string;
  try {
    const snapshots = new Map<string, Buffer>();
    const document = directionJson(sceneBytes(dir, CURRENT_DIRECTION_PATH, 'DIRECTION_SOURCE_CHANGED', snapshots), CURRENT_DIRECTION_PATH);
    sourcePath = currentDirectionSource(dir, project, document, snapshots).source.path;
  } catch (error) {
    if (!(error instanceof SceneError || error instanceof DirectionError)) throw error;
    return { role: 'agent', field: CURRENT_DIRECTION_PATH, awaits: CURRENT_DIRECTION_PATH,
      command: `rig-create direction write ${shellWord(dir)} --file specs/direction/intent.json`,
      act: 'Author a looping take and citations for the current camera, timing and composition choices, then seal the direction spec.' };
  }

  if ([COMPOSE_RUN_PATH, COMPOSE_CHECK_PATH].every(path => existsSync(join(dir, 'outputs/direction.next', path)))) {
    return currentOutputMove(dir, kind, shellWord);
  }
  return { role: 'producer', field: 'current.direction', awaits: 'current.direction',
    command: inProject(`rig-parts compose --scene ${shellWord(sourcePath)} --out outputs/direction.next`),
    act: 'Compose the scene bound by the direction spec, then record the staged direction.' };
}

/** An occupied path is never a fresh producer destination, including dangling links. */
function retouchPathExists(dir: string, path: string): boolean {
  try { lstatSync(resolve(dir, path)); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ENOENT'; }
}

/** Resume a related prepared config, without treating it as producer provenance or approval. */
function preparedPartsRetouch(dir: string, draft: JsonObject, id: string): boolean {
  try {
    if (!isObject(draft.config) || typeof draft.config.path !== 'string') return false;
    const root = realpathSync(dir);
    const source = publicationFile(root, draft.config.path);
    if (createHash('sha256').update(source).digest('hex') !== draft.config.sha256) return false;
    const previous: Json = JSON.parse(source.toString('utf8'));
    const pending: Json = JSON.parse(publicationFile(root, `derived/drafts/${id}/config.json`).toString('utf8'));
    if (!isObject(previous) || !isObject(previous.assemble) || !isObject(pending) || !isObject(pending.assemble)) return false;
    // Keep the source configuration fixed; the producer validates the edited_parts declaration.
    delete previous.assemble.edited_parts;
    delete pending.assemble.edited_parts;
    return isDeepStrictEqual(previous, pending);
  } catch { return false; }
}

function partsRetouchMoves(dir: string, project: JsonObject, draft: JsonObject): NextMove[] {
  const ids = new Set(asArray(project.drafts).filter(isObject).map(row => String(row.id)));
  let id: string;
  let suffix = 1;
  do {
    const tail = `-retouch-${suffix++}`;
    id = `${String(draft.id).slice(0, 64 - tail.length)}${tail}`;
  } while (ids.has(id) || retouchPathExists(dir, `derived/drafts/${id}`) && !preparedPartsRetouch(dir, draft, id));
  const root = `derived/drafts/${id}`;
  const build = `${root}/build`;
  const prepared = retouchPathExists(dir, root);
  const existingBuild = retouchPathExists(dir, build);
  const evidence = partsEvidencePaths(id, true);
  const painting = asArray(project.inputs).filter(isObject)[0]?.path;
  const paintingPath = typeof painting === 'string' ? painting : '<painting.png>';
  const move = (role: NextRole, field: string, command: string | null, act: string): NextMove => ({ role, field, awaits: `drafts[${id}]`, command, act });
  const diff = resolveDiffComponentsMove(dir, id, build, paintingPath, evidence.diff);
  return [
    move('agent', `drafts[${id}].config`, null, `Draft ${String(draft.id)} requests changes. Retain it and its verdict and evidence; keep parts-review throughout. ${prepared ? `Resume ${root}/config.json without replacing the prepared config or its inputs; it matches the previous config outside assemble.edited_parts. The producer and draft writer still validate its contents. Original config:` : `Prepare ${root}/config.json from`} ${String(isObject(draft.config) ? draft.config.path : '<previous config>')}, preserving source input bindings and declaring assemble.edited_parts with dir and per-file receipts (part, file, from_sha256, sha256, editor) for the retouch against the painting (docs/SOURCE.md#handing-a-retouch-to-an-image-editor). ${BASELINES_AFTER_FINAL_ASSEMBLE} Do not replace the old draft's files.`),
    ...(existingBuild
      ? [move('agent', `drafts[${id}].parts`, null, `Preserve the existing ${build} entry; do not rerun build over it. Try the draft-rig registration below to validate retained output. If incomplete or unrelated, inspect it and choose a separate output target rather than overwriting it.`)]
      : [move('producer', `drafts[${id}].parts`, `rig-parts build --config ${shellWord(resolve(dir, root, 'config.json'))} --source ${shellWord(resolve(dir, paintingPath))} --full '<source layers dir or PSD>' --out ${shellWord(resolve(dir, build))}`, 'build the edited_parts draft from its source layers; preserve any required head/source arguments and stop on producer refusals')]),
    move('agent', 'drafts', `rig-create draft-rig ${shellWord(id)} ${shellWord(dir)} --config ${shellWord(`${root}/config.json`)} --from ${shellWord(build)}`, `register NEW draft ${id}; inventory only, without asking for a verdict yet`),
    move('producer', `drafts[${id}].parts`, `rig-parts check-parts --parts ${shellWord(resolve(dir, build))} --out ${shellWord(resolve(dir, evidence.directory))}`, `retain the new draft's parts-check at ${evidence.check}; preserve the original stage-entry advance evidence`),
    move('agent', `drafts[${id}]`, `rig-create structure-snapshot ${shellWord(dir)} --draft ${shellWord(id)}`, 'retain a NEW structure snapshot of the retouched draft'),
    move('producer', `drafts[${id}].parts`, diff.command, diff.act),
    move('agent', 'diff_map', resolveDiffClassesCommand(dir, evidence.diff, evidence.triage), `classify the NEW diff report ${evidence.diff}; rerun next after producing it to omit triage when no components exist`),
    move('agent', 'review_acts', `rig-create job open ${shellWord(dir)} --draft ${shellWord(id)} --reviewer '<reviewer>' --role owner`, `only after the new evidence is ready, publish NEW draft ${id} and ask for one parts-verdict; approval also records its parts-review signature`),
  ];
}

function partsDraftEvidenceMoves(
  dir: string,
  project: JsonObject,
  effectiveStage: string,
  jobId: string | undefined,
  now: number,
): {
  draftId: string | undefined;
  hasApprovedPartsVerdict: boolean;
  structure: { path: string; valid: boolean } | undefined;
  retouching: boolean;
  moves: NextMove[];
} {
  const drafts = asArray(project.drafts).filter(isObject);
  const latestDraft = drafts[drafts.length - 1];
  const draftId = typeof latestDraft?.id === 'string' ? latestDraft.id : undefined;
  const partsRoot =
    isObject(latestDraft?.parts) && typeof latestDraft.parts.path === 'string'
      ? latestDraft.parts.path
      : undefined;
  const hasApprovedPartsVerdict = hasApprovedPartsVerdictReceipt(dir, project, draftId);
  const structure = draftId === undefined ? undefined : partsStructureSnapshot(dir, project, draftId);
  if (effectiveStage === 'parts-review' && draftId !== undefined && latestPartsVerdictStatus(project, draftId) === 'changes-requested') {
    const field = `drafts[${draftId}]`;
    return {
      draftId,
      hasApprovedPartsVerdict,
      structure,
      retouching: true,
      moves: project.current === undefined ? partsRetouchMoves(dir, project, latestDraft!) : [{
        role: 'agent', field, awaits: field, command: null,
        act: `Draft ${draftId} requests changes. Read the owner's comments in Review and preserve the draft and its evidence while preparing replacement parts.`,
      }],
    };
  }
  const arrival = asArray(project.advances).filter(isObject).filter(isPartsCheckMove).at(-1);
  const retouch = effectiveStage === 'parts-review' && isObject(arrival?.parts_check)
    && arrival.parts_check.parts !== partsRoot;
  const evidence = partsEvidencePaths(draftId ?? '', retouch);
  const previousPartsActAt = Math.max(
    -Infinity,
    ...asArray(project.review_acts)
      .filter((entry): entry is JsonObject => isObject(entry) && entry.draft_id !== draftId && isPartsReviewReceipt(entry))
      .map(entry => {
        if (typeof entry.at === 'string') return Date.parse(entry.at);
        if (typeof entry.bytes === 'string') {
          try {
            const parsed: Json = JSON.parse(entry.bytes);
            if (isObject(parsed) && typeof parsed.at === 'string') return Date.parse(parsed.at);
          } catch { /* Handled by reviewActFindings. */ }
        }
        return -Infinity;
      })
      .filter(Number.isFinite),
  );
  const diffAt = isObject(project.diff_map) ? Date.parse(String(project.diff_map.at)) : NaN;
  const draftAt = Date.parse(String(latestDraft?.at));
  const diffForCurrentDraft = !retouch
    || (isObject(project.diff_map) && (
      (isObject(project.diff_map.report) && project.diff_map.report.path === evidence.diff)
      || (Number.isFinite(diffAt) && Number.isFinite(draftAt) && diffAt >= draftAt && diffAt > previousPartsActAt)
    ));
  const currentDiff = diffForCurrentDraft
    && hasValidDiffMap(dir, project, partsRoot === undefined ? undefined : resolve(dir, partsRoot, 'parts.json'));
  const arrivalCheckValid = isObject(arrival?.parts_check)
    && partsCheckFindings(dir, arrival.parts_check, 'advances.parts_check', true).length === 0;
  const currentCheck = partsRoot !== undefined && (
    hasCurrentPartsCheck(dir, evidence.check, partsRoot)
    || (effectiveStage === 'parts-review' && Boolean(structure?.valid) && currentDiff && arrivalCheckValid)
  );

  const moves: NextMove[] = [];
  if (partsRoot !== undefined && !currentCheck) {
    moves.push({
      role: 'producer',
      field: 'drafts',
      awaits: evidence.check,
      command: `rig-parts check-parts --parts ${shellWord(resolve(dir, partsRoot))} --out ${shellWord(resolve(dir, evidence.directory))}`,
      act: `produce and retain ${evidence.check} for the current draft before asking for its verdict`,
    });
  }
  if (draftId !== undefined && structure !== undefined && !structure.valid) {
    moves.push({
      role: 'agent',
      field: `drafts[${draftId}]`,
      awaits: structure.path,
      command: `rig-create structure-snapshot ${shellWord(dir)} --draft ${shellWord(draftId)}`,
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
  const reusedDraftNeedsStack = isObject(latestDraft?.reuse) && partsRoot !== undefined &&
    !diffStackCandidates(resolve(dir, partsRoot, 'parts.json')).some(file => existsSync(file));
  if (reusedDraftNeedsStack && !currentDiff) {
    moves.push({
      role: 'agent',
      field: `drafts[${draftId}].parts`,
      awaits: `${partsRoot}/recomposite_rig.png`,
      command: null,
      act: 'restore the retained recomposite_rig.png for the reused parts before checking their diff map',
    });
  } else if (
    draftId !== undefined &&
    partsRoot !== undefined &&
    paintingPath !== undefined &&
    !currentDiff &&
    !existsSync(join(dir, evidence.diff))
  ) {
    const diffMove = resolveDiffComponentsMove(dir, draftId, partsRoot, paintingPath, evidence.diff);
    moves.push({
      role: 'producer',
      field: `drafts[${draftId}].parts`,
      awaits: evidence.diff,
      command: diffMove.command,
      act: diffMove.act,
    });
  } else if (
    existsSync(join(dir, evidence.diff)) &&
    !currentDiff
  ) {
    moves.push({
      role: 'agent',
      field: 'diff_map',
      awaits: 'diff_map',
      command: resolveDiffClassesCommand(dir, evidence.diff, evidence.triage),
      act: `record agent component classification for ${evidence.diff} in diff_map`,
    });
  }
  if (effectiveStage === 'parts' && partsRoot !== undefined && structure?.valid && currentDiff && currentCheck) {
    const advCmd = candidateAdvance(dir, project, 'parts-review', now, {
      report: evidence.check,
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
  if (draftId !== undefined && !hasApprovedPartsVerdict && effectiveStage === 'parts-review' && currentCheck && structure?.valid && currentDiff) {
    const verdictAwait = `review_acts[kind=parts-verdict,draft_id=${draftId}]`;
    moves.push({
      role: 'human',
      field: 'review_acts',
      awaits: verdictAwait,
      command: null,
      act: `review-tool act parts-verdict for drafts[${draftId}]; approve once to record the verdict and parts-review signature`,
      review_act: {
        kind: 'parts-verdict',
        stage: 'parts-review',
        draft_id: draftId,
        ...(jobId ? { job_id: jobId } : {}),
      },
    });
  }
  return {
    draftId,
    hasApprovedPartsVerdict,
    structure,
    retouching: false,
    moves,
  };
}

export function nextCollection(collectionDirArg: string): NextCollectionReport {
  const checked = checkCollection(collectionDirArg);
  return {
    kind: 'collection',
    collection_dir: checked.collection_dir,
    stage: checked.stage,
    effective_stage: checked.effective_stage,
    refusals: checked.refusals.map(r => ({
      code: r.code,
      path: r.path,
      message: r.message,
      remedy: remedyForFinding(r.code, r.message),
    })),
    members: checked.members.map(name => ({
      name,
      command: `rig-create next ${shellWord(join(checked.collection_dir, 'members', name))}`,
    })),
  };
}

function moveNeedsJobHost(move: NextMove, hasJobBinding: boolean): boolean {
  const cmd = move.command;
  if (!cmd) return false;
  if (cmd.startsWith('rig-create job ') || cmd.includes(' --from-review')) return true;
  if (!hasJobBinding) return false;
  return /^rig-create (?:draft-rig|rig-version (?!adapter\b)|direction write [0-9]|advance (?:rig-review|direction-review)\b)/.test(cmd);
}

function ownerLanguageMove(dir: string, report: CheckReport): NextMove | undefined {
  const finding = report.warnings.find(
    warning => warning.code === 'OWNER_LANGUAGE_MISSING' || warning.code === 'OWNER_LANGUAGE_INVALID',
  );
  if (!finding) return undefined;
  const status = finding.code === 'OWNER_LANGUAGE_INVALID'
    ? 'owner.language is invalid'
    : 'owner.language is undeclared';
  return {
    role: 'agent',
    field: 'owner.language',
    awaits: 'owner.language',
    command: `rig-create owner-language set '<tag>' ${shellWord(dir)}`,
    act: `${status} (${finding.code}): ask the owner through the relayed chat for their language tag (such as ko or en-US), then declare it with owner-language set before opening Review`,
  };
}

export function nextProject(projectDirArg: string, now: number = Date.now()): NextReport {
  const dir = resolve(projectDirArg);
  const report: CheckReport = checkProject(dir, undefined, { now, readOnly: true, includeRoutedAnswerWarnings: true });
  const fatal = report.refusals.find(r => FATAL_CODES.has(r.code));
  if (fatal !== undefined) refuse(fatal.code, fatal.message);

  const project = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
  const steps = asArray(isObject(project.plan) ? project.plan.steps : undefined).filter(isObject);
  const staleSteps = report.refusals.flatMap(finding => {
    if (finding.code !== 'PLAN_STEP_PREDATES_ANSWER') return [];
    const step = steps.find(step => finding.path === `plan.steps[${String(step.id)}]`);
    return step ? [{ finding, step }] : [];
  });
  const collection = loadCollection(dir);
  const allItems = collectItems(project, { collection });
  const currentPath = isCurrentPathProject(project, allItems);
  const { blocksOutputMoves, ...derived } = deriveNextProject(dir, project, report, now, steps, staleSteps, currentPath, collection, allItems);
  let next = derived;
  if (!blocksOutputMoves && derived.stage !== PAUSED_STAGE) {
    const current = project.current === undefined && currentPath ? {} : project.current;
    if (isObject(current)) {
      const reopens = collectReopens(project, []);
      const missing = new Map(CURRENT_KINDS.flatMap(kind => {
        const node = current[kind];
        const preCutoffDirection = kind === 'direction' && currentPath && isObject(node)
          && !liveSignoff(reopens, 'post', Date.parse(String(node.at)));
        if (node !== undefined && !preCutoffDirection) return [];
        let producer: NextMove | undefined;
        if (!currentPath) {
          producer = currentOutputMove(dir, kind, shellWord);
        } else if (kind === 'parts' || kind === 'rig') {
          if (derived.effective_stage === (kind === 'parts' ? 'parts' : 'rigging')) {
            producer = currentBuildMove(dir, project, kind, now);
          }
        } else if (derived.effective_stage === 'post') {
          producer = currentPostOutputMove(dir, project, kind);
        }
        return producer ? [[kind, { adoption: adoptionMove(dir, project, kind), producer }]] as const : [];
      }));
      next = withStaleOutputs(dir, current, report.warnings, derived, shellWord, missing);
    }
  }
  const languageMove = next.stage !== PAUSED_STAGE && !next.accepted
    && (!blocksOutputMoves || next.moves.length > 0 || staleSteps.length > 0)
    ? ownerLanguageMove(dir, report)
    : undefined;
  if (languageMove) {
    const hasJobBinding = readWriterBinding(dir) !== null;
    const jobIndex = next.moves.findIndex(move => moveNeedsJobHost(move, hasJobBinding));
    const moves = jobIndex >= 0
      ? [...next.moves.slice(0, jobIndex), languageMove, ...next.moves.slice(jobIndex)]
      : [...next.moves, languageMove];
    const awaits = next.awaits.includes(languageMove.awaits)
      ? next.awaits
      : jobIndex >= 0
        ? [languageMove.awaits, ...next.awaits]
        : [...next.awaits, languageMove.awaits];
    next = { ...next, awaits, moves };
  }
  // Every stage shows the repairs. Approval gating uses only the steps that approval covers.
  const revisionMoves = staleSteps.map(({ finding, step }): NextMove => {
    if (planStepCompleted(project, step)) {
      const needsAmendment = completedPlanStepNeedsAmendment(project, step, now);
      const command = needsAmendment ? null : completedPlanRepairCommand(step, dir);
      return { role: needsAmendment ? 'human' : 'agent', field: finding.path, awaits: finding.path, command,
        act: `${finding.message}. Retain the completed definition and its execution history in plan.replaced.`
          + (command === null ? '' : ' Before executing the shown plan replace command, review the replacement definition against the recorded answer and update any fields that need to change.') };
    }
    const id = String(step.id);
    return { role: 'agent', field: finding.path, awaits: finding.path,
      command: `rig-create plan revise ${shellWord(id)} ${shellWord(dir)} --by agent --reason '<why this step fits the recorded answer>'`,
      act: `Review ${finding.path} against the recorded answer and update any fields that need to change before requesting approval.` };
  });
  const receipts = asArray(project.review_acts);
  const commentMoves = report.warnings.flatMap((warning): NextMove[] => {
    if (warning.code !== 'REVIEW_ANSWER_COMMENT_ROUTED') return [];
    const match = ROUTED_ANSWER_COMMENT_PATH.exec(warning.path);
    if (match === null) return [];
    const receipt = receipts[Number(match[1])];
    if (!isObject(receipt) || receipt.kind !== 'interview-picks' || !isObject(receipt.feedback_route)
      || typeof receipt.jobId !== 'string' || typeof receipt.actId !== 'string'
      || typeof receipt.feedback_route.question !== 'string') return [];
    const { question } = receipt.feedback_route;
    const comment = asArray(receipt.feedback_route.comments)[Number(match[2])];
    if (!isObject(comment) || typeof comment.order !== 'number') return [];
    const source = `--job ${shellWord(receipt.jobId)} --act ${shellWord(receipt.actId)} --order ${comment.order}`;
    return [{
      role: 'agent', field: warning.path, awaits: warning.path,
      command: `rig-create interview-answer ${shellWord(question)} ${shellWord(dir)} --close-comment ${source} --by agent --reason-file '<file>'`,
      act: 'Replace <file> with your explanation. Add --resolved-by-answer <question> if a later completed answer or guide resolves the comment.',
    }];
  });
  const combined = revisionMoves.length === 0 && commentMoves.length === 0 ? next : {
    ...next,
    awaits: [...revisionMoves.map(move => move.awaits), ...next.awaits, ...commentMoves.map(move => move.awaits)],
    moves: [...revisionMoves, ...next.moves, ...commentMoves],
  };
  return withCurrentComments(dir, project, combined, shellWord, now, currentPath || isCurrentProject(project));
}

function deriveNextProject(dir: string, project: JsonObject, report: CheckReport, now: number,
  steps: JsonObject[], staleSteps: { finding: Finding; step: JsonObject }[], currentPath: boolean,
  collection: ReturnType<typeof loadCollection>, allItems: Item[]): NextReport & { blocksOutputMoves?: true } {
  const stage = String(project.stage ?? '');
  const effectiveStage = String(report.effective_stage ?? stage);
  const legacyWrites = !currentPath && !isCurrentProject(project);
  const warnings = report.warnings.filter(w => w.code === 'STRUCTURE_DELTA_REVIEW' || w.code === 'REVIEW_ANSWER_COMMENT_ROUTED'
    || w.code === 'OUTPUT_STALE' || (!legacyWrites && ['FEEDBACK_OPEN', 'REOPEN_SIGNOFF_LAPSED', 'REOPEN_VERDICT_LAPSED'].includes(w.code)));
  const splitOrder = hasStageOrder(project);
  const stageItems = allItems.filter(item => interviewStageOfGuide(item.id, item.kind === 'post', splitOrder) === effectiveStage);
  const answers = allItems.flatMap(item => {
    const answer = item.state.state === 'user' || item.state.state === 'delegated' || item.state.state === 'not_applicable'
      ? item.state.answer : isObject(item.raw) ? item.raw : null;
    if (!answer) return [];
    return [{ question_id: item.id, field: item.path, by: answer.by ?? null, at: answer.at ?? null,
      picks: asArray(isObject(answer.choice) ? answer.choice.picks : undefined).filter(isObject).map(pick => ({
        ask: pick.ask ?? null, option_id: pick.option_id ?? null, label: isObject(pick.shown) ? pick.shown.label ?? null : null,
      })),
      ...(interviewStageOfGuide(item.id, item.kind === 'post', splitOrder) === effectiveStage
        ? { command: optionCommand(item.id, dir) } : {}) }];
  });
  const versions = asArray(project.versions).filter(isObject);
  const parsedVersions = readVersions(project);
  const reopens = collectReopens(project, []);
  const latestRig = parsedVersions.rigs.at(-1);
  let bustCommands: string[] | undefined;
  const bustRefusals: Finding[] = [];
  if (stage !== PAUSED_STAGE && rigVerdictIngestible(effectiveStage) && latestRig?.live) {
    const version = versions.find(v => v.kind === 'rig' && v.n === latestRig.n)!;
    const verdict = humanReviewVerdicts(version.verdicts, 'rig-review').at(-1);
    const receipts = asArray(project.review_acts);
    let index = -1;
    if (verdict?.record.verdict === 'bounced' && liveSignoff(reopens, 'rig-review', Date.parse(String(verdict.record.at)))) {
      // Resolve the active verdict's receipt before touching any working files.
      index = receipts.findLastIndex((receipt, i) => isObject(receipt)
        && receipt.schema === 'rig-create/review-act@1' && receipt.kind === undefined
        && receipt.version === latestRig.n && receipt.verdict === verdict.index && isObject(receipt.bust_config)
        && !report.refusals.some(finding => finding.path === `review_acts[${i}]`));
    }
    let newest = verdict ? Date.parse(String(verdict.record.at)) : -Infinity;
    receipts.forEach((receipt, i) => {
      if (!isObject(receipt) || receipt.kind !== 'comments' || !isObject(receipt.bust_config)
        || typeof receipt.bytes !== 'string' || report.refusals.some(finding => finding.path === `review_acts[${i}]`)) return;
      const chest = commentChestAct(decodeReviewAct(receipt.bytes, 'comments'));
      if (chest?.source.selector.version !== latestRig.n || !currentUsesBustVersion(project, latestRig.n)) return;
      const at = Date.parse(chest.at);
      if (at < newest || !liveSignoff(reopens, 'rig-review', at)) return;
      newest = at;
      index = i;
    });
    const receipt = receipts[index];
    if (isObject(receipt) && isObject(receipt.bust_config)
      && typeof receipt.bust_config.path === 'string' && typeof receipt.sha256 === 'string') {
      try {
        bustCommands = bustLandmarkCommands(dir, project, version, receipt.bust_config.path, receipt.sha256, true);
      } catch (error) {
        if (!(error instanceof Refusal)) throw error;
        bustRefusals.push({ code: error.code, path: `review_acts[${index}]`, message: error.message });
      }
    }
  }
  const warningFields = { ...(warnings.length ? { warnings } : {}), answers,
    ...(bustCommands ? { bust_landmark_commands: bustCommands } : {}) };
  const jobId = readOptionalJobId(dir);
  const holes = report.holes ?? [];
  const partsEditHoles = holes.filter(hole => hole.code === 'PART_EDIT_UNCOVERED');
  const canRepairPartsEdit = stage !== PAUSED_STAGE && (effectiveStage === 'parts' || effectiveStage === 'parts-review');
  const blockingHoles = canRepairPartsEdit ? holes.filter(hole => hole.code !== 'PART_EDIT_UNCOVERED') : holes;

  const pendingOtherFindings: Finding[] = allItems
    .filter(item => hasPendingOther(item) && !report.refusals.some(r => r.code === 'INTERVIEW_CHOICE_REQUIRED' && r.path === item.path))
    .map(item => ({
      code: 'INTERVIEW_CHOICE_REQUIRED',
      path: item.path,
      message: `${item.path}: Other is pending; ${item.id === 'post_composition'
        ? SCENE_OTHER_FOLLOW_UP
        : 'redraft with a tailored value option and have the person explicitly pick it before approval'}`,
    }));
  const allRefusalFindings: Finding[] = [...report.refusals, ...bustRefusals, ...pendingOtherFindings, ...holes];
  const refusals: NextRefusal[] = allRefusalFindings.map(r => ({
    code: r.code,
    field: r.path,
    message: r.message,
    fix: remedyForFinding(r.code, r.message),
  }));

  const riggingDraft = effectiveStage === 'rigging' ? asArray(project.drafts).filter(isObject).at(-1) : undefined;
  const compiledDraftId = riggingDraft && typeof riggingDraft.id === 'string' && eligibleRigDraftModel(riggingDraft)
    ? riggingDraft.id : undefined;
  const compiledVerdict = compiledDraftId === undefined ? undefined : latestRigDraftVerdict(project, compiledDraftId, now);
  const partsChange = riggingDraft && riggingDraftPartsChange(dir, project, riggingDraft, effectiveStage);
  if (partsChange) {
    const { code, path, message, command } = partsChange;
    const target = 'amendments[target.stage=parts-review]';
    return { schema: NEXT_SCHEMA, project_id: String(project.name ?? ''), stage, effective_stage: effectiveStage,
      blocksOutputMoves: true,
      accepted: false, refusals: [...refusals, { code, field: path, message, fix: command }], ...warningFields,
      awaits: [target], moves: [{ role: 'human', field: 'amendments', awaits: target, command,
        act: 'Record the parts change using the owner’s exact words.' }] };
  }

  // A signed current stage is not refused (#981); next still offers the move to the stage after it.
  const currentStageKind = !legacyWrites && isPublishAdvanceStage(stage) ? currentReviewKind(stage) : undefined;
  const laggingAdvance = !currentPath && stageSignedThrough(project, stage)
    && (!currentStageKind || activeCurrentSignoffTargetPath(project, currentStageKind) !== undefined)
    ? resolveLaggingAdvance(dir, project, stage, now)
    : null;

  const depthFinding = effectiveStage === 'rigging-interview'
    ? [...report.refusals, ...report.warnings].find(finding => finding.code === 'RIG_DEPTH_PLAN_MISSING') : undefined;
  const depthMoves: NextMove[] = depthFinding ? [{ role: 'agent', field: 'plan.steps[turn]', awaits: 'plan.steps[turn]', command: null,
    act: `${depthFinding.code}: ${depthFinding.message}. Record the chosen depth route and reason in its text, with a bar that reads the producer depth reports.` }] : [];
  const phaseApproval = effectiveStage === 'rigging-interview' || effectiveStage === 'post-interview';
  const hasStaleApprovalStep = (stage: string, checkpoint: string | null = null): boolean => staleSteps.some(({ step }) =>
    checkpoint === null ? stepCoveredByApproval(project, step, stage) : step.id === checkpoint);
  const scopedStale = new Set(staleSteps.filter(({ step }) => !phaseApproval || stepCoveredByApproval(project, step, effectiveStage))
    .map(({ finding }) => finding));
  const blockingRefusals = report.refusals.filter(r => r.code === 'PLAN_STEP_PREDATES_ANSWER' ? scopedStale.has(r)
    : !isOpenInterviewTodo(r, effectiveStage));
  const registrations = plateInputMoves(dir, project, allItems, now);
  const allowPostOptions = currentPath && effectiveStage === 'post-interview';
  if (allowPostOptions && registrations.length === 0 && stageItems.some(item =>
    item.id === 'post_composition' && item.state.state === 'silent' && !pendingInterviewOptions(item))) {
    registrations.push({ role: 'agent', field: 'inputs', awaits: 'inputs',
      command: `rig-create input add '<background-image>' ${shellWord(dir)} --origin '<origin>'`,
      act: "If the owner's intended background is unregistered, put it inside the project and register it with its source origin." });
  }
  if (blockingHoles.length > 0 || blockingRefusals.length > 0) {
    const signoffs = asArray(project.signoffs);
    const readyToResign = new Map<string, boolean>();
    for (const finding of report.refusals) {
      if (finding.code !== 'SIGNOFF_ANSWERS_STALE') continue;
      const match = /^signoffs\[(\d+)\]\.answer_hashes\[(.+)\]$/.exec(finding.path);
      if (!match) continue;
      const signoff = signoffs[Number(match[1])];
      if (!isObject(signoff) || typeof signoff.stage !== 'string') continue;
      const item = allItems.find(item => item.id === match[2]);
      // A missing or unfinished answer needs repair before the owner can re-sign.
      const ready = item !== undefined && answered(item.state) && !hasPendingOther(item) && !isUndecidedDelegation(item);
      readyToResign.set(signoff.stage, readyToResign.get(signoff.stage) !== false && ready);
    }
    const moves = [...depthMoves, ...registrations];
    for (const [stage, ready] of readyToResign) {
      if (!ready) continue;
      if (hasStaleApprovalStep(stage)) continue;
      if (!legacyWrites && isPublishAdvanceStage(stage)) {
        const path = `current.${currentReviewKind(stage)}`;
        if (report.warnings.some(w => w.code === 'OUTPUT_STALE' && w.path === path)) continue;
      }
      const command = ownerChatSignoffCommand(dir, project, { kind: 'signoff', stage }, `signoff ${shellWord(stage)}`);
      if (command) moves.push({
        role: 'human', field: 'signoffs', awaits: `signoffs[stage=${stage}]`, command,
        act: `re-sign ${stage} after confirming the intended answers and relay the owner's exact words`,
      });
    }
    // Keep the interview and plan drafting available while a stale step blocks approval.
    const postComp = allItems.find(item => item.id === 'post_composition');
    const sceneChoiceMoves = report.refusals.some(r => r.code === 'SCENE_CHOICE_MISSING')
      ? postCompositionSceneRepairMoves(dir, project, postComp, effectiveStage, now)
      : [];
    const interviewCanContinue = holes.length === 0 && blockingRefusals.every(r => r.code === 'PLAN_STEP_PREDATES_ANSWER')
      && stage !== PAUSED_STAGE && isOpenInterviewStage(effectiveStage);
    const stepPlans = stepPlanQuestions(dir, project, stageItems, allowPostOptions);
    const questions = [...sceneChoiceMoves, ...(interviewCanContinue ? [...stepPlans.moves, ...interviewQuestionMoves(dir, stepPlans.questionItems, effectiveStage)] : [])];
    const plan = interviewCanContinue ? interviewPlanMoves(dir, project, stageItems, effectiveStage, steps) : undefined;
    const awaits = [...moves, ...questions].map(move => move.awaits);
    if (plan?.missingPlanIds.length) awaits.push('plan.steps');
    return {
      schema: NEXT_SCHEMA,
      project_id: String(project.name ?? ''),
      stage,
      effective_stage: effectiveStage,
      blocksOutputMoves: true,
      accepted: false,
      refusals,
      ...warningFields,
      awaits,
      moves: [...moves, ...runnableNextMoves(dir, project, effectiveStage, questions), ...(plan?.moves ?? [])],
    };
  }

  const awaitsList: string[] = [];
  const addAwait = (target: string): void => {
    if (!awaitsList.includes(target)) awaitsList.push(target);
  };
  const moves: NextMove[] = [...depthMoves, ...registrations];
  moves.forEach(move => addAwait(move.awaits));
  if (effectiveStage === 'parts-review') {
    const draftState = partsDraftEvidenceMoves(dir, project, effectiveStage, jobId, now);
    if (partsEditHoles.length > 0 || (!draftState.hasApprovedPartsVerdict && draftState.moves.length > 0)) {
      if (draftState.retouching) {
        return {
          schema: NEXT_SCHEMA,
          project_id: String(project.name ?? ''),
          stage,
          effective_stage: effectiveStage,
          accepted: false,
          refusals,
          ...warningFields,
          awaits: [...new Set(draftState.moves.map(move => move.awaits))],
          moves: draftState.moves,
        };
      }
      const runnableDraftMoves = draftState.moves.flatMap(move => reviewCommands(dir, project, move));
      if (partsEditHoles.length > 0 && (draftState.hasApprovedPartsVerdict || runnableDraftMoves.length === 0)) {
        for (const hole of partsEditHoles) runnableDraftMoves.push({
          role: 'agent', field: hole.path, awaits: hole.path, command: null,
          act: `${hole.message}. ${legacyWrites ? 'Register a new draft if the current one binds different bytes. ' : ''}If the stage is already signed, record the owner's amendment before opening a new verdict.`,
        });
      }
      for (const move of runnableDraftMoves) addAwait(move.awaits);
      return {
        schema: NEXT_SCHEMA,
        project_id: String(project.name ?? ''),
        stage,
        effective_stage: effectiveStage,
        accepted: false,
        refusals,
        ...warningFields,
        awaits: awaitsList,
        moves: [...moves, ...runnableDraftMoves],
      };
    }
  }
  const rigN = parsedVersions.rigs.filter(rig => rig.live).at(-1)?.n ?? null;
  const nextRigN = Math.max(0, ...versions.map(v => Number(v.n) || 0)) + 1;
  const approval = legacyWrites && stage !== PAUSED_STAGE && rigN === null && (effectiveStage === 'rigging' || effectiveStage === 'rig-review')
    ? latestPartsApproval(project, now) : undefined;
  const approvalIdentity = approval && partsApprovalIdentity(approval);
  const checked = approvalIdentity ? latestCheckedRigBuild(dir, versions, Date.parse(approvalIdentity.signoff_at), reopens, now) : undefined;
  const checkedRigN = checked ? nextRigRegistrationNumber(dir, nextRigN) : undefined;
  const pendingCarryCorrection = effectiveStage === 'rigging' && compiledVerdict?.value.verdict === 'approved'
    ? correctionApprovalFindings(project, 'rig-review').find(finding => finding.code === 'CORRECTION_PENDING')
    : undefined;
  const checkedRegistration = checked && checkedRigN !== undefined
    ? rigRegistrationMove(dir, checkedRigN, checked, registrationDeclarations(dir, project, checkedRigN, checked), pendingCarryCorrection)
    : undefined;

  if (effectiveStage === 'rigging') {
    const feedback = compiledDraftId === undefined && typeof riggingDraft?.id === 'string'
      ? latestRiggingDraftFeedback(project, riggingDraft.id) : undefined;
    const currentRig = isObject(project.current) ? project.current.rig : undefined;
    if (compiledVerdict?.value.verdict === 'changes-requested' && (legacyWrites ? rigN === null
      : !isObject(currentRig) || Date.parse(String(currentRig.at)) <= Date.parse(compiledVerdict.at))) {
      const field = `drafts[${compiledVerdict.source.selector.id}]`;
      const source = `review act ${compiledVerdict.jobId}/${compiledVerdict.actId}`;
      const revision = asArray(project.corrections).filter(isObject)
        .findLast(row => row.source === source && isObject(row.outcome) && row.outcome.kind === 'mesh-delta')?.outcome;
      addAwait(field);
      moves.push({ role: 'agent', field, awaits: field,
        command: legacyWrites ? `rig-create draft-rig '<new-id>' ${shellWord(dir)} --config '<new-config>' --from '<new-output>'` : null,
        act: `Read the retained comments in ${source} and ${legacyWrites ? 'build a new draft with a new ID' : 'prepare the replacement rig output'}${isObject(revision) ? ` using the retained Parts revision ${String(revision.revision)}` : ''}. Preserve ${field} and its verdict${legacyWrites ? ', then register and publish the new draft' : ''}.` });
      if (checkedRegistration) {
        addAwait(checkedRegistration.awaits);
        moves.push(checkedRegistration);
      }
      return { schema: NEXT_SCHEMA, project_id: String(project.name ?? ''), stage, effective_stage: effectiveStage,
        accepted: false, refusals, ...warningFields, awaits: awaitsList, moves };
    }
    if (feedback?.act.value.verdict === 'changes-requested' && liveSignoff(reopens, 'rigging', Date.parse(feedback.act.at))) {
      const id = feedback.act.source.selector.id;
      const field = `drafts[${id}]`;
      addAwait(field);
      try {
        assertPartsActSource(dir, project, feedback.act, { comparePlan: false });
        moves.push({
          role: 'agent', field, awaits: field,
          command: legacyWrites ? `rig-create draft-rig '<new-id>' ${shellWord(dir)} --config '<new-config>' --from '<new-output>'` : null,
          act: `Rigging draft ${id} requests changes. Read the owner's exact comments in ${String(feedback.evidence.path)} (sha256 ${String(feedback.evidence.sha256)}), ${legacyWrites ? 'apply them to a new draft output, then register and publish it for review' : 'and apply them to the replacement rig output'}. Preserve the reviewed draft and evidence.`,
        });
      } catch (error) {
        if (!(error instanceof Refusal)) throw error;
        moves.push({ role: 'agent', field, awaits: field, command: null, act: `${error.code} ${error.message}` });
      }
      return { schema: NEXT_SCHEMA, project_id: String(project.name ?? ''), stage, effective_stage: effectiveStage,
        accepted: false, refusals, ...warningFields, awaits: awaitsList, moves };
    }
  }
  // The check owns bounce/withdrawal/answer logic; consume its open findings.
  const openFeedback = report.warnings.filter(w => w.code === 'FEEDBACK_OPEN');
  const pendingMesh = legacyWrites && stage !== PAUSED_STAGE && (effectiveStage === 'rigging' || effectiveStage === 'rig-review')
    ? pendingMeshDeltaRevision(project) : null;
  if (openFeedback.length > 0 || pendingMesh !== null) {
    const previousMoves = moves.length;
    const n = nextRigN;
    const rigInputs = RIG_VERSION_INPUTS.replace('--rig <dir>', '--rig <rig-dir>');
    const groups = new Map<string, { version: number; verdict: number }[]>();
    for (const finding of openFeedback) {
      const summary = report.feedback.find(f => f.verdict === finding.path);
      if (!summary) continue;
      const kind = versions.find(v => v.n === summary.version)?.kind;
      if (kind !== 'rig' && kind !== 'post') continue;
      groups.set(kind, [...(groups.get(kind) ?? []), { version: summary.version, verdict: summary.index }]);
    }

    if (pendingMesh !== null) {
      const field = `versions[n=${n}]`;
      const args = rigInputs.replace(/<[^>]+>/g, arg => shellWord(arg === '<rig-dir>' ? pendingMesh.revision : arg));
      const answers = (groups.get('rig') ?? []).map(ref => ` --answers ${ref.version}:${ref.verdict}`).join('');
      addAwait(field);
      moves.push({ role: 'agent', field: 'versions', awaits: field,
        command: `rig-create rig-version ${n} ${shellWord(dir)} ${args}${answers}`,
        act: `build and check from the recorded mesh revision ${pendingMesh.revision} of rig v${pendingMesh.sourceVersion}, then register it with rig-version ${n} and pass that build's run.json to --run-record` });
      return { schema: NEXT_SCHEMA, project_id: String(project.name ?? ''), stage, effective_stage: effectiveStage, accepted: false, refusals, ...warningFields, awaits: awaitsList, moves };
    }

    for (const [kind, refs] of groups) {
      if (kind === 'post') {
        if (effectiveStage === 'direction-review' && optionPublicationStage(project, effectiveStage, now) === 'post-interview') {
          const pendingPostItems = allItems.filter(item => item.kind === 'post' && pendingInterviewOptions(item));
          const questions = interviewQuestionMoves(dir, pendingPostItems, effectiveStage);
          if (questions.length > 0) {
            for (const question of questions) addAwait(question.awaits);
            moves.push(...questions);
            continue;
          }
        }
        if (!currentPath) {
          const missingApprovals = missingDirectionStepApprovals(project, allItems);
          if (missingApprovals.length > 0) {
            const target = 'signoffs[stage=post-interview]';
            const ids = missingApprovals.join(',');
            addAwait(target);
            moves.push({ role: 'human', field: 'signoffs', awaits: target,
              command: `rig-create signoff post-interview ${shellWord(dir)} --steps ${ids} ${OWNER_CHAT_COMMAND_FLAGS}`,
              act: `Re-approve the post-interview steps ${missingApprovals.join(', ')} before writing the replacement post.` });
            continue;
          }
        }
      }
      if (!legacyWrites) continue;
      const field = `versions[n=${n}]`;
      addAwait(field);
      const writer = kind === 'rig' ? `rig-version ${n}` : `direction write ${n}`;
      const inputs = kind === 'rig' ? rigInputs.replace('<rig-dir>', '<dir>') : '--file <direction.json> --rig <rig-version>';
      moves.push({ role: 'agent', field: 'versions', awaits: field,
        command: `rig-create ${writer} ${shellWord(dir)} ${inputs.replace(/<[^>]+>/g, shellWord)} ${refs.map(r => `--answers ${r.version}:${r.verdict}`).join(' ')}`,
        act: `build the next ${kind} version with ${writer}, recording answers_feedback ${JSON.stringify(refs)}` });
    }
    if (moves.length > (legacyWrites ? 0 : previousMoves)) return { schema: NEXT_SCHEMA, project_id: String(project.name ?? ''), stage, effective_stage: effectiveStage, accepted: false, refusals, ...warningFields, awaits: awaitsList, moves: runnableNextMoves(dir, project, effectiveStage, moves) };
  }
  const recordedLapseTargets = new Set<string>();
  const stageHasPendingOptions = stageItems.some(pendingInterviewOptions);
  const withdrawnCheckpoint = (id: string): boolean => steps.some(step => step.id === id
    && checkpointEnabled(step) && !checkpointRequired(project, step, now));

  // 1. Derive lapsed approvals from reopens[] and amendments[].
  const rawSignoffs = asArray(project.signoffs).filter(isObject);
  const rawReopens = asArray(project.reopens).filter(isObject);
  const signoffs = collectSignoffs(project, []);
  const hasLiveStageSignoff = (targetStage: string): boolean => {
    if (!legacyWrites && isPublishAdvanceStage(targetStage)) {
      return activeCurrentSignoffTargetPath(project, currentReviewKind(targetStage)) !== undefined;
    }
    if (currentPath && targetStage === 'parts-review') {
      return activeCurrentSignoffTargetPath(project, 'parts') !== undefined;
    }
    return signoffs.some(s => s.stage === targetStage && s.checkpoint === null && liveSignoff(reopens, s.stage, s.at));
  };
  const pushCurrentStageProgression = (targetStage: string): void => {
    const reviewReady = !isPublishAdvanceStage(effectiveStage) || (
      currentReviewOutput(dir, project, effectiveStage)
      && !report.warnings.some(w => w.code === 'OUTPUT_STALE' && w.path === `current.${currentReviewKind(effectiveStage)}`)
    );
    if (!reviewReady) return;
    const nextStage = nextStageInOrder(project, effectiveStage, postNotPassed({ items: allItems }));
    const advCmd = nextStage !== null ? candidateAdvance(dir, project, nextStage, now) : null;
    if (advCmd !== null && nextStage !== null) {
      const planMove = stagePlanMove(dir, project, effectiveStage, steps);
      if (planMove) moves.push(planMove);
      addAwait('project.stage');
      moves.push({
        role: 'agent',
        field: 'stage',
        awaits: 'project.stage',
        command: advCmd,
        act: `advance stage from ${effectiveStage} to ${nextStage}`,
      });
    }
    const optionalSignoff = optionalCurrentSignoffMove(dir, project, targetStage, hasLiveStageSignoff(targetStage), now);
    if (optionalSignoff) moves.push(optionalSignoff);
  };
  const addCurrentReviewSignoff = (targetStage: string, field = 'signoffs', lapse?: NextLapse): void => {
    if (stage === PAUSED_STAGE || stageIndex(effectiveStage) < stageIndex(targetStage)) return;
    const awaits = `signoffs[stage=${targetStage}]`;
    if (hasLiveStageSignoff(targetStage) || recordedLapseTargets.has(awaits)) return;
    const command = ownerChatSignoffCommand(dir, project, { kind: 'signoff', stage: targetStage }, `signoff ${targetStage}`);
    if (!command) return;
    addAwait(awaits);
    recordedLapseTargets.add(awaits);
    moves.push({ role: 'human', field, awaits, command,
      act: `relay the owner's ${targetStage} approval with exact words, owner date and relay identity`, ...(lapse ? { lapse } : {}) });
  };
  const hasLiveCheckpointSignoff = (targetStage: string, stepId: string): boolean =>
    signoffs.some(s => s.stage === targetStage && s.checkpoint === stepId && liveSignoff(reopens, s.stage, s.at));
  const isHistoryVersion = (n: number, kind?: 'rig' | 'post'): boolean => {
    const entry = kind === 'rig'
      ? parsedVersions.rigs.find(r => r.n === n)
      : kind === 'post'
        ? parsedVersions.posts.find(p => p.n === n)
        : parsedVersions.rigs.find(r => r.n === n) ?? parsedVersions.posts.find(p => p.n === n);
    return entry !== undefined && !entry.live;
  };
  const hasHistorySignoffTarget = (targetStage: string, signoffEntry: JsonObject | undefined): boolean => {
    const kind = SIGNOFF_TARGET_KINDS[targetStage];
    if (kind === undefined) return false;
    const targetVersion = isObject(signoffEntry?.target) && typeof signoffEntry.target.version === 'number'
      ? signoffEntry.target.version
      : undefined;
    if (targetVersion !== undefined) return isHistoryVersion(targetVersion, kind);
    const pool = kind === 'rig' ? parsedVersions.rigs : parsedVersions.posts;
    const signedAt = Date.parse(String(signoffEntry?.at ?? ''));
    const candidates = Number.isFinite(signedAt)
      ? pool.filter(v => Date.parse(String(v.at ?? '')) <= signedAt)
      : pool;
    return candidates.length > 0 && candidates.every(v => !v.live);
  };
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
      if (currentPath && checkpoint === null) continue;
      if (hasStaleApprovalStep(lapsedStage, checkpoint)) continue;
      if (checkpoint !== null && withdrawnCheckpoint(checkpoint)) continue;
      if (checkpoint === null && lapsedStage === effectiveStage && stageHasPendingOptions) continue;
      if (!legacyWrites && checkpoint === null && isPublishAdvanceStage(lapsedStage)) {
        addCurrentReviewSignoff(lapsedStage, reopenField, { code: warning.code, source_field: reopenField,
          target_field: warning.path, ...(reopenId ? { reopen_id: reopenId } : {}), message: warning.message });
        continue;
      }
      if (checkpoint === null && hasHistorySignoffTarget(lapsedStage, signoffEntry)) continue;
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
    } else if (legacyWrites && warning.code === 'REOPEN_VERDICT_LAPSED') {
      const vMatch = /^versions\[v(\d+)\]\.verdicts\[(\d+)\]$/.exec(warning.path);
      const n = vMatch ? Number(vMatch[1]) : 1;
      if (isHistoryVersion(n)) continue;
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
      if (currentPath && checkpoint === null) continue;
      if (hasStaleApprovalStep(targetStage, checkpoint)) continue;
      if (checkpoint !== null && withdrawnCheckpoint(checkpoint)) continue;
      if (checkpoint !== null ? hasLiveCheckpointSignoff(targetStage, checkpoint) : hasLiveStageSignoff(targetStage)) continue;
      if (checkpoint === null && targetStage === effectiveStage && stageHasPendingOptions) continue;
      const vMatch = /^versions\[(\d+)\]\.verdicts\[\d+\]$/.exec(lapsedApproval.path);
      if (!legacyWrites && checkpoint === null && isPublishAdvanceStage(targetStage)) {
        if (!vMatch) addCurrentReviewSignoff(targetStage, amendField, { code: 'AMENDED_STEP', source_field: amendField,
          target_field: lapsedApproval.path, ...(targetId ? { amendment_id: targetId } : {}), message: lapsedApproval.reason });
        continue;
      }
      const signoffMatch = /^signoffs\[(\d+)\]$/.exec(lapsedApproval.path);
      const signoffEntry = signoffMatch ? rawSignoffs[Number(signoffMatch[1])] : undefined;
      if (checkpoint === null && hasHistorySignoffTarget(targetStage, signoffEntry)) continue;
      if (vMatch) {
        const versionEntry = asArray(project.versions).filter(isObject)[Number(vMatch[1])];
        const n = typeof versionEntry?.n === 'number' ? versionEntry.n : null;
        if (n !== null && isHistoryVersion(n)) continue;
      }
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
    // An interview-answer amendment names each step resting on the changed answer until it is done again.
    if (amendment.target.kind !== 'interview-answer') continue;
    for (const step of amendmentLapsedSteps(project, amendment.target)) {
      const stepId = String(step.id);
      const stepStage = stageOfStep(step.phase as 'rig' | 'post', stepId);
      if (step.status === 'done' || stepStage === effectiveStage) continue;
      const awaitTarget = `plan.steps[${stepId}].status`;
      addAwait(awaitTarget);
      moves.push({
        role: 'agent',
        field: amendField,
        awaits: awaitTarget,
        command: null,
        act: `redo plan.steps[${stepId}] at ${stepStage}; it rests on ${amendedAnswerId(amendment.target)}, changed by ${amendField}`,
        lapse: {
          code: 'AMENDED_STEP',
          source_field: amendField,
          target_field: `plan.steps[${stepId}]`,
          ...(targetId ? { amendment_id: targetId } : {}),
          message: `rests on ${amendedAnswerId(amendment.target)}`,
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
  const drafts = asArray(project.drafts).filter(isObject);

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
    const stepPlans = stepPlanQuestions(dir, project, stageItems, allowPostOptions);
    const questionMoves = [...stepPlans.moves, ...interviewQuestionMoves(dir, stepPlans.questionItems, effectiveStage)];
    for (const move of questionMoves) {
      addAwait(move.awaits);
      moves.push(move);
    }

    const { planIds, missingPlanIds, moves: planMoves } = interviewPlanMoves(dir, project, stageItems, effectiveStage, steps);
    const needsPlanSteps = missingPlanIds.length > 0;
    if (needsPlanSteps) {
      addAwait('plan.steps');
      moves.push(...planMoves);
    }

    const missingStepNames = missingPlanIds.length === planIds.length ? '' : `${missingPlanIds.join(', ')} `;
    const missingStepKind = effectiveStage === 'post-interview' ? 'post' : 'rig';
    const missingPlanReason = `plan.steps has no ${missingStepNames}${missingStepKind} step${missingPlanIds.length === 1 ? '' : 's'}`;
    const pendingOtherFields = stageItems.filter(hasPendingOther).map(item => item.path);
    const undecidedFields = stageItems.filter(isUndecidedDelegation).map(item => `${item.path}.agent_decision`);

    if (currentPath) {
      if (questionMoves.length === 0 && !needsPlanSteps && !stageHasPendingOptions
        && pendingOtherFields.length === 0 && undecidedFields.length === 0) {
        pushCurrentStageProgression(effectiveStage);
      }
    } else {
      const signoffAwait = `signoffs[stage=${effectiveStage}]`;
      if (!stageHasPendingOptions && !hasLiveStageSignoff(effectiveStage) && !recordedLapseTargets.has(signoffAwait)) {
        addAwait(signoffAwait);
        const unansweredSignoff = needsPlanSteps
          ? 'plan.steps'
          : pendingOtherFields.length > 0
            ? pendingOtherFields.join(', ')
            : undecidedFields.length > 0
              ? undecidedFields.join(', ')
              : undefined;
        const fromPicks = pickSignoffEvidence(dir, project, effectiveStage, now);
        if (fromPicks && !unansweredSignoff) moves.push({
          role: 'agent', field: 'signoffs', awaits: signoffAwait,
          command: `rig-create signoff ${effectiveStage} ${shellWord(dir)} --from-picks`,
          act: `record ${effectiveStage} approval from the ingested owner picks`,
        });
        else moves.push({
          role: 'human',
          field: 'signoffs',
          awaits: signoffAwait,
          command: null,
          act: needsPlanSteps
            ? effectiveStage === 'rigging-interview'
              ? `review-tool act signoff for stage rigging-interview (unanswered by record: ${missingPlanReason} approved at rigging-interview)`
              : `review-tool act signoff for stage ${effectiveStage} (unanswered by record: ${effectiveStage === 'post-interview' ? missingPlanReason : steps.length === 0 ? 'plan.steps is empty' : 'plan.steps has uncovered parts guides'} in project.json)`
            : pendingOtherFields.length > 0
              ? `review-tool act signoff for stage ${effectiveStage} (unanswered by record: ${pendingOtherFields.join(', ')} has pending Other; resolve INTERVIEW_CHOICE_REQUIRED before approval)`
              : undecidedFields.length > 0
                ? `review-tool act signoff for stage ${effectiveStage} (unanswered by record: ${undecidedFields.join(', ')} requires agent decision before approval)`
                : `review-tool act signoff for stage ${effectiveStage}`,
          review_act: {
            kind: 'signoff',
            stage: effectiveStage,
            ...(jobId ? { job_id: jobId } : {}),
          },
          ...(unansweredSignoff !== undefined ? { unanswered_by_record: unansweredSignoff } : {}),
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
    }
  } else if (effectiveStage === 'plan-approved') {
    if (currentPath) {
      pushCurrentStageProgression('plan-approved');
    } else {
      const signoffAwait = 'signoffs[stage=plan-approved]';
      if (!hasLiveStageSignoff('plan-approved') && !recordedLapseTargets.has(signoffAwait)) {
        addAwait(signoffAwait);
        const fromPicks = pickSignoffEvidence(dir, project, effectiveStage, now);
        const missing = fromPicks ? missingPickSignoffSteps(project, effectiveStage) : [];
        if (missing.length) {
          addAwait('plan.steps');
          moves.push({ role: 'agent', field: 'plan.steps', awaits: 'plan.steps', command: null,
            act: `add the missing plan steps with plan add: ${missing.join(', ')}`, unanswered_by_record: 'plan.steps' });
        } else if (fromPicks) moves.push({
          role: 'agent', field: 'signoffs', awaits: signoffAwait,
          command: `rig-create signoff ${effectiveStage} ${shellWord(dir)} --from-picks`,
          act: `record ${effectiveStage} approval from the ingested owner picks`,
        });
        else moves.push({
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
    }
  } else if (effectiveStage === 'parts' || effectiveStage === 'parts-review') {
    const partsSteps = steps.filter(
      s => (s.phase === 'rig' || s.phase === 'post') && stageOfStep(s.phase, String(s.id)) === 'parts',
    );
    const openPartsSteps = partsSteps.filter(s => s.status !== 'done');

    if (legacyWrites && effectiveStage === 'parts' && asArray(project.drafts).length === 0) {
      addAwait('drafts');
      moves.push({
        role: 'agent',
        field: 'drafts',
        awaits: 'drafts',
        command: null,
        act: `Run rig-parts assemble, then rig-parts propose --write-config, then rig-parts assemble again with the written config. ${BASELINES_AFTER_FINAL_ASSEMBLE} Register the second output and its config with draft-rig before job open --draft.`,
      });
    }

    if (effectiveStage === 'parts' && openPartsSteps.length > 0) {
      for (const step of openPartsSteps) {
        const stepId = String(step.id);
        const currentStatus = String(step.status ?? 'pending');
        const checkpointEnabled = checkpointRequired(project, step, now);
        const nextStatus = nextStepStatus(currentStatus, checkpointEnabled);
        if (nextStatus === undefined) continue;
        if (nextStatus === 'done' && checkpointEnabled && !hasLiveCheckpointSignoff('parts', stepId)) {
          const cpAwait = `signoffs[checkpoint=${stepId}]`;
          addAwait(cpAwait);
          if (!recordedLapseTargets.has(cpAwait)) {
            moves.push(checkpointSignoffMove(dir, 'parts', stepId, cpAwait));
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
      const { draftId, hasApprovedPartsVerdict, structure, retouching, moves: draftMoves } =
        partsDraftEvidenceMoves(dir, project, effectiveStage, jobId, now);
      if (retouching) {
        return { schema: NEXT_SCHEMA, project_id: String(project.name ?? ''), stage, effective_stage: effectiveStage,
          accepted: false, refusals, ...warningFields, awaits: [...new Set(draftMoves.map(move => move.awaits))], moves: draftMoves };
      }
      for (const move of draftMoves) {
        if (move.awaits !== 'project.stage') addAwait(move.awaits);
        moves.push(move);
      }

      const signoffAwait = 'signoffs[stage=parts-review]';
      // Already-ingested approvals from before the fold retain their separate signing route.
      if (hasApprovedPartsVerdict && !hasLiveStageSignoff('parts-review') && !recordedLapseTargets.has(signoffAwait)) {
        addAwait(signoffAwait);
        moves.push({
          role: 'human',
          field: 'signoffs',
          awaits: signoffAwait,
          command: null,
          act: `legacy approval already recorded: review-tool act signoff for stage parts-review; after structure-snapshot, ingest rig-create signoff parts-review ${shellWord(dir)} --draft ${shellWord(draftId!)} --structure-file ${shellWord(structure!.path)} --from-review '<actId>'`,
          review_act: {
            kind: 'signoff',
            stage: 'parts-review',
            ...(draftId ? { draft_id: draftId } : {}),
            ...(jobId ? { job_id: jobId } : {}),
          },
        });
      }

      if (effectiveStage === 'parts') {
        addAwait('project.stage');
        if (currentPath && refusals.length === 0
          && isObject(project.current) && isObject(project.current.parts)
          && existsSync(join(dir, outputRoot('parts'), 'rig', 'parts.json'))) {
          let advanced = false;
          if (stage === 'parts') {
            const command = candidateAdvance(dir, project, 'parts-review', now,
              { report: `evidence/${PARTS_CHECK_FILE}`, root: `${outputRoot('parts')}/rig` });
            moves.push(command ? { role: 'agent', field: 'stage', awaits: 'project.stage', command,
              act: 'Advance to parts-review with the retained check of the recorded parts.' } : currentPartsAdvanceMove(dir));
            advanced = true;
          } else if (!report.warnings.some(w => w.code === 'OUTPUT_STALE' && w.path === 'current.parts')) {
            const command = candidateAdvance(dir, project, 'parts-review', now);
            if (command !== null) {
              moves.push({ role: 'agent', field: 'stage', awaits: 'project.stage', command,
                act: 'advance stage from parts to parts-review' });
              advanced = true;
            }
          }
          if (advanced) {
            const lookMove = optionalCurrentOpenMove(dir, project, report, 'parts');
            if (lookMove) moves.push(lookMove);
          }
        }
      } else if (currentPath) {
        const snapshotMove = currentPartsSnapshotMove(dir, project, now);
        if (snapshotMove) {
          addAwait(snapshotMove.awaits);
          moves.push(snapshotMove);
        } else {
          pushCurrentStageProgression('parts-review');
        }
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
    if (effectiveStage === 'rigging') for (const move of depthPlanMoves(project, collection)) {
      addAwait(move.awaits);
      moves.push(move);
    }
    if (effectiveStage === 'rigging') for (const move of turnExtraGroupMoves(dir, project, collection)) {
      addAwait(move.awaits);
      moves.push(move);
    }
    const rigSteps = steps.filter(
      s => (s.phase === 'rig' || s.phase === 'post') && stageOfStep(s.phase, String(s.id)) === 'rigging',
    );
    const openRigSteps = rigSteps.filter(s => s.status !== 'done');
    const hasOpenRigSteps = effectiveStage === 'rigging' && openRigSteps.length > 0;
    const hasHistoryRig = parsedVersions.rigs.some(r => !r.live) || !liveSignoff(reopens, 'rig-review', -Infinity);

    if (hasOpenRigSteps) {
      for (const step of openRigSteps) {
        const stepId = String(step.id);
        const currentStatus = String(step.status ?? 'pending');
        const checkpointEnabled = checkpointRequired(project, step, now);
        const nextStatus = nextStepStatus(currentStatus, checkpointEnabled);
        if (nextStatus === undefined) continue;
        if (nextStatus === 'done' && checkpointEnabled && !hasLiveCheckpointSignoff('rigging', stepId)) {
          const cpAwait = `signoffs[checkpoint=${stepId}]`;
          addAwait(cpAwait);
          if (!recordedLapseTargets.has(cpAwait)) {
            moves.push(checkpointSignoffMove(dir, 'rigging', stepId, cpAwait));
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
    }

    const offerDraftReview = legacyWrites && rigN === null && compiledDraftId !== undefined && compiledVerdict?.value.verdict !== 'approved';
    if (offerDraftReview) {
      const field = `drafts[${compiledDraftId}]`;
      addAwait(field);
      moves.push({ role: 'human', field, awaits: field, command: null, act: `review-tool act review-verdict for rigging draft ${compiledDraftId}`,
        review_act: { kind: 'review-verdict', stage: 'rig-review', review: 'rig-review', draft_id: compiledDraftId, ...(jobId ? { job_id: jobId } : {}) } });
    }
    // Draft review is also available when the producer has a checked build to register,
    // and a reopened project with a history rig can register a plain rig beside it (#773).
    if (checkedRegistration) {
      addAwait(checkedRegistration.awaits);
      moves.push(checkedRegistration);
    } else if (legacyWrites && !checked && rigN === null && pendingCarryCorrection) {
      const move = rigRegistrationMove(dir, nextRigN, undefined, '', pendingCarryCorrection);
      addAwait(move.awaits);
      moves.push(move);
    } else if (!checked && !hasOpenRigSteps && (!offerDraftReview || hasHistoryRig)) {
      if (effectiveStage === 'rigging' && (!legacyWrites || rigN !== null)) {
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
          if (currentPath) {
            const lookMove = optionalCurrentOpenMove(dir, project, report, 'rig');
            if (lookMove) moves.push(lookMove);
          }
        }
      }

      if (currentPath) {
        if (effectiveStage === 'rig-review') pushCurrentStageProgression('rig-review');
      } else if (!legacyWrites) {
        if (effectiveStage === 'rig-review') addCurrentReviewSignoff('rig-review');
      } else if (rigN === null && compiledDraftId !== undefined && compiledVerdict?.value.verdict === 'approved') {
        const move = rigRegistrationMove(dir, nextRigN);
        addAwait(move.awaits);
        moves.push({ ...move, act: `Register the frozen rig from draft ${compiledDraftId}. Byte-identical inputs carry review act ${compiledVerdict.actId}.` });
      } else if (rigN === null && hasHistoryRig) {
        const move = rigRegistrationMove(dir, nextRigN);
        addAwait(move.awaits);
        moves.push(move);
      } else if (rigN === null) {
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
        const hasLiveAcceptedRigVerdict = !reviewVerdictSignable(project, rigN, 'rig-review');
        const verdictAwait = `versions[n=${rigN}].verdicts[review=rig-review]`;
        if (!hasLiveAcceptedRigVerdict && !recordedLapseTargets.has(verdictAwait)) {
          const coversChangedStructure = warnings.some(w =>
            w.code === 'STRUCTURE_DELTA_REVIEW' && w.path === `versions[v${rigN}].provenance.structure_delta`);
          addAwait(verdictAwait);
          moves.push({
            role: 'human',
            field: `versions[v${rigN}].verdicts`,
            awaits: verdictAwait,
            command: null,
            act: `review-tool act review-verdict for versions[v${rigN}] (rig-review)${effectiveStage === 'rig-review' ? '; approve once to record the verdict and rig-review signature' : ''}${coversChangedStructure ? '; verdict covers changed structure' : ''}`,
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
      if (!currentPath && legacyWrites && !hasLiveStageSignoff('rig-review') && !recordedLapseTargets.has(signoffAwait)
        && !((effectiveStage === 'rig-review' || hasHistoryRig) && (rigN === null || reviewVerdictSignable(project, rigN, 'rig-review')))) {
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
      } else if (!currentPath && effectiveStage === 'rig-review' && hasLiveStageSignoff('rig-review')) {
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
    const postState = legacyWrites ? directionReviewPostState(dir, project, now) : undefined;
    const addPostAuthoringMove = (): void => {
      if (!postState || postState.ready) return;
      const { nextPostN, composed, currentScene } = postState;
      if (!isObject(project.direction_contract)) {
        addAwait('direction_contract');
        moves.push({ role: 'agent', field: 'direction_contract', awaits: 'direction_contract',
          command: `rig-create direction --adopt ${shellWord(dir)}`, act: 'adopt direction before authoring the post' });
        return;
      }
      const acceptedRig = latestAccepted(parsedVersions);
      const rig = acceptedRig ?? parsedVersions.rigs.filter(r => r.live).at(-1);
      const rigN = typeof rig?.n === 'number' ? String(rig.n) : '<rig-version>';
      if (composed) {
        addAwait(`versions[n=${nextPostN}]`);
        moves.push({ role: 'agent', field: 'versions', awaits: `versions[n=${nextPostN}]`,
          command: `rig-create direction write ${nextPostN} ${shellWord(dir)} --file '<direction@3.json>' --rig ${shellWord(rigN)} --compose-out '<compose-out>' --compose-scene '<compose-scene.json>'`,
          act: 'compose the cited owner values with Parts, then freeze the green idle as direction@3' });
      } else if (currentScene === undefined) {
        const postComp = allItems.find(item => item.id === 'post_composition');
        const repairMoves = postCompositionSceneRepairMoves(dir, project, postComp, effectiveStage, now);
        if (repairMoves.length > 0) {
          for (const move of repairMoves) addAwait(move.awaits);
          moves.push(...repairMoves);
        } else {
          addAwait('scenes[n=1]');
          moves.push({ role: 'agent', field: 'scenes', awaits: 'scenes[n=1]',
            command: sceneWriteCommand(dir, project, rigN),
            act: 'author scene inputs matching the current post_composition Review choice, then write the scene' });
        }
      } else {
        addAwait(`versions[n=${nextPostN}]`);
        moves.push({ role: 'agent', field: 'versions', awaits: `versions[n=${nextPostN}]`,
          command: `rig-create direction write ${nextPostN} ${shellWord(dir)} --file '<direction.json>' --rig ${shellWord(rigN)}`,
          act: 'author a direction document binding the current scene, then record the post version' });
      }
    };

    if (effectiveStage === 'post' && openPostSteps.length > 0) {
      addPostAuthoringMove();
      for (const step of openPostSteps) {
        const stepId = String(step.id);
        const currentStatus = String(step.status ?? 'pending');
        const checkpointEnabled = checkpointRequired(project, step, now);
        const nextStatus = nextStepStatus(currentStatus, checkpointEnabled);
        if (nextStatus === undefined) continue;
        if (nextStatus === 'done' && checkpointEnabled && !hasLiveCheckpointSignoff('post', stepId)) {
          const cpAwait = `signoffs[checkpoint=${stepId}]`;
          addAwait(cpAwait);
          if (!recordedLapseTargets.has(cpAwait)) {
            moves.push(checkpointSignoffMove(dir, 'post', stepId, cpAwait));
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
      if (effectiveStage === 'post' && (!postState || postState.ready)) {
        const advCmd = candidateAdvance(dir, project, 'direction-review', now);
        if (advCmd !== null) {
          moves.push({
            role: 'agent',
            field: 'stage',
            awaits: 'project.stage',
            command: advCmd,
            act: 'advance stage from post to direction-review',
          });
          if (currentPath) {
            const lookMove = optionalCurrentOpenMove(dir, project, report, 'direction');
            if (lookMove) moves.push(lookMove);
          }
        }
      }

      if (currentPath) {
        if (effectiveStage === 'direction-review') pushCurrentStageProgression('direction-review');
      } else if (!postState) {
        if (effectiveStage === 'direction-review') addCurrentReviewSignoff('direction-review');
      } else {
        const { latestPost, postN, nextPostN, missingScene } = postState;
        addPostAuthoringMove();
        if (missingScene) addAwait('scenes[n=1]');
        if (postN === null) {
          addAwait(`versions[n=${nextPostN}]`);
          const verdictAwait = `versions[n=${nextPostN}].verdicts[review=direction-review]`;
          addAwait(verdictAwait);
          moves.push({
            role: 'human',
            field: 'versions',
            awaits: verdictAwait,
            command: null,
            act: `review-tool act review-verdict for direction-review (unanswered by record: ${missingScene ? 'scenes[n=1] and ' : ''}versions[n=${nextPostN}] are not recorded in project.json)`,
            review_act: {
              kind: 'review-verdict',
              stage: 'direction-review',
              version_id: `v${nextPostN}`,
              review: 'direction-review',
              ...(jobId ? { job_id: jobId } : {}),
            },
            unanswered_by_record: missingScene ? `scenes[n=1], versions[n=${nextPostN}]` : `versions[n=${nextPostN}]`,
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
              act: `review-tool act review-verdict for versions[v${postN}] (direction-review) on the post page: job open --rig ${postN}; ingest with review ${postN} --from-review <actId>`,
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
                ? `after recording the current post and accepted direction verdict, review-tool act signoff for direction-review (unanswered by record: ${missingScene ? 'scenes[n=1] and ' : ''}versions[n=${nextPostN}] are not recorded in project.json)`
                : `after ingesting the accepted direction-review verdict for v${postN}, record signoff for stage direction-review, then advance accepted`,
            review_act: {
              kind: 'signoff',
              stage: 'direction-review',
              version_id: `v${nextPostN}`,
              ...(jobId ? { job_id: jobId } : {}),
            },
            ...(postN === null
              ? {
                  unanswered_by_record:
                    missingScene ? `scenes[n=1], versions[n=${nextPostN}]` : `versions[n=${nextPostN}]`,
                }
              : {}),
          });
        }
      }

      if (effectiveStage === 'post') {
        if (legacyWrites || moves.some(move => move.field === 'stage')) addAwait('project.stage');
      } else if (!currentPath && hasLiveStageSignoff('direction-review')) {
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

  const partsAdvancePrepared = laggingAdvance?.targetStage !== 'parts-review' || (() => {
    const drafts = asArray(project.drafts).filter(isObject);
    const id = drafts[drafts.length - 1]?.id;
    return typeof id === 'string' && partsStructureSnapshot(dir, project, id).valid && hasValidDiffMap(dir, project);
  })();
  if (laggingAdvance !== null && partsAdvancePrepared && !moves.some(m => m.role === 'agent' && m.command === laggingAdvance.command)) {
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
    moves: runnableNextMoves(dir, project, effectiveStage, moves),
  };
}

export function formatNext(report: NextReport | NextCollectionReport): string {
  if ('kind' in report) {
    const lines: string[] = [
      `next (collection): ${report.collection_dir} — stage: ${report.stage ?? '(unknown)'}${
        report.effective_stage !== report.stage ? ` (effective: ${report.effective_stage})` : ''
      }`,
    ];
    if (report.refusals.length > 0) {
      lines.push(`refusals (${report.refusals.length}):`);
      for (const r of report.refusals) {
        lines.push(`  [${r.code}] ${r.path}: ${r.message}`);
        lines.push(`    remedy: ${r.remedy}`);
      }
    }
    if (report.members.length === 0) {
      lines.push('members (0): none');
    } else {
      lines.push(`members (${report.members.length}):`);
      for (const member of report.members) {
        lines.push(`  ${member.name}: ${member.command}`);
      }
    }
    return lines.join('\n');
  }
  const lines: string[] = [];
  lines.push(
    `next: ${report.project_id || '(unnamed)'} — stage: ${report.stage}${
      report.effective_stage !== report.stage ? ` (effective: ${report.effective_stage})` : ''
    }`,
  );
  for (const w of report.warnings ?? []) lines.push(`  WARN [${w.code}]: ${w.message}`);
  for (const c of report.comments ?? []) {
    lines.push(`  comment comments[${c.comment}] [${c.status}${c.closed ? ', closed' : ''}]: ${c.comments.length} comment(s)`);
  }
  for (const command of report.bust_landmark_commands ?? []) lines.push(command);
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
    if (move.command !== null && (ROUTED_ANSWER_COMMENT_PATH.test(move.field) || move.field.startsWith('comments[')
      || move.field.startsWith('current.') || move.field === CURRENT_SCENE_PATH || move.field === CURRENT_DIRECTION_PATH
      || move.act === SCENE_OPTIONS_REPAIR_ACT
      || move.act.startsWith(OPTIONAL_SIGNOFF_PREFIX))) {
      lines.push(`    ${move.act}`);
    }
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
  const collectionDir = collectionDirOf(dir);
  const progress = collectionDir === null ? beginJobProgress(dir, 'other', 'Resolving the next project actions') : undefined;
  const report = collectionDir !== null ? nextCollection(collectionDir) : nextProject(dir, now);
  progress?.('Next project actions ready');
  return {
    stdout: json ? JSON.stringify(report, null, 2) : formatNext(report),
    exit: 0,
  };
}
