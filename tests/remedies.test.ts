import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderAgentGuide } from '../src/agent-guide.ts';
import { DirectionError, directionBytes } from '../src/direction.ts';
import { sameArtworkFor } from '../src/init.ts';
import { readVerbatim } from '../src/record-input.ts';
import { Refusal } from '../src/refusal.ts';

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
  expect(guide).toContain('Keep the host up across bound writes');
  expect(guide).toContain('then `job reconcile`');
  expect(guide).toContain('](AGENT-REFERENCE.md)');
  expect(readFileSync(new URL('../docs/AGENT-REFERENCE.md', import.meta.url), 'utf8')).toContain('direction has no depth/turn fields');
  expect(`${guide}\n${readFileSync(new URL('../docs/AGENT-REFERENCE.md', import.meta.url), 'utf8')}`).not.toContain('when the plan has a head turn driven by depth');
});
