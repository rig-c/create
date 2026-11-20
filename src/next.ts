import { missingPickSignoffSteps, pickSignoffEvidence, requiredInterviewSteps } from './pick-signoff.ts';
import { ChoiceError, hasPendingOther, isUndecidedDelegation, optionFile, pendingInterviewOptions, pendingInterviewOptionsPath, selection } from './choices.ts';
import { reviewVerdictSignable } from './signable.ts';
import { ownerChatSignoffAllowed } from './owner-chat.ts';
import { checkpointEnabled, checkpointRequired } from './plan-history.ts';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from './check-reads.ts';
import { isDeepStrictEqual } from 'node:util';
import { publicationFile } from './job-publication.ts';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import {
  answered,
  asArray,
  checkProject,
  collectItems,
  collectSignoffs,
  isObject,
  loadCollection,
  postNotPassed,
  type CheckReport,
  type Finding,
  type Item,
} from './check.ts';
import { collectAmendments } from './amend.ts';
import { pendingMeshDeltaRevision } from './corrections.ts';
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
import { isPartsCheckMove, partsCheckFindings, partsCheckRecord } from './parts-check.ts';
import { latestPartsVerdictStatus, recordedPartsVerdict } from './parts-verdict-record.ts';
import { pausedFrom } from './pause.ts';
import { checkCollection, collectionDirOf } from './pins-check.ts';
import { carriedRefusals, findingKey, newFindings } from './refusal-baseline.ts';
import { refuse, USAGE_EXIT } from './refusal.ts';
import { reopenLapseWarnings } from './reopen-lapses.ts';
import { collectReopens, directionReviewClosed, liveSignoff } from './reopen.ts';
import { acceptedReviewVerdict, latestAccepted, readVersions } from './review.ts';
import { SIGNOFF_TARGET_KINDS } from './review-act.ts';
import {
  advanceOrder,
  directionReviewPostState,
  furthestStageSignoff,
  isSignoffIdentity,
  moveOwner,
  signoffIdentity,
  STEP_STATUSES,
} from './stage-progress.ts';
import {
  hasStageOrder,
  interviewStageOfGuide,
  isOpenInterviewStage,
  LEGACY_STAGE_VALUES,
  PARTS_REVIEW_SINCE,
  PAUSED_STAGE,
  STAGE_VALUES,
  stageIndex,
  stageOfStep,
} from './stages.ts';
import type { Json, JsonObject } from './templates.ts';
import { currentScene, plateRegistration, sceneBytes, sceneCurrentAt, sceneRig, SceneError } from './scene.ts';
import { depthPlanMoves } from './rig-version.ts';
import { resolveAgentCitationSpec } from './scene-authority.ts';
import { DIRECTION_COMPOSE_SPEC } from './direction-compose.ts';

export const NEXT_SCHEMA = 'rig-create/next@1';

const RIG_VERSION_INPUTS = '--parts <dir> --rig <dir> --build <dir> --idle <dir> --config <file> --path-adapter <file> --compile-report <file> --check-report <check.json> --toolchain-lock <file> --run-record <run.json> --at-source <file> --at-pointer <pointer> --by <agent>';

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

function isOpenInterviewTodo(finding: Finding, effectiveStage: string): boolean {
  return isOpenInterviewStage(effectiveStage)
    && (finding.code === 'INTERVIEW_INCOMPLETE' || finding.code === 'INTERVIEW_CHOICE_REQUIRED');
}

const SCENE_OTHER_FOLLOW_UP = 'use the recorded Other words to draft concrete scene options with fragment.scene. Write each label and effect as one plain 해요체 sentence. Register the new set for a Review pick, then cite that pick in scene write';

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

function ownerChatSignoffCommand(dir: string, project: JsonObject, act: NextReviewAct, writer: string): string | undefined {
  if (act.kind !== 'signoff' || !ownerChatSignoffAllowed(dir, project, act.stage, act.draft_id, act.version_id?.slice(1))) return;
  const version = act.stage === 'rig-review' || act.stage === 'direction-review'
    ? ` --version ${shellWord(act.version_id?.slice(1) ?? '<current-version>')}` : '';
  return `rig-create ${writer} ${shellWord(dir)}${version} ${OWNER_CHAT_COMMAND_FLAGS}`;
}

