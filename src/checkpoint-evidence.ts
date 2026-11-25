/** Sealed producer presentation. Create binds bytes and never derives measurements. */
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, statSync } from './check-reads.ts';
import { join } from 'node:path';
import { parseCheckpointEvidencePacket, type JobCheckpointEvidence } from '@rig-c/review/job-host';
import { asArray, isObject, type Finding } from './check.ts';
import { Refusal, refuse } from './refusal.ts';
import type { JsonObject } from './templates.ts';

type Seal = { readonly path: string; readonly sha256: string };
export type CheckpointEvidence = JobCheckpointEvidence;
export type CheckpointTable = {
  schema: 'rig-review-checkpoint-table/1';
  columns: string[];
  rows: (string | number | boolean | null)[][];
};
const RECORD_PATH = 'plan.checkpoint_evidence';
const PACKET_REMEDY = 'supply the sealed checkpoint packet through checkpoint-evidence --file';
const hash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const tableColumn = (value: unknown): value is string => typeof value === 'string' && value.length > 0
  && value.length <= 512 && !/[\x00-\x08\x0b-\x1f\x7f]/.test(value);

function invalid(detail: string): never {
  refuse('CHECKPOINT_EVIDENCE_INVALID', `${RECORD_PATH}: ${detail}; ${PACKET_REMEDY}`);
}

class CheckpointPacketRefusal extends Refusal {
  constructor(code: string, readonly path: string, reason: string) {
    super(code, `${path}: ${PACKET_REMEDY}; ${reason}`);
  }
}

/** Review canonicalizes each packet. Create binds the ordered list to this plan. */
export function parseCheckpointEvidence(raw: unknown, project: JsonObject): CheckpointEvidence[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 8) invalid('expected 1–8 ordered packets');
  const steps = asArray(isObject(project.plan) ? project.plan.steps : undefined).filter(isObject);
  const seen = new Set<string>();
  const packets = raw.map((value, packetIndex) => {
    const result = parseCheckpointEvidencePacket(value);
    if (!result.ok) {
      const path = `${RECORD_PATH}[${packetIndex}].${result.member}`;
      if (result.member === 'pair') {
        throw new CheckpointPacketRefusal('CHECKPOINT_EVIDENCE_PAIR_INVALID',
          result.side === undefined ? path : `${path}.${result.side}`, result.reason);
      }
      throw new CheckpointPacketRefusal('CHECKPOINT_EVIDENCE_INVALID',
        result.index === undefined ? path : `${path}[${result.index}]`, result.reason);
    }
    const { packet } = result;
    if (seen.has(packet.checkpointId) || packet.checkpointId !== packet.planStepId
      || steps.filter(step => step.id === packet.planStepId).length !== 1) invalid('checkpointId must name its unique existing plan step without an alias');
    seen.add(packet.checkpointId);
    return packet;
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
      || value.columns.some(column => !tableColumn(column)) || !Array.isArray(value.rows) || value.rows.length > 2048
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
    refusals.push({ code: error.code, path: error instanceof CheckpointPacketRefusal ? error.path : RECORD_PATH, message: error.message });
  }
}

/** Publish sealed checkpoint packets with their exact asset closure. No fallback association. */
export function checkpointEvidenceContext(root: string, project: JsonObject,
  files: Seal[]): { checkpointEvidence?: readonly CheckpointEvidence[] } {
  const packets = readCheckpointEvidence(root, project);
  if (!packets?.length) return {};
  for (const packet of packets) {
    for (const { path, sha256 } of [...packet.tiles, packet.table]) {
      if (files.some(file => file.path === path && file.sha256 !== sha256)) invalid('closure contains conflicting file seals');
      if (!files.some(file => file.path === path)) files.push({ path, sha256 });
    }
  }
  return { checkpointEvidence: packets };
}
