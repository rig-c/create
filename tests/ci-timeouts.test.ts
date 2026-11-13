import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

type Job = { 'timeout-minutes'?: number; 'continue-on-error'?: boolean };
const workflow = Bun.YAML.parse(readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')) as { jobs: Record<string, Job> };
function checkBound(job: Job) {
  expect(Number.isInteger(job['timeout-minutes'])).toBe(true);
  expect(job['timeout-minutes']!).toBeGreaterThan(0);
  expect(job['timeout-minutes']!).toBeLessThan(360);
  expect(job['continue-on-error'] ?? false).toBe(false);
}
for (const name of ['release', 'publish']) {
  const job = workflow.jobs[name]!;
  test(`release.yml: ${name} has an explicit job timeout`, () => {
    checkBound(job);
    expect(job['timeout-minutes']).toBe(20);
  });
  for (const [label, mutate] of Object.entries<(copy: Job) => void>({
    'missing timeout': copy => { delete copy['timeout-minutes']; },
    'implicit ceiling': copy => { copy['timeout-minutes'] = 360; },
    'zero timeout': copy => { copy['timeout-minutes'] = 0; },
    'masked failure': copy => { copy['continue-on-error'] = true; },
  })) {
    test(`release.yml: ${name} rejects ${label}`, () => {
      const copy = structuredClone(job);
      mutate(copy);
      expect(() => checkBound(copy)).toThrow();
    });
  }
}
