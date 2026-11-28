import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderAgentGuide } from '../src/agent-guide.ts';
import { RETIRED_NUMBERED_COMMANDS } from '../src/cli.ts';
import { DirectionError, directionBytes } from '../src/direction.ts';
import { sameArtworkFor } from '../src/init.ts';
import { readVerbatim } from '../src/record-input.ts';
import { Refusal } from '../src/refusal.ts';
import { reopenLapseWarnings } from '../src/reopen-lapses.ts';

const roots: string[] = [];
function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'create-remedies-'));
  roots.push(dir);
  return dir;
}
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test('ignored direction input names a retained remedy and preserves source bytes', () => {
  const dir = root();
  mkdirSync(join(dir, 'scratch'));
  writeFileSync(join(dir, 'scratch/direction.json'), '{"synthetic":true}\n');
  const before = readFileSync(join(dir, 'scratch/direction.json'));
  expect(() => directionBytes(dir, 'scratch/direction.json')).toThrow(expect.objectContaining({
    code: 'DIRECTION_FILE', message: expect.stringContaining('path is ignored'),
  }));
  try { directionBytes(dir, 'scratch/direction.json'); }
  catch (error) {
    expect(error).toBeInstanceOf(DirectionError);
    expect((error as DirectionError).message).toContain('evidence/direction-src/');
  }
  expect(readFileSync(join(dir, 'scratch/direction.json'))).toEqual(before);
  mkdirSync(join(dir, 'evidence'));
  writeFileSync(join(dir, 'evidence/direction.json'), before);
  expect(directionBytes(dir, 'evidence/direction.json')).toEqual(before);
});

test('duplicate artwork refuses with the existing version and correction-ledger route', () => {
  const dir = root();
  const existing = join(dir, 'existing');
  mkdirSync(existing);
  const record = JSON.stringify({ inputs: [{ sha256: 'a'.repeat(64) }] });
  writeFileSync(join(existing, 'project.json'), record);
  expect(() => sameArtworkFor(join(dir, 'new'), 'synthetic.png', 'a'.repeat(64), 0)).toThrow(expect.objectContaining({
    code: 'INIT_ARTWORK_EXISTS', message: expect.stringContaining('continue in that existing project as a new version'),
  }));
  try { sameArtworkFor(join(dir, 'new'), 'synthetic.png', 'a'.repeat(64), 0); }
  catch (error) {
    expect(error).toBeInstanceOf(Refusal);
    expect((error as Refusal).message).toContain('restart there inherits its correction ledger');
    expect((error as Refusal).message).toContain('different artwork or a different rig kind');
  }
  expect(readFileSync(join(existing, 'project.json'), 'utf8')).toBe(record);
});

test('unreadable verbatim input explains working-directory resolution without changing its code', () => {
  expect(() => readVerbatim(join(root(), 'missing.txt'))).toThrow(expect.objectContaining({
    code: 'VERBATIM_UNREADABLE', message: expect.stringContaining('current working directory, not the project folder'),
  }));
});

test('rendered guide fits its byte bar and scopes camera choices to the direction format', () => {
  const guide = renderAgentGuide();
  expect(Buffer.byteLength(guide)).toBeLessThan(10_000);
  expect(guide).toContain('Reused opens exit. The page updates in place.');
  expect(guide).toContain('Keep the job host up across bound writes; if it stopped, run `job open` again with the same reviewer/role and URL, then `job reconcile`.');
  expect(guide).toContain('](AGENT-REFERENCE.md)');
  expect(readFileSync(new URL('../docs/AGENT-REFERENCE.md', import.meta.url), 'utf8')).toMatch(/already retained in the accepted\s+assembled parts/);
  expect(`${guide}\n${readFileSync(new URL('../docs/AGENT-REFERENCE.md', import.meta.url), 'utf8')}`).not.toContain('when the plan has a head turn driven by depth');
});

test('#1122 reopen lapse remedies name surviving routes or read-only status without retired commands', () => {
  const warnings = reopenLapseWarnings({
    signoffs: [
      { stage: 'parts', checkpoint: 'seethrough', by: 'owner', at: '2026-11-10T00:00:00.000Z', verbatim: 'ok' },
      { stage: 'parts-review', checkpoint: null, by: 'owner', at: '2026-11-10T00:01:00.000Z', verbatim: 'ok' },
      { stage: 'rig-review', checkpoint: null, by: 'owner', at: '2026-11-10T00:02:00.000Z', verbatim: 'ok' },
      { stage: 'direction-review', checkpoint: null, by: 'owner', at: '2026-11-10T00:03:00.000Z', verbatim: 'ok' },
    ],
    versions: [
      { n: 1, kind: 'rig', at: '2026-11-10T00:01:30.000Z', verdicts: [{ by: 'owner', at: '2026-11-10T00:01:45.000Z', review: 'rig-review', verdict: 'accepted', verbatim: 'ok' }] },
      { n: 2, kind: 'post', rig_version: 1, at: '2026-11-10T00:02:30.000Z', verdicts: [{ by: 'owner', at: '2026-11-10T00:02:45.000Z', review: 'direction-review', verdict: 'accepted', verbatim: 'ok' }] },
    ],
    reopens: [
      { stage: 'parts', from_stage: 'accepted', by: 'owner', at: '2026-11-11T00:00:00.000Z', verbatim: 'reopen', steps_before: [] },
    ],
  });
  expect(warnings.map((w) => [w.code, w.path])).toEqual([
    ['REOPEN_SIGNOFF_LAPSED', 'signoffs[0]'],
    ['REOPEN_SIGNOFF_LAPSED', 'signoffs[1]'],
    ['REOPEN_SIGNOFF_LAPSED', 'signoffs[2]'],
    ['REOPEN_SIGNOFF_LAPSED', 'signoffs[3]'],
    ['REOPEN_VERDICT_LAPSED', 'versions[v1].verdicts[0]'],
    ['REOPEN_VERDICT_LAPSED', 'versions[v2].verdicts[0]'],
  ]);
  for (const warning of warnings) {
    for (const retired of Object.keys(RETIRED_NUMBERED_COMMANDS)) {
      expect(warning.message).not.toContain(`rig-create ${retired}`);
    }
    expect(warning.message).not.toContain('--from-review');
    expect(warning.message).not.toContain('--draft');
    expect(warning.message).not.toContain('--version');
    expect(warning.message).toContain('--owner-chat');
  }
});
