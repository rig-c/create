/** Atomic project.json commit helper for derived sign-offs. */
import { randomUUID } from 'node:crypto';
import { renameSync, writeFileSync } from 'node:fs';
import { readFileSync } from './check-reads.ts';
import { dirname, join } from 'node:path';
import { refuse } from './refusal.ts';
import type { JsonObject } from './templates.ts';

/** Writes only if the record is the one validated against, through an exclusive temporary file. */
export function commitIngestedSignoff(file: string, original: Buffer, project: JsonObject): void {
  if (!readFileSync(file).equals(original)) refuse('REVIEW_ACT_SOURCE_STALE', 'project.json: record changed during signoff validation; retry against the current record');
  const temporary = join(dirname(file), `.rig-create-review-act-${randomUUID()}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(project, null, 2)}\n`, { flag: 'wx' });
  renameSync(temporary, file);
}
