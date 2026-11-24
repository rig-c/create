/**
 * Owner value shapes for a composed take (`post_composition.value.compose`, issue #599).
 *
 * These values map 1:1 onto Parts' `spine-parts-scene/1` (`canvas`, `plates[]`,
 * `order`, `characters[0].offset`/`scale`, `animations.idle.tracks`).
 *
 * Per AGENTS.md invariant 1 (create reads producer reports and never computes them),
 * this validator checks only the closed shape, literal paths, finite numbers and
 * self-consistent key times when tracks are present (starting at 0, strictly
 * increasing, ending at one positive `end` across all tracks). Parts range-checks
 * slider dials (`SCENE_DIAL_KEY_RANGE`) and checks posed loop closure
 * (`SCENE_ANIMATION_LOOP_CLOSES`). Create reads compose's report.
 * The `direction@3` writer (#600) matches the composed model stage to the
 * cited `canvas` and aligns the take, scene idle, model idle, cited timing
 * seconds and any track end. Timing and composition can be revised sequentially.
 */
import { asArray, isObject, itemFor, type Ctx, type Finding } from './check.ts';
import { closed } from './direction.ts';
import type { Json, JsonObject } from './templates.ts';

export const COMPOSE_VALUE_INVALID = 'COMPOSE_VALUE_INVALID';

const COMPOSE_VALUE_REMEDY =
  'record a post_composition choice in the Review tool (or complete its delegated agent_decision) whose value.compose binds closed {canvas,plates,order,character,idle_tracks} with empty idle_tracks or a common positive track end';

/**
 * Vector and scalar bone track properties from `@rig-c/core`:
 * cited from `node_modules/@rig-c/core/docs/AUTHORING.md` §4.4 (the `bone` target
 * rows in the track property table, lines 4923–4926, where vector properties key
 * `[x, y]` and scalar properties key `[value]`, and `BONE_TRACKS` in
 * `node_modules/@rig-c/core/src/compile.ts`, where vector properties have
 * `fields: ['x', 'y']` and scalar properties have `fields: ['value']`). `inherit`
 * keys a stepped mode name rather than a number-channel array and is excluded.
 */
export const COMPOSE_VECTOR_TRACK_PROPERTIES = ['translate', 'scale', 'shear'] as const;
export const COMPOSE_SCALAR_TRACK_PROPERTIES = [
  'translatex',
  'translatey',
  'scalex',
  'scaley',
  'shearx',
  'sheary',
  'rotate',
] as const;
export const COMPOSE_TRACK_PROPERTIES = [
  ...COMPOSE_VECTOR_TRACK_PROPERTIES,
  ...COMPOSE_SCALAR_TRACK_PROPERTIES,
] as const;

export type ComposeVectorTrackProperty = (typeof COMPOSE_VECTOR_TRACK_PROPERTIES)[number];
export type ComposeScalarTrackProperty = (typeof COMPOSE_SCALAR_TRACK_PROPERTIES)[number];
export type ComposeTrackProperty = (typeof COMPOSE_TRACK_PROPERTIES)[number];

export interface ComposeCanvasSpec {
  width: number;
  height: number;
}

export interface ComposePlateSpec {
  name: string;
  image: string;
  at: [number, number];
  opaque_backdrop?: boolean;
}

export interface ComposeCharacterSpec {
  offset: [number, number];
  scale?: number;
}

export interface ComposeTrackKeySpec {
  t: number;
  v: [number] | [number, number];
  curve?: Json;
}

export interface ComposeIdleTrackSpec {
  bone: string;
  property: ComposeTrackProperty;
  keys: ComposeTrackKeySpec[];
}

export interface ComposeValueSpec {
  canvas: ComposeCanvasSpec;
  plates: ComposePlateSpec[];
  order: string[];
  character: ComposeCharacterSpec;
  idle_tracks: ComposeIdleTrackSpec[];
  end?: number;
}

