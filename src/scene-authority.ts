/** Agent scene authority: every agent-authored scene derives from a recorded post_composition choice or decided delegation. */
import { isDeepStrictEqual as equal } from 'node:util';
import { asArray, collectItems, isObject, loadCollection, type Ctx, type Finding } from './check.ts';
import { CHOICE_SPEC, OPTIONS_SPEC, choiceVerbatim, assembleFragments, optionFile, selection } from './choices.ts';
import { closed } from './direction.ts';
import { checkPlateReceipt } from './plate-receipt.ts';
import { answersOf } from './provenance.ts';
import { sceneBytes, sceneFail } from './scene.ts';
import type { Json, JsonObject } from './templates.ts';

export const SCENE_CHOICE_MISSING = 'SCENE_CHOICE_MISSING';
export const SCENE_CHOICE_MISMATCH = 'SCENE_CHOICE_MISMATCH';

const MISSING_REMEDY =
  'record a post_composition choice in the Review tool (or complete its delegated agent_decision) whose value.scene binds {background:{path,rect:{x,y,width,height}},foreground?:{path,rect:{x,y,width,height}}} and run scene write';
const MISMATCH_REMEDY =
  'match the exact roles, paths and rects from the cited post_composition choice in the Review tool (or record a new post_composition choice in the Review tool) and run scene write';

const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const pathShape = (value: unknown): value is string =>
  text(value) &&
  !value.startsWith('/') &&
  !value.includes('\\') &&
  !/^[A-Za-z]:/.test(value) &&
  value.split('/').every(part => part !== '' && part !== '.' && part !== '..');
const boxShape = (value: unknown): value is JsonObject =>
  closed(value, ['x', 'y', 'width', 'height']) && Object.values(value).every(v => typeof v === 'number');

export const sceneAuthor = (value: unknown): value is string =>
  value === 'agent' || (text(value) && value.toLowerCase() !== 'agent');

export interface AgentRoleSpec {
  path: string;
  rect: JsonObject;
}
export interface AgentSceneSpec {
  background: AgentRoleSpec;
  foreground?: AgentRoleSpec;
}

function parseRoleSpec(role: 'background' | 'foreground', raw: Json | undefined, valuePath: string): AgentRoleSpec {
  const rolePath = `${valuePath}.scene.${role}`;
  if (!isObject(raw)) {
    sceneFail(SCENE_CHOICE_MISSING, rolePath, `post_composition value.scene.${role} must be a closed {path,rect} object`, MISSING_REMEDY);
  }
  if (!('path' in raw) || raw.path === undefined) {
    sceneFail(SCENE_CHOICE_MISSING, `${rolePath}.path`, `post_composition value.scene.${role} must declare a project-relative path`, MISSING_REMEDY);
  }
  if (!('rect' in raw) || raw.rect === undefined) {
    sceneFail(SCENE_CHOICE_MISSING, `${rolePath}.rect`, `post_composition value.scene.${role} must declare rect:{x,y,width,height}`, MISSING_REMEDY);
  }
  if (!closed(raw, ['path', 'rect'])) {
    sceneFail(SCENE_CHOICE_MISSING, rolePath, `post_composition value.scene.${role} allows only path and rect`, MISSING_REMEDY);
  }
  if (!pathShape(raw.path)) {
    sceneFail(SCENE_CHOICE_MISSING, `${rolePath}.path`, `post_composition value.scene.${role}.path must be a literal project-relative path`, MISSING_REMEDY);
  }
  const rect = raw.rect;
  if (!boxShape(rect) || !Object.values(rect).every(finite) || Number(rect.width) <= 0 || Number(rect.height) <= 0) {
    sceneFail(SCENE_CHOICE_MISSING, `${rolePath}.rect`, `post_composition value.scene.${role}.rect must be a finite positive {x,y,width,height} box`, MISSING_REMEDY);
  }
  return { path: raw.path, rect };
}

