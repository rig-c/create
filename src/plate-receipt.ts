/** Bind the producer's published receipt bytes, without repeating its measurements. */
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from './check-reads.ts';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { asArray, isObject, type Ctx } from './check.ts';
import type { Json, JsonObject } from './templates.ts';

export const PLATE_RECEIPT_SINCE = '2026-11-08T00:00:00Z';
const PLATE_SPEC = 'rig-parts-plate-receipt/1';
export const MATTE_RECEIPT_SPEC = 'rig-parts-matte-receipt/1';
const PLATE_KEYS = ['spec', 'mode', 'painting', 'mask', 'model', 'params', 'graph', 'gpu'];
const MATTE_KEYS = ['spec', 'painting', 'model', 'params', 'graph', 'gpu', 'input_transform', 'input_sha256', 'raw_output', 'output'];
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const hex = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
const lowercaseHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

const RECEIPTS = {
  [PLATE_SPEC]: {
    verify: verifyPlateReport,
    code: 'PLATE_RECEIPT_INVALID',
    remedy: 'restore the producer receipt and record its painting, mask and output with derived add --receipt',
  },
  [MATTE_RECEIPT_SPEC]: {
    verify: verifyMatteReport,
    code: 'MATTE_RECEIPT_INVALID',
    remedy: 'restore the producer receipt and its painting, raw mask and output, then record with derived add --receipt',
  },
};
type ReceiptSpec = keyof typeof RECEIPTS;
const KNOWN_SPECS = Object.keys(RECEIPTS).join(' or ');
const knownSpec = (spec: unknown): spec is ReceiptSpec => typeof spec === 'string' && Object.hasOwn(RECEIPTS, spec);

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

/** Read once by spec, and bind the original JSON bytes. Also used by the derived writer. */
export function readDerivedReceipt(dir: string, path: string) {
  const bytes = receiptBytes(dir, path);
  const value = JSON.parse(bytes.toString('utf8')) as Json;
  if (!isObject(value) || !knownSpec(value.spec)) throw Error(`receipt spec must be ${KNOWN_SPECS}`);
  return { binding: { path, sha256: hash(bytes), spec: value.spec }, report: value };
}

function verifyReceipt(dir: string, entry: JsonObject, spec: ReceiptSpec): void {
  const record = entry.receipt;
  if (!isObject(record) || typeof record.path !== 'string' || !hex(record.sha256)) {
    throw Error('receipt needs path, sha256 and spec');
  }
  if (record.spec !== spec) throw Error(`receipt needs ${spec}; accepted derived receipt specs are ${KNOWN_SPECS}`);
  const { binding, report } = readDerivedReceipt(dir, record.path);
  if (binding.spec !== record.spec) throw Error(`receipt file spec ${binding.spec} differs from the bound ${record.spec}`);
  if (binding.sha256 !== record.sha256.toLowerCase()) throw Error('receipt bytes differ from the recorded sha256');
  RECEIPTS[spec].verify(dir, entry, dirname(resolve(dir, record.path)), report);
}

function relativePath(path: Json | undefined): path is string {
  return typeof path === 'string' && path !== '' && !isAbsolute(path) && !path.includes('\\');
}

function verifyPlateReport(dir: string, entry: JsonObject, base: string, report: JsonObject): void {
  const keys = [...PLATE_KEYS, ...(report.grid_transform === undefined ? [] : ['grid_transform']), 'output'];
  if (Object.keys(report).join(',') !== keys.join(',')) throw Error('published receipt key order required');
  const fileFields = [
    ['painting', ['path', 'sha256']],
    ['mask', ['source', 'from', 'path', 'sha256']],
    ['output', ['path', 'sha256']],
  ] as const;
  for (const [field, fields] of fileFields) {
    const record = report[field];
    if (!isObject(record) || Object.keys(record).join(',') !== fields.join(',')
      || !relativePath(record.path) || !hex(record.sha256)) {
      throw Error(`${field} needs the published path and sha256 fields`);
    }
  }
  const matches = (declared: JsonObject, recorded: JsonObject): boolean =>
    typeof recorded.path === 'string' && hex(recorded.sha256)
    && resolve(base, String(declared.path)) === resolve(dir, recorded.path)
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
}

function checkReceipt(ctx: Pick<Ctx, 'dir' | 'refusals'>, entry: JsonObject, at: string, spec: ReceiptSpec): void {
  if (entry.receipt === undefined) return;
  try { verifyReceipt(ctx.dir, entry, spec); }
  catch (error) {
    const { code, remedy } = RECEIPTS[spec];
    const path = `${at}.receipt`;
    ctx.refusals.push({ code, path, message: `${path}: ${(error as Error).message}; ${remedy}` });
  }
}

