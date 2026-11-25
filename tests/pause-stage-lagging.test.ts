import { afterEach, expect, test } from 'bun:test';
import { cpSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CheckReport } from '../src/check.ts';
import type { NextReport } from '../src/next.ts';
import type { JsonObject } from '../src/templates.ts';
import { testClock } from './clock.ts';
import { cli, ownerChatArgs, tempDir } from './helpers.ts';

afterEach(() => testClock.reset());

test.each([
  ['a closing signoff recorded while paused still allows resume and advance', true],
  ['a previously authorized pause still resumes after the stage was signed', false],
])('%s', (_, signWhilePaused) => {
  const dir = join(tempDir(), 'project');
  cpSync(join(import.meta.dir, '../templates/example-chain/checkpoints/0b-plan-pending'), dir, { recursive: true });
  const read = (): JsonObject => JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'));
  const words = 'evidence/approval.txt';
  let now = Date.parse('2026-11-23T00:00:00Z');
  const run = (args: string[], ownerChat = false): string => {
    testClock.set(now += 1000);
    const authority = ownerChat ? ['--by', 'owner', ...ownerChatArgs(words)] : [];
    const { code, stderr, stdout } = cli([...args, ...authority], dir, process.env as Record<string, string>);
    expect({ command: args.join(' '), code, stderr }).toEqual({ command: args.join(' '), code: 0, stderr: '' });
    return stdout;
  };

  run(['interview', '--check', '--json']);
  run(['signoff', 'paused'], true);
  if (!signWhilePaused) run(['signoff', 'plan-approved'], true);
  run(['pause', '--by', 'owner', '--verbatim-file', words]);
  if (signWhilePaused) run(['signoff', 'plan-approved'], true);
  const pausedCheck: CheckReport = JSON.parse(run(['interview', '--check', '--json']));
  expect(pausedCheck).toMatchObject({ stage: 'paused', effective_stage: 'parts', refusals: [] });
  const pausedNext: NextReport = JSON.parse(run(['next', '--json']));
  expect(pausedNext.moves).toContainEqual(expect.objectContaining({
    role: 'human', field: 'pauses', review_act: { kind: 'signoff', stage: 'plan-approved' },
  }));

  const before = read();
  run(['resume', 'plan-approved', '--by', 'owner', '--verbatim-file', words]);
  expect(read()).toEqual({
    ...before,
    stage: 'plan-approved',
    pauses: [
      ...(before.pauses as JsonObject[]),
      { from_stage: 'paused', stage: 'plan-approved', by: 'owner', at: testClock.iso(), verbatim: readFileSync(join(dir, words), 'utf8') },
    ],
  });
  const resumedNext: NextReport = JSON.parse(run(['next', '--json']));
  expect(resumedNext.refusals).toEqual([]);
  expect(resumedNext.moves).toContainEqual(expect.objectContaining({
    role: 'agent', command: expect.stringContaining('rig-create advance parts '),
  }));
  run(['advance', 'parts']);
  const advancedCheck: CheckReport = JSON.parse(run(['interview', '--check', '--json']));
  expect(advancedCheck).toMatchObject({ stage: 'parts', effective_stage: 'parts', refusals: [] });
});
