import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sha256 } from '../src/current.ts';
import { FIX_LEDGER_REPORT_SPEC } from '../src/fix-ledger.ts';

/** Write the synthetic producer's report for the SHA-256 of this build's manifest. */
export function syntheticLedgerReport(dir: string, manifestSha256: string, results: Record<string, string>, name = manifestSha256): string {
  const path = `evidence/fix-ledger/${name}.json`;
  const file = join(dir, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({
    schema: FIX_LEDGER_REPORT_SPEC, build: { manifest_sha256: manifestSha256 }, script_sha256: sha256('synthetic check'),
    rows: Object.entries(results).map(([id, result]) => ({ id, result })),
  })}\n`);
  return path;
}