export class ComposeValueError extends Error {
  constructor(
    readonly code: string,
    readonly path: string,
    why: string,
    remedy = COMPOSE_VALUE_REMEDY,
  ) {
    super(`${path}: ${why}; ${remedy}`);
  }
}

export function composeFail(path: string, why: string, remedy = COMPOSE_VALUE_REMEDY): never {
  throw new ComposeValueError(COMPOSE_VALUE_INVALID, path, why, remedy);
}

export function composeValueFinding(error: ComposeValueError): Finding {
  return { code: error.code, path: error.path, message: error.message };
}

const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const finiteInt = (value: unknown): value is number => finite(value) && Number.isInteger(value);
const positiveInt = (value: unknown): value is number => finiteInt(value) && value > 0;
const pathShape = (value: unknown): value is string =>
  text(value) &&
  !value.startsWith('/') &&
  !value.includes('\\') &&
  !/^[A-Za-z]:/.test(value) &&
  value.split('/').every(part => part !== '' && part !== '.' && part !== '..');
const finiteSingle = (value: unknown): value is [number] =>
  Array.isArray(value) && value.length === 1 && finite(value[0]);
const finitePair = (value: unknown): value is [number, number] =>
  Array.isArray(value) && value.length === 2 && finite(value[0]) && finite(value[1]);
const intPair = (value: unknown): value is [number, number] =>
  Array.isArray(value) && value.length === 2 && finiteInt(value[0]) && finiteInt(value[1]);

const vectorPropertySet = new Set<string>(COMPOSE_VECTOR_TRACK_PROPERTIES);
const trackPropertySet = new Set<string>(COMPOSE_TRACK_PROPERTIES);

/**
 * Validate `post_composition.value.compose` (or a `post_composition.value` wrapper carrying `.compose`).
 *
 * By AGENTS.md invariant 1, Create never range-checks dial keys (`SCENE_DIAL_KEY_RANGE`)
 * and never checks posed loop closure (`SCENE_ANIMATION_LOOP_CLOSES`); `rig-parts compose`
 * owns and refuses both, and Create reads compose's report. Equality with the composed model's
 * stage canvas and `post_timing.value.seconds` is checked by the `direction@3` writer (#600),
 * not here.
 */
