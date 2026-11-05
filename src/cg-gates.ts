/**
 * The CG gates (docs/CHECKS.md § CG gates): a rig version of a full-screen
 * scene (an illustration CG brought to life, `rig_type` `fullscreen.*`) is held
 * to the three opt-in `@rig-c/parts` gates that measure what a CG build is for —
 * every part's pixels trace to the split or to a receipted edit, no seam shows
 * background in motion, no part boundary carries a colour step the pieces do
 * not have:
 *
 * - `assemble.editor_receipts.trace_parts: true` in the version's config;
 * - `seam_over_motion.required: true` and
 * - `boundary_colour.max_step_excess` (an integer, at most
 *   {@link CG_BOUNDARY_ALLOWANCE}) in the requirements file the config names
 *   as `requirements`, so `rig-parts build` runs both from the config alone.
 *
 * create writes no config: the agent does. So the declarations are not
 * written here; this check refuses, by name, a CG version whose config does
 * not carry them, the same for every CG project. It reads the files; what the
 * gates measure is parts' (`rig-parts build` / `check`), not create's.
 *
 * `rig_type` is also checked against the values docs/INTERVIEW.md lists, since
 * a value outside them would decide nothing here and let a CG build through.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';

import { asString, isObject, itemFor, asArray, type Ctx } from './check.ts';
import type { Json, JsonObject } from './templates.ts';

/** The `rig_type` values (docs/INTERVIEW.md § Framing). */
export const RIG_TYPES: readonly string[] = ['character.idle', 'character.complex', 'character.monster', 'fullscreen.minimal', 'fullscreen.game_logic'];

/** A `rig_type` with this prefix is a full-screen scene: create's notion of a CG build. */
export const CG_RIG_TYPE_PREFIX = 'fullscreen.';

/**
 * The boundary colour allowance a CG version declares at most: parts' public
 * examples read 1 to 4 clean and 21 and up planted (parts AUTHORING,
 * *Boundary colour step*), and each declares 12. A lower value is stricter and
 * allowed; a higher one is refused.
 */
export const CG_BOUNDARY_ALLOWANCE = 12;

/** The first `@rig-c/parts` with all three gates (issues #969, #975, #976). A version built with an earlier one could not declare them. */
export const CG_GATES_FROM_PARTS = '2.4.0';

function versionLabel(v: JsonObject, index: number): string {
  return typeof v.n === 'number' ? `versions[v${v.n}]` : `versions[${index}]`;
}

function semver(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  return m === null ? null : [Number(m[1]), Number(m[2]), Number(m[3])];
}

function before(a: string, b: string): boolean {
  const x = semver(a);
  const y = semver(b);
  if (x === null || y === null) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] as number) < (y[i] as number);
  return false;
}

/** The answered `rig_type` value: the user's `value`, or the agent's decision on a delegation. */
function rigTypeValue(ctx: Ctx): { value: Json | undefined; path: string } | null {
  const item = itemFor(ctx, 'rig_type');
  if (item === undefined) return null;
  const s = item.state;
  // A pending Other has no type yet; the choice gate refuses its interview/plan approval.
  if (s.state === 'user' && s.answer.value === null && isObject(s.answer.choice) && asArray(s.answer.asks).some(a => isObject(a) && a.state === 'other-pending')) return null;
  if (s.state === 'user') return { value: s.answer.value, path: item.path };
  if (s.state === 'delegated' && s.decided && isObject(s.answer.agent_decision)) return { value: s.answer.agent_decision.value, path: item.path };
  return null;
}

type Read = { ok: true; value: JsonObject; file: string } | { ok: false; why: string };

function inside(dir: string, file: string): boolean {
  const rel = relative(dir, file);
  return rel !== '' && !rel.startsWith('..') && !rel.startsWith(sep);
}

