/**
 * Where each top-level section of a `@rig-c/parts` config goes: a rig waypoint,
 * a post item, or nowhere (not a direction call). This is the table in
 * docs/INTERVIEW.md § Waypoints, as data, and the ONLY place the mapping is
 * written. The section list itself is not here: it is read from the installed
 * parts package (src/parts-sections.ts), so a section parts adds that is not
 * on this table is refused by name (`SECTION_UNPLACED`) — a new section is a
 * new question before it is a new line here.
 *
 * `alternates` is not listed: @rig-c/parts 2.4.0 accepts it only inside
 * `assemble` (`assemble.alternates`), so it is part of the `assemble`
 * waypoint's decision, not a section of its own.
 */
export type Placement =
  | { readonly kind: 'waypoint'; readonly waypoint: string }
  | { readonly kind: 'post'; readonly item: string }
  | { readonly kind: 'none'; readonly why: string };

const wp = (waypoint: string): Placement => ({ kind: 'waypoint', waypoint });
const post = (item: string): Placement => ({ kind: 'post', item });
const none = (why: string): Placement => ({ kind: 'none', why });

export const SECTION_PLACEMENT: Readonly<Record<string, Placement>> = {
  seethrough: wp('seethrough'),
  assemble: wp('assemble'),
  limbs: wp('assemble'),
  scene: wp('assemble'),
  waist: wp('assemble'),
  bones: wp('bones'),
  meshes: wp('meshes'),
  regions: wp('meshes'),
  constraints: wp('constraints'),
  stops: wp('constraints'),
  cloth: wp('constraints'),
  motion: wp('motion'),
  turn: post('camera_depth'),
  depth: post('camera_depth'),
  key: none('a name'),
  generation: none('a record of a run'),
  proposed_rig_scale: none('a value the tool proposes'),
  requirements: none(
    "a path to a checks file. Declare setup_painting.required: true, with limits from parts' own pixel_count per region "
    + 'on the build accepted at the split checkpoint, recorded as a "no worse than the accepted split" bar with its source. '
    + 'Translated guide sentences land here, after they are asked',
  ),
  motion_seams: none('an observation'),
  note: none('an annotation; parts accepts it beside any object and reads nothing from it'),
};

/** Pipeline order of the rig waypoints; a waypoint not listed here sorts last, by name. */
export const WAYPOINT_ORDER: readonly string[] = ['seethrough', 'assemble', 'bones', 'meshes', 'constraints', 'motion'];

/** The framing questions asked before the waypoints (INTERVIEW.md F1, F2). */
export const FRAMING_IDS: readonly string[] = ['rig_type', 'reference'];

/**
 * Post items with no config section of their own (INTERVIEW.md § Post-production).
 * `camera_depth` is not listed: it is derived from the `turn` and `depth`
 * sections through the table above.
 */
export const SECTIONLESS_POST_ITEMS: readonly string[] = ['post_timing', 'post_composition'];

export interface DerivedWaypoint {
  readonly id: string;
  /** The parts sections placed on it, in parts' order. */
  readonly config: readonly string[];
}

export interface DerivedSet {
  readonly waypoints: readonly DerivedWaypoint[];
  readonly post_items: readonly DerivedWaypoint[];
  /** Sections present in parts and absent from the table. */
  readonly unplaced: readonly string[];
  /** Sections the table places on a waypoint or post item that parts no longer has (a retired `none` entry is not reported: nothing was asked there). */
  readonly retired: readonly string[];
}

function byOrder(a: string, b: string): number {
  const ia = WAYPOINT_ORDER.indexOf(a);
  const ib = WAYPOINT_ORDER.indexOf(b);
  if (ia === -1 && ib === -1) return a.localeCompare(b);
  if (ia === -1) return 1;
  if (ib === -1) return -1;
  return ia - ib;
}

