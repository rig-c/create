import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ConsumerCase { file: string; name: string; displayName: string; reason: string }
export const consumerCases = JSON.parse(readFileSync(join(import.meta.dir, 'consumer-ci-tests.json'), 'utf8')) as ConsumerCase[];
export function guardConsumerCoverage(
  entries: readonly ConsumerCase[], registered: readonly { file: string; name: string }[],
  passed: ReadonlySet<string>, skipped: ReadonlySet<string>, mode: 'registry' | 'source',
): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!entry.file || !entry.name || !entry.displayName || !entry.reason || seen.has(entry.displayName)) {
      throw new Error('CONSUMER_CI_COVERAGE: scripts/consumer-ci-tests.json: use unique exact cases with reasons');
    }
    seen.add(entry.displayName);
    if (!registered.some(r => r.file === entry.file && r.name === entry.name)) {
      throw new Error(`CONSUMER_CI_COVERAGE: scripts/consumer-ci-tests.json: listed case does not exist: ${entry.displayName}; restore its consumerOnlyTest registration or remove the exclusion`);
    }
    if (mode === 'registry' && (!passed.has(entry.displayName) || skipped.has(entry.displayName))) {
      throw new Error(`CONSUMER_CI_COVERAGE: registry check did not execute and pass: ${entry.displayName}; run the full registry suite without source conditions`);
    }
    if (mode === 'source' && (!skipped.has(entry.displayName) || passed.has(entry.displayName))) {
      throw new Error(`CONSUMER_CI_COVERAGE: source case must SKIP, never pass: ${entry.displayName}; use consumerOnlyTest`);
    }
  }
  if (mode === 'source') for (const name of skipped) {
    if (!seen.has(name)) throw new Error(`CONSUMER_CI_COVERAGE: unexpected source skip: ${name}; execute the test`);
  }
}
export function skippedTestNames(output: string): Set<string> {
  const clean = output.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '');
  return new Set(clean.split(/\r?\n/).flatMap(line => {
    const match = /^\(skip\) (.+)$/.exec(line); return match ? [match[1]!] : [];
  }));
}