export function readObject(dir: string, file: string, sha256: string | null): Read {
  if (!inside(dir, file)) return { ok: false, why: `${relative(dir, file)} is not under the project` };
  if (!existsSync(file)) return { ok: false, why: `${relative(dir, file)} is not there` };
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch {
    return { ok: false, why: `${relative(dir, file)} cannot be read` };
  }
  if (sha256 !== null) {
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== sha256) return { ok: false, why: `${relative(dir, file)} hashes to ${actual}, not the recorded ${sha256}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    return { ok: false, why: `${relative(dir, file)} is not JSON` };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, why: `${relative(dir, file)} is not a JSON object` };
  return { ok: true, value: parsed as JsonObject, file };
}

/** Refuses an unknown `rig_type` and, on a CG project, every rig version whose config does not declare the three gates. */
export function checkCgGates(ctx: Ctx): void {
  const rigType = rigTypeValue(ctx);
  if (rigType === null) return; // unanswered or not applicable: reported by the answer checks
  if (typeof rigType.value !== 'string' || !RIG_TYPES.includes(rigType.value)) {
    ctx.refusals.push({
      code: 'RIG_TYPE_UNKNOWN',
      path: rigType.path,
      message: `${rigType.path}: value ${JSON.stringify(rigType.value ?? null)} is none of ${RIG_TYPES.join(', ')}; the value decides which prompts apply and whether the build is a CG (fullscreen.*), so a value outside the list decides nothing`,
    });
    return;
  }
  if (!rigType.value.startsWith(CG_RIG_TYPE_PREFIX)) return;

  asArray(ctx.project.versions).forEach((v, index) => {
    if (!isObject(v) || v.kind !== 'rig') return;
    const label = versionLabel(v, index);
    const builtWith = isObject(v.built_with) ? asString(v.built_with['@rig-c/parts']) : null;
    if (builtWith !== null && before(builtWith, CG_GATES_FROM_PARTS)) {
      ctx.warnings.push({
        code: 'CG_GATES_PREDATE',
        path: `${label}.built_with`,
        message: `${label}: built with @rig-c/parts ${builtWith}, before the CG gates (${CG_GATES_FROM_PARTS}); it is not held to them, and the next CG version declares them`,
      });
      return;
    }
    const prov = isObject(v.provenance) ? v.provenance : {};
    const config = isObject(prov.config) ? prov.config : {};
    const configPath = asString(config.path);
    const at = `${label}.provenance.config`;
    if (configPath === null) {
      ctx.refusals.push({ code: 'CG_GATES_UNREAD', path: at, message: `${at}: no path; a CG version's gates are read from the config it was built from — keep it under the project and record its path and sha256` });
      return;
    }
    const configSha = asString(config.sha256);
    if (configSha === null || configSha === '') {
      ctx.refusals.push({ code: 'CG_GATES_UNREAD', path: at, message: `${at}: no sha256; a CG version's gates are read from the config it was built from, verified by its recorded hash — record the config's sha256` });
      return;
    }
    const cfg = readObject(ctx.dir, resolve(ctx.dir, configPath), configSha);
    if (!cfg.ok) {
      ctx.refusals.push({ code: 'CG_GATES_UNREAD', path: at, message: `${at}: ${cfg.why}; a CG version's gates are read from the config it was built from — keep it in evidence/v<N>/ (in git; outputs/ is ignored) at the recorded path and sha256` });
      return;
    }
    const assemble = isObject(cfg.value.assemble) ? cfg.value.assemble : {};
    const receipts = isObject(assemble.editor_receipts) ? assemble.editor_receipts : {};
    if (receipts.trace_parts !== true) {
      ctx.refusals.push({
        code: 'CG_GATE_UNDECLARED',
        path: `${at} assemble.editor_receipts.trace_parts`,
        message: `${label}: ${configPath} does not declare assemble.editor_receipts.trace_parts: true; a CG build's every part traces to a layer of the split or a receipted edit (parts ASSEMBLE_PART_SOURCE)`,
      });
    }
    const reqPath = asString(cfg.value.requirements);
    if (reqPath === null || reqPath === '') {
      ctx.refusals.push({
        code: 'CG_GATE_UNDECLARED',
        path: `${at} requirements`,
        message: `${label}: ${configPath} names no requirements file; a CG config names one (config.requirements) declaring seam_over_motion.required: true and boundary_colour.max_step_excess, so the build runs both gates from the config alone`,
      });
      return;
    }
    const req = readObject(ctx.dir, resolve(dirname(cfg.file), reqPath), null);
    if (!req.ok) {
      ctx.refusals.push({ code: 'CG_GATES_UNREAD', path: `${at} requirements`, message: `${label}: the requirements file ${reqPath} (from ${configPath}): ${req.why}` });
      return;
    }
    const seam = isObject(req.value.seam_over_motion) ? req.value.seam_over_motion : {};
    if (seam.required !== true) {
      ctx.refusals.push({
        code: 'CG_GATE_UNDECLARED',
        path: `${at} requirements seam_over_motion.required`,
        message: `${label}: ${reqPath} does not declare seam_over_motion.required: true; a CG build shows no background at any declared seam on any frame (parts CHECK_SEAM_OVER_MOTION_REQUIRED)`,
      });
    }
    const colour = isObject(req.value.boundary_colour) ? req.value.boundary_colour : {};
    const allowance = colour.max_step_excess;
    if (typeof allowance !== 'number' || !Number.isInteger(allowance) || allowance < 0) {
      ctx.refusals.push({
        code: 'CG_GATE_UNDECLARED',
        path: `${at} requirements boundary_colour.max_step_excess`,
        message: `${label}: ${reqPath} does not declare boundary_colour.max_step_excess as an integer; a CG build declares at most ${CG_BOUNDARY_ALLOWANCE} (parts CHECK_BOUNDARY_COLOUR_STEP)`,
      });
    } else if (allowance > CG_BOUNDARY_ALLOWANCE) {
      ctx.refusals.push({
        code: 'CG_BOUNDARY_ALLOWANCE_RAISED',
        path: `${at} requirements boundary_colour.max_step_excess`,
        message: `${label}: ${reqPath} declares boundary_colour.max_step_excess ${allowance}; a CG build declares at most ${CG_BOUNDARY_ALLOWANCE} — a step over it is the art's to fix (the piece's image or mesh), not the allowance's`,
      });
    }
  });
}
