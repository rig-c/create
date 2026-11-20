import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { readFileSync, realpathSync } from './check-reads.ts';
import { asArray, isObject, type Finding } from './check.ts';
import { refuse } from './refusal.ts';
import type { Json, JsonObject } from './templates.ts';

export const ASSEMBLE_ONLY = 'assemble-only';

export const isAssembleOnlyDraft = (draft: JsonObject | undefined): boolean => draft?.layout === ASSEMBLE_ONLY;

export function draftRigRequired(path: string, id: Json | undefined): Finding {
  return { code: 'DRAFT_RIG_REQUIRED', path, message: `${path}: draft ${String(id)} is assemble-only; register a new draft with a rig output using draft-rig` };
}

export function assertDraftHasRig(draft: JsonObject | undefined, path: string): void {
  if (!isAssembleOnlyDraft(draft)) return;
  const finding = draftRigRequired(path, draft?.id);
  refuse(finding.code, finding.message);
}

/** Production version numbers take priority over any draft with a colliding id. */
export function assembleOnlyDraftTarget(project: JsonObject, target: Json | undefined): JsonObject | undefined {
  if (typeof target !== 'string' && typeof target !== 'number') return undefined;
  const n = Number(String(target).replace(/^v/, ''));
  if (asArray(project.versions).some(v => isObject(v) && v.n === n)) return undefined;
  const drafts = asArray(project.drafts).filter(isObject).filter(isAssembleOnlyDraft);
  return drafts.find(d => d.id === String(target)) ?? (Number.isSafeInteger(n) && n > 0 ? drafts.find(d => d.id === String(n)) : undefined);
}

/** Usage checks may recognize a draft id without taking over the caller's project-file errors. */
export function readAssembleOnlyDraftTarget(dir: string, target: string | undefined): JsonObject | undefined {
  if (target === undefined) return undefined;
  let project: Json;
  try { project = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as Json; } catch { return undefined; }
  return isObject(project) ? assembleOnlyDraftTarget(project, target) : undefined;
}

/** Recognize a draft's reserved root before a rig consumer attempts to open its files. */
export function assembleOnlyDraftPath(dir: string, project: JsonObject, source: Json | undefined): JsonObject | undefined {
  if (typeof source !== 'string') return undefined;
  const drafts = asArray(project.drafts).filter(isObject).filter(isAssembleOnlyDraft);
  if (!drafts.length) return undefined;
  const rootDir = realpathSync(dir);
  const paths = [resolve(rootDir, source)];
  try { paths.push(realpathSync(paths[0]!)); } catch { /* The draft may only exist in the record. */ }
  return drafts.find(d => {
    if (typeof d.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(d.id)) return false;
    const root = resolve(rootDir, 'derived/drafts', d.id);
    return paths.some(path => {
      const rel = relative(root, path);
      return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
    });
  });
}

/** Check explicit draft identity and the package's declared rig build source. */
export function assembleOnlyVersionFinding(dir: string, project: JsonObject, version: JsonObject, path: string): Finding | undefined {
  if (version.kind === 'draft-rig' && isAssembleOnlyDraft(version)) return draftRigRequired(path, version.id);
  const pkg = isObject(version.review_package) ? version.review_package : undefined;
  const explicitDraft = typeof version.draft_id === 'string'
    ? asArray(project.drafts).filter(isObject).find(d => isAssembleOnlyDraft(d) && d.id === version.draft_id)
    : undefined;
  const draft = explicitDraft ?? assembleOnlyDraftPath(dir, project, version.source_dir) ?? assembleOnlyDraftPath(dir, project, pkg?.from);
  return draft && draftRigRequired(path, draft.id);
}
