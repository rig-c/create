import { randomUUID } from 'node:crypto';
import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readFileSync } from './check-reads.ts';

import { refuse, USAGE_EXIT } from './refusal.ts';
import type { JsonObject } from './templates.ts';

/** Replace project.json in one rename, refusing if its original bytes changed. */
export function writeRecord(file: string, original: Buffer, project: JsonObject, writer: string, conflictCode: string): void {
  const tmp = join(dirname(file), `.${writer}-${process.pid}-${randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, `${JSON.stringify(project, null, 2)}\n`, { flag: 'wx' });
    if (!readFileSync(file).equals(original)) refuse(conflictCode, `project.json: changed while ${writer} was validating; retry against the current record`);
    renameSync(tmp, file);
  } finally { rmSync(tmp, { force: true }); }
}

/** Decode valid UTF-8 without removing a BOM, spaces, CRLFs or the final newline. */
export function readVerbatim(file: string): string {
  let bytes: Buffer;
  try {
    bytes = readFileSync(file === '-' ? 0 : file);
  } catch (error) {
    refuse('VERBATIM_UNREADABLE', `${file}: ${error instanceof Error ? error.message : String(error)}; --verbatim-file paths resolve against the current working directory, not the project folder; supply an absolute path or run from the folder containing the file`);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    refuse('VERBATIM_INVALID_UTF8', 'verbatim input must be valid UTF-8 to round-trip through project.json', USAGE_EXIT);
  }
}
