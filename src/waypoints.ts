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
  requirements: none('a path to a checks file; where translated guide sentences land, not where they are asked'),
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