/** The person acts in Review; the agent only hosts and ingests its exported act. */
function reviewCommands(dir: string, project: JsonObject, move: NextMove): NextMove[] {
  const act = move.review_act;
  if (move.role !== 'human' || move.unanswered_by_record || move.field === 'pauses' || !act) return [move];
  let selector: string;
  let writer: string;
  if (act.kind === 'interview-picks' && act.question_id) {
    selector = `--question ${shellWord(act.question_id)}`;
    writer = `interview-answer ${shellWord(act.question_id)}`;
  } else if (act.kind === 'signoff' && ['interview', 'plan-approved', 'rigging-interview', 'post-interview', 'direction-review'].includes(act.stage)) {
    selector = '--plan';
    writer = `signoff ${act.stage}`;
  } else if (act.kind === 'parts-verdict' && act.draft_id) {
    selector = `--draft ${shellWord(act.draft_id)}`;
    writer = 'parts-review';
  } else if (act.kind === 'signoff' && act.stage === 'parts-review' && act.draft_id) {
    selector = `--draft ${shellWord(act.draft_id)}`;
    const structure = partsStructureSnapshot(dir, project, act.draft_id);
    writer = `signoff parts-review --draft ${shellWord(act.draft_id)} --structure-file ${shellWord(structure.path)}`;
  } else if (act.kind === 'signoff' && act.stage === 'rig-review' && act.version_id) {
    selector = `--rig ${shellWord(act.version_id.slice(1))}`;
    writer = 'signoff rig-review';
  } else if (['rig-review', 'direction-review'].includes(act.stage) && act.kind === 'review-verdict' && act.version_id) {
    const n = act.version_id.slice(1);
    selector = `--rig ${shellWord(n)}`;
    writer = `review ${shellWord(n)}`;
  } else return [move];
  const agent = (command: string, description: string): NextMove => ({
    role: 'agent', field: move.field, awaits: move.awaits, command, act: description,
  });
  const root = shellWord(dir);
  const chatMoves: NextMove[] = [];
  const chatSignoff = ownerChatSignoffCommand(dir, project, act, writer);
  if (chatSignoff) {
    chatMoves.push({ ...move, command: chatSignoff, act: `${move.act}; or relay the owner chat signoff with exact words, owner date and relay identity`, review_act: undefined });
  } else if (act.kind === 'interview-picks' && act.question_id) {
    const item = collectItems(project, {collection:loadCollection(dir)}).find(item => item.id === act.question_id);
    const binding = item?.record.pending_options;
    if (isObject(binding) && typeof binding.path === 'string' && typeof binding.sha256 === 'string') {
      try {
        const {set} = optionFile(dir,binding);
        const picks = asArray(set.asks).filter(isObject).map(ask => ` --pick ${shellWord(`${String(ask.id)}=<option-id>`)}`).join('');
        chatMoves.push({...move, command:`rig-create ${writer} ${root} --set ${shellWord(binding.path)} --sha256 ${shellWord(binding.sha256)} ${OWNER_CHAT_COMMAND_FLAGS}${picks}`, act:`${move.act}; or relay the owner chat answer and explicit option ids from the displayed set`, review_act:undefined});
      } catch { /* The check's named option-file refusal supplies the repair route. */ }
    }
  }
  return [
    ...chatMoves,
    agent(`rig-create job open ${root} ${selector} --reviewer '<reviewer>' --role owner`, 'publish this Review page; run the first open in the background and share its URL once; later opens publish into the running host and exit'),
    move,
    agent(`rig-create job acts ${root} --json`, `ask the person to tell you when they submit in Review, then list exported acts and use the matching actId below${act.kind === 'parts-verdict' ? '; approval also records the prepared parts-review signature' : act.stage === 'parts-review' ? '; run its reported legacy signoff preconditions before ingestion' : ''}`),
    agent(`rig-create ${writer} ${root} --from-review '<actId>'`, 'ingest the matching exported Review act; never supply the human answer or words'),
  ];
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
  if (stage === 'post' && !directionReviewPostState(dir, project, now).ready) return null;
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
    move('agent', `drafts[${id}].config`, null, `Draft ${String(draft.id)} requests changes. Retain it and its verdict and evidence; keep parts-review throughout. ${prepared ? `Resume ${root}/config.json without replacing the prepared config or its inputs; it matches the previous config outside assemble.edited_parts. The producer and draft writer still validate its contents. Original config:` : `Prepare ${root}/config.json from`} ${String(isObject(draft.config) ? draft.config.path : '<previous config>')}, preserving source input bindings and declaring assemble.edited_parts with dir and per-file receipts (part, file, from_sha256, sha256, editor) for the retouch against the painting (docs/SOURCE.md#handing-a-retouch-to-an-image-editor). Do not replace the old draft's files.`),
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
    return {
      draftId,
      hasApprovedPartsVerdict,
      structure,
      retouching: true,
      moves: partsRetouchMoves(dir, project, latestDraft!),
    };
  }
  const arrival = asArray(project.advances).filter(isObject).filter(isPartsCheckMove).at(-1);
  const retouch = effectiveStage === 'parts-review' && isObject(arrival?.parts_check)
    && arrival.parts_check.parts !== partsRoot;
  const evidence = partsEvidencePaths(draftId ?? '', retouch);
  const previousPartsActAt = Math.max(
    -Infinity,
    ...asArray(project.review_acts)
      .filter((entry): entry is JsonObject => isObject(entry) && entry.kind === 'parts-verdict' && entry.draft_id !== draftId)
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

export function nextProject(projectDirArg: string, now: number = Date.now()): NextReport {
  const dir = resolve(projectDirArg);
  const report: CheckReport = checkProject(dir, undefined, { now, readOnly: true });
  const fatal = report.refusals.find(r => FATAL_CODES.has(r.code));
  if (fatal !== undefined) refuse(fatal.code, fatal.message);

  const project = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
  const stage = String(project.stage ?? '');
  const effectiveStage = String(report.effective_stage ?? stage);
  const structureWarnings = report.warnings.filter(w => w.code === 'STRUCTURE_DELTA_REVIEW');
  const collection = loadCollection(dir);
  const allItems = collectItems(project, { collection });
  const answers = allItems.flatMap(item => {
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

  const pendingOtherFindings: Finding[] = allItems
    .filter(item => hasPendingOther(item) && !report.refusals.some(r => r.code === 'INTERVIEW_CHOICE_REQUIRED' && r.path === item.path))
    .map(item => ({
      code: 'INTERVIEW_CHOICE_REQUIRED',
      path: item.path,
      message: `${item.path}: Other is pending; ${item.id === 'post_composition'
        ? SCENE_OTHER_FOLLOW_UP
        : 'redraft with a tailored value option and have the person explicitly pick it before approval'}`,
    }));
  const allRefusalFindings: Finding[] = [...report.refusals, ...pendingOtherFindings, ...holes];
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
    finding.code === 'STAGE_LAGGING' && (laggingAdvance !== null || (stage === 'post' && !directionReviewPostState(dir, project, now).ready));

  const depthFinding = effectiveStage === 'rigging-interview'
    ? [...report.refusals, ...report.warnings].find(finding => finding.code === 'RIG_DEPTH_PLAN_MISSING') : undefined;
  const depthMoves: NextMove[] = depthFinding ? [{ role: 'agent', field: 'plan.steps[turn]', awaits: 'plan.steps[turn]', command: null,
    act: `${depthFinding.code}: ${depthFinding.message}. Record the chosen depth route and reason in its text, with a bar that reads the producer depth reports.` }] : [];
  const hasBlockingRefusal =
    holes.length > 0 ||
    report.refusals.some(r => !isOpenInterviewTodo(r, effectiveStage) && !isResolvableLagging(r));
  const registrations = plateInputMoves(dir, project, allItems, now);
  if (hasBlockingRefusal) {
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
      const command = ownerChatSignoffCommand(dir, project, { kind: 'signoff', stage }, `signoff ${shellWord(stage)}`);
      if (command) moves.push({
        role: 'human', field: 'signoffs', awaits: `signoffs[stage=${stage}]`, command,
        act: `re-sign ${stage} after confirming the intended answers and relay the owner's exact words`,
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
      awaits: moves.map(move => move.awaits),
      moves,
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
    if (!draftState.hasApprovedPartsVerdict && draftState.moves.length > 0) {
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
  // The check owns bounce/withdrawal/answer logic; consume its open findings.
  const openFeedback = report.warnings.filter(w => w.code === 'FEEDBACK_OPEN');
  const pendingMesh = stage !== PAUSED_STAGE && (effectiveStage === 'rigging' || effectiveStage === 'rig-review')
    ? pendingMeshDeltaRevision(project) : null;
  if (openFeedback.length > 0 || pendingMesh !== null) {
    const versions = asArray(project.versions).filter(isObject);
    const n = Math.max(0, ...versions.map(v => Number(v.n) || 0)) + 1;
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
        // Earlier acceptance still closes authoring after a bounce.
        if (directionReviewClosed(project)) {
          const target = 'amendments[target.stage=direction-review]';
          addAwait(target);
          moves.push({ role: 'human', field: 'amendments', awaits: target,
            command: `rig-create amend direction-review ${shellWord(dir)} --kind '<kind>' --target '<artifact id>' --change '<project-relative file>' --by '<human>' --verbatim-file '<words file>'`,
            act: 'record the human amendment and its changed artifact before writing the replacement post' });
          continue;
        }
      }
      const field = `versions[n=${n}]`;
      addAwait(field);
      const writer = kind === 'rig' ? `rig-version ${n}` : `direction write ${n}`;
      const inputs = kind === 'rig' ? rigInputs.replace('<rig-dir>', '<dir>') : '--file <direction.json> --rig <rig-version>';
      moves.push({ role: 'agent', field: 'versions', awaits: field,
        command: `rig-create ${writer} ${shellWord(dir)} ${inputs.replace(/<[^>]+>/g, shellWord)} ${refs.map(r => `--answers ${r.version}:${r.verdict}`).join(' ')}`,
        act: `build the next ${kind} version with ${writer}, recording answers_feedback ${JSON.stringify(refs)}` });
    }
    if (moves.length > 0) return { schema: NEXT_SCHEMA, project_id: String(project.name ?? ''), stage, effective_stage: effectiveStage, accepted: false, refusals, ...warningFields, awaits: awaitsList, moves: moves.flatMap(move => reviewCommands(dir, project, move)) };
  }
  const recordedLapseTargets = new Set<string>();
  const steps = asArray(isObject(project.plan) ? project.plan.steps : undefined).filter(isObject);
  const splitOrder = hasStageOrder(project);
  const stageItems = allItems.filter(item => interviewStageOfGuide(item.id, item.kind === 'post', splitOrder) === effectiveStage);
  const stageHasPendingOptions = stageItems.some(pendingInterviewOptions);
  const withdrawnCheckpoint = (id: string): boolean => steps.some(step => step.id === id
    && checkpointEnabled(step) && !checkpointRequired(project, step, now));

  // 1. Derive lapsed approvals from reopens[] and amendments[].
  const rawSignoffs = asArray(project.signoffs).filter(isObject);
  const rawReopens = asArray(project.reopens).filter(isObject);
  const parsedVersions = readVersions(project);
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
      if (checkpoint !== null && withdrawnCheckpoint(checkpoint)) continue;
      if (checkpoint === null && lapsedStage === effectiveStage && stageHasPendingOptions) continue;
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
    } else if (warning.code === 'REOPEN_VERDICT_LAPSED') {
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
      if (checkpoint !== null && withdrawnCheckpoint(checkpoint)) continue;
      if (checkpoint === null && targetStage === effectiveStage && stageHasPendingOptions) continue;
      const signoffMatch = /^signoffs\[(\d+)\]$/.exec(lapsedApproval.path);
      const signoffEntry = signoffMatch ? rawSignoffs[Number(signoffMatch[1])] : undefined;
      if (checkpoint === null && hasHistorySignoffTarget(targetStage, signoffEntry)) continue;
      const vMatch = /^versions\[(\d+)\]\.verdicts\[\d+\]$/.exec(lapsedApproval.path);
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
    for (const item of stageItems) {
      const answerField = item.path;
      const questionPath = item.path.replace(/\.(answer|guide)$/, '');
      const pendingOpts = pendingInterviewOptions(item);
      if (pendingOpts !== undefined || item.state.state === 'silent' || hasPendingOther(item)) {
        addAwait(answerField);
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
          moves.push({
            role: 'human',
            field: pendingInterviewOptionsPath(item),
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
        } else if (hasPendingOther(item)) {
          const followUp = item.id === 'post_composition'
            ? SCENE_OTHER_FOLLOW_UP
            : `redraft the option-set file for ${item.id} with a tailored value option and register it for a Review pick, or re-answer with --other-fragment`;
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
            act: `draft an option-set file for ${item.id}, then register it for a Review pick`,
            unanswered_by_record: pendingInterviewOptionsPath(item),
          });
        }
      } else if (isUndecidedDelegation(item)) {
        const decisionField = `${answerField}.agent_decision`;
        addAwait(decisionField);
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

    const planIds = effectiveStage === 'post-interview' ? ['camera', 'timing', 'composition'] : requiredInterviewSteps(effectiveStage);
    const missingPlanIds = planIds.filter(id => {
      const guide = id === 'camera' ? 'camera_depth' : id === 'timing' ? 'post_timing' : id === 'composition' ? 'post_composition' : id;
      const phase = effectiveStage === 'post-interview' ? 'post' : 'rig';
      return !steps.some(step => step.phase === phase && (step.id === id
        || phase === 'post' && asArray(step.rests_on).includes(guide)));
    });
    const needsPlanSteps = missingPlanIds.length > 0;
    if (needsPlanSteps) {
      addAwait('plan.steps');
      for (const [index, id] of missingPlanIds.entries()) {
        const guideId = id === 'camera' ? 'camera_depth' : id === 'timing' ? 'post_timing' : id === 'composition' ? 'post_composition' : id;
        const item = stageItems.find(item => item.id === guideId);
        if (!item || item.state.state === 'silent' || hasPendingOther(item) || isUndecidedDelegation(item)) continue;
        const order = Math.max(0, ...steps.map(step => Number(step.order) || 0)) + index + 1;
        moves.push({ role: 'agent', field: 'plan.steps', awaits: 'plan.steps',
          command: `rig-create plan add ${id} ${shellWord(dir)} --by agent --phase ${effectiveStage === 'post-interview' ? 'post' : 'rig'} --order ${order} --does '<work>' --produces '<result>' --rests-on ${guideId} --bar '<acceptance bar>' --checkpoint-proposed false`,
          act: `author the ${id} plan step for approval at ${effectiveStage}; replace the work, result and acceptance bar placeholders`,
          unanswered_by_record: 'plan.steps' });
      }
    }

    const missingStepNames = missingPlanIds.length === planIds.length ? '' : `${missingPlanIds.join(', ')} `;
    const missingStepKind = effectiveStage === 'post-interview' ? 'post' : 'rig';
    const missingPlanReason = `plan.steps has no ${missingStepNames}${missingStepKind} step${missingPlanIds.length === 1 ? '' : 's'}`;
    const pendingOtherFields = stageItems.filter(hasPendingOther).map(item => item.path);
    const undecidedFields = stageItems.filter(isUndecidedDelegation).map(item => `${item.path}.agent_decision`);

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
              : effectiveStage === 'interview'
                ? 'review-tool act signoff for stage interview on the record page with job open --plan; ingest signoff interview --from-review <actId>, then advance plan-approved'
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
  } else if (effectiveStage === 'plan-approved') {
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
  } else if (effectiveStage === 'parts' || effectiveStage === 'parts-review') {
    const partsSteps = steps.filter(
      s => (s.phase === 'rig' || s.phase === 'post') && stageOfStep(s.phase, String(s.id)) === 'parts',
    );
    const openPartsSteps = partsSteps.filter(s => s.status !== 'done');

    if (effectiveStage === 'parts' && asArray(project.drafts).length === 0) {
      addAwait('drafts');
      moves.push({
        role: 'agent',
        field: 'drafts',
        awaits: 'drafts',
        command: null,
        act: 'Run rig-parts assemble, then rig-parts propose --write-config, then rig-parts assemble again with the written config. Register the second output and its config with draft-rig before job open --draft.',
      });
    }

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
      const liveRigs = parsedVersions.rigs.filter(r => r.live);
      const latestLiveRig = liveRigs[liveRigs.length - 1];
      const rigN = latestLiveRig?.n ?? null;
      const hasHistoryRig = parsedVersions.rigs.some(r => !r.live) || !liveSignoff(reopens, 'rig-review', -Infinity);

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

      if (rigN === null && hasHistoryRig) {
        const nextRigN = Math.max(0, ...versions.map(v => Number(v.n) || 0)) + 1;
        const nextRigField = `versions[n=${nextRigN}]`;
        addAwait(nextRigField);
        moves.push({
          role: 'agent',
          field: 'versions',
          awaits: nextRigField,
          command: `rig-create rig-version ${nextRigN} ${shellWord(dir)} ${RIG_VERSION_INPUTS.replace(/<[^>]+>/g, shellWord)}`,
          act: `register a new rig version built after the reopen or amendment with rig-version ${nextRigN}, then publish it for one verdict`,
        });
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
          addAwait(verdictAwait);
          moves.push({
            role: 'human',
            field: `versions[v${rigN}].verdicts`,
            awaits: verdictAwait,
            command: null,
            act: `review-tool act review-verdict for versions[v${rigN}] (rig-review)${effectiveStage === 'rig-review' ? '; approve once to record the verdict and rig-review signature' : ''}${structureWarnings.some(w => w.path === `versions[v${rigN}].provenance.structure_delta`) ? '; verdict covers changed structure' : ''}`,
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
      if (!hasLiveStageSignoff('rig-review') && !recordedLapseTargets.has(signoffAwait)
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
    const {
      ready: postReady,
      latestPost,
      postN,
      nextPostN,
      composed,
      currentScene,
      missingScene,
    } = directionReviewPostState(dir, project, now);
    const addPostAuthoringMove = (): void => {
      if (postReady) return;
      const rig = latestAccepted(parsedVersions) ?? parsedVersions.rigs.filter(r => r.live).at(-1);
      const rigN = typeof rig?.n === 'number' ? String(rig.n) : '<rig-version>';
      if (!isObject(project.direction_contract)) {
        addAwait('direction_contract');
        moves.push({ role: 'agent', field: 'direction_contract', awaits: 'direction_contract',
          command: `rig-create direction --adopt ${shellWord(dir)}`, act: 'adopt direction before authoring the post' });
      } else if (composed) {
        addAwait(`versions[n=${nextPostN}]`);
        moves.push({ role: 'agent', field: 'versions', awaits: `versions[n=${nextPostN}]`,
          command: `rig-create direction write ${nextPostN} ${shellWord(dir)} --file '<direction@3.json>' --rig ${shellWord(rigN)} --compose-out '<compose-out>' --compose-scene '<compose-scene.json>'`,
          act: 'compose the cited owner values with Parts, then freeze the green idle as direction@3' });
      } else if (currentScene === undefined) {
        addAwait('scenes[n=1]');
        moves.push({ role: 'agent', field: 'scenes', awaits: 'scenes[n=1]',
          command: sceneWriteCommand(dir, project, rigN),
          act: 'author scene inputs matching the current post_composition Review choice, then write the scene' });
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
      if (effectiveStage === 'post' && postReady) {
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
            act: `review-tool act review-verdict for versions[v${postN}] (direction-review) on the post page: job open --rig ${postN}; ingest with review ${postN} --from-review <actId>; then request record-page sign-off with job open --plan`,
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
              ? `after recording the current post and accepted direction verdict, request review-tool act signoff for direction-review on the record page with job open --plan (unanswered by record: ${missingScene ? 'scenes[n=1] and ' : ''}versions[n=${nextPostN}] are not recorded in project.json)`
              : `after ingesting the accepted direction-review verdict for v${postN}, request review-tool act signoff on the record page with job open --plan, ingest signoff direction-review --from-review <actId>, then advance accepted`,
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

  const runnableMoves = moves.flatMap(move => {
    if (move.review_act && move.review_act.stage !== effectiveStage) return [move];
    if (move.review_act?.stage === 'direction-review' && move.review_act.kind === 'signoff'
      && moves.some(other => other.review_act?.stage === 'direction-review' && other.review_act.kind === 'review-verdict')) return [move];
    return reviewCommands(dir, project, move);
  });

  return {
    schema: NEXT_SCHEMA,
    project_id: String(project.name ?? ''),
    stage,
    effective_stage: effectiveStage,
    accepted: false,
    refusals,
    ...warningFields,
    awaits: awaitsList,
    moves: runnableMoves,
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
  const collectionDir = collectionDirOf(dir);
  const report = collectionDir !== null ? nextCollection(collectionDir) : nextProject(dir, now);
  return {
    stdout: json ? JSON.stringify(report, null, 2) : formatNext(report),
    exit: 0,
  };
}