export function checkDerivedReceipt(ctx: Pick<Ctx, 'dir' | 'refusals'>, entry: JsonObject, at: string): void {
  const spec = isObject(entry.receipt) ? entry.receipt.spec : undefined;
  checkReceipt(ctx, entry, at, knownSpec(spec) ? spec : PLATE_SPEC);
}

/** Scene plate callers continue to require a plate receipt. */
export function checkPlateReceipt(ctx: Pick<Ctx, 'dir' | 'refusals'>, entry: JsonObject, at: string): void {
  checkReceipt(ctx, entry, at, PLATE_SPEC);
}

export function hasMatteReceipt(entry: JsonObject): boolean {
  return isObject(entry.receipt) && entry.receipt.spec === MATTE_RECEIPT_SPEC;
}

export function verifyMatteReceipt(dir: string, entry: JsonObject): void {
  verifyReceipt(dir, entry, MATTE_RECEIPT_SPEC);
}

/** Matte leaves pixel, graph and transform derivation with Parts. */
function verifyMatteReport(dir: string, entry: JsonObject, base: string, report: JsonObject): void {
  if (Object.keys(report).join(',') !== MATTE_KEYS.join(',')
    || !isObject(report.model) || !isObject(report.params) || !isObject(report.graph)
    || typeof report.gpu !== 'string' || !report.gpu
    || (report.input_transform !== null && !isObject(report.input_transform))
    || !hex(report.input_sha256)) {
    throw Error(`complete ordered ${MATTE_RECEIPT_SPEC} fields required`);
  }
  const painting = report.painting;
  const raw = report.raw_output;
  const output = report.output;
  if (!isObject(painting) || !relativePath(painting.path) || !lowercaseHash(painting.sha256)) {
    throw Error('painting needs a receipt-relative path and lowercase sha256');
  }
  if (!matteArtifact(raw, 'model-mask.png') || !matteArtifact(output, 'mask.png')) {
    throw Error('raw_output and output need fixed paths model-mask.png and mask.png, lowercase sha256 and positive integer dimensions');
  }
  const paintingPath = resolve(base, painting.path);
  const outputPath = resolve(base, output.path);
  const rawPath = resolve(base, raw.path);
  const sources = entry.sources === undefined ? [entry.source] : asArray(entry.sources);
  const source = sources[0];
  if (entry.kind !== 'prepared-input' || sources.length !== 1 || !isObject(source)
    || !matchesMatteFile(dir, source, paintingPath, painting.sha256)
    || !matchesMatteFile(dir, entry, outputPath, output.sha256)
    || paintingPath === outputPath || paintingPath === rawPath) {
    throw Error('prepared-input needs the receipt painting as its only source and the receipt output as its distinct result, with matching paths and hashes');
  }
  for (const [field, file, sha256] of [
    ['painting', paintingPath, painting.sha256],
    ['raw_output', rawPath, raw.sha256],
    ['output', outputPath, output.sha256],
  ]) {
    const path = relative(dir, file);
    let actual: string;
    try { actual = hash(receiptBytes(dir, path)); }
    catch (error) { throw Error(`${field} '${path}': ${(error as Error).message}`); }
    if (actual !== sha256) throw Error(`${field} '${path}' bytes differ from the receipt sha256`);
  }
}

function matteArtifact(value: Json | undefined, path: string): value is { path: string; sha256: string } {
  return isObject(value) && value.path === path && lowercaseHash(value.sha256)
    && [value.width, value.height].every(n => typeof n === 'number' && Number.isSafeInteger(n) && n > 0);
}

function matchesMatteFile(dir: string, recorded: JsonObject, path: string, sha256: string): boolean {
  return relativePath(recorded.path) && resolve(dir, recorded.path) === path
    && hex(recorded.sha256) && recorded.sha256.toLowerCase() === sha256;
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
    if (entry.receipt !== undefined) {
      if (hasMatteReceipt(entry)) checkPlateReceipt(ctx, entry, `derived[${index}]`);
      continue;
    }
    const path = `derived[${index}].receipt`;
    const findings = first < Date.parse(PLATE_RECEIPT_SINCE) ? ctx.warnings : ctx.refusals;
    findings.push({ code: 'PLATE_RECEIPT_MISSING', path, message: `${path}: scene-registered derived plate has no producer receipt; record the plate with derived add --receipt` });
  }
}
