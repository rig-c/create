/** Sealed producer presentation. Create binds bytes and never derives measurements. */
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, statSync } from './check-reads.ts';
import { join } from 'node:path';
import { asArray, isObject, type Finding } from './check.ts';
import { Refusal, refuse } from './refusal.ts';
import type { JsonObject } from './templates.ts';

type Seal = { readonly path: string; readonly sha256: string };
export type CheckpointEvidence = {
  readonly schema: 'rig-review-checkpoint-evidence/1';
  readonly checkpointId: string;
  readonly planStepId: string;
  readonly tiles: readonly (Seal & { readonly id: string; readonly label: string })[];
  readonly table: Seal & { readonly label?: string };
  readonly routesText: string;
  readonly recommendationText: string;
};
export type CheckpointTable = {
  schema: 'rig-review-checkpoint-table/1';
  columns: string[];
  rows: (string | number | boolean | null)[][];
};
const RECORD_PATH = 'plan.checkpoint_evidence';
const hash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0
  && value.length <= max && !/[\x00-\x08\x0b-\x1f\x7f]/.test(value);
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);

function invalid(detail: string): never {
  refuse('CHECKPOINT_EVIDENCE_INVALID', `${RECORD_PATH}: ${detail}; supply the sealed checkpoint packet through checkpoint-evidence --file`);
}

function exact(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!object(value) || required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) invalid('unexpected or missing declaration fields');
  return value;
}

function seal(value: Record<string, unknown>): Seal {
  if (typeof value.path !== 'string' || value.path.length > 4096 || !value.path
    || /[\\:%?#\x00-\x1f\x7f]/.test(value.path) || value.path.split('/').some(piece => !piece || piece === '.' || piece === '..')
    || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) invalid('a file needs its literal portable project-relative path and lowercase SHA-256');
  return { path: value.path, sha256: value.sha256 };
}

/** Fixed key order, exact strings and list order. Absence is handled by the caller. */
export function parseCheckpointEvidence(raw: unknown, project: JsonObject): CheckpointEvidence[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 8) invalid('expected 1–8 ordered packets');
  const steps = asArray(isObject(project.plan) ? project.plan.steps : undefined).filter(isObject);
  const seen = new Set<string>();
  const packets = raw.map((value): CheckpointEvidence => {
    const packet = exact(value, ['schema', 'checkpointId', 'planStepId', 'tiles', 'table', 'routesText', 'recommendationText']);
    if (packet.schema !== 'rig-review-checkpoint-evidence/1' || !id(packet.checkpointId) || !id(packet.planStepId)
      || seen.has(packet.checkpointId) || packet.checkpointId !== packet.planStepId
      || steps.filter(step => step.id === packet.planStepId).length !== 1) invalid('checkpointId must name its unique existing plan step without an alias');
    seen.add(packet.checkpointId);
    if (!Array.isArray(packet.tiles) || packet.tiles.length < 1 || packet.tiles.length > 8) invalid('expected 1–8 ordered tiles');
    const tileIds = new Set<string>();
    const tiles = packet.tiles.map(value => {
      const tile = exact(value, ['id', 'label', 'path', 'sha256']);
      if (!id(tile.id) || tileIds.has(tile.id) || !text(tile.label, 512)) invalid('tile IDs must be unique and labels must be bounded nonempty text');
      tileIds.add(tile.id);
      return { id: tile.id, label: tile.label, ...seal(tile) };
    });
    const table = exact(packet.table, ['path', 'sha256'], ['label']);
    if ('label' in table && !text(table.label, 512)) invalid('table label must be bounded nonempty text');
    if (!text(packet.routesText, 4096) || !text(packet.recommendationText, 4096)) invalid('routes and recommendation must be bounded nonempty text');
    return { schema: 'rig-review-checkpoint-evidence/1', checkpointId: packet.checkpointId, planStepId: packet.planStepId,
      tiles, table: { ...seal(table), ...('label' in table ? { label: table.label as string } : {}) },
      routesText: packet.routesText, recommendationText: packet.recommendationText };
  });
  if (Buffer.byteLength(JSON.stringify(packets)) > 32 * 1024) invalid('canonical declaration exceeds 32 KiB');
  return packets;
}

