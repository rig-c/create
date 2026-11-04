import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { checkProject } from '../src/check.ts';
import { signoffCommand } from '../src/signoff.ts';
import { stepHash } from '../src/step-hash.ts';
import type { JsonObject } from '../src/templates.ts';
import { arr, fixture, obj, step } from './fixtures.ts';
import { EXAMPLE_VERDICT } from './parts-package.ts';
import { CLI, cli, gitEnv } from './helpers.ts';

const read = (dir: string): JsonObject => JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
const words = '  좋아\r\n초안대로\n\n';
function input(dir: string): string {
  const file = join(dir, 'words.txt');
  writeFileSync(file, words);
  return file;
}
afterEach(() => setSystemTime());

describe('signoff', () => {
  test('one command signs the filled plan, fills null checkpoints and passes the interview check', () => {
    setSystemTime(new Date('2026-11-20T00:00:00Z'));
    const dir = fixture((p) => {
      p.signoffs = arr(p.signoffs).filter((s) => obj(s).stage !== 'plan-approved');
      for (const raw of arr(obj(p.plan).steps)) {
        const s = obj(raw);
        if (s.phase === 'rig' && s.id !== 'constraints') s.checkpoint = null;
      }
    });
    const delegated = step(read(dir), 'constraints').checkpoint;
    const post = step(read(dir), 'camera').checkpoint;
    expect(signoffCommand(['plan-approved', dir, '--by', 'user', '--verbatim-file', input(dir)]).exit).toBe(0);
    const p = read(dir);
    const signed = obj(arr(p.signoffs).at(-1));
    expect(signed.at).toBe('2026-11-20T00:00:00.000Z');
    expect(p.stage).toBe('accepted');
    expect(step(p, 'constraints').checkpoint).toEqual(delegated);
    expect(step(p, 'camera').checkpoint).toEqual(post);
    for (const raw of arr(obj(p.plan).steps)) {
      const s = obj(raw);
      if (s.phase !== 'rig') continue;
      expect(obj(signed.step_hashes)[s.id as string]).toBe(stepHash(s));
      if (s.id !== 'constraints') expect(Buffer.from(obj(s.checkpoint).verbatim as string)).toEqual(Buffer.from(words));
    }
    expect(Buffer.from(signed.verbatim as string)).toEqual(readFileSync(join(dir, 'words.txt')));
    expect(checkProject(dir).refusals).toEqual([]);
    expect(cli(['interview', '--check', '--json'], dir, gitEnv()).code).toBe(0);
  });

  test('subset and post approvals preserve other steps', () => {
    const dir = fixture();
    const before = read(dir);
    signoffCommand(['post-interview', dir, '--steps', 'camera', '--by', 'user', '--verbatim-file', input(dir)]);
    const p = read(dir);
    expect(p.plan).toEqual(before.plan);
    expect(Object.keys(obj(obj(arr(p.signoffs).at(-1)).step_hashes))).toEqual(['camera']);
  });

  test('ordinary stages record only, stdin retains UTF-8 BOM and newlines', () => {
    const dir = fixture();
    const before = read(dir);
    const bytes = Buffer.from('\uFEFF' + words);
    const result = Bun.spawnSync([process.execPath, CLI, 'signoff', 'interview', dir, '--by', 'user'], { stdin: bytes, stdout: 'pipe', stderr: 'pipe' });
    expect(result.exitCode).toBe(0);
    const p = read(dir);
    expect(p.plan).toEqual(before.plan);
    expect(Buffer.from(obj(arr(p.signoffs).at(-1)).verbatim as string)).toEqual(bytes);
  });

  test.each(['agent', 'AGENT'])('refuses non-human %s without writing', (by) => {
    const dir = fixture();
    const before = readFileSync(join(dir, 'project.json'));
    expect(() => signoffCommand(['plan-approved', dir, '--by', by])).toThrow('agent');
    expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
  });

  test.each(['unknown', 'camera_depth', 'bones,bones', 'bones,'])('refuses invalid step selection %s', (ids) => {
    const dir = fixture();
    const before = readFileSync(join(dir, 'project.json'));
    expect(() => signoffCommand(['plan-approved', dir, '--by', 'user', '--steps', ids])).toThrow();
    expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
  });

  test.each(['proposal', 'delegation'])('invalid %s refuses the entire write', (kind) => {
    const dir = fixture((p) => {
      step(p, 'assemble').checkpoint = null;
      if (kind === 'proposal') step(p, 'motion').checkpoint_proposed = null;
      else obj(step(p, 'constraints').checkpoint).agent_decision = null;
    });
    const before = readFileSync(join(dir, 'project.json'));
    expect(() => signoffCommand(['plan-approved', dir, '--by', 'user', '--verbatim-file', input(dir)])).toThrow(kind === 'proposal' ? 'motion' : 'constraints');
    expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
  });

  test('no caller-supplied clock and invalid UTF-8 are refused without writing', () => {
    const dir = fixture();
    const before = readFileSync(join(dir, 'project.json'));
    expect(cli(['signoff', 'interview', '--by', 'user', '--at', '2026-01-01'], dir, gitEnv()).code).toBe(2);
    const file = input(dir);
    writeFileSync(file, Buffer.from([0xff]));
    expect(() => signoffCommand(['interview', dir, '--by', 'user', '--verbatim-file', file])).toThrow('valid UTF-8');
    expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
  });
});