export function parseAgentSceneValue(value: Json | undefined, valuePath: string): AgentSceneSpec {
  if (!isObject(value) || !isObject(value.scene)) {
    sceneFail(
      SCENE_CHOICE_MISSING,
      `${valuePath}.scene`,
      'post_composition choice value must declare scene:{background:{path,rect},foreground?:{path,rect}}',
      MISSING_REMEDY,
    );
  }
  const scene = value.scene;
  if (!('background' in scene) || scene.background === undefined) {
    sceneFail(SCENE_CHOICE_MISSING, `${valuePath}.scene.background`, 'post_composition value.scene must declare background:{path,rect}', MISSING_REMEDY);
  }
  if (!closed(scene, ['background'], ['foreground'])) {
    sceneFail(SCENE_CHOICE_MISSING, `${valuePath}.scene`, 'post_composition value.scene allows only background and optional foreground', MISSING_REMEDY);
  }
  const background = parseRoleSpec('background', scene.background, valuePath);
  const foreground = scene.foreground === undefined ? undefined : parseRoleSpec('foreground', scene.foreground, valuePath);
  return { background, ...(foreground ? { foreground } : {}) };
}

function matchesCitationSurface(answer: JsonObject, citation: JsonObject): boolean {
  if (citation.delegated === true) {
    return (
      answer.delegated === true ||
      asArray(answer.asks).some(ask => isObject(ask) && ask.id === 'post_composition' && ask.state === 'delegated') ||
      isObject(answer.agent_decision)
    );
  }
  if (typeof citation.quote === 'string' && citation.quote.trim().length > 0) {
    return (
      (typeof answer.verbatim === 'string' && answer.verbatim.includes(citation.quote)) ||
      asArray(answer.additions).some(add => isObject(add) && typeof add.verbatim === 'string' && add.verbatim.includes(String(citation.quote)))
    );
  }
  return false;
}

