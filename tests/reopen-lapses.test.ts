import { afterEach, expect, test } from 'bun:test';
import { cpSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from './fixtures.ts';
import { tempDir } from './helpers.ts';
import { amendCommand, checkProject, reopenCommand, signoffCommand, testClock } from './clock.ts';

const CHAIN_POST = join(import.meta.dir, '../templates/example-chain/checkpoints/4-direction-post');
const lapses = (dir: string): string[][] => checkProject(dir).warnings.filter(f => f.code.startsWith('REOPEN_')).map(f => [f.code, f.path]);
function words(dir: string): string { const file = join(dir, 'words.txt'); writeFileSync(file, 'Reopen the synthetic project.\n'); return file; }
const reopen = (dir: string, stage: string): void => { reopenCommand([stage, dir, '--by', 'owner', '--verbatim-file', words(dir)]); };

afterEach(() => testClock.reset());

test('a writer-built project reopened to parts past rig-review and post-interview lists exactly the lapsed approvals', () => {
  const dir = join(tempDir(), 'project');
  cpSync(CHAIN_POST, dir, { recursive: true });
  expect(checkProject(dir)).toMatchObject({ refusals: [], warnings: [] });
  testClock.set(new Date('2026-11-06T02:00:00Z'));
  reopen(dir, 'parts');
  const report = checkProject(dir);
  expect(report.refusals).toEqual([]);
  expect(report.warnings.map(f => [f.code, f.path])).toEqual([
    ['REOPEN_SIGNOFF_LAPSED', 'signoffs[2]'],
    ['REOPEN_SIGNOFF_LAPSED', 'signoffs[3]'],
    ['REOPEN_SIGNOFF_LAPSED', 'signoffs[4]'],
    ['REOPEN_SIGNOFF_LAPSED', 'signoffs[5]'],
    ['REOPEN_SIGNOFF_LAPSED', 'signoffs[6]'],
    ['REOPEN_VERDICT_LAPSED', 'versions[v1].verdicts[0]'],
  ]);
  // Each names the reopen that voided it and the writer that records the restoring act.
  const byPath = new Map(report.warnings.map(f => [f.path, f.message]));
  for (const message of byPath.values()) expect(message).toContain('the reopen to parts at 2026-11-06T02:00:00.000Z (reopens[0])');
  expect(byPath.get('signoffs[5]')).toContain('rig-create signoff rig-review');
  expect(byPath.get('signoffs[6]')).toContain('rig-create signoff post-interview');
  expect(byPath.get('versions[v1].verdicts[0]')).toContain('rig-create review <n> --verdict accepted --review rig-review');
});

test('an unreopened project lists no lapsed approvals', () => {
  for (const dir of [fixture(() => {}, 'example-project.json'), fixture()]) expect(lapses(dir)).toEqual([]);
});

test('a re-signed approval leaves the list; the rest stay until restored', () => {
  const dir = fixture(() => {}, 'example-project.json');
  testClock.set(new Date('2026-11-19T00:00:00Z'));
  reopen(dir, 'post-interview');
  expect(lapses(dir)).toEqual([
    ['REOPEN_SIGNOFF_LAPSED', 'signoffs[9]'],
    ['REOPEN_SIGNOFF_LAPSED', 'signoffs[10]'],
    ['REOPEN_VERDICT_LAPSED', 'versions[v4].verdicts[0]'],
  ]);
  testClock.set(new Date('2026-11-20T00:00:00Z'));
  signoffCommand(['post-interview', dir, '--by', 'owner', '--verbatim-file', words(dir)]);
  expect(lapses(dir)).toEqual([['REOPEN_SIGNOFF_LAPSED', 'signoffs[10]'], ['REOPEN_VERDICT_LAPSED', 'versions[v4].verdicts[0]']]);
});

test('an amendment alone adds no reopen lapse: its lapses are the report amendments list', () => {
  const dir = fixture();
  testClock.set(new Date('2026-11-20T00:00:00Z'));
  writeFileSync(join(dir, 'replacement.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>\n');
  amendCommand(['parts', dir, '--kind', 'part', '--target', 'panel', '--change', 'replacement.svg', '--by', 'owner', '--verbatim-file', words(dir)]);
  const report = checkProject(dir);
  expect(report.amendments?.[0]?.lapsed.length).toBeGreaterThan(0);
  expect(report.warnings.map(f => f.code).filter(code => code.startsWith('REOPEN_'))).toEqual([]);
});
