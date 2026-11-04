/** Hash-bound inventory on the latest parts-review sign-off. create never measures differences. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import type { Finding } from './check.ts';
import type { JsonObject } from './templates.ts';

export const DIFF_MAP_SINCE = '2026-11-06T00:00:00Z';
export const DIFF_MAP_MAX_FLOOR_PX = 2;
export const DIFF_MAP_MAX_THRESHOLD = 40;
const SPEC = 'rig-parts-diff-components/1';
const SHA256 = /^[0-9a-f]{64}$/;
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonempty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const hash = (v: unknown): v is string => typeof v === 'string' && SHA256.test(v);
const integer = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const binding = (v: unknown): boolean => object(v) && nonempty(v.path) && hash(v.sha256);

function reportShape(v: Record<string, unknown>): boolean {
  const d = v.definition;
  const b = v.below_floor;
  return v.spec === SPEC && binding(v.stack) && binding(v.painting) && object(d)
    && d.metric === 'max-absolute-rgb-channel' && d.comparison === '>' && d.connectivity === 8
    && d.coordinates === 'native' && d.y === 'down' && d.origin === 'top-left' && d.resampling === 'none'
    && d.covered_alpha_above === 128 && integer(d.width) && d.width > 0 && integer(d.height) && d.height > 0
    && integer(d.floor_px) && d.floor_px > 0 && typeof d.threshold === 'number' && Number.isFinite(d.threshold) && d.threshold >= 0 && d.threshold <= 255
    && (d.inside_sha256 === null || hash(d.inside_sha256))
    && integer(v.error_px) && integer(v.uncovered_error_px)
    && object(b) && integer(b.count) && integer(b.px) && integer(b.uncovered_px)
    && Array.isArray(v.components) && v.components.every((c) => object(c) && nonempty(c.id) && integer(c.px) && c.px > 0
      && object(c.box) && integer(c.box.x) && integer(c.box.y) && integer(c.box.w) && c.box.w > 0 && integer(c.box.h) && c.box.h > 0
      && typeof c.coverage === 'string' && ['covered', 'uncovered', 'mixed'].includes(c.coverage) && integer(c.uncovered_px)
      && Array.isArray(c.borders) && c.borders.every((p) => object(p) && nonempty(p.part) && integer(p.px)));
}

/** A project-relative regular file, contained as written and with links followed. */
export function diffReportBytes(dir: string, path: string): Buffer {
  if (isAbsolute(path)) throw new Error('report path must be project-relative');
  const file = resolve(dir, path);
  const contained = (root: string, target: string): boolean => {
    const rel = relative(root, target);
    return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  };
  if (!contained(resolve(dir), file) || !contained(realpathSync(dir), realpathSync(file))) throw new Error('report must be under the project');
  return readFileSync(file);
}

/** parts cli.ts assemble --out uses rig/ and render/; src/build.ts writes both beside one another. */
export function diffStackCandidates(partsFile: string): string[] {
  const dir = dirname(partsFile);
  const candidates = [resolve(dir, 'recomposite_rig.png')];
  if (basename(dir) === 'rig') candidates.push(resolve(dir, '..', 'render', 'recomposite_rig.png'));
  return candidates;
}

/** `partsFile` is returned only by the successful parts-verdict reader. */
export function checkDiffMap(dir: string, signoff: JsonObject, at: string, partsFile: string | undefined, refusals: Finding[], warnings: Finding[]): void {
  const path = `${at}.diff_map`;
  const remedy = 'generate rig-parts diff-components on the reviewed assembly, list every component with its status and why, and record a new parts-review sign-off with --diff-report and --component';
  const push = (code: string, detail: string): void => { refusals.push({ code, path, message: `${at} ${path}: ${detail}; ${remedy}` }); };
  const map = signoff.diff_map;
  if (map === undefined) {
    const date = typeof signoff.at === 'string' ? Date.parse(signoff.at) : NaN;
    if (Number.isFinite(date) && date < Date.parse(DIFF_MAP_SINCE)) {
      warnings.push({ code: 'DIFF_MAP_PREDATES', path, message: `${at} ${path}: no diff_map, sign-off predates ${DIFF_MAP_SINCE}; preserve this record and include the map when parts are reviewed again` });
    } else push('DIFF_MAP_MISSING', 'the parts-review sign-off has no diff_map');
    return;
  }
  if (!object(map) || !object(map.report) || !nonempty(map.report.path) || !hash(map.report.sha256)) {
    push('DIFF_MAP_REPORT', 'report needs a project-relative path and lowercase sha256');
    return;
  }
  let report: unknown;
  try {
    const bytes = diffReportBytes(dir, map.report.path);
    if (createHash('sha256').update(bytes).digest('hex') !== map.report.sha256) throw new Error('sha256 differs from the sign-off');
    report = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    push('DIFF_MAP_REPORT', `${map.report.path}: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (!object(report) || !reportShape(report)) {
    push('DIFF_MAP_REPORT', `${map.report.path}: needs a well-shaped ${SPEC} report`);
    return;
  }
  const components = report.components as { id: string }[];
  const ids = new Set(components.map((c) => c.id));
  if (ids.size !== components.length) {
    push('DIFF_MAP_REPORT', `${map.report.path}: duplicate report component ids`);
    return;
  }
  const definition = report.definition as { floor_px: number; threshold: number };
  if (definition.floor_px > DIFF_MAP_MAX_FLOOR_PX || definition.threshold > DIFF_MAP_MAX_THRESHOLD) {
    push('DIFF_MAP_POLICY', `${map.report.path}: floor_px ${definition.floor_px} must be <= ${DIFF_MAP_MAX_FLOOR_PX} and threshold ${definition.threshold} must be <= ${DIFF_MAP_MAX_THRESHOLD}`);
  }
  if (partsFile !== undefined) {
    const candidates = diffStackCandidates(partsFile);
    const present = candidates.filter((file) => existsSync(file));
    try {
      if (present.length !== 1) throw new Error(present.length === 0 ? 'neither candidate is on disk' : 'both candidates are on disk, ambiguous');
      const bytes = diffReportBytes(dir, relative(dir, present[0]));
      if (createHash('sha256').update(bytes).digest('hex') !== (report.stack as { sha256: string }).sha256) throw new Error('sha256 differs from report.stack.sha256');
    } catch (error) {
      push('DIFF_MAP_STACK_MISMATCH', `${candidates.map((file) => relative(dir, file)).join(', ')} for ${map.report.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!Array.isArray(map.components)) {
    push('DIFF_MAP_STATUS', `${map.report.path}: diff_map.components must be a list of {id, status, why}`);
    return;
  }
  const listed = new Set<string>();
  for (const c of map.components) {
    if (!object(c) || !nonempty(c.id)) {
      push('DIFF_MAP_STATUS', `${map.report.path}: component needs an id, status and why`);
      continue;
    }
    if (!ids.has(c.id)) push('DIFF_MAP_COMPONENT_UNKNOWN', `${map.report.path}: unknown component ${c.id}`);
    if (listed.has(c.id)) push('DIFF_MAP_STATUS', `${map.report.path}: component ${c.id} is listed more than once`);
    listed.add(c.id);
    if (typeof c.status !== 'string' || !['in-painting', 'fixed', 'left'].includes(c.status) || !nonempty(c.why)) {
      push('DIFF_MAP_STATUS', `${map.report.path}: component ${c.id} needs status in-painting, fixed or left and nonempty why`);
    }
  }
  for (const id of ids) if (!listed.has(id)) push('DIFF_MAP_COMPONENT_UNLISTED', `${map.report.path}: component ${id} is unlisted`);
}