function resolveAnswerValue(
  dir: string,
  itemPath: string,
  answer: JsonObject,
  citation: JsonObject,
  snapshots?: Map<string, Buffer>,
): { value: Json | undefined; valuePath: string } {
  if (!isObject(answer.choice) || answer.choice.spec !== CHOICE_SPEC) {
    sceneFail(
      SCENE_CHOICE_MISSING,
      `${itemPath}.choice`,
      'agent scene assembly requires a recorded Review interview-choice@1 on post_composition',
      MISSING_REMEDY,
    );
  }
  if (!isObject(answer.choice.set) || typeof answer.choice.set.path !== 'string') {
    sceneFail(SCENE_CHOICE_MISSING, `${itemPath}.choice.set`, 'post_composition choice requires a retained option set binding', MISSING_REMEDY);
  }
  if (snapshots) sceneBytes(dir, answer.choice.set.path, 'SCENE_CITATION_MISSING', snapshots);
  let set: JsonObject;
  try {
    set = optionFile(dir, answer.choice.set).set;
  } catch {
    return sceneFail(SCENE_CHOICE_MISSING, `${itemPath}.choice.set`, 'post_composition option set is missing or changed', MISSING_REMEDY);
  }
  let selected: ReturnType<typeof selection>;
  try {
    if (set.schema !== OPTIONS_SPEC || set.question !== 'post_composition' || !text(answer.by) || answer.by.toLowerCase() === 'agent'
      || !text(answer.at) || !Number.isFinite(Date.parse(answer.at))) throw Error('invalid human choice identity');
    selected = selection(set, answer.choice);
    if (answer.delegated !== selected.delegated || !equal(answer.asks, selected.asks)
      || answer.verbatim !== choiceVerbatim(asArray(answer.choice.picks).filter(isObject), answer.choice.note)) throw Error('choice projection differs');
  } catch {
    return sceneFail(SCENE_CHOICE_MISSING, `${itemPath}.choice`, 'post_composition choice does not match its retained option set', MISSING_REMEDY);
  }
  if (citation.delegated === true) {
    if (!selected.delegated || !selected.autos.includes('post_composition')) {
      sceneFail(SCENE_CHOICE_MISSING, `${itemPath}.choice`, 'cited post_composition choice did not delegate post_composition', MISSING_REMEDY);
    }
    const decision = answer.agent_decision;
    if (
      !isObject(decision) ||
      decision.by !== 'agent' ||
      !text(decision.at) ||
      !Number.isFinite(Date.parse(decision.at)) ||
      !text(decision.reasoning) ||
      decision.value === undefined ||
      decision.value === null ||
      !Array.isArray(decision.fragments)
    ) {
      sceneFail(
        SCENE_CHOICE_MISSING,
        `${itemPath}.agent_decision`,
        'complete the delegated post_composition agent_decision before assembling an agent scene',
        MISSING_REMEDY,
      );
    }
    const frag = decision.fragments.filter(isObject).find(entry => entry.ask === 'post_composition');
    if (!frag || frag.fragment === undefined) {
      sceneFail(
        SCENE_CHOICE_MISSING,
        `${itemPath}.agent_decision.fragments`,
        'delegated post_composition decision must supply a post_composition fragment',
        MISSING_REMEDY,
      );
    }
    const rule = isObject(set.assembly) && typeof set.assembly.rule === 'string' ? set.assembly.rule : 'single';
    let assembled: Json;
    try {
      assembled = assembleFragments(rule, [frag.fragment]);
    } catch {
      return sceneFail(SCENE_CHOICE_MISSING, `${itemPath}.agent_decision.value`, 'delegated post_composition fragment cannot be assembled', MISSING_REMEDY);
    }
    if (!equal(decision.value, assembled)) {
      sceneFail(
        SCENE_CHOICE_MISSING,
        `${itemPath}.agent_decision.value`,
        'delegated post_composition decision value differs from its assembled fragment',
        MISSING_REMEDY,
      );
    }
    return { value: decision.value, valuePath: `${itemPath}.agent_decision.value` };
  }
  if (selected.delegated || selected.pending.length > 0 || selected.value === undefined || selected.value === null || !equal(answer.value, selected.value)) {
    sceneFail(
      SCENE_CHOICE_MISSING,
      `${itemPath}.value`,
      'post_composition choice must have a resolved non-pending value from the retained option set',
      MISSING_REMEDY,
    );
  }
  if (typeof answer.verbatim !== 'string' || !answer.verbatim.includes(String(citation.quote))) {
    sceneFail(
      SCENE_CHOICE_MISSING,
      `${itemPath}.verbatim`,
      'agent scene citation quote must match the recorded Review choice verbatim',
      MISSING_REMEDY,
    );
  }
  return { value: answer.value, valuePath: `${itemPath}.value` };
}

function assertPlatesMatchSpec(plates: JsonObject[], spec: AgentSceneSpec): void {
  const bgIndex = plates.findIndex(plate => plate.role === 'background');
  const bgPlate = plates[bgIndex]!;
  if (bgPlate.path !== spec.background.path) {
    sceneFail(
      SCENE_CHOICE_MISMATCH,
      `scene.plates[${bgIndex}].path`,
      'background plate path differs from post_composition value.scene.background.path',
      MISMATCH_REMEDY,
    );
  }
  if (!equal(bgPlate.rect, spec.background.rect)) {
    sceneFail(
      SCENE_CHOICE_MISMATCH,
      `scene.plates[${bgIndex}].rect`,
      'background plate rect differs from post_composition value.scene.background.rect',
      MISMATCH_REMEDY,
    );
  }
  const fgIndex = plates.findIndex(plate => plate.role === 'foreground');
  const fgPlate = fgIndex >= 0 ? plates[fgIndex] : undefined;
  if (spec.foreground !== undefined && !fgPlate) {
    sceneFail(
      SCENE_CHOICE_MISMATCH,
      'scene.plates',
      'post_composition value.scene declares a foreground plate that is absent from scene.plates',
      MISMATCH_REMEDY,
    );
  }
  if (spec.foreground === undefined && fgPlate) {
    sceneFail(
      SCENE_CHOICE_MISMATCH,
      `scene.plates[${fgIndex}]`,
      'scene declares a foreground plate not present in post_composition value.scene',
      MISMATCH_REMEDY,
    );
  }
  if (spec.foreground !== undefined && fgPlate) {
    if (fgPlate.path !== spec.foreground.path) {
      sceneFail(
        SCENE_CHOICE_MISMATCH,
        `scene.plates[${fgIndex}].path`,
        'foreground plate path differs from post_composition value.scene.foreground.path',
        MISMATCH_REMEDY,
      );
    }
    if (!equal(fgPlate.rect, spec.foreground.rect)) {
      sceneFail(
        SCENE_CHOICE_MISMATCH,
        `scene.plates[${fgIndex}].rect`,
        'foreground plate rect differs from post_composition value.scene.foreground.rect',
        MISMATCH_REMEDY,
      );
    }
  }
}

