/** A retained review Apply and the create version made from it (create#65). */
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep, posix } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import type { Json } from './templates.ts';
import { asArray, isObject, type Ctx } from './check.ts';
import { reviewHandoffInputs } from './review-package.ts';

export const APPLIED_REVIEW_SINCE = '2026-11-06T00:00:00Z';
const hash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const hex = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const inside = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

/** Missing old declarations warn, while an explicit null records a build made without feedback. */
export function checkAppliedReview(ctx: Pick<Ctx, 'dir' | 'project' | 'refusals' | 'warnings'>): void {
  const versions = asArray(ctx.project.versions).filter(isObject);
  for (const version of versions) {
    if (version.pre_interview === true || !Number.isSafeInteger(version.n)) continue;
    const path = `versions[v${String(version.n)}].review_origin`;
    const push = (code: string, message: string): void => { ctx.refusals.push({ code, path, message: `${path}: ${message}` }); };
    const record = version.review_origin;
    if (record === undefined) {
      const at = typeof version.at === 'string' ? Date.parse(version.at) : Number.NaN;
      const legacy = !Number.isFinite(at) || at < Date.parse(APPLIED_REVIEW_SINCE);
      const finding = { code: legacy ? 'APPLIED_REVIEW_LEGACY' : 'APPLIED_REVIEW_MISSING', path, message: `${path}: declare null for a build made without feedback, or { feedback: {path, sha256}, source_version, feedback_id, applied }; records before ${APPLIED_REVIEW_SINCE} retain their old contract` };
      (legacy ? ctx.warnings : ctx.refusals).push(finding);
      continue;
    }
    if (record === null) continue;
    if (!isObject(record) || !isObject(record.feedback) || typeof record.feedback.path !== 'string'
      || isAbsolute(record.feedback.path) || !inside(resolve(ctx.dir), resolve(ctx.dir, record.feedback.path))
      || !hex(record.feedback.sha256) || !Number.isSafeInteger(record.source_version)
      || typeof record.feedback_id !== 'string' || !record.feedback_id.trim() || !isObject(record.applied)
      || typeof record.applied.schema !== 'string' || !record.applied.schema.startsWith('rig-review-applied/')
      || !hex(record.applied.configHash) || !hex(record.applied.modelHash)) {
      push('APPLIED_REVIEW_MALFORMED', 'expected feedback {project-relative path, sha256}, source_version, feedback_id and the complete context.applied object');
      continue;
    }
    const earlier = versions.filter((v) => v.kind === version.kind && typeof v.n === 'number' && v.n < (version.n as number));
    const source = earlier.reduce<(typeof versions)[number] | undefined>((latest, v) => latest === undefined || (v.n as number) > (latest.n as number) ? v : latest, undefined);
    if (source === undefined || source.n !== record.source_version || versions.filter((v) => v.n === record.source_version).length !== 1) {
      push('APPLIED_REVIEW_SOURCE', 'source_version must name the immediately preceding version of the same kind, without skipping a link');
      continue;
    }
    let feedback: Json;
    try {
      const file = resolve(ctx.dir, record.feedback.path);
      if (!inside(realpathSync(ctx.dir), realpathSync(file))) throw new Error('feedback resolves outside the project');
      const bytes = readFileSync(file);
      if (hash(bytes) !== record.feedback.sha256) {
        push('APPLIED_REVIEW_HASH', 'feedback bytes differ from their recorded sha256');
        continue;
      }
      feedback = JSON.parse(bytes.toString('utf8'));
    } catch (error) {
      push('APPLIED_REVIEW_FILE', error instanceof Error ? error.message : String(error));
      continue;
    }
    if (!isObject(feedback) || feedback.schema !== 'rig-review-session/1' || !isObject(feedback.reviewedSource)
      || !Array.isArray(feedback.feedback)) {
      push('APPLIED_REVIEW_FILE', 'expected the single-build JSON written by rig-review feedback');
      continue;
    }
    const pkg = source.review_package;
    const reviewed = feedback.reviewedSource;
    const handoff = isObject(reviewed.handoff) ? reviewed.handoff : null;
    const files = isObject(pkg) ? asArray(pkg.files) : [];
    const fileHash = (name: string): Json | undefined => files.find((f) => isObject(f) && f.path === name);
    const model = fileHash('out/check/build/skeleton.model.json');
    const inputs = isObject(pkg) ? reviewHandoffInputs(pkg) : [];
    const handoffFiles = isObject(handoff) ? asArray(handoff.files) : [];
    const boundInputs = inputs.every((input) => isObject(input) && handoffFiles.some((f) => isObject(f)
      && typeof f.path === 'string' && posix.normalize(`out/check/${f.path}`) === input.path && f.sha256 === input.sha256));
    if (!isObject(pkg) || !isObject(pkg.config) || !isObject(handoff?.config)
      || handoff.config.sha256 !== pkg.config.sha256 || record.applied.configHash !== pkg.config.sha256
      || !isObject(model) || !isObject(reviewed.rig) || reviewed.rig.path !== 'build/skeleton.model.json'
      || reviewed.rig.sha256 !== model.sha256 || reviewed.motion !== null || !boundInputs
      || handoffFiles.length !== inputs.length || asArray(handoff.missing).length !== 0) {
      push('APPLIED_REVIEW_SOURCE', 'feedback handoff inputs and inspected compiled model must match the source version package');
      continue;
    }
    const items = feedback.feedback.filter((item) => isObject(item) && item.id === record.feedback_id);
    const item = items[0];
    if (items.length !== 1 || !isObject(item) || !isObject(item.context) || !isObject(item.context.applied)
      || !isDeepStrictEqual(record.applied, item.context.applied)) {
      push('APPLIED_REVIEW_RESULT', 'feedback_id must select exactly one feedback item with the same non-null context.applied');
    }
  }
}
