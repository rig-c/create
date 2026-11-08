/** Hash-list comparison for retained parts-review API responses. */
import { createHash } from 'node:crypto';

export const PARTS_VERDICT_SCHEMA = 'rig-review-parts-verdict/1';
export const PARTS_VERDICT_SCHEMA_V2 = 'rig-review-parts-verdict/2';
export const PARTS_VERDICT_KIND = 'parts-verdict';
export const PARTS_VERDICT_DRAFT_SINCE = '2026-11-08T00:00:00Z';

export type FileBinding = { path: string; sha256: string };

/** Synthetic producer fixtures use Review's canonical source-list hash. */
export function sourceSha256(files: readonly { path: string; sha256: string }[]): string {
  const sorted = [...files].sort((a, b) => Buffer.compare(Buffer.from(a.path, 'utf8'), Buffer.from(b.path, 'utf8')));
  const hash = createHash('sha256');
  for (const f of sorted) hash.update(`${f.path}\t${f.sha256}\n`, 'utf8');
  return hash.digest('hex');
}

function unmatched(side: FileBinding[], other: FileBinding[]): string[] {
  const counts = new Map<string, number>();
  for (const f of other) counts.set(f.sha256, (counts.get(f.sha256) ?? 0) + 1);
  const out: string[] = [];
  for (const f of side) {
    const n = counts.get(f.sha256) ?? 0;
    if (n > 0) counts.set(f.sha256, n - 1);
    else out.push(f.path);
  }
  return out;
}

export function comparePartsVerdictBindings(reviewed: FileBinding[], parts: FileBinding[], outputs: FileBinding[]): { verdictOnly: string[]; draftOnly: string[] } {
  return { verdictOnly: unmatched(reviewed, [...parts, ...outputs]), draftOnly: unmatched(parts, reviewed) };
}
