/** Bind the producer's published receipt bytes, without repeating its measurements. */
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from './check-reads.ts';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { asArray, isObject, type Ctx } from './check.ts';
import type { Json, JsonObject } from './templates.ts';

export const PLATE_RECEIPT_SINCE = '2026-11-08T00:00:00Z';
const PLATE_SPEC = 'rig-parts-plate-receipt/1';
export const MATTE_RECEIPT_SPEC = 'rig-parts-matte-receipt/1';
export const EXTERNAL_RECEIPT_SPEC = 'rig-parts-external-receipt/1';
export const MASK_RECEIPT_SPECS = `${MATTE_RECEIPT_SPEC} or ${EXTERNAL_RECEIPT_SPEC}`;
type MaskReceiptSpec = typeof MATTE_RECEIPT_SPEC | typeof EXTERNAL_RECEIPT_SPEC;
const PLATE_KEYS = ['spec', 'mode', 'painting', 'mask', 'model', 'params', 'graph', 'gpu'];
const MATTE_KEYS = ['spec', 'painting', 'model', 'params', 'graph', 'gpu', 'input_transform', 'input_sha256', 'raw_output', 'output'];
type ReceiptFile = { path: string; sha256: string };
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
  [EXTERNAL_RECEIPT_SPEC]: {
    verify: verifyExternalReport,
    code: 'EXTERNAL_RECEIPT_INVALID',
    remedy: 'restore the producer receipt, painting and mask, then record with derived add --receipt',
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

export function maskReceiptSpec(receipt: Json | undefined): MaskReceiptSpec | undefined {
  const spec = isObject(receipt) ? receipt.spec : undefined;
  return spec === MATTE_RECEIPT_SPEC || spec === EXTERNAL_RECEIPT_SPEC ? spec : undefined;
}

export function verifyMaskReceipt(dir: string, entry: JsonObject, spec: MaskReceiptSpec): void {
  verifyReceipt(dir, entry, spec);
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
  const paintingFile = { path: resolve(base, painting.path), sha256: painting.sha256 };
  const outputFile = { path: resolve(base, output.path), sha256: output.sha256 };
  const rawPath = resolve(base, raw.path);
  if (!matchesPreparedReceipt(dir, entry, paintingFile, outputFile) || paintingFile.path === rawPath) {
    throw Error('prepared-input needs the receipt painting as its only source and the receipt output as its distinct result, with matching paths and hashes');
  }
  verifyReceiptFiles(dir, [
    ['painting', paintingFile.path, paintingFile.sha256],
    ['raw_output', rawPath, raw.sha256],
    ['output', outputFile.path, outputFile.sha256],
  ]);
}

function verifyReceiptFiles(dir: string, files: [field: string, file: string, sha256: string][]): void {
  for (const [field, file, sha256] of files) {
    const path = relative(dir, file);
    let actual: string;
    try { actual = hash(receiptBytes(dir, path)); }
    catch (error) { throw Error(`${field} '${path}': ${(error as Error).message}`); }
    if (actual !== sha256) throw Error(`${field} '${path}' bytes differ from the receipt sha256`);
  }
}

function matteArtifact(value: Json | undefined, path: string): value is ReceiptFile {
  return isObject(value) && value.path === path && lowercaseHash(value.sha256)
    && positiveGrid(value);
}

function matchesReceiptFile(dir: string, recorded: JsonObject, file: ReceiptFile): boolean {
  return relativePath(recorded.path) && resolve(dir, recorded.path) === file.path
    && hex(recorded.sha256) && recorded.sha256.toLowerCase() === file.sha256;
}

function matchesPreparedReceipt(dir: string, entry: JsonObject, painting: ReceiptFile, result: ReceiptFile): boolean {
  const sources = entry.sources === undefined ? [entry.source] : asArray(entry.sources);
  const source = sources[0];
  return entry.kind === 'prepared-input' && sources.length === 1 && isObject(source)
    && matchesReceiptFile(dir, source, painting) && matchesReceiptFile(dir, entry, result)
    && painting.path !== result.path;
}

function positiveGrid(value: JsonObject): boolean {
  return [value.width, value.height].every(n => typeof n === 'number' && Number.isSafeInteger(n) && n > 0);
}

function hasKeys(value: Json | undefined, keys: string[]): value is JsonObject {
  return isObject(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function nonblank(value: Json | undefined): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function externalFile(value: Json | undefined): value is ReceiptFile {
  return hasKeys(value, ['path', 'sha256']) && relativePath(value.path) && nonblank(value.path)
    && !/^[A-Za-z]:/.test(value.path) && !value.path.includes('\0') && lowercaseHash(value.sha256);
}

/** External receipts bind the producer's measured grid without decoding either PNG. */
function verifyExternalReport(dir: string, entry: JsonObject, base: string, report: JsonObject): void {
  if (report.kind !== 'mask') {
    throw Error(`${EXTERNAL_RECEIPT_SPEC} requires kind "mask"; accepted derived receipt specs are ${KNOWN_SPECS}`);
  }
  const { file, painting, grid, producer } = report;
  if (!hasKeys(report, ['spec', 'kind', 'file', 'painting', 'grid', 'producer'])
    || !externalFile(file) || !externalFile(painting) || !hasKeys(grid, ['width', 'height']) || !positiveGrid(grid)) {
    throw Error(`${EXTERNAL_RECEIPT_SPEC} requires receipt-relative file and painting paths with lowercase sha256 and a positive integer grid`);
  }
  if (!isObject(producer) || !nonblank(producer.tool)
    || (Object.hasOwn(producer, 'model') && !nonblank(producer.model))) {
    throw Error('producer requires a nonblank tool and an optional nonblank model');
  }
  const digests = ['checkpoint_sha256', 'graph_sha256', 'script_sha256'].filter(key => Object.hasOwn(producer, key));
  if (digests.length !== 1 || !lowercaseHash(producer[digests[0]!])
    || !Object.keys(producer).every(key => key === 'tool' || key === 'model' || key === digests[0])) {
    throw Error('producer requires exactly one lowercase SHA-256 in checkpoint_sha256, graph_sha256 or script_sha256 and no other fields');
  }
  const paintingFile = { path: resolve(base, painting.path), sha256: painting.sha256 };
  const maskFile = { path: resolve(base, file.path), sha256: file.sha256 };
  if (!matchesPreparedReceipt(dir, entry, paintingFile, maskFile)) {
    throw Error('prepared-input needs the receipt painting as its only source and the receipt mask as its distinct result, with matching paths and hashes');
  }
  verifyReceiptFiles(dir, [['painting', paintingFile.path, paintingFile.sha256], ['file', maskFile.path, maskFile.sha256]]);
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
      if (maskReceiptSpec(entry.receipt)) checkPlateReceipt(ctx, entry, `derived[${index}]`);
      continue;
    }
    const path = `derived[${index}].receipt`;
    const findings = first < Date.parse(PLATE_RECEIPT_SINCE) ? ctx.warnings : ctx.refusals;
    findings.push({ code: 'PLATE_RECEIPT_MISSING', path, message: `${path}: scene-registered derived plate has no producer receipt; record the plate with derived add --receipt` });
  }
}
