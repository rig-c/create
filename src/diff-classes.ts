/** Group only producer fields; no image measurement takes place here. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { diffReportBytes, reportShape } from './diff-map.ts';
import { refuse, USAGE_EXIT } from './refusal.ts';
import type { JsonObject } from './templates.ts';

type Component = { id: string; px: number; uncovered_px: number; coverage: string; borders: { part: string }[] };
type Key = { coverage_band: string; border_parts: string[] };
export type DiffClass = { id: string; key: Key; members: string[]; px_range: number[]; uncovered_fraction_range: number[] };
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const status = (v: unknown): boolean => typeof v === 'string' && ['in-painting', 'fixed', 'left'].includes(v);
const nonempty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

/** Quarter-width mixed bands limit the within-class spread to less than 0.25. */
export function deriveDiffClasses(report: unknown): DiffClass[] {
  if (!object(report) || !reportShape(report)) refuse('DIFF_MAP_REPORT', 'diff_map.report: needs a well-shaped rig-parts-diff-components/1 report; regenerate the report');
  const groups = new Map<string, { key: Key; components: Component[] }>();
  const ids = new Set<string>();
  for (const c of report.components as Component[]) {
    const fraction = c.uncovered_px / c.px;
    if (ids.has(c.id) || fraction > 1 || c.coverage === 'covered' && fraction !== 0 || c.coverage === 'uncovered' && fraction !== 1 || c.coverage === 'mixed' && (fraction <= 0 || fraction >= 1)) {
      refuse('DIFF_MAP_REPORT', `diff_map.report.components ${c.id}: duplicate id or inconsistent coverage counts; regenerate the report`);
    }
    ids.add(c.id);
    const band = Math.floor(fraction * 4);
    const key = { coverage_band: c.coverage === 'mixed' ? `mixed:${(band / 4).toFixed(2)}-${((band + 1) / 4).toFixed(2)}` : c.coverage,
      border_parts: [...new Set(c.borders.map(b => b.part))].sort() };
    const encoded = JSON.stringify(key);
    const group = groups.get(encoded) ?? { key, components: [] };
    group.components.push(c);
    groups.set(encoded, group);
  }
  return [...groups.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([encoded, { key, components }]) => ({
    id: `class-${createHash('sha256').update(encoded).digest('hex')}`, key,
    members: components.map(c => c.id).sort(),
    px_range: [Math.min(...components.map(c => c.px)), Math.max(...components.map(c => c.px))],
    uncovered_fraction_range: [Math.min(...components.map(c => c.uncovered_px / c.px)), Math.max(...components.map(c => c.uncovered_px / c.px))],
  }));
}