export function readComposeValue(value: Json | undefined, path: string): ComposeValueSpec {
  const unwrap =
    isObject(value) &&
    'compose' in value &&
    !('canvas' in value || 'plates' in value || 'order' in value || 'character' in value || 'idle_tracks' in value);
  const raw = unwrap ? value.compose : value;
  const composePath = unwrap && !path.endsWith('.compose') ? `${path}.compose` : path;

  if (!isObject(raw)) {
    composeFail(composePath, 'post_composition value.compose must be a closed {canvas,plates,order,character,idle_tracks} object');
  }
  if (!('canvas' in raw) || raw.canvas === undefined) {
    composeFail(`${composePath}.canvas`, 'post_composition value.compose must declare canvas:{width,height}');
  }
  if (!('plates' in raw) || raw.plates === undefined) {
    composeFail(`${composePath}.plates`, 'post_composition value.compose must declare plates');
  }
  if (!('order' in raw) || raw.order === undefined) {
    composeFail(`${composePath}.order`, 'post_composition value.compose must declare order');
  }
  if (!('character' in raw) || raw.character === undefined) {
    composeFail(`${composePath}.character`, 'post_composition value.compose must declare character');
  }
  if (!('idle_tracks' in raw) || raw.idle_tracks === undefined) {
    composeFail(`${composePath}.idle_tracks`, 'post_composition value.compose must declare idle_tracks');
  }
  if (!closed(raw, ['canvas', 'plates', 'order', 'character', 'idle_tracks'])) {
    composeFail(composePath, 'post_composition value.compose allows only canvas, plates, order, character and idle_tracks');
  }

  const canvasPath = `${composePath}.canvas`;
  if (!isObject(raw.canvas)) {
    composeFail(canvasPath, 'post_composition value.compose.canvas must be a closed {width,height} object');
  }
  if (!('width' in raw.canvas) || raw.canvas.width === undefined) {
    composeFail(`${canvasPath}.width`, 'canvas must declare a positive finite integer width');
  }
  if (!('height' in raw.canvas) || raw.canvas.height === undefined) {
    composeFail(`${canvasPath}.height`, 'canvas must declare a positive finite integer height');
  }
  if (!closed(raw.canvas, ['width', 'height'])) {
    composeFail(canvasPath, 'canvas allows only width and height');
  }
  if (!positiveInt(raw.canvas.width)) {
    composeFail(`${canvasPath}.width`, 'canvas.width must be a positive finite integer');
  }
  if (!positiveInt(raw.canvas.height)) {
    composeFail(`${canvasPath}.height`, 'canvas.height must be a positive finite integer');
  }
  const canvas: ComposeCanvasSpec = { width: raw.canvas.width, height: raw.canvas.height };

  const platesPath = `${composePath}.plates`;
  if (!Array.isArray(raw.plates)) {
    composeFail(platesPath, 'post_composition value.compose.plates must be an array');
  }
  const plates: ComposePlateSpec[] = [];
  const seenPlateNames = new Set<string>();
  for (const [index, entry] of raw.plates.entries()) {
    const platePath = `${platesPath}[${index}]`;
    if (!isObject(entry)) {
      composeFail(platePath, 'plate entry must be a closed {name,image,at,opaque_backdrop?} object');
    }
    if (!('name' in entry) || entry.name === undefined) {
      composeFail(`${platePath}.name`, 'plate entry must declare a nonempty unique name');
    }
    if (!('image' in entry) || entry.image === undefined) {
      composeFail(`${platePath}.image`, 'plate entry must declare a literal project-relative image path');
    }
    if (!('at' in entry) || entry.at === undefined) {
      composeFail(`${platePath}.at`, 'plate entry must declare at:[x,y] of two finite integers');
    }
    if (!closed(entry, ['name', 'image', 'at'], ['opaque_backdrop'])) {
      composeFail(platePath, 'plate entry allows only name, image, at and optional opaque_backdrop');
    }
    if (!text(entry.name)) {
      composeFail(`${platePath}.name`, 'plate name must be a nonempty string');
    }
    if (seenPlateNames.has(entry.name)) {
      composeFail(`${platePath}.name`, `duplicate plate name ${JSON.stringify(entry.name)}`);
    }
    seenPlateNames.add(entry.name);
    if (!pathShape(entry.image)) {
      composeFail(`${platePath}.image`, 'plate image must be a literal project-relative path');
    }
    if (!intPair(entry.at)) {
      composeFail(`${platePath}.at`, 'plate at must be two finite integers [x, y]');
    }
    if (entry.opaque_backdrop !== undefined && typeof entry.opaque_backdrop !== 'boolean') {
      composeFail(`${platePath}.opaque_backdrop`, 'plate opaque_backdrop must be a boolean when present');
    }
    plates.push({
      name: entry.name,
      image: entry.image,
      at: [entry.at[0], entry.at[1]],
      ...(entry.opaque_backdrop !== undefined ? { opaque_backdrop: entry.opaque_backdrop } : {}),
    });
  }

  const orderPath = `${composePath}.order`;
  if (!Array.isArray(raw.order) || raw.order.length === 0) {
    composeFail(orderPath, 'post_composition value.compose.order must be a nonempty array of unique strings');
  }
  const order: string[] = [];
  const seenOrder = new Set<string>();
  for (const [index, token] of raw.order.entries()) {
    const tokenPath = `${orderPath}[${index}]`;
    if (!text(token)) {
      composeFail(tokenPath, 'order token must be a nonempty string');
    }
    if (seenOrder.has(token)) {
      composeFail(tokenPath, `duplicate order token ${JSON.stringify(token)}`);
    }
    seenOrder.add(token);
    order.push(token);
  }
  for (const plateName of seenPlateNames) {
    if (!seenOrder.has(plateName)) {
      composeFail(orderPath, `order must name every plate once (missing ${JSON.stringify(plateName)})`);
    }
  }

  const charPath = `${composePath}.character`;
  if (!isObject(raw.character)) {
    composeFail(charPath, 'post_composition value.compose.character must be a closed {offset,scale?} object');
  }
  if (!('offset' in raw.character) || raw.character.offset === undefined) {
    composeFail(`${charPath}.offset`, 'character must declare offset:[x,y]');
  }
  if (!closed(raw.character, ['offset'], ['scale'])) {
    composeFail(charPath, 'character allows only offset and optional scale');
  }
  if (!finitePair(raw.character.offset)) {
    composeFail(`${charPath}.offset`, 'character.offset must be two finite numbers [x, y]');
  }
  if (raw.character.scale !== undefined && (!finite(raw.character.scale) || raw.character.scale <= 0)) {
    composeFail(`${charPath}.scale`, 'character.scale must be a positive finite number when present');
  }
  const character: ComposeCharacterSpec = {
    offset: [raw.character.offset[0], raw.character.offset[1]],
    ...(raw.character.scale !== undefined ? { scale: raw.character.scale } : {}),
  };

  const tracksPath = `${composePath}.idle_tracks`;
  if (!Array.isArray(raw.idle_tracks)) {
    composeFail(tracksPath, 'post_composition value.compose.idle_tracks must be an array');
  }
  const idle_tracks: ComposeIdleTrackSpec[] = [];
  let end: number | undefined;
  for (const [index, entry] of raw.idle_tracks.entries()) {
    const trackPath = `${tracksPath}[${index}]`;
    if (!isObject(entry)) {
      composeFail(trackPath, 'idle track must be a closed {bone,property,keys} object');
    }
    if (!('bone' in entry) || entry.bone === undefined) {
      composeFail(`${trackPath}.bone`, 'idle track must declare a nonempty bone name');
    }
    if (!('property' in entry) || entry.property === undefined) {
      composeFail(`${trackPath}.property`, 'idle track must declare a property');
    }
    if (!('keys' in entry) || entry.keys === undefined) {
      composeFail(`${trackPath}.keys`, 'idle track must declare keys');
    }
    if (!closed(entry, ['bone', 'property', 'keys'])) {
      composeFail(trackPath, 'idle track allows only bone, property and keys');
    }
    if (!text(entry.bone)) {
      composeFail(`${trackPath}.bone`, 'idle track bone must be a nonempty string');
    }
    if (typeof entry.property !== 'string' || !trackPropertySet.has(entry.property)) {
      composeFail(
        `${trackPath}.property`,
        `idle track property must be one of rigc's scalar or vector bone track properties (${COMPOSE_TRACK_PROPERTIES.join(', ')})`,
      );
    }
    const property = entry.property as ComposeTrackProperty;
    const isVector = vectorPropertySet.has(property);
    const keysPath = `${trackPath}.keys`;
    if (!Array.isArray(entry.keys) || entry.keys.length === 0) {
      composeFail(keysPath, 'idle track keys must be a nonempty array starting at 0 and ending at a positive time');
    }
    const keys: ComposeTrackKeySpec[] = [];
    let prevT = -Infinity;
    for (const [keyIndex, keyEntry] of entry.keys.entries()) {
      const keyPath = `${keysPath}[${keyIndex}]`;
      if (!isObject(keyEntry)) {
        composeFail(keyPath, 'track key must be a closed {t,v,curve?} object');
      }
      if (!('t' in keyEntry) || keyEntry.t === undefined) {
        composeFail(`${keyPath}.t`, 'track key must declare finite time t');
      }
      if (!('v' in keyEntry) || keyEntry.v === undefined) {
        composeFail(`${keyPath}.v`, 'track key must declare value v');
      }
      if (!closed(keyEntry, ['t', 'v'], ['curve'])) {
        composeFail(keyPath, 'track key allows only t, v and optional curve');
      }
      if (!finite(keyEntry.t)) {
        composeFail(`${keyPath}.t`, 'track key t must be a finite number');
      }
      if (keyEntry.t < 0) {
        composeFail(`${keyPath}.t`, 'track key t must be nonnegative');
      }
      if (keyIndex === 0 && keyEntry.t !== 0) {
        composeFail(`${keyPath}.t`, 'first track key t must be 0');
      }
      if (keyIndex > 0 && keyEntry.t <= prevT) {
        composeFail(`${keyPath}.t`, 'track key times must strictly increase');
      }
      if (keyIndex === entry.keys.length - 1) {
        if (keyEntry.t <= 0) {
          composeFail(`${keyPath}.t`, 'last track key t must be positive');
        }
        if (end === undefined) {
          end = keyEntry.t;
        } else if (keyEntry.t !== end) {
          composeFail(`${keyPath}.t`, `last track key t (${keyEntry.t}) must equal the declared compose end (${end})`);
        }
      }
      prevT = keyEntry.t;

      if (isVector) {
        if (!finitePair(keyEntry.v)) {
          composeFail(`${keyPath}.v`, `track key v for vector property "${property}" must be a two-number array [x, y] of finite numbers`);
        }
      } else if (!finiteSingle(keyEntry.v)) {
        composeFail(`${keyPath}.v`, `track key v for scalar property "${property}" must be a one-number array [n] of a finite number`);
      }
      const v: [number] | [number, number] = isVector
        ? [(keyEntry.v as [number, number])[0], (keyEntry.v as [number, number])[1]]
        : [(keyEntry.v as [number])[0]];
      keys.push({
        t: keyEntry.t,
        v,
        ...(keyEntry.curve !== undefined ? { curve: keyEntry.curve } : {}),
      });
    }
    idle_tracks.push({ bone: entry.bone, property, keys });
  }

  return { canvas, plates, order, character, idle_tracks, ...(end === undefined ? {} : { end }) };
}