/** Resolve the cited post_composition scene spec for an agent scene write before falling back to any stage rect. */
export function resolveAgentCitationSpec(
  dir: string,
  project: JsonObject,
  citation: Json,
  snapshots?: Map<string, Buffer>,
): AgentSceneSpec {
  const collection = loadCollection(dir);
  const items = collectItems(project, { collection });
  const item = items.find(value => value.id === 'post_composition');
  if (!item) sceneFail('SCENE_CITATION_MISSING', 'scene.plates[0].citation', 'cite a recorded post_composition answer or decided delegation');
  if (
    !isObject(citation) ||
    !((closed(citation, ['guide', 'asks', 'quote']) && text(citation.quote)) ||
      (closed(citation, ['guide', 'asks', 'delegated']) && citation.delegated === true)) ||
    citation.guide !== 'post_composition' ||
    !equal(citation.asks, ['post_composition'])
  ) {
    sceneFail('SCENE_CITATION_MISSING', 'scene.plates[0].citation', 'cite post_composition with asks and a quote or delegated:true');
  }
  const currentAnswer =
    item.state.state === 'user' || item.state.state === 'delegated'
      ? item.state.answer
      : isObject(item.raw)
        ? item.raw
        : null;
  if (!currentAnswer) {
    sceneFail('SCENE_CITATION_MISSING', 'scene.plates[0].citation', 'cite a recorded post_composition answer or decided delegation');
  }
  if (!matchesCitationSurface(currentAnswer, citation)) {
    const ctx: Ctx = {
      dir,
      project,
      collection,
      items,
      refusals: [],
      warnings: [],
      signoffs: [],
      steps: [],
      stage: String(project.stage),
      effectiveStage: String(project.stage),
      predatesPartsReview: null,
    };
    const historical = answersOf(item, ctx).some(answer => matchesCitationSurface(answer, citation));
    if (historical) {
      sceneFail(SCENE_CHOICE_MISMATCH, 'scene.plates[0].citation', 'agent scene must cite the current post_composition choice or decided delegation', MISMATCH_REMEDY);
    }
    sceneFail('SCENE_CITATION_MISSING', 'scene.plates[0].citation', 'cite a recorded post_composition answer or decided delegation');
  }
  const { value, valuePath } = resolveAnswerValue(dir, item.path, currentAnswer, citation, snapshots);
  return parseAgentSceneValue(value, valuePath);
}

