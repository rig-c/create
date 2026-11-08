/** Bind the producer's published receipt bytes, without repeating its measurements. */
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from './check-reads.ts';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { asArray, isObject, type Ctx } from './check.ts';
import type { Json, JsonObject } from './templates.ts';

export const PLATE_RECEIPT_SINCE = '2026-11-08T00:00:00Z';
const SPEC = 'rig-parts-plate-receipt/1';
const KEYS = ['spec', 'mode', 'painting', 'mask', 'model', 'params', 'graph', 'gpu'];
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const hex = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);

/** Reject symlinks at every component, including directory aliases within the project. */
function receiptBytes(dir: string, path: unknown): Buffer {
  if (typeof path !== 'string' || !path || isAbsolute(path) || path.includes('\\')) throw Error('project-relative receipt path required');
  const rel = relative(dir, resolve(dir, path));
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || rel === 'project.json') throw Error('receipt must stay inside the project');
  let current = dir;
  for (const part of path.split('/').filter(part => part && part !== '.')) {
    current = resolve(current, part);
    const component = relative(dir, current);
    if (component === '..' || component.startsWith(`..${sep}`)) throw Error('receipt must stay inside the project');
    if (lstatSync(current).isSymbolicLink()) throw Error('receipt must have no symlink components');
  }
  return readFileSync(current);
}

/** Also used before the derived writer commits its new entry. */
export function readPlateReceipt(dir: string, path: string): { binding: JsonObject; report: JsonObject } {
  const bytes = receiptBytes(dir, path);
  const value = JSON.parse(bytes.toString('utf8')) as Json;
  if (!isObject(value) || value.spec !== SPEC) throw Error('known rig-parts-plate-receipt/1 spec required');
  const keys = [...KEYS, ...(value.grid_transform === undefined ? [] : ['grid_transform']), 'output'];
  if (Object.keys(value).join(',') !== keys.join(',')) throw Error('published receipt key order required');
  const fileFields = [
    ['painting', ['path', 'sha256']],
    ['mask', ['source', 'from', 'path', 'sha256']],
    ['output', ['path', 'sha256']],
  ] as const;
  for (const [field, fields] of fileFields) {
    const record = value[field];
    if (!isObject(record) || Object.keys(record).join(',') !== fields.join(',')
      || typeof record.path !== 'string' || !record.path || isAbsolute(record.path)
      || record.path.includes('\\') || !hex(record.sha256)) {
      throw Error(`${field} needs the published path and sha256 fields`);
    }
  }
  return { binding: { path, sha256: hash(bytes), spec: SPEC }, report: value };
}

export function checkPlateReceipt(ctx: Pick<Ctx, 'dir' | 'refusals'>, entry: JsonObject, at: string): void {
  if (entry.receipt === undefined) return;
  try {
    if (!isObject(entry.receipt) || typeof entry.receipt.path !== 'string'
      || !hex(entry.receipt.sha256) || entry.receipt.spec !== SPEC) {
      throw Error('receipt needs path, sha256 and a known spec');
    }
    const { binding, report } = readPlateReceipt(ctx.dir, entry.receipt.path);
    if (binding.sha256 !== entry.receipt.sha256.toLowerCase()) throw Error('receipt bytes differ from the recorded sha256');
    const base = dirname(resolve(ctx.dir, entry.receipt.path));
    const matches = (declared: JsonObject, recorded: JsonObject): boolean =>
      typeof recorded.path === 'string' && hex(recorded.sha256)
      && resolve(base, String(declared.path)) === resolve(ctx.dir, recorded.path)
      && String(declared.sha256).toLowerCase() === recorded.sha256.toLowerCase();
    const sources = entry.sources === undefined ? [entry.source] : asArray(entry.sources);
    const painting = report.painting as JsonObject;
    const mask = report.mask as JsonObject;
    if (sources.length !== 2 || !sources.every(isObject)
      || !(matches(painting, sources[0] as JsonObject) && matches(mask, sources[1] as JsonObject)
        || matches(painting, sources[1] as JsonObject) && matches(mask, sources[0] as JsonObject))
      || !matches(report.output as JsonObject, entry)) {
      throw Error('painting, uploaded mask and output must match the recorded source and result paths and hashes');
    }
  } catch (error) {
    ctx.refusals.push({ code: 'PLATE_RECEIPT_INVALID', path: `${at}.receipt`, message: `${at}.receipt: ${(error as Error).message}; restore the producer receipt and record its painting, mask and output with derived add --receipt` });
  }
}

/** Scene plate registrations are the recorded discriminator. Earliest registration dates the rule. */
export function checkPlateRegistrations(ctx: Pick<Ctx, 'dir' | 'project' | 'refusals' | 'warnings'>): void {
  const earliest = new Map<number, number>();
  for (const scene of asArray(ctx.project.scenes)) {
    if (!isObject(scene) || typeof scene.path !== 'string' || !hex(scene.sha256) || typeof scene.at !== 'string' || !Number.isFinite(Date.parse(scene.at))) continue;
    let doc: JsonObject;
    try {
      const bytes = receiptBytes(ctx.dir, scene.path);
      if (hash(bytes) !== scene.sha256.toLowerCase()) continue;
      const value = JSON.parse(bytes.toString('utf8')) as Json;
      if (!isObject(value)) continue;
      doc = value;
    } catch { continue; } // The scene checker reports missing or changed scene documents.
    for (const plate of asArray(doc.plates)) {
      if (!isObject(plate) || !isObject(plate.registered) || plate.registered.kind !== 'derived' || typeof plate.registered.ref !== 'string') continue;
      const match = /^derived\[(\d+)\]$/.exec(plate.registered.ref);
      if (!match) continue;
      const index = Number(match[1]);
      const entry = asArray(ctx.project.derived)[index];
      if (!isObject(entry) || plate.path !== entry.path || plate.sha256 !== entry.sha256) continue;
      earliest.set(index, Math.min(earliest.get(index) ?? Infinity, Date.parse(scene.at)));
    }
  }
  for (const [index, first] of earliest) {
    const entry = asArray(ctx.project.derived)[index] as JsonObject;
    if (entry.receipt !== undefined) continue;
    const path = `derived[${index}].receipt`;
    const findings = first < Date.parse(PLATE_RECEIPT_SINCE) ? ctx.warnings : ctx.refusals;
    findings.push({ code: 'PLATE_RECEIPT_MISSING', path, message: `${path}: scene-registered derived plate has no producer receipt; record the plate with derived add --receipt` });
  }
}