function specific(why: string, key: Key): boolean {
  const tokens = [key.coverage_band, ...key.border_parts];
  return tokens.some(token => {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^\\p{L}\\p{N}_-])${escaped}($|[^\\p{L}\\p{N}_-])`, 'iu').test(why);
  });
}

/** Strict decision-only input: callers cannot supply keys or member lists. */
export function expandDiffTriage(report: unknown, triage: unknown, path: string): JsonObject {
  const fail = (detail: string): never => refuse('DIFF_MAP_TRIAGE', `${path}: ${detail}; use diff-classes and provide only status and why for each class or component id`);
  if (!object(triage) || Object.keys(triage).some(k => !['classes', 'components'].includes(k))) fail('needs classes and/or components decision maps');
  const input = triage as Record<string, unknown>;
  const derived = new Map(deriveDiffClasses(report).map(c => [c.id, c]));
  const ids = new Set((report as { components: Component[] }).components.map(c => c.id));
  const classes: JsonObject[] = [], components: JsonObject[] = [];
  for (const kind of ['classes', 'components']) {
    const entries = input[kind] ?? {};
    if (!object(entries)) fail(`${kind} must be an id-to-decision object`);
    for (const [id, value] of Object.entries(entries as Record<string, unknown>)) {
      if (!object(value) || Object.keys(value).length !== 2 || !status(value.status) || !nonempty(value.why)) fail(`${id} needs only status and nonempty why`);
      const decision = value as { status: string; why: string };
      if (kind === 'classes') {
        const c = derived.get(id);
        if (!c) fail(`unknown class ${id}`);
        const group = c!;
        if (!specific(decision.why, group.key)) refuse('DIFF_MAP_CLASS_WHY', `${path}.${id}.why: name a border part or ${group.key.coverage_band}; inspect this class and state its measured property`);
        classes.push({ id, key: group.key, ...decision, members: group.members });
        components.push(...group.members.map(member => ({ id: member, ...decision, class_id: id })));
      } else {
        if (!ids.has(id)) fail(`unknown component ${id}`);
        components.push({ id, ...decision });
      }
    }
  }
  return { classes, components };
}

/** Optional class records are audited by both the writer and check. */
export function checkDiffClasses(report: unknown, map: Record<string, unknown>, path: string, push: (code: string, detail: string) => void): void {
  const components = map.components as Record<string, unknown>[];
  if (map.classes === undefined && !components.some(c => object(c) && c.class_id !== undefined)) return;
  let derived: DiffClass[];
  try { derived = deriveDiffClasses(report); }
  catch (error) { push('DIFF_MAP_CLASS', `${path}: ${error instanceof Error ? error.message : String(error)}`); return; }
  if (!Array.isArray(map.classes)) { push('DIFF_MAP_CLASS', `${path}.classes must be a list; regenerate classes with --triage-file`); return; }
  const expected = new Map(derived.map(c => [c.id, c]));
  const seen = new Set<string>(), owners = new Map<string, Record<string, unknown>>();
  for (const c of map.classes) {
    if (!object(c) || !nonempty(c.id)) { push('DIFF_MAP_CLASS', `${path}.classes: class needs an id`); continue; }
    const group = expected.get(c.id);
    if (!group || seen.has(c.id) || !object(c.key) || Object.keys(c.key).length !== 2
      || c.key.coverage_band !== group.key.coverage_band || JSON.stringify(c.key.border_parts) !== JSON.stringify(group.key.border_parts)
      || !Array.isArray(c.members) || c.members.length !== group.members.length || new Set(c.members).size !== c.members.length
      || c.members.some(id => typeof id !== 'string' || !group.members.includes(id))) {
      push('DIFF_MAP_CLASS', `${path}.classes ${c.id}: key or full member set differs from the derived class, or id repeats`);
      continue;
    }
    seen.add(c.id);
    if (!status(c.status) || !nonempty(c.why)) push('DIFF_MAP_CLASS', `${path}.classes ${c.id}: needs a valid status and nonempty why`);
    else if (!specific(c.why, group.key)) push('DIFF_MAP_CLASS_WHY', `${path}.classes ${c.id}: why must name a border part or ${group.key.coverage_band}`);
    for (const member of c.members as string[]) {
      if (owners.has(member)) push('DIFF_MAP_CLASS', `${path}.classes ${c.id}: ${member} belongs to more than one class`);
      owners.set(member, c);
      const expanded = components.filter(v => object(v) && v.id === member);
      if (expanded.length !== 1 || expanded[0].class_id !== c.id || expanded[0].status !== c.status || expanded[0].why !== c.why) {
        push('DIFF_MAP_CLASS', `${path}.components ${member}: class id, status and why must equal its class`);
      }
    }
  }
  for (const c of components) if (object(c) && c.class_id !== undefined && (!nonempty(c.id) || owners.get(c.id)?.id !== c.class_id)) {
    push('DIFF_MAP_CLASS', `${path}.components ${String(c.id)}: class_id has no matching class membership`);
  }
}

export const DIFF_CLASSES_HELP = `diff-classes [<project dir>] --diff-report <path>
  Read derived classes as JSON: id, key, members, member_count, px_range and uncovered_fraction_range.
  Triage JSON: {"classes":{"<class id>":{"status":"left","why":"<property and observation>"}},"components":{}}.
  Mixed bands have width 0.25; the lower bound is inclusive and upper bound exclusive.`;

export function diffClassesCommand(args: string[]): { stdout: string; exit: number } {
  let dir: string | undefined, report: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--diff-report' && report === undefined) report = args[++i];
    else if (args[i].startsWith('-') || dir !== undefined) refuse('DIFF_MAP_TRIAGE', `diff_map.report: ${DIFF_CLASSES_HELP}`, USAGE_EXIT);
    else dir = args[i];
  }
  if (!report) refuse('DIFF_MAP_TRIAGE', `diff_map.report: ${DIFF_CLASSES_HELP}`, USAGE_EXIT);
  try {
    const classes = deriveDiffClasses(JSON.parse(diffReportBytes(resolve(dir ?? process.cwd()), report).toString('utf8')));
    return { stdout: JSON.stringify(classes.map(c => ({ ...c, member_count: c.members.length })), null, 2), exit: 0 };
  } catch (error) { refuse('DIFF_MAP_REPORT', `diff_map.report ${report}: ${error instanceof Error ? error.message : String(error)}; generate a report under the project and read it again`); }
}

export function readDiffTriage(file: string): unknown {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { refuse('DIFF_MAP_TRIAGE', `diff_map --triage-file ${file}: ${error instanceof Error ? error.message : String(error)}; supply a readable JSON decision file`); }
}