export function validateAgentSceneAuthority(
  dir: string,
  project: JsonObject,
  doc: JsonObject,
  ctx: Ctx,
  snapshots?: Map<string, Buffer>,
  current = false,
): void {
  const plates = doc.plates as JsonObject[];
  for (const [index, plate] of plates.entries()) {
    const registration = plate.registered as JsonObject;
    if (registration.kind === 'input') {
      const match = /^inputs\[(\d+)\]$/.exec(String(registration.ref));
      const entry = match ? asArray(project.inputs)[Number(match[1])] : undefined;
      const bytes = sceneBytes(dir, String(plate.path), 'SCENE_PLATE_CHANGED', snapshots);
      if (!isObject(entry) || entry.bytes !== bytes.length || !Number.isSafeInteger(entry.bytes)
        || !text(entry.origin) || !text(entry.at) || !Number.isFinite(Date.parse(entry.at))) {
        sceneFail('SCENE_INPUT_RECEIPT_MISSING', `scene.plates[${index}].registered`,
          'candidate lacks input-writer metadata {path,sha256,bytes,origin,at}',
          'register a new source name with input add <path> --origin … and select it through the Review choice');
      }
    }
    if (registration.kind === 'derived') {
      const match = /^derived\[(\d+)\]$/.exec(String(registration.ref));
      const entry = match ? asArray(project.derived)[Number(match[1])] : undefined;
      if (!isObject(entry) || !isObject(entry.receipt) || typeof entry.receipt.path !== 'string') {
        sceneFail('SCENE_PLATE_UNREGISTERED', `scene.plates[${index}].registered`, 'agent scene derived plate requires a bound rig-parts-plate-receipt/1 receipt');
      }
      if (snapshots) sceneBytes(dir, entry.receipt.path, 'SCENE_FILE_CHANGED', snapshots);
      const receiptFindings: Finding[] = [];
      checkPlateReceipt({ dir, refusals: receiptFindings }, entry, `derived[${match![1]}]`);
      if (receiptFindings.length > 0) {
        sceneFail('SCENE_PLATE_UNREGISTERED', `scene.plates[${index}].registered`, 'agent scene derived plate has an invalid rig-parts-plate-receipt/1 receipt');
      }
    }
  }
  const item = ctx.items.find(value => value.id === 'post_composition');
  if (!item) sceneFail('SCENE_CITATION_MISSING', 'scene.plates[0].citation', 'cite a recorded post_composition answer or decided delegation');
  if (plates.length === 2) {
    const first = plates[0]!.citation as JsonObject;
    const second = plates[1]!.citation as JsonObject;
    if (Boolean(first.delegated) !== Boolean(second.delegated)) {
      sceneFail(
        SCENE_CHOICE_MISMATCH,
        'scene.plates[1].citation',
        'background and foreground plates must cite the same post_composition choice or decided delegation',
        MISMATCH_REMEDY,
      );
    }
  }
  const allAnswers = answersOf(item, ctx);
  const currentPool =
    item.state.state === 'user' || item.state.state === 'delegated'
      ? [item.state.answer]
      : isObject(item.raw)
        ? [item.raw]
        : [];
  const pool = current ? currentPool : allAnswers.length > 0 ? allAnswers : currentPool;
  const matching = pool.filter(answer => plates.every(plate => matchesCitationSurface(answer, plate.citation as JsonObject)));
  if (matching.length === 0) {
    if (current && allAnswers.some(answer => plates.every(plate => matchesCitationSurface(answer, plate.citation as JsonObject)))) {
      sceneFail(SCENE_CHOICE_MISMATCH, 'scene.plates[0].citation', 'agent scene must cite the current post_composition choice or decided delegation', MISMATCH_REMEDY);
    }
    if (plates.length === 2 && pool.some(a => matchesCitationSurface(a, plates[0]!.citation as JsonObject)) && pool.some(a => matchesCitationSurface(a, plates[1]!.citation as JsonObject))) {
      sceneFail(
        SCENE_CHOICE_MISMATCH,
        'scene.plates[1].citation',
        'background and foreground plates must cite the same post_composition choice or decided delegation',
        MISMATCH_REMEDY,
      );
    }
    sceneFail('SCENE_CITATION_MISSING', 'scene.plates[0].citation', 'cite a recorded post_composition answer or decided delegation');
  }
  const validSpecs: AgentSceneSpec[] = [];
  let firstError: unknown;
  for (const answer of matching) {
    try {
      const { value, valuePath } = resolveAnswerValue(dir, item.path, answer, plates[0]!.citation as JsonObject, snapshots);
      validSpecs.push(parseAgentSceneValue(value, valuePath));
    } catch (error) {
      if (!firstError) firstError = error;
    }
  }
  if (validSpecs.length === 0) throw firstError;
  let firstMismatch: unknown;
  for (const spec of validSpecs) {
    try {
      assertPlatesMatchSpec(plates, spec);
      return;
    } catch (error) {
      if (!firstMismatch) firstMismatch = error;
    }
  }
  throw firstMismatch;
}
