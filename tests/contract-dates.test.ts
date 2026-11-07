/**
 * The only test that reads the real clock (README.md "The clock"). Every other
 * test runs create at an injected instant, so it passes on any date.
 */
import { expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

test('real clock: every exported *_SINCE contract date is at or before the real current date', async () => {
  const src = join(import.meta.dir, '../src');
  const since: [string, string][] = [];
  for (const name of readdirSync(src).filter(file => file.endsWith('.ts')).sort()) {
    const exports = await import(join(src, name)) as Record<string, unknown>;
    for (const [key, value] of Object.entries(exports)) if (key.endsWith('_SINCE')) since.push([key, String(value)]);
  }
  expect(since.length).toBeGreaterThan(0);
  const today = Date.now();
  const ahead = since.filter(([, value]) => !(Date.parse(value) <= today)).map(([key, value]) => `${key} = ${value}`);
  expect(ahead).toEqual([]);
});