function collectAnswerValues(answer: JsonObject, basePath: string): { value: Json | undefined; path: string }[] {
  const out: { value: Json | undefined; path: string }[] = [];
  if ('value' in answer) {
    out.push({ value: answer.value, path: `${basePath}.value` });
  }
  if (isObject(answer.agent_decision) && 'value' in answer.agent_decision) {
    out.push({ value: answer.agent_decision.value, path: `${basePath}.agent_decision.value` });
  }
  asArray(answer.additions).forEach((add, index) => {
    if (isObject(add) && 'value' in add) {
      out.push({ value: add.value, path: `${basePath}.additions[${index}].value` });
    }
  });
  return out;
}

/** Validate the current recorded `post_composition` value when it carries `compose`. */
export function checkComposeValues(ctx: Ctx): void {
  const item = itemFor(ctx, 'post_composition');
  if (!item) return;
  const candidates: { value: Json | undefined; path: string }[] = [];
  if (item.state.state === 'user' || item.state.state === 'delegated') {
    candidates.push(...collectAnswerValues(item.state.answer, item.path));
  } else if (isObject(item.raw)) {
    candidates.push(...collectAnswerValues(item.raw, item.path));
  }
  for (const { value, path } of candidates) {
    if (!isObject(value) || !('compose' in value) || value.compose === undefined) continue;
    try {
      readComposeValue(value.compose, `${path}.compose`);
    } catch (error) {
      if (error instanceof ComposeValueError) {
        ctx.refusals.push(composeValueFinding(error));
      } else {
        throw error;
      }
    }
  }
}
