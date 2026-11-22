import { afterEach, expect, test } from 'bun:test';
import { cpSync } from 'node:fs';
import { join } from 'node:path';
import { testClock } from './clock.ts';
import { cli, ownerChatArgs, tempDir } from './helpers.ts';

afterEach(() => testClock.reset());

// Known failure for #839: resume introduces STAGE_LAGGING after a closing signoff succeeds while paused.
test('a closing signoff recorded while paused still allows resume and advance', () => {
  const dir = join(tempDir(), 'project');
  cpSync(join(import.meta.dir, '../templates/example-chain/checkpoints/0b-plan-pending'), dir, { recursive: true });
  const words = 'evidence/approval.txt';
  let now = Date.parse('2026-11-23T00:00:00Z');
  const run = (args: string[], ownerChat = false): void => {
    testClock.set(now += 1000);
    const authority = ownerChat ? ['--by', 'owner', ...ownerChatArgs(words)] : [];
    const { code, stderr } = cli([...args, ...authority], dir, process.env as Record<string, string>);
    expect({ command: args.join(' '), code, stderr }).toEqual({ command: args.join(' '), code: 0, stderr: '' });
  };

  run(['interview', '--check', '--json']);
  run(['signoff', 'paused'], true);
  run(['pause', '--by', 'owner', '--verbatim-file', words]);
  run(['signoff', 'plan-approved'], true);
  run(['interview', '--check', '--json']);
  run(['resume', 'plan-approved', '--by', 'owner', '--verbatim-file', words]);
  run(['advance', 'parts']);
  run(['interview', '--check', '--json']);
});