/** Places every section parts has; the result is what a project's interview is checked against. */
export function deriveWaypoints(sections: readonly string[]): DerivedSet {
  const waypoints = new Map<string, string[]>();
  const items = new Map<string, string[]>();
  const unplaced: string[] = [];
  for (const section of sections) {
    const placement = SECTION_PLACEMENT[section];
    if (placement === undefined) {
      unplaced.push(section);
    } else if (placement.kind === 'waypoint') {
      waypoints.set(placement.waypoint, [...(waypoints.get(placement.waypoint) ?? []), section]);
    } else if (placement.kind === 'post') {
      items.set(placement.item, [...(items.get(placement.item) ?? []), section]);
    }
  }
  for (const item of SECTIONLESS_POST_ITEMS) if (!items.has(item)) items.set(item, []);
  const present = new Set(sections);
  return {
    waypoints: [...waypoints.entries()].sort(([a], [b]) => byOrder(a, b)).map(([id, config]) => ({ id, config })),
    post_items: [...items.entries()].map(([id, config]) => ({ id, config })),
    unplaced,
    retired: Object.keys(SECTION_PLACEMENT).filter((s) => !present.has(s) && SECTION_PLACEMENT[s]?.kind !== 'none'),
  };
}

/** A direction ask, from INTERVIEW.md's waypoint descriptions, not a config field. */
export interface WaypointAsk {
  readonly id: string;
  readonly text: string;
  readonly required_for?: 'fullscreen.game_logic' | 'other';
}

export const WAYPOINT_ASKS: Readonly<Record<string, readonly WaypointAsk[]>> = {
  seethrough: [
    { id: 'layers', text: 'What must the layer split keep together or apart?' },
    { id: 'resolution', text: 'What resolution should the layer passes use?' },
    { id: 'head_crop', text: 'What head crop should be used?' },
    { id: 'seed', text: 'What seed should be used?' },
  ],
  assemble: [
    { id: 'projection', text: 'Core keeps the part mask as the boundary. Visible follows the painting rim and can take backdrop pixels. Which projection should assemble use?' },
    { id: 'ground', text: 'Plain preserves the existing rim projection. Busy limits backdrop pickup around thin parts. Is the ground plain or busy?' },
    { id: 'cut', text: 'Which parts are cut, and how finely?' },
    { id: 'emphasis', text: 'Which parts need detail or must stay exactly as painted?' },
    { id: 'draw_order', text: 'What is the parts draw order?' },
    { id: 'authored', text: 'What is authored new?' },
    { id: 'occluders', text: 'What is kept under occluders?' },
    { id: 'outfits', text: 'Which outfit sets exist?' },
  ],
  bones: [
    { id: 'chains', text: 'Which parts get chains or stay rigid?' },
    { id: 'placement', text: 'Where do bones sit?' },
    { id: 'length', text: 'How long are the chains?' },
  ],
  meshes: [
    { id: 'bend', text: 'Which parts bend smoothly?' },
    { id: 'rigid', text: 'Which parts stay rigid?' },
    { id: 'density', text: 'What mesh density should be used?' },
  ],
  constraints: [
    { id: 'effects', text: 'Which parts move on physics, wind or other effects?' },
    { id: 'strength', text: 'How strongly do those effects act?' },
    { id: 'extent', text: 'How far may the affected parts move?' },
    { id: 'gravity', text: 'What gravity applies?' },
    { id: 'stops', text: 'Where must chains stop?' },
  ],
  motion: [
    { id: 'tracks', text: 'Which moves? Name each one.', required_for: 'other' },
    { id: 'states', text: 'Which game states drive the motion?', required_for: 'fullscreen.game_logic' },
    { id: 'transitions', text: 'What moves it from one state to the next?', required_for: 'fullscreen.game_logic' },
    { id: 'extent', text: 'How far does each motion move?' },
    { id: 'speed', text: 'How fast does each motion move?' },
    { id: 'loop', text: 'How long is the motion loop?' },
    { id: 'blink', text: 'Should it blink?', required_for: 'other' },
  ],
};
