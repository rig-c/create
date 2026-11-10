import { closeSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { existsSync, lstatSync, readFileSync, realpathSync } from './check-reads.ts';
import { dirname, join, resolve } from 'node:path';
import { checkProject, isObject } from './check.ts';
import { parseCheckpointEvidence, parseCheckpointTable, readCheckpointEvidence } from './checkpoint-evidence.ts';
import { readProject } from './feedback.ts';
import { acquireBoundJobWrite } from './job-writer.ts';
import { baselineOf, newFindings } from './refusal-baseline.ts';
import { readVerbatim } from './record-input.ts';
import { refuse, USAGE_EXIT } from './refusal.ts';
import type { Json, JsonObject } from './templates.ts';

export const CHECKPOINT_EVIDENCE_HELP = `checkpoint-evidence [<project dir>] --file <packet-list.json> [--json]
  Attach an ordered sealed packet list as plan.checkpoint_evidence. Assets already live
  inside the project. Checkpoint IDs name their existing plan steps. Replays write nothing.
  Publication includes packets only for admitted checkpoint subjects. Review validates PNGs.
checkpoint-table [<project dir>] --file <producer.json> --rows <field> --out <relative.json>
  Present every object row and every column in order. Nested values become lossless JSON
  text cells. No measurements or classifications change. Existing output is immutable.`;

function options(args: string[], table: boolean): { root: string; opts: Record<string, string>; json: boolean } {
  const opts: Record<string, string> = {};
  const positional: string[] = [];
  let json = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--json' && !json) json = true;
    else if ((table ? ['--file', '--rows', '--out'] : ['--file']).includes(arg) && opts[arg] === undefined) {
      const value = args[++index];
      if (!value || value.startsWith('--')) usage();
      opts[arg] = value;
    } else if (arg.startsWith('-')) usage();
    else positional.push(arg);
  }
  if (positional.length > 1 || !opts['--file'] || table && (!opts['--rows'] || !opts['--out'])) usage();
  return { root: realpathSync(resolve(positional[0] ?? process.cwd())), opts, json };
}

function usage(): never {
  refuse('CHECKPOINT_EVIDENCE_USAGE', `plan.checkpoint_evidence: supply the required file options; ${CHECKPOINT_EVIDENCE_HELP}`, USAGE_EXIT);
}

function readJson(file: string): Json {
  try { return JSON.parse(readVerbatim(file)) as Json; }
  catch { return refuse('CHECKPOINT_EVIDENCE_INVALID', 'plan.checkpoint_evidence: input must be valid UTF-8 JSON; supply the producer presentation file'); }
}

export function checkpointEvidenceCommand(args: string[], now: number): { stdout: string; exit: number } {
  const { root, opts, json } = options(args, false);
  const raw = readJson(resolve(root, opts['--file']!));
  const release = acquireBoundJobWrite(root);
  const lock = join(root, '.checkpoint-evidence.lock');
  let descriptor: number;
  try { descriptor = openSync(lock, 'wx'); }
  catch { release(); refuse('CHECKPOINT_EVIDENCE_WRITE_CONFLICT', 'plan.checkpoint_evidence: another attachment writer holds the lock; wait and retry'); }
  const temporary = join(root, `.checkpoint-evidence-${crypto.randomUUID()}.tmp`);
  try {
    const { file, project } = readProject(root);
    const original = readFileSync(file);
    const packets = parseCheckpointEvidence(raw, project);
    const next = structuredClone(project);
    (next.plan as JsonObject).checkpoint_evidence = packets as unknown as Json;
    // The same checker validates every stored declaration and raw file seal.
    readCheckpointEvidence(root, next);
    const fresh = newFindings(baselineOf(checkProject(root, project, { now, readOnly: true })), checkProject(root, next, { now, readOnly: true }).refusals)[0];
    if (fresh) refuse(fresh.code, fresh.message);
    if (JSON.stringify((project.plan as JsonObject).checkpoint_evidence) !== JSON.stringify(packets)) {
      writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { flag: 'wx' });
      // Check the raw assets again after candidate validation, before committing.
      readCheckpointEvidence(root, next);
      if (!readFileSync(file).equals(original)) refuse('CHECKPOINT_EVIDENCE_WRITE_CONFLICT', 'project.json: changed during checkpoint attachment; reload and retry');
      renameSync(temporary, file);
    }
    return { stdout: json ? JSON.stringify(packets, null, 2) : `checkpoint-evidence: retained ${packets.length} packet(s)`, exit: 0 };
  } finally {
    rmSync(temporary, { force: true });
    closeSync(descriptor);
    rmSync(lock);
    release();
  }
}

/** A generic, lossless presentation conversion of a producer's existing object rows. */
export function checkpointTableCommand(args: string[]): { stdout: string; exit: number } {
  const { root, opts, json } = options(args, true);
  const source = readJson(resolve(root, opts['--file']!));
  const rows = isObject(source) ? source[opts['--rows']!] : undefined;
  if (!Array.isArray(rows) || !rows.length || rows.some(row => !isObject(row))) {
    refuse('CHECKPOINT_EVIDENCE_TABLE_INVALID', 'plan.checkpoint_evidence.table: --rows must name a nonempty ordered array of producer objects; preserve the original rows');
  }
  const columns = Object.keys(rows[0] as JsonObject);
  if (rows.some(row => Object.keys(row as JsonObject).length !== columns.length || columns.some(column => !Object.hasOwn(row as JsonObject, column)))) {
    refuse('CHECKPOINT_EVIDENCE_TABLE_INVALID', 'plan.checkpoint_evidence.table: producer rows have different columns; supply a complete rectangular producer table');
  }
  const table = { schema: 'rig-review-checkpoint-table/1', columns, rows: rows.map(row => columns.map(column => {
    const value = (row as JsonObject)[column]!;
    return typeof value === 'object' && value !== null ? JSON.stringify(value) : value;
  })) };
  const bytes = Buffer.from(`${JSON.stringify(table, null, 2)}\n`);
  parseCheckpointTable(bytes);
  const name = opts['--out']!;
  const target = join(root, name);
  let regularParent = false;
  try { regularParent = realpathSync(dirname(target)) === dirname(target); } catch { /* Named below. */ }
  if (!name || name.length > 4096 || /[\\:%?#\x00-\x1f\x7f]/.test(name) || name.split('/').some(piece => !piece || piece === '.' || piece === '..')
    || ['project.json', 'package.json', 'bun.lock'].includes(name) || !name.endsWith('.json') || !regularParent) {
    refuse('CHECKPOINT_EVIDENCE_PATH_REFUSED', 'plan.checkpoint_evidence.table: --out needs a new contained JSON file in an existing regular directory; retain the source and choose a presentation path');
  }
  try {
    if (existsSync(target)) {
      if (realpathSync(target) !== target || !lstatSync(target).isFile() || !readFileSync(target).equals(bytes)) throw Error();
    } else writeFileSync(target, bytes, { flag: 'wx' });
  } catch {
    refuse('CHECKPOINT_EVIDENCE_WRITE_CONFLICT', 'plan.checkpoint_evidence.table: output is occupied or differs; preserve it and choose a new presentation path');
  }
  return { stdout: json ? JSON.stringify({ path: name, rows: rows.length, columns: columns.length }) : `checkpoint-table: ${name} (${rows.length} rows, ${columns.length} columns)`, exit: 0 };
}