/** Validate presentation grammar only. All supplied scalar values and ordering survive. */
export function parseCheckpointTable(bytes: Buffer): CheckpointTable {
  const bad = (): never => refuse('CHECKPOINT_EVIDENCE_TABLE_INVALID', `${RECORD_PATH}.table: expected a bounded rig-review-checkpoint-table/1 document with ordered scalar cells; retain all producer rows and columns through checkpoint-table`);
  try {
    if (bytes.length > 256 * 1024) return bad();
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!object(value) || Object.keys(value).length !== 3 || value.schema !== 'rig-review-checkpoint-table/1'
      || !Array.isArray(value.columns) || value.columns.length < 1 || value.columns.length > 32
      || value.columns.some(column => !text(column, 512)) || !Array.isArray(value.rows) || value.rows.length > 2048
      || value.rows.length * value.columns.length > 16384) return bad();
    const width = value.columns.length;
    for (const row of value.rows) {
      if (!Array.isArray(row) || row.length !== width || row.some(cell => typeof cell === 'string'
        ? cell.length > 2048 || /[\x00-\x08\x0b-\x1f\x7f]/.test(cell)
        : cell !== null && typeof cell !== 'boolean' && !(typeof cell === 'number' && Number.isFinite(cell)))) return bad();
    }
    return value as CheckpointTable;
  } catch (error) {
    if (error instanceof Refusal) throw error;
    return bad();
  }
}

/** Contained regular files, bounded before read. Review owns full PNG decoding at admission. */
export function checkpointFile(root: string, file: Seal, limit: number): Buffer {
  const path = `${RECORD_PATH}[${file.path}]`;
  let bytes: Buffer;
  try {
    const canonicalRoot = realpathSync(root);
    const target = join(canonicalRoot, file.path);
    if (realpathSync(target) !== target || !lstatSync(target).isFile() || statSync(target).size > limit) throw Error();
    bytes = readFileSync(target);
    if (bytes.length > limit) throw Error();
  } catch {
    refuse('CHECKPOINT_EVIDENCE_PATH_REFUSED', `${path}: file must be a bounded regular project file without symlinks; restore its sealed bytes`);
  }
  if (hash(bytes) !== file.sha256) refuse('CHECKPOINT_EVIDENCE_HASH_MISMATCH', `${path}: raw bytes differ from the declared SHA-256; restore the sealed file or attach a newly sealed packet`);
  return bytes;
}

export function readCheckpointEvidence(root: string, project: JsonObject): CheckpointEvidence[] | undefined {
  if (!isObject(project.plan) || !Object.hasOwn(project.plan, 'checkpoint_evidence')) return undefined;
  const packets = parseCheckpointEvidence(project.plan.checkpoint_evidence, project);
  let tableBytes = 0;
  for (const packet of packets) {
    for (const tile of packet.tiles) checkpointFile(root, tile, 8 * 1024 * 1024);
    const bytes = checkpointFile(root, packet.table, 256 * 1024);
    tableBytes += bytes.length;
    if (tableBytes > 512 * 1024) invalid('raw tables exceed the 512 KiB publication bound');
    parseCheckpointTable(bytes);
  }
  return packets;
}

export function checkCheckpointEvidence(root: string, project: JsonObject, refusals: Finding[]): void {
  try { readCheckpointEvidence(root, project); }
  catch (error) {
    if (!(error instanceof Refusal)) throw error;
    refusals.push({ code: error.code, path: RECORD_PATH, message: error.message });
  }
}

/** Publish only declared subjects, with their exact asset closure. No fallback association. */
export function checkpointEvidenceContext(root: string, project: JsonObject,
  subjects: readonly { readonly kind: string; readonly checkpointId?: string; readonly planStepId?: string }[], files: Seal[]): { checkpointEvidence?: readonly CheckpointEvidence[] } {
  const packets = readCheckpointEvidence(root, project)?.filter(packet => subjects.some(subject => subject.kind === 'checkpoint'
    && subject.checkpointId === packet.checkpointId && (subject.planStepId ?? subject.checkpointId) === packet.planStepId));
  if (!packets?.length) return {};
  for (const packet of packets) {
    for (const { path, sha256 } of [...packet.tiles, packet.table]) {
      if (files.some(file => file.path === path && file.sha256 !== sha256)) invalid('closure contains conflicting file seals');
      if (!files.some(file => file.path === path)) files.push({ path, sha256 });
    }
  }
  return { checkpointEvidence: packets };
}
