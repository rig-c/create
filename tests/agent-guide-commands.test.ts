import { describe, expect, test } from 'bun:test';
import { cli, gitEnv, tempDir } from './helpers.ts';

const ownerChat = ['--by', 'owner', '--owner-chat', 'words.txt', '--said-at', '2026-11-27T00:00:00Z', '--relayed-by', 'agent'];
const missingProject = 'PROJECT_JSON_MISSING';

// These probes run outside a project so the real CLI parses the complete
// invocation without building, publishing or writing a project record.
const guideCommands: ReadonlyArray<{ args: string[]; code: string; exit?: number }> = [
  { args: ['next', '.'], code: missingProject },
  { args: ['interview', '--check', '.', '--json'], code: missingProject },
  { args: ['history', '.'], code: 'PROJECT_NOT_IN_GIT', exit: 0 },
  { args: ['plan', 'propose', 'parts', '.', '--file', 'plan.md', '--by', 'agent'], code: missingProject },
  {
    args: ['plan', 'feedback', 'parts', '.', '--words-file', 'words.txt', '--by', 'owner', '--said-at', '2026-11-27T00:00:00Z', '--relayed-by', 'agent'],
    code: 'VERBATIM_UNREADABLE',
  },
  {
    args: ['plan', 'add', 'camera', '.', '--by', 'agent', '--phase', 'post', '--order', '1', '--does', 'Frame the shot.', '--produces', 'Framing.', '--rests-on', 'camera_depth', '--bar', 'Keep framing stable.', '--checkpoint-proposed', 'false'],
    code: missingProject,
  },
  {
    args: ['interview-decision', 'assemble', '.', '--by', 'agent', '--reasoning-file', 'reason.txt', '--value-file', 'value.json', '--plan-quote-file', 'quote.txt'],
    code: missingProject,
  },
  { args: ['interview-options', 'camera_depth', '.', '--file', 'options.json'], code: missingProject },
  {
    args: ['interview-answer', 'camera_depth', '.', '--set', 'options.json', '--sha256', 'a'.repeat(64), '--pick', 'camera_depth=keep', ...ownerChat],
    code: 'VERBATIM_UNREADABLE',
  },
  { args: ['record', 'parts', '.', '--from', 'outputs/parts.next', '--config', 'config.json'], code: missingProject },
  { args: ['record', 'rig', '.', '--from', 'outputs/rig.next', '--config', 'config.json'], code: missingProject },
  { args: ['record', 'motion', '.', '--from', 'outputs/motion.next'], code: missingProject },
  {
    args: ['record', 'direction', '.', '--from', 'outputs/direction.next', '--direction', 'specs/direction/direction.json'],
    code: missingProject,
  },
  { args: ['scene', 'write', '.', '--compose-scene', 'scene.json'], code: 'SCENE_MALFORMED' },
  { args: ['direction', 'write', '.', '--file', 'intent.json'], code: 'DIRECTION_SOURCE_CHANGED' },
  { args: ['step-status', 'assemble', 'done', '.', '--by', 'agent'], code: missingProject },
  { args: ['advance', 'parts-review', '.', '--parts-check', 'report.json', '--parts', 'outputs/parts/rig'], code: missingProject },
  { args: ['advance', 'accepted', '.'], code: missingProject },
  { args: ['signoff', 'parts-review', '.', ...ownerChat], code: missingProject },
  { args: ['input', 'add', 'painting.png', '.', '--painting', '--origin', 'owner'], code: 'PROJECT_JSON_INVALID' },
  { args: ['owner-language', 'set', 'en', '.'], code: missingProject },
  { args: ['packages', 'upgrade', '.', '--by', 'agent'], code: 'PACKAGE_UPGRADE_INPUT' },
  { args: ['diff-classes', '.', '--diff-report', 'report.json', '--by', 'agent'], code: missingProject },
  { args: ['job', 'open', '.', '--reviewer', 'owner', '--role', 'owner', '--current', 'parts'], code: 'JOB_PUBLISH_PENDING' },
  { args: ['job', 'open', '.', '--reviewer', 'owner', '--role', 'owner', '--current', 'rig'], code: 'JOB_PUBLISH_PENDING' },
  { args: ['job', 'open', '.', '--reviewer', 'owner', '--role', 'owner', '--current', 'direction'], code: 'JOB_PUBLISH_PENDING' },
  { args: ['job', 'acts', '.', '--json', '--wait', '--timeout-ms', '1'], code: 'JOB_HOST_ATTACH_REFUSED' },
  { args: ['job', 'reconcile', '.'], code: 'JOB_PUBLISH_PENDING' },
  { args: ['job', 'withdraw-act', 'act@10', '.', ...ownerChat], code: 'VERBATIM_UNREADABLE' },
  { args: ['job', 'close', '.', '--retire-refused'], code: 'JOB_BINDING_INVALID' },
  { args: ['job', 'close', '.', '--discard-acts', 'reason', '--by', 'agent'], code: 'JOB_BINDING_INVALID' },
  {
    args: ['comment', '--close', '0', '.', '--act-sha256', 'a'.repeat(64), '--after', `file=${'b'.repeat(64)}`],
    code: missingProject,
  },
];

describe('current agent-guide command forms reach their project or input checks', () => {
  for (const { args, code, exit = 1 } of guideCommands) {
    test(`rig-create ${args.join(' ')}`, () => {
      const result = cli(args, tempDir(), gitEnv());
      const output = result.stdout + result.stderr;
      expect(result.code, output).toBe(exit);
      expect(output).toMatch(new RegExp(`\\b${code}\\b`));
    }, 15_000);
  }
});
