import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { renderAgentGuide } from '../src/agent-guide.ts';
import { cli, gitEnv, tempDir } from './helpers.ts';

const ownerChat = ['--by', 'owner', '--owner-chat', 'words.txt', '--said-at', '2026-11-27T00:00:00Z', '--relayed-by', 'agent'];
const missingProject = 'PROJECT_JSON_MISSING';

// These probes run outside a project so the real CLI parses the complete
// invocation without building, publishing or writing a project record.
const guideCommands: ReadonlyArray<{ args: string[]; code: string; exit?: number; needsProject?: boolean }> = [
  {
    args: ['init', 'project', '--painting', 'painting.png', '--origin', 'owner', '--owner-language', 'en'],
    code: 'INIT_ARTWORK_USAGE', exit: 2,
  },
  { args: ['structure-snapshot', '.'], code: 'STRUCTURE_SNAPSHOT_USAGE', exit: 2 },
  { args: ['input', 'add', 'background.png', '.', '--origin', 'owner'], code: 'PROJECT_JSON_INVALID' },
  { args: ['job', 'acts', '.', '--json'], code: 'JOB_HOST_ATTACH_REFUSED' },
  { args: ['job', 'acts', '.', '--wait'], code: 'JOB_HOST_ATTACH_REFUSED' },
  { args: ['job', 'close', '.'], code: 'JOB_BINDING_INVALID' },
  { args: ['comment', '--from-review', 'act@10', 'project'], code: 'JOB_BINDING_INVALID', needsProject: true },
  { args: ['next', '.'], code: missingProject },
  { args: ['interview', '--check', '.'], code: missingProject },
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
  for (const { args, code, exit = 1, needsProject } of guideCommands) {
    test(`rig-create ${args.join(' ')}`, () => {
      const dir = tempDir();
      const env = gitEnv();
      if (needsProject) {
        const init = cli(['init', 'project', '--no-install'], dir, env);
        expect(init.code, init.stderr).toBe(0);
      }
      const result = cli(args, dir, env);
      const output = result.stdout + result.stderr;
      expect(result.code, output).toBe(exit);
      expect(output).toMatch(new RegExp(`\\b${code}\\b`));
    }, 15_000);
  }
});

test('the rendered guide has a CLI probe for each written command form and its flags', () => {
  const guide = renderAgentGuide();
  const spans = [...guide.matchAll(/`([^`]+)`/g)].map(match => match[1]!);
  const commands = spans.filter(span => span.startsWith('rig-create ')).map(span => span.slice('rig-create '.length));
  const flags = (text: string): string[] => (text.match(/--[a-z][a-z0-9-]*/g) ?? []).sort();
  expect(commands.length).toBeGreaterThan(20);
  for (const command of commands) {
    const literalPrefix = command.split(/ (?=<|--)/, 1)[0]!.split(' ');
    expect(guideCommands.some(({ args }) =>
      literalPrefix.every((word, index) => args[index] === word) &&
      flags(args.join(' ')).join(' ') === flags(command).join(' ')), command).toBe(true);
  }
  expect([...new Set(spans.flatMap(flags))].sort()).toEqual([...new Set(commands.flatMap(flags))].sort());
});

test('each refusal or warning named in the rendered guide is implemented and documented', () => {
  const guide = renderAgentGuide();
  const checks = readFileSync(new URL('../docs/CHECKS.md', import.meta.url), 'utf8');
  const generators = ['parts-check.ts', 'current.ts', 'package-upgrades.ts'].map(file =>
    readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8')).join('\n');
  const codes = [...guide.matchAll(/`([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)`/g)].map(match => match[1]!);
  expect(codes.length).toBeGreaterThan(0);
  for (const code of codes) {
    expect(generators).toContain(`'${code}'`);
    expect(checks).toContain(`| \`${code}\` |`);
  }
});

const reviewControlRules: ReadonlyArray<{
  control: string;
  status: 'still works on Review 5.x' | 'refused on 5.x';
  pattern: RegExp;
}> = [
  { control: 'job open --current parts|rig|direction', status: 'still works on Review 5.x', pattern: /rig-create job open --reviewer <id> --role owner --current <parts\|rig\|direction>/ },
  { control: 'job acts --json / --wait', status: 'still works on Review 5.x', pattern: /rig-create job acts --(?:json|wait)/ },
  { control: 'comment --from-review <actId>', status: 'still works on Review 5.x', pattern: /rig-create comment --from-review <actId>/ },
  { control: 'explicit Review 5.x refusal statement', status: 'still works on Review 5.x', pattern: /for looking and comments \(Review refuses verdicts,\s+signoffs, checkpoints and picks\)/ },
  { control: 'parts-verdict submission in Review', status: 'refused on 5.x', pattern: /\bparts-verdict\b|\bparts-review\s+--from-review\b|\brecord an approval\b.*\bin Review\b/i },
  { control: 'review-verdict submission in Review', status: 'refused on 5.x', pattern: /\breview-verdict\b|\breview\s+\S+\s+--from-review\b|\bapprove\s+in\s+Review\b|\baccept(?:\s+[^.;]*)?\s+in\s+Review\b/i },
  { control: 'signoff submission in Review', status: 'refused on 5.x', pattern: /\bsignoff\b[^`\n]*--from-review\b|\bsign(?:\s+[^.;]*)?\s+in\s+Review\b/i },
  { control: 'checkpoint submission in Review', status: 'refused on 5.x', pattern: /\bcheckpoint\b[^`\n]*--from-review\b|\bpass(?:es)?\s+checkpoint\b.*\bin\s+Review\b/i },
  { control: 'interview-picks submission in Review', status: 'refused on 5.x', pattern: /\binterview-picks\b|\binterview-answer\b[^`\n]*--from-review\b|\bin the Review tool\b|\bask for it in Review\b|\bhave the owner pick\b.*\bjob open\b/i },
];

test('#1157 the rendered guide and stage reference walk Review 5.x controls and exclude retired submissions', () => {
  const guide = renderAgentGuide();
  const reference = readFileSync(new URL('../docs/AGENT-REFERENCE.md', import.meta.url), 'utf8');
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  expect(Buffer.byteLength(guide)).toBeLessThan(10_000);

  for (const rule of reviewControlRules) {
    if (rule.status === 'still works on Review 5.x') {
      expect(rule.pattern.test(guide), `expected guide to include ${rule.control}`).toBe(true);
    } else {
      for (const [label, text] of [['renderAgentGuide()', guide], ['docs/AGENT-REFERENCE.md', reference], ['README.md', readme]] as const) {
        expect(rule.pattern.test(text), `${label} must not instruct ${rule.control}`).toBe(false);
      }
    }
  }
});
