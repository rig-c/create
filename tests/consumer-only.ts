import { test } from 'bun:test';
import { appendFileSync } from 'node:fs';
import { consumerCases } from '../scripts/consumer-ci.ts';
import { isSourceLinkedRun } from './source-only.ts';

export function consumerOnlyTest(file: string, name: string, fn: () => void | Promise<unknown>, timeout?: number): void {
  const entry = consumerCases.find(row => row.file === file && row.name === name);
  if (!entry) throw new Error(`CONSUMER_CI_COVERAGE: ${file}: unlisted consumer case ${name}; update scripts/consumer-ci-tests.json`);
  if (process.env.RIG_CREATE_CONSUMER_REGISTRATIONS) appendFileSync(process.env.RIG_CREATE_CONSUMER_REGISTRATIONS, `${JSON.stringify({file,name})}\n`);
  if (isSourceLinkedRun()) {
    console.log(`SKIP ${entry.displayName}: ${entry.reason}`);
    test.skip(name, fn);
  } else if (timeout !== undefined) test(name, fn, timeout);
  else test(name, fn);
}