test('step hash pinned vector, recursive ordering and status exclusion', () => {
  const s: JsonObject = { id: 'sample', phase: 'rig', order: 1, does: 'Move', produces: 'config', rests_on: ['sample'], bar: 'steady', checkpoint_proposed: false,
    checkpoint: { value: false, by: 'user', delegated: false, verbatim: '좋아\r\n', at: '2026-11-04T00:00:00Z' } };
  expect(stepHash(s)).toBe('f2c2a353d897038c9a7da7514551037c95e646a59127d13c703505e4b69475eb');
  expect(stepHash({ ...s, status: 'done' })).toBe(stepHash(s));
  expect(stepHash({ ...s, checkpoint: Object.fromEntries(Object.entries(obj(s.checkpoint)).reverse()) })).toBe(stepHash(s));
  expect(stepHash({ ...s, bar: 'changed' })).not.toBe(stepHash(s));
});


describe('parts-review evidence and execution checkpoints', () => {
  test('records the approved verdict hash and clears the check without hand edits', () => {
    const dir = fixture((p) => { p.signoffs = arr(p.signoffs).filter((s) => obj(s).stage !== 'parts-review'); });
    expect(checkProject(dir).refusals.map((r) => r.code)).toContain('PARTS_REVIEW_UNSIGNED');
    const result = cli(['signoff', 'parts-review', '--by', 'user', '--evidence', join(dir, EXAMPLE_VERDICT), '--verbatim-file', input(dir)], dir, gitEnv());
    expect(result).toMatchObject({ code: 0, stderr: '' });
    const signed = obj(arr(read(dir).signoffs).at(-1));
    expect(signed.evidence).toEqual({ kind: 'parts-verdict', path: EXAMPLE_VERDICT, sha256: new Bun.CryptoHasher('sha256').update(readFileSync(join(dir, EXAMPLE_VERDICT))).digest('hex') });
    expect(cli(['interview', '--check', '--json'], dir, gitEnv()).code).toBe(0);
  });

  test.each(['unapproved', 'malformed', 'stale'])('refuses %s evidence before writing', (kind) => {
    const dir = fixture();
    const file = join(dir, EXAMPLE_VERDICT);
    const verdict = JSON.parse(readFileSync(file, 'utf8')) as JsonObject;
    if (kind === 'malformed') writeFileSync(file, '{');
    else if (kind === 'unapproved') { verdict.status = 'needs-work'; writeFileSync(file, JSON.stringify(verdict)); }
    else {
      const source = obj(arr(obj(verdict.source).files)[0]);
      writeFileSync(join(dir, EXAMPLE_VERDICT, '..', source.path as string), 'changed');
    }
    const before = readFileSync(join(dir, 'project.json'));
    const r = cli(['signoff', 'parts-review', '--by', 'user', '--evidence', EXAMPLE_VERDICT, '--verbatim-file', input(dir)], dir, gitEnv());
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(kind === 'unapproved' ? 'PARTS_VERDICT_NOT_APPROVED' : kind === 'malformed' ? 'PARTS_VERDICT_UNREAD' : 'PARTS_VERDICT_SOURCE_CHANGED');
    expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
  });

  test('evidence is required only at parts-review', () => {
    const dir = fixture();
    const before = readFileSync(join(dir, 'project.json'));
    expect(cli(['signoff', 'parts-review', '--by', 'user'], dir, gitEnv()).code).toBe(2);
    expect(cli(['signoff', 'rig-review', '--by', 'user', '--evidence', EXAMPLE_VERDICT], dir, gitEnv()).code).toBe(2);
    expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
  });

  test.each([['rigging', 'constraints'], ['parts', 'assemble']])('signs %s checkpoint %s and clears the check', (stage, id) => {
    const dir = fixture((p) => { p.signoffs = arr(p.signoffs).filter((s) => obj(s).checkpoint !== id); });
    expect(checkProject(dir).refusals.map((r) => r.code)).toContain('CHECKPOINT_UNSIGNED');
    expect(cli(['signoff', stage, '--checkpoint', id, '--by', 'user', '--verbatim-file', input(dir)], dir, gitEnv()).code).toBe(0);
    const signed = obj(arr(read(dir).signoffs).at(-1));
    expect(signed.checkpoint).toBe(id);
    expect(signed.step_hashes).toBeUndefined();
    expect(signed.steps).toBeUndefined();
    expect(cli(['interview', '--check', '--json'], dir, gitEnv()).code).toBe(0);
  });

  test.each([['rigging', 'bones'], ['rigging', 'assemble'], ['rigging', 'camera'], ['rigging', 'missing'], ['plan-approved', 'constraints']])('refuses %s checkpoint %s', (stage, id) => {
    const dir = fixture();
    const before = readFileSync(join(dir, 'project.json'));
    const result = cli(['signoff', stage, '--checkpoint', id, '--by', 'user', '--verbatim-file', input(dir)], dir, gitEnv());
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('SIGNOFF_CHECKPOINT_INVALID');
    expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
  });

  test('checkpoint cannot be combined with steps', () => {
    const dir = fixture();
    const before = readFileSync(join(dir, 'project.json'));
    expect(cli(['signoff', 'rigging', '--checkpoint', 'constraints', '--steps', 'constraints', '--by', 'user'], dir, gitEnv()).code).toBe(2);
    expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
  });
});
