import { afterEach, describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { JobOwnerHost } from '@rig-c/review/job-host';
import { main } from '../src/cli.ts';
import { checkProject } from '../src/check.ts';
import { openCreateJob } from '../src/job-host.ts';
import { jobHostStateRoot } from '../src/job-outbox.ts';
import { jobRuntimeExecArgv } from '../src/job-writer.ts';
import { NEXT_SCHEMA, nextCommand, nextProject, type NextReport } from '../src/next.ts';
import { partsReviewCommand } from '../src/parts-review.ts';
import { Refusal, USAGE_EXIT } from '../src/refusal.ts';
import { EXAMPLE_NOW } from '../scripts/example-time.ts';
import { planCommand, stepStatusCommand, amendCommand, reopenCommand, reviewCommand, signoffCommand, testClock } from './clock.ts';
import { arr, fixture, obj, retimeFixture } from './fixtures.ts';
import { tempDir } from './helpers.ts';
import { recordPartsReceipt } from './parts-receipt-fixture.ts';
import type { JsonObject } from '../src/templates.ts';

const REPO = join(import.meta.dir, '..');
const CHAIN_DIR = join(REPO, 'templates/example-chain');
const CHECKPOINTS_DIR = join(CHAIN_DIR, 'checkpoints');
const REMESH_DIR = join(REPO, 'templates/example-remesh');
const CHAIN_NOW = EXAMPLE_NOW;

afterEach(() => testClock.reset());

test('#467 next offers the direction verdict page and retains the upstream sign-off blocker after ingest', () => {
  const dir = join(tempDir(), 'direction-pages');
  cpSync(CHAIN_DIR, dir, { recursive: true });
  const file = join(dir, 'project.json');
  const project = JSON.parse(readFileSync(file, 'utf8')) as JsonObject;
  project.stage = 'direction-review';
  project.signoffs = arr(project.signoffs).filter(entry => obj(entry).stage !== 'direction-review');
  project.advances = arr(project.advances).filter(entry => obj(entry).stage !== 'accepted');
  const post = arr(project.versions).map(obj).find(version => version.n === 2)!;
  const accepted = post.verdicts;
  post.verdicts = [];
  writeFileSync(file, `${JSON.stringify(project, null, 2)}\n`);
  const before = nextProject(dir, CHAIN_NOW);
  expect(before.refusals).toEqual([]);
  expect(before.moves.find(move => move.review_act?.kind === 'review-verdict' && move.review_act.stage === 'direction-review')).toMatchObject({
    command: null,
    act: expect.stringContaining('job open --rig 2'),
    review_act: { kind: 'review-verdict', stage: 'direction-review', version_id: 'v2', review: 'direction-review' },
  });
  const pendingSignoff = before.moves.find(move => move.review_act?.kind === 'signoff' && move.review_act.stage === 'direction-review');
  expect(pendingSignoff).toBeDefined();
  expect(pendingSignoff?.act).toContain('blocked pending an upstream Review change');
  expect(pendingSignoff?.act).not.toContain('job open --plan');

  post.verdicts = accepted!;
  writeFileSync(file, `${JSON.stringify(project, null, 2)}\n`);
  const after = nextProject(dir, CHAIN_NOW);
  expect(after.refusals).toEqual([]);
  expect(after.moves.some(move => move.review_act?.kind === 'review-verdict' && move.review_act.stage === 'direction-review')).toBe(false);
  const blockedSignoff = after.moves.find(move => move.review_act?.kind === 'signoff' && move.review_act.stage === 'direction-review');
  expect(blockedSignoff).toBeDefined();
  expect(blockedSignoff?.act).toContain('do not advance to accepted');
  expect(blockedSignoff).toMatchObject({
    command: null,
    act: expect.stringContaining('blocked pending an upstream Review change'),
    review_act: { kind: 'signoff', stage: 'direction-review', version_id: 'v2' },
  });
});

interface CheckpointSpec {
  schema: string;
  stage: string;
  name: string;
  chain_step: number;
  pending: {
    act: string;
    commands: string[];
    command_roles: string[];
    awaits: string[];
  };
}

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function treeDigest(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (current: string): void => {
    for (const entry of readdirSync(current).sort()) {
      const full = join(current, entry);
      const rel = relative(root, full).split('\\').join('/');
      const st = statSync(full);
      if (st.isDirectory()) {
        out.set(`${rel}/`, 'dir');
        walk(full);
      } else {
        out.set(rel, sha256(readFileSync(full)));
      }
    }
  };
  walk(root);
  return out;
}

function runMainCapture(argv: string[], now: number): { code: number; stdout: string; stderr: string } {
  let stdout = '';
  let stderr = '';
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stderr.write;
  try {
    const code = main(argv, now);
    return { code, stdout, stderr };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

describe('Frozen Bar 1 — The chain is the answer key (example-chain checkpoints)', () => {
  const specFiles = readdirSync(CHECKPOINTS_DIR)
    .filter(name => name.endsWith('.json'))
    .sort();

  test('all six example-chain checkpoints exist and are compared dynamically against their pending blocks', () => {
    expect(specFiles).toEqual([
      '0a-interview-options.json',
      '0b-plan-pending.json',
      '1-parts-verdict.json',
      '2-rigging-answers.json',
      '3-rig-review.json',
      '4-direction-post.json',
    ]);
  });

  for (const file of specFiles) {
    const spec = JSON.parse(readFileSync(join(CHECKPOINTS_DIR, file), 'utf8')) as CheckpointSpec;
    const cpDir = join(CHECKPOINTS_DIR, spec.name);

    test(`checkpoint ${spec.name} (${spec.stage}): compares next --json with pending block and verifies record-decided differences`, () => {
      const res = nextCommand([cpDir, '--json'], CHAIN_NOW);
      expect(res.exit).toBe(0);
      const report = JSON.parse(res.stdout) as NextReport;
      const project = JSON.parse(readFileSync(join(cpDir, 'project.json'), 'utf8')) as Record<string, unknown>;

      expect(report.schema).toBe(NEXT_SCHEMA);
      expect(report.stage).toBe(String(project.stage));

      if (spec.name === '0a-interview-options') {
        // Awaits match the checkpoint's pending.awaits 100%.
        expect(report.awaits).toEqual(spec.pending.awaits);
        // 4 INTERVIEW_INCOMPLETE refusals come first, matching the 4 unanswered questions.
        expect(report.refusals.map(r => [r.code, r.field])).toEqual([
          ['INTERVIEW_INCOMPLETE', 'interview.framing[rig_type].answer'],
          ['INTERVIEW_INCOMPLETE', 'interview.framing[reference].answer'],
          ['INTERVIEW_INCOMPLETE', 'interview.waypoints[seethrough].guide'],
          ['INTERVIEW_INCOMPLETE', 'interview.waypoints[assemble].guide'],
        ]);
        // Disagreement 1: interview.framing[0] (rig_type) has pending_options in project.json,
        // so its move is human review-tool act interview-picks (not interview-answer --by user).
        const interview = project.interview as { framing: Record<string, unknown>[]; waypoints: Record<string, unknown>[] };
        expect(interview.framing[0]?.pending_options).toBeDefined();
        expect(report.moves[0]).toMatchObject({
          role: 'human',
          field: 'interview.framing[rig_type].pending_options',
          awaits: 'interview.framing[rig_type].answer',
          command: null,
          review_act: {
            kind: 'interview-picks',
            stage: 'interview',
            question_id: 'rig_type',
            option_set_id: 'chain-rig_type',
          },
        });
        // Disagreement 2: reference, seethrough, assemble have no pending_options in project.json,
        // and plan.steps is [], so next names those missing fields in unanswered_by_record instead of guessing.
        expect(interview.framing[1]?.pending_options).toBeUndefined();
        expect(report.moves[1]?.unanswered_by_record).toBe('interview.framing[reference].pending_options');
        expect(report.moves[2]?.unanswered_by_record).toBe('interview.waypoints[seethrough].pending_options');
        expect(report.moves[3]?.unanswered_by_record).toBe('interview.waypoints[assemble].pending_options');
        expect((project.plan as { steps: unknown[] }).steps).toEqual([]);
        expect(report.moves[4]).toMatchObject({
          role: 'human',
          field: 'signoffs',
          awaits: 'signoffs[stage=interview]',
          command: null,
          unanswered_by_record: 'plan.steps',
        });
      } else if (spec.name === '0b-plan-pending') {
        // Awaits and roles match pending 100%.
        expect(report.awaits).toEqual(spec.pending.awaits);
        expect(report.moves.map(m => String(m.role))).toEqual(spec.pending.command_roles);
        // Disagreement: pending.commands[0] offers `rig-create signoff plan-approved --by user ...`,
        // whereas signoffs[] requires a human review-tool signoff act (command: null).
        expect(report.moves[0]).toMatchObject({
          role: 'human',
          field: 'signoffs',
          awaits: 'signoffs[stage=plan-approved]',
          command: null,
          review_act: { kind: 'signoff', stage: 'plan-approved' },
        });
      } else if (spec.name === '1-parts-verdict') {
        // The runnable agent move matches pending.commands[4] verbatim, but its role is 'agent'
        // (decided by stage="parts", plan.steps all done, drafts[0].parts.path, and evidence/parts-check.json),
        // whereas pending.command_roles[4] mislabelled advance as 'human'.
        const agentMove = report.moves.find(m => m.role === 'agent');
        expect(agentMove?.command).toBe(spec.pending.commands[4]);
        expect(agentMove?.field).toBe('stage');
        expect(agentMove?.awaits).toBe('project.stage');
        // Producer diff-components uses project-relative paths from drafts[0].parts.path and inputs[0].path.
        const producerMove = report.moves.find(m => m.role === 'producer');
        expect(producerMove?.command).toBe(
          'rig-parts diff-components --stack derived/drafts/chain/input/recomposite_rig.png --painting inputs/painting.png --parts derived/drafts/chain/input/parts.json --floor 2 --threshold 40 --out evidence/diff-components.json',
        );
        // Disagreement: pending.command_roles[1] labelled `parts-review --from-review-cli --by user` as 'agent',
        // whereas review_acts is absent and a parts verdict is a human review-tool act.
        expect(project.review_acts ?? []).toEqual([]);
        expect(report.moves.find(m => m.review_act?.kind === 'parts-verdict')).toMatchObject({
          role: 'human',
          field: 'review_acts',
          awaits: 'review_acts[kind=parts-verdict,draft_id=chain]',
          command: null,
        });
      } else if (spec.name === '2-rigging-answers') {
        // Awaits match the checkpoint's pending.awaits 100%.
        expect(report.awaits).toEqual(spec.pending.awaits);
        expect(report.refusals.map(r => [r.code, r.field])).toEqual([
          ['INTERVIEW_INCOMPLETE', 'interview.waypoints[bones].guide'],
          ['INTERVIEW_INCOMPLETE', 'interview.waypoints[meshes].guide'],
          ['INTERVIEW_INCOMPLETE', 'interview.waypoints[constraints].guide'],
          ['INTERVIEW_INCOMPLETE', 'interview.waypoints[motion].guide'],
        ]);
        // bones has pending_options in project.json; meshes, constraints, motion do not.
        expect(report.moves[0]).toMatchObject({
          role: 'human',
          field: 'interview.waypoints[bones].pending_options',
          awaits: 'interview.waypoints[bones].guide',
          command: null,
          review_act: {
            kind: 'interview-picks',
            stage: 'rigging-interview',
            question_id: 'bones',
            option_set_id: 'chain-bones',
          },
        });
        expect(report.moves[1]?.unanswered_by_record).toBe('interview.waypoints[meshes].pending_options');
        expect(report.moves[2]?.unanswered_by_record).toBe('interview.waypoints[constraints].pending_options');
        expect(report.moves[3]?.unanswered_by_record).toBe('interview.waypoints[motion].pending_options');
      } else if (spec.name === '3-rig-review') {
        // Awaits and roles match pending 100%.
        expect(report.awaits).toEqual(spec.pending.awaits);
        expect(report.moves.map(m => String(m.role))).toEqual(spec.pending.command_roles);
        // Disagreement: pending.commands uses `--by user` writers for review 1 and signoff rig-review.
        expect(report.moves[0]).toMatchObject({
          role: 'human',
          field: 'versions[v1].verdicts',
          awaits: 'versions[n=1].verdicts[review=rig-review]',
          command: null,
          review_act: { kind: 'review-verdict', stage: 'rig-review', version_id: 'v1', review: 'rig-review' },
        });
        expect(report.moves[1]).toMatchObject({
          role: 'human',
          field: 'signoffs',
          awaits: 'signoffs[stage=rig-review]',
          command: null,
          review_act: { kind: 'signoff', stage: 'rig-review', version_id: 'v1' },
        });
      } else if (spec.name === '4-direction-post') {
        // The runnable agent move matches pending.commands[7] verbatim (`rig-create advance direction-review`),
        // and its role is 'agent' (decided by stage="post", plan.steps all done, signoffs[6]),
        // whereas pending.command_roles[7] mislabelled advance as 'human'.
        const agentMove = report.moves.find(m => m.role === 'agent');
        expect(agentMove?.command).toBe(spec.pending.commands[7]);
        expect(agentMove?.field).toBe('stage');
        expect(agentMove?.awaits).toBe('project.stage');
        // scenes is absent and versions has only v1 (rig), so next names scenes[n=1], versions[n=2] as unanswered_by_record.
        expect(project.scenes).toBeUndefined();
        expect(report.moves.filter(m => m.role === 'human').map(m => m.unanswered_by_record)).toEqual([
          'scenes[n=1], versions[n=2]',
          'scenes[n=1], versions[n=2]',
        ]);
      }
    });
  }
});

describe('Frozen Bar 2 — No suggested agent move refuses on a scratch copy', () => {
  test('every agent move across checkpoints and examples executes with exit 0 and 0 refusals on a scratch copy', () => {
    const targets: { name: string; dir: string; now: number }[] = [
      ...readdirSync(CHECKPOINTS_DIR)
        .filter(name => !name.endsWith('.json'))
        .sort()
        .map(name => ({ name: `checkpoint:${name}`, dir: join(CHECKPOINTS_DIR, name), now: CHAIN_NOW })),
      { name: 'example-chain', dir: CHAIN_DIR, now: CHAIN_NOW },
      { name: 'example-remesh', dir: REMESH_DIR, now: CHAIN_NOW },
      { name: 'example-project', dir: fixture(() => {}, 'example-project.json'), now: CHAIN_NOW },
    ];

    // Also include an open-step project in `parts` where `step-status` is an agent move.
    const openStepDir = join(tempDir(), 'open-step-parts');
    cpSync(join(CHECKPOINTS_DIR, '1-parts-verdict'), openStepDir, { recursive: true });
    const openStepProj = JSON.parse(readFileSync(join(openStepDir, 'project.json'), 'utf8')) as {
      plan: { steps: { id: string; status: string; status_history?: unknown[] }[] };
    };
    openStepProj.plan.steps[0]!.status = 'pending';
    openStepProj.plan.steps[0]!.status_history = [];
    writeFileSync(join(openStepDir, 'project.json'), `${JSON.stringify(openStepProj, null, 2)}\n`);
    targets.push({ name: 'open-step-parts', dir: openStepDir, now: CHAIN_NOW });

    let executedCount = 0;
    for (const target of targets) {
      const report = nextProject(target.dir, target.now);
      const agentMoves = report.moves.filter(m => m.role === 'agent');
      for (const move of agentMoves) {
        expect(typeof move.command).toBe('string');
        expect(move.command!.startsWith('rig-create ')).toBe(true);
        const scratch = join(tempDir(), 'scratch');
        cpSync(target.dir, scratch, { recursive: true });
        const argv = move.command!.slice('rig-create '.length).split(/\s+/);
        // Pass the scratch directory to the command.
        const argsWithDir = [...argv, scratch];
        const run = runMainCapture(argsWithDir, target.now);
        expect(run.stderr, `${target.name} -> ${move.command}`).toBe('');
        expect(run.code, `${target.name} -> ${move.command}`).toBe(0);
        const afterCheck = checkProject(scratch, undefined, { now: target.now, readOnly: true });
        expect(afterCheck.refusals, `${target.name} -> ${move.command} check refusals`).toEqual([]);
        executedCount++;
      }
    }
    expect(executedCount).toBeGreaterThanOrEqual(3);
  });
});

describe('Frozen Bar 3 — No human act is offered as an agent command', () => {
  const FORBIDDEN_WRITERS = [
    /^rig-create\s+signoff\b/,
    /^rig-create\s+review\b/,
    /^rig-create\s+parts-review\b/,
    /^rig-create\s+interview-answer\b/,
    /^rig-create\s+reopen\b/,
    /^rig-create\s+pause\b/,
    /^rig-create\s+resume\b/,
    /^rig-create\s+amend\b/,
    /^rig-create\s+scene\s+write\b/,
    /--by\s+user\b/,
    /--by\s+owner\b/,
  ];

  test('no agent or producer move writes signoffs[], a verdict or an approval, and no human move offers a create writer command', () => {
    const dirs = [
      ...readdirSync(CHECKPOINTS_DIR)
        .filter(name => !name.endsWith('.json'))
        .sort()
        .map(name => join(CHECKPOINTS_DIR, name)),
      CHAIN_DIR,
      REMESH_DIR,
      fixture(() => {}, 'example-project.json'),
    ];

    for (const dir of dirs) {
      const report = nextProject(dir, CHAIN_NOW);
      for (const move of report.moves) {
        if (move.role === 'agent' || move.role === 'producer') {
          expect(typeof move.command).toBe('string');
          for (const pattern of FORBIDDEN_WRITERS) {
            expect(move.command!).not.toMatch(pattern);
          }
        } else {
          expect(move.role).toBe('human');
          expect(move.command).toBeNull();
          expect(move.act).not.toMatch(/--by\s+user\b/);
        }
      }
    }
  });
});

describe('Frozen Bar 4 — Read-only and deterministic across every example', () => {
  test('project.json and the directory tree are byte-identical before and after next and next --json', () => {
    const dirs = [
      ...readdirSync(CHECKPOINTS_DIR)
        .filter(name => !name.endsWith('.json'))
        .sort()
        .map(name => join(CHECKPOINTS_DIR, name)),
      CHAIN_DIR,
      REMESH_DIR,
      fixture(() => {}, 'example-project.json'),
    ];

    for (const dir of dirs) {
      const beforeProjectHash = sha256(readFileSync(join(dir, 'project.json')));
      const beforeTree = treeDigest(dir);

      const text1 = nextCommand([dir], CHAIN_NOW);
      const text2 = nextCommand([dir], CHAIN_NOW);
      const json1 = nextCommand([dir, '--json'], CHAIN_NOW);
      const json2 = nextCommand([dir, '--json'], CHAIN_NOW);

      expect(text1.exit).toBe(0);
      expect(text1.stdout).toBe(text2.stdout);
      expect(json1.exit).toBe(0);
      expect(json1.stdout).toBe(json2.stdout);

      const afterProjectHash = sha256(readFileSync(join(dir, 'project.json')));
      const afterTree = treeDigest(dir);

      expect(afterProjectHash).toBe(beforeProjectHash);
      expect([...afterTree.entries()]).toEqual([...beforeTree.entries()]);
    }
  });
});

describe('Frozen Bar 5 — Plants (lapsed approval, changed bound input DRAFT_RIG_FILE, accepted project)', () => {
  test('plant 1: a lapsed approval appears as a human re-approval item naming the lapse (reopens[] and amendments[])', () => {
    const dir = join(tempDir(), 'reopened');
    cpSync(join(CHECKPOINTS_DIR, '4-direction-post'), dir, { recursive: true });
    const words = join(dir, 'words.txt');
    writeFileSync(words, 'Reopen the synthetic project to parts.\n');
    const reopenAt = Date.parse('2026-11-06T02:00:00Z');
    testClock.set(new Date(reopenAt));
    reopenCommand(['parts', dir, '--by', 'owner', '--verbatim-file', words]);

    const report = nextProject(dir, reopenAt);
    expect(report.refusals).toEqual([]);
    const lapseMoves = report.moves.filter(m => m.lapse !== undefined);
    expect(lapseMoves.map(m => [m.role, m.field, m.lapse?.code, m.lapse?.target_field])).toEqual([
      ['human', 'reopens[0]', 'REOPEN_SIGNOFF_LAPSED', 'signoffs[2]'],
      ['human', 'reopens[0]', 'REOPEN_SIGNOFF_LAPSED', 'signoffs[3]'],
      ['human', 'reopens[0]', 'REOPEN_SIGNOFF_LAPSED', 'signoffs[4]'],
      ['human', 'reopens[0]', 'REOPEN_SIGNOFF_LAPSED', 'signoffs[5]'],
      ['human', 'reopens[0]', 'REOPEN_SIGNOFF_LAPSED', 'signoffs[6]'],
      ['human', 'reopens[0]', 'REOPEN_VERDICT_LAPSED', 'versions[v1].verdicts[0]'],
    ]);
    for (const move of lapseMoves) {
      expect(move.command).toBeNull();
      expect(move.act).toContain('reopens[0]');
      expect(move.act).toContain(move.lapse!.code);
    }

    // Also verify example-remesh (which is reopened to parts-review).
    const remeshReport = nextProject(REMESH_DIR, CHAIN_NOW);
    const remeshLapses = remeshReport.moves.filter(m => m.lapse !== undefined);
    expect(remeshLapses.length).toBeGreaterThan(0);
    for (const move of remeshLapses) {
      expect(move.role).toBe('human');
      expect(move.field).toBe('reopens[0]');
      expect(move.command).toBeNull();
    }

    // Also verify an amendment lapse plant.
    const amendDir = fixture();
    const amendAt = Date.parse('2026-11-20T00:00:00Z');
    testClock.set(new Date(amendAt));
    writeFileSync(join(amendDir, 'replacement.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>\n');
    writeFileSync(join(amendDir, 'words.txt'), 'Amend synthetic part.\n');
    amendCommand([
      'parts',
      amendDir,
      '--kind',
      'part',
      '--target',
      'panel',
      '--change',
      'replacement.svg',
      '--by',
      'owner',
      '--verbatim-file',
      join(amendDir, 'words.txt'),
    ]);
    const amendReport = nextProject(amendDir, amendAt);
    const amendLapses = amendReport.moves.filter(m => m.lapse?.code === 'AMENDED_STEP');
    expect(amendLapses.length).toBeGreaterThan(0);
    expect(amendLapses[0]?.role).toBe('human');
    expect(amendLapses[0]?.field).toBe('amendments[0]');
    expect(amendLapses[0]?.command).toBeNull();
  });

  test('plant 2: a changed bound input appears as its DRAFT_RIG_FILE refusal with CHECKS.md fix ahead of every forward move', () => {
    const dir = join(tempDir(), 'tampered-draft');
    cpSync(join(CHECKPOINTS_DIR, '1-parts-verdict'), dir, { recursive: true });
    const boundFile = join(dir, 'derived/drafts/chain/input/parts.json');
    writeFileSync(boundFile, `${readFileSync(boundFile, 'utf8')}\n`);

    const report = nextProject(dir, CHAIN_NOW);
    expect(report.refusals.length).toBeGreaterThan(0);
    expect(report.refusals[0]?.code).toBe('DRAFT_RIG_FILE');
    expect(report.refusals[0]?.field).toBe('drafts[0]');
    expect(report.refusals[0]?.fix).toBe('restore its frozen config, parts and output files');
    // A project that does not check clean has no forward move.
    expect(report.moves).toEqual([]);
    expect(report.awaits).toEqual([]);

    const text = nextCommand([dir], CHAIN_NOW);
    expect(text.exit).toBe(0);
    expect(text.stdout).toContain('[DRAFT_RIG_FILE]');
    expect(text.stdout).toContain('no forward move (resolve refusals first)');
  });

  test('plant 3: an accepted project with no remaining move says so and exits 0', () => {
    for (const dir of [CHAIN_DIR, fixture(() => {}, 'example-project.json')]) {
      const jsonRes = nextCommand([dir, '--json'], CHAIN_NOW);
      expect(jsonRes.exit).toBe(0);
      const report = JSON.parse(jsonRes.stdout) as NextReport;
      expect(report.accepted).toBe(true);
      expect(report.refusals).toEqual([]);
      expect(report.awaits).toEqual([]);
      expect(report.moves).toEqual([]);

      const textRes = nextCommand([dir], CHAIN_NOW);
      expect(textRes.exit).toBe(0);
      expect(textRes.stdout).toContain('no remaining move (project is accepted)');
    }
  });

  test('plant 4 (STAGE_LAGGING): after human signoff, STAGE_LAGGING stays in refusals while the resolving advance is emitted as an agent move that clears it on a scratch copy', () => {
    const dir = join(tempDir(), 'stage-lagging');
    cpSync(join(CHECKPOINTS_DIR, '0b-plan-pending'), dir, { recursive: true });
    testClock.set(new Date(CHAIN_NOW));
    signoffCommand(['plan-approved', dir, '--by', 'user', '--verbatim-file', join(dir, 'evidence/approval.txt')]);

    const report = nextProject(dir, CHAIN_NOW);
    expect(report.refusals.map(r => r.code)).toContain('STAGE_LAGGING');
    const advanceMove = report.moves.find(m => m.role === 'agent');
    expect(advanceMove).toMatchObject({
      role: 'agent',
      field: 'stage',
      awaits: 'project.stage',
      command: 'rig-create advance parts',
    });

    const scratch = join(tempDir(), 'stage-lagging-scratch');
    cpSync(dir, scratch, { recursive: true });
    const argv = advanceMove!.command!.slice('rig-create '.length).split(/\s+/);
    const run = runMainCapture([...argv, scratch], CHAIN_NOW);
    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    const afterCheck = checkProject(scratch, undefined, { now: CHAIN_NOW, readOnly: true });
    expect(afterCheck.refusals).toEqual([]);
  });

  test('plant 5 (parts-verdict receipts): both CLI and API parts-verdict routes unlock structure-snapshot as an agent move', async () => {
    // Route 1: CLI parts-verdict receipt (`rig-create/parts-verdict-cli@1`, uses `status: "approved"`).
    const cliDir = join(tempDir(), 'parts-cli-route');
    cpSync(join(CHECKPOINTS_DIR, '1-parts-verdict'), cliDir, { recursive: true });
    recordPartsReceipt(cliDir, 'chain', CHAIN_NOW, 'approved');

    const cliReport = nextProject(cliDir, CHAIN_NOW);
    const cliSnapshotMove = cliReport.moves.find(
      m => m.role === 'agent' && m.command?.startsWith('rig-create structure-snapshot'),
    );
    expect(cliSnapshotMove).toMatchObject({
      role: 'agent',
      field: 'drafts[chain]',
      awaits: 'evidence/structure.json',
      command: 'rig-create structure-snapshot --draft chain --out evidence/structure.json',
    });
    const cliScratch = join(tempDir(), 'parts-cli-scratch');
    cpSync(cliDir, cliScratch, { recursive: true });
    const cliRun = runMainCapture(
      [...cliSnapshotMove!.command!.slice('rig-create '.length).split(/\s+/), cliScratch],
      CHAIN_NOW,
    );
    expect(cliRun.stderr).toBe('');
    expect(cliRun.code).toBe(0);
    expect(checkProject(cliScratch, undefined, { now: CHAIN_NOW, readOnly: true }).refusals).toEqual([]);

    // Route 2: API parts-verdict receipt (`rig-create/review-act@1`, uses serialized `bytes`).
    const apiDir = realpathSync(mkdtempSync(join(tmpdir(), 'create-next-parts-api-')));
    let host: JobOwnerHost | undefined;
    try {
      cpSync(join(CHECKPOINTS_DIR, '1-parts-verdict'), apiDir, { recursive: true });
      cpSync(join(CHAIN_DIR, 'evidence/diff-components.json'), join(apiDir, 'evidence/diff-components.json'));
      const proj = JSON.parse(readFileSync(join(apiDir, 'project.json'), 'utf8')) as Record<string, unknown>;
      proj.drafts = [];
      writeFileSync(join(apiDir, 'project.json'), `${JSON.stringify(proj, null, 2)}\n`);

      host = await openCreateJob(apiDir, { id: 'synthetic-owner', role: 'owner' }, Date.now());
      const draftChild = Bun.spawn(
        [
          process.execPath,
          ...jobRuntimeExecArgv(),
          join(REPO, 'src/cli.ts'),
          'draft-rig',
          'chain',
          '--config',
          'derived/drafts/chain/config.json',
          '--from',
          'derived/drafts/chain/out',
          '--parts',
          'derived/drafts/chain/input',
          '--json',
        ],
        { cwd: apiDir, stdout: 'pipe', stderr: 'pipe' },
      );
      const [, draftStderr, draftExit] = await Promise.all([
        new Response(draftChild.stdout).text(),
        new Response(draftChild.stderr).text(),
        draftChild.exited,
      ]);
      expect(draftStderr).toBe('');
      expect(draftExit).toBe(0);

      const publication = host.session.status().publication!;
      const askReq = {
        schema: 'rig-review/job-api@2',
        verb: 'ask',
        jobId: host.session.jobId,
        requestId: randomUUID(),
        idempotencyKey: randomUUID(),
        expectedGeneration: host.session.status().generation,
        publicationId: publication.publicationId,
        subject: { kind: 'parts-verdict', draftId: 'chain' },
      };
      const askRes = await host.ports.handleJobApi(
        new Request(`${host.origin}/jobs/${host.session.jobId}/api`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${host.session.hostCredentials().agent}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(askReq),
        }),
      );
      const asked = (await askRes.json()) as { ok: boolean; value: { askId: string } };
      expect(asked.ok).toBe(true);

      const pageId = randomUUID();
      const uiReq = (route: string, body: object) =>
        new Request(`${host!.origin}/jobs/${host!.session.jobId}/ui/${route}`, {
          method: 'POST',
          headers: {
            origin: host!.origin,
            'X-Review-Capability': host!.session.hostCredentials().ui,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
        });
      const displayed = await host.ports.ackDisplayed(
        host.session.jobId,
        uiReq('displayed', {
          publicationId: publication.publicationId,
          pageId,
          sourceHash: publication.source.sourceHash,
        }),
      );
      expect(displayed.ok).toBe(true);
      if (!displayed.ok) throw new Error(displayed.error.code);

      const committed = await host.ports.commitUIAct(
        host.session.jobId,
        uiReq('acts', {
          publicationId: publication.publicationId,
          askId: asked.value.askId,
          pageId,
          displayedNonce: displayed.value.displayedNonce,
          expectedGeneration: host.session.status().generation,
          submissionId: randomUUID(),
          kind: 'parts-verdict',
          value: {
            verdict: 'approved',
            issues: [],
            words: 'Synthetic API parts review.\n',
          },
        }),
      );
      expect(committed.ok).toBe(true);
      if (!committed.ok) throw new Error(committed.error.code);

      const prChild = Bun.spawn(
        [
          process.execPath,
          ...jobRuntimeExecArgv(),
          join(REPO, 'src/cli.ts'),
          'parts-review',
          '--from-review',
          committed.value.actId,
          '--json',
        ],
        { cwd: apiDir, stdout: 'pipe', stderr: 'pipe' },
      );
      const [, prStderr, prExit] = await Promise.all([
        new Response(prChild.stdout).text(),
        new Response(prChild.stderr).text(),
        prChild.exited,
      ]);
      expect(prStderr).toBe('');
      expect(prExit).toBe(0);

      const apiNow = Date.now();
      const apiReport = nextProject(apiDir, apiNow);
      const apiSnapshotMove = apiReport.moves.find(
        m => m.role === 'agent' && m.command?.startsWith('rig-create structure-snapshot'),
      );
      expect(apiSnapshotMove).toMatchObject({
        role: 'agent',
        field: 'drafts[chain]',
        awaits: 'evidence/structure.json',
        command: 'rig-create structure-snapshot --draft chain --out evidence/structure.json',
      });

      const apiScratch = join(tempDir(), 'parts-api-scratch');
      cpSync(apiDir, apiScratch, { recursive: true });
      const apiRun = runMainCapture(
        [...apiSnapshotMove!.command!.slice('rig-create '.length).split(/\s+/), apiScratch],
        apiNow,
      );
      expect(apiRun.stderr).toBe('');
      expect(apiRun.code).toBe(0);
      expect(checkProject(apiScratch, undefined, { now: apiNow, readOnly: true }).refusals).toEqual([]);
    } finally {
      host?.stop();
      rmSync(jobHostStateRoot(apiDir), { recursive: true, force: true });
      rmSync(apiDir, { recursive: true, force: true });
    }
  });

  test('plant 6 (withdrawn acceptance): when changes-requested follows accepted on rig-review or direction-review, the human review-verdict move reappears', () => {
    // rig-review: accepted followed by changes-requested
    const rigDir = join(tempDir(), 'rig-withdrawn');
    cpSync(join(CHECKPOINTS_DIR, '3-rig-review'), rigDir, { recursive: true });
    const bounceWords = join(rigDir, 'bounce.txt');
    writeFileSync(bounceWords, 'Please adjust the shoulder pivot.\n');
    testClock.set(new Date(CHAIN_NOW));
    reviewCommand([
      '1',
      rigDir,
      '--verdict',
      'accepted',
      '--by',
      'user',
      '--review',
      'rig-review',
      '--verbatim-file',
      join(rigDir, 'evidence/approval.txt'),
      '--source',
      'synthetic example',
    ]);
    // After acceptance alone, review-verdict is no longer awaited.
    expect(nextProject(rigDir, CHAIN_NOW).awaits).toEqual(['signoffs[stage=rig-review]']);

    // Now a human changes-requested (bounced) verdict withdraws the earlier acceptance.
    testClock.set(new Date(CHAIN_NOW + 1000));
    reviewCommand([
      '1',
      rigDir,
      '--verdict',
      'bounced',
      '--by',
      'user',
      '--review',
      'rig-review',
      '--verbatim-file',
      bounceWords,
      '--source',
      'synthetic bounce',
      '--item',
      'bones:user',
    ]);
    const rigReport = nextProject(rigDir, CHAIN_NOW + 1000);
    expect(rigReport.awaits).toContain('versions[n=1].verdicts[review=rig-review]');
    expect(rigReport.moves.find(m => m.review_act?.kind === 'review-verdict')).toMatchObject({
      role: 'human',
      field: 'versions[v1].verdicts',
      awaits: 'versions[n=1].verdicts[review=rig-review]',
      command: null,
      review_act: {
        kind: 'review-verdict',
        stage: 'rig-review',
        version_id: 'v1',
        review: 'rig-review',
      },
    });

    // direction-review: accepted followed by changes-requested (bounced) on post v2
    const postDir = join(tempDir(), 'post-withdrawn');
    cpSync(join(CHECKPOINTS_DIR, '4-direction-post'), postDir, { recursive: true });
    for (const rel of [
      'inputs/background.png',
      'evidence/scene-citations.json',
      'evidence/direction-input.json',
    ]) {
      cpSync(join(CHAIN_DIR, rel), join(postDir, rel));
    }
    testClock.set(new Date(CHAIN_NOW));
    expect(
      runMainCapture(
        [
          'input',
          'add',
          'inputs/background.png',
          '--origin',
          'synthetic background plate, generated by generateExampleParts',
          postDir,
        ],
        CHAIN_NOW,
      ).code,
    ).toBe(0);
    expect(
      runMainCapture(
        [
          'scene',
          'write',
          postDir,
          '--rig',
          '1',
          '--background',
          'inputs/background.png',
          '--citations-file',
          'evidence/scene-citations.json',
        ],
        CHAIN_NOW,
      ).code,
    ).toBe(0);
    expect(
      runMainCapture(
        ['direction', 'write', '2', postDir, '--file', 'evidence/direction-input.json', '--rig', '1'],
        CHAIN_NOW,
      ).code,
    ).toBe(0);
    expect(runMainCapture(['direction', 'check', '2', postDir, '--json'], CHAIN_NOW).code).toBe(0);
    expect(runMainCapture(['advance', 'direction-review', postDir], CHAIN_NOW).code).toBe(0);

    reviewCommand([
      '2',
      postDir,
      '--verdict',
      'accepted',
      '--by',
      'user',
      '--review',
      'direction-review',
      '--verbatim-file',
      join(postDir, 'evidence/approval.txt'),
      '--source',
      'synthetic example',
    ]);
    expect(nextProject(postDir, CHAIN_NOW).awaits).toEqual(['signoffs[stage=direction-review]']);

    const postBounceWords = join(postDir, 'bounce-post.txt');
    writeFileSync(postBounceWords, 'Tighten the final camera hold.\n');
    testClock.set(new Date(CHAIN_NOW + 2000));
    reviewCommand([
      '2',
      postDir,
      '--verdict',
      'bounced',
      '--by',
      'user',
      '--review',
      'direction-review',
      '--verbatim-file',
      postBounceWords,
      '--source',
      'synthetic direction bounce',
      '--item',
      'camera_depth:user',
    ]);

    const postReport = nextProject(postDir, CHAIN_NOW + 2000);
    expect(postReport.awaits).toContain('versions[n=2].verdicts[review=direction-review]');
    expect(postReport.moves.find(m => m.review_act?.kind === 'review-verdict')).toMatchObject({
      role: 'human',
      field: 'versions[v2].verdicts',
      awaits: 'versions[n=2].verdicts[review=direction-review]',
      command: null,
      review_act: {
        kind: 'review-verdict',
        stage: 'direction-review',
        version_id: 'v2',
        review: 'direction-review',
      },
    });
  });

  test('plant 7 (build/rig + build/render draft layout with inside figure mask): reuses draft diff-components report when sha matches and carries stack + --figure when re-run is required', () => {
    const dir = join(tempDir(), 'draft-build-layout');
    cpSync(join(CHECKPOINTS_DIR, '1-parts-verdict'), dir, { recursive: true });
    testClock.set(new Date(CHAIN_NOW));
    expect(
      runMainCapture(
        [
          'advance',
          'parts-review',
          '--parts-check',
          'evidence/parts-check.json',
          '--parts',
          'derived/drafts/chain/input',
          dir,
        ],
        CHAIN_NOW,
      ).code,
    ).toBe(0);

    // Construct a draft shaped like real draft output (`build/rig/` + `build/render/`).
    const draftId = 'scene-draft';
    const draftRoot = join(dir, 'derived/drafts', draftId);
    const buildRig = join(draftRoot, 'build/rig');
    const buildRender = join(draftRoot, 'build/render');
    const buildOut = join(draftRoot, 'build/out');
    mkdirSync(join(buildRig, 'parts'), { recursive: true });
    mkdirSync(buildRender, { recursive: true });
    cpSync(join(dir, 'derived/drafts/chain/config.json'), join(draftRoot, 'config.json'));
    cpSync(
      join(dir, 'derived/drafts/chain/interview-requirements.json'),
      join(draftRoot, 'interview-requirements.json'),
    );
    cpSync(join(dir, 'derived/drafts/chain/out'), buildOut, { recursive: true });
    cpSync(join(dir, 'derived/drafts/chain/input/parts'), join(buildRig, 'parts'), { recursive: true });
    cpSync(
      join(dir, 'derived/drafts/chain/input/painting_in_rig.png'),
      join(buildRig, 'painting_in_rig.png'),
    );
    // The stack sits ONLY in build/render/, not beside parts.json in build/rig/.
    cpSync(
      join(dir, 'derived/drafts/chain/input/recomposite_rig.png'),
      join(buildRender, 'recomposite_rig.png'),
    );

    // Generate a binary figure_rig.png mask (128x128: top half opaque white, bottom half opaque black).
    const load = createRequire(import.meta.url);
    const { encodePng } = load('@rig-c/core/plate') as {
      encodePng: (w: number, h: number, rgba: Uint8Array) => Uint8Array;
    };
    const W = 128;
    const H = 128;
    const figureRgba = new Uint8Array(W * H * 4);
    const expectedInside = new Uint8Array(W * H);
    for (let p = 0; p < W * H; p++) {
      const inside = p < (W * H) / 2 ? 1 : 0;
      expectedInside[p] = inside;
      const v = inside === 1 ? 255 : 0;
      figureRgba[p * 4] = v;
      figureRgba[p * 4 + 1] = v;
      figureRgba[p * 4 + 2] = v;
      figureRgba[p * 4 + 3] = 255;
    }
    const expectedInsideSha = sha256(expectedInside);
    const figurePng = encodePng(W, H, figureRgba);
    writeFileSync(join(buildRender, 'figure_rig.png'), figurePng);
    writeFileSync(join(buildRig, 'figure_rig.png'), figurePng);

    const partsManifest = JSON.parse(
      readFileSync(join(dir, 'derived/drafts/chain/input/parts.json'), 'utf8'),
    ) as Record<string, unknown>;
    partsManifest.scene = {
      figure_alpha_above: 128,
      figure_px: (W * H) / 2,
      figure_mask: 'figure_rig.png',
    };
    writeFileSync(join(buildRig, 'parts.json'), `${JSON.stringify(partsManifest, null, 2)}\n`);

    // Record the draft via create's draft-rig writer.
    const recordRes = runMainCapture(
      [
        'draft-rig',
        draftId,
        dir,
        '--config',
        `derived/drafts/${draftId}/config.json`,
        '--from',
        `derived/drafts/${draftId}/build/out`,
        '--parts',
        `derived/drafts/${draftId}/build/rig`,
      ],
      CHAIN_NOW + 1000,
    );
    expect(recordRes.stderr).toBe('');
    expect(recordRes.code).toBe(0);

    // Produce the draft's own diff-components report using the installed rig-parts CLI.
    const rigPartsBin = join(REPO, 'node_modules/@rig-c/parts/bin/rig-parts.cjs');
    const draftDiffRun = Bun.spawnSync(
      [
        process.execPath,
        rigPartsBin,
        'diff-components',
        '--stack',
        `derived/drafts/${draftId}/build/render/recomposite_rig.png`,
        '--painting',
        'inputs/painting.png',
        '--parts',
        `derived/drafts/${draftId}/build/rig/parts.json`,
        '--figure',
        `derived/drafts/${draftId}/build/render/figure_rig.png`,
        '--floor',
        '2',
        '--threshold',
        '40',
        '--out',
        `derived/drafts/${draftId}/diff-components.json`,
      ],
      { cwd: dir, stdout: 'pipe', stderr: 'pipe' },
    );
    expect(draftDiffRun.exitCode).toBe(0);

    const beforeCheck = checkProject(dir, undefined, { now: CHAIN_NOW + 1000, readOnly: true });
    expect(beforeCheck.refusals).toEqual([]);

    // Route 1: Draft's own report exists over the same stack and painting sha256 -> move points at it.
    const reportWithOwnDiff = nextProject(dir, CHAIN_NOW + 1000);
    const copyMove = reportWithOwnDiff.moves.find(m => m.role === 'producer');
    expect(copyMove).toMatchObject({
      role: 'producer',
      field: `drafts[${draftId}].parts`,
      awaits: 'evidence/diff-components.json',
      command: `cp derived/drafts/${draftId}/diff-components.json evidence/diff-components.json`,
    });

    const copyExec = Bun.spawnSync(copyMove!.command!.split(/\s+/), {
      cwd: dir,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(copyExec.exitCode).toBe(0);
    const copiedReport = JSON.parse(
      readFileSync(join(dir, 'evidence/diff-components.json'), 'utf8'),
    ) as { definition: { inside_sha256: string | null } };
    expect(copiedReport.definition.inside_sha256).toBe(expectedInsideSha);
    expect(nextProject(dir, CHAIN_NOW + 1000).awaits).not.toContain('evidence/diff-components.json');
    const afterCopyCheck = checkProject(dir, undefined, { now: CHAIN_NOW + 1000, readOnly: true });
    expect(afterCopyCheck.refusals).toEqual(beforeCheck.refusals);

    // Route 2: Without the draft's own report, next emits rig-parts diff-components with the real stack path and --figure.
    rmSync(join(dir, 'evidence/diff-components.json'));
    rmSync(join(draftRoot, 'diff-components.json'));

    const reportWithoutOwnDiff = nextProject(dir, CHAIN_NOW + 1000);
    const rerunMove = reportWithoutOwnDiff.moves.find(m => m.role === 'producer');
    expect(rerunMove).toMatchObject({
      role: 'producer',
      field: `drafts[${draftId}].parts`,
      awaits: 'evidence/diff-components.json',
      command: `rig-parts diff-components --stack derived/drafts/${draftId}/build/render/recomposite_rig.png --painting inputs/painting.png --parts derived/drafts/${draftId}/build/rig/parts.json --figure derived/drafts/${draftId}/build/render/figure_rig.png --floor 2 --threshold 40 --out evidence/diff-components.json`,
    });

    const rerunArgs = rerunMove!.command!.slice('rig-parts '.length).split(/\s+/);
    const rerunExec = Bun.spawnSync([process.execPath, rigPartsBin, ...rerunArgs], {
      cwd: dir,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(rerunExec.exitCode).toBe(0);
    const rerunReport = JSON.parse(
      readFileSync(join(dir, 'evidence/diff-components.json'), 'utf8'),
    ) as { definition: { inside_sha256: string | null } };
    expect(rerunReport.definition.inside_sha256).toBe(expectedInsideSha);
    expect(nextProject(dir, CHAIN_NOW + 1000).awaits).not.toContain('evidence/diff-components.json');
    const afterRerunCheck = checkProject(dir, undefined, { now: CHAIN_NOW + 1000, readOnly: true });
    expect(afterRerunCheck.refusals).toEqual(beforeCheck.refusals);
  });

  test('plant 8 (parts-review agent diff-classes move): when evidence/diff-components.json is present without project.diff_map, next emits the agent diff-classes move and keeps signoff human-only', () => {
    const dir = join(tempDir(), 'diff-classes-move');
    cpSync(join(CHECKPOINTS_DIR, '1-parts-verdict'), dir, { recursive: true });
    cpSync(join(CHAIN_DIR, 'evidence/diff-components.json'), join(dir, 'evidence/diff-components.json'));
    testClock.set(new Date(CHAIN_NOW));
    expect(
      runMainCapture(
        [
          'advance',
          'parts-review',
          '--parts-check',
          'evidence/parts-check.json',
          '--parts',
          'derived/drafts/chain/input',
          dir,
        ],
        CHAIN_NOW,
      ).code,
    ).toBe(0);

    const report = nextProject(dir, CHAIN_NOW + 1000);
    expect(report.awaits).toContain('diff_map');
    const diffMove = report.moves.find(m => m.field === 'diff_map');
    expect(diffMove).toEqual({
      role: 'agent',
      field: 'diff_map',
      awaits: 'diff_map',
      act: 'record agent component classification for evidence/diff-components.json in diff_map',
      command:
        'rig-create diff-classes --diff-report evidence/diff-components.json --by agent',
    });
    const signoffMove = report.moves.find(m => m.review_act?.kind === 'signoff');
    expect(signoffMove).toMatchObject({
      role: 'human',
      field: 'signoffs',
      awaits: 'signoffs[stage=parts-review]',
      command: null,
      review_act: { kind: 'signoff', stage: 'parts-review', draft_id: 'chain' },
    });

    const execArgs = diffMove!.command!.slice('rig-create '.length).split(/\s+/);
    const execRes = runMainCapture([execArgs[0]!, dir, ...execArgs.slice(1)], CHAIN_NOW + 1000);
    expect(execRes.stderr).toBe('');
    expect(execRes.code).toBe(0);

    const afterReport = nextProject(dir, CHAIN_NOW + 1000);
    expect(afterReport.awaits).not.toContain('diff_map');
    expect(afterReport.moves.find(m => m.field === 'diff_map')).toBeUndefined();
  });

  test('usage errors refuse with NEXT_USAGE and exit 2', () => {
    expect(() => nextCommand(['--bogus'], CHAIN_NOW)).toThrow(Refusal);
    try {
      nextCommand(['--bogus'], CHAIN_NOW);
    } catch (err) {
      expect(err).toBeInstanceOf(Refusal);
      expect((err as Refusal).code).toBe('NEXT_USAGE');
      expect((err as Refusal).exitCode).toBe(USAGE_EXIT);
    }
    const cliRes = runMainCapture(['next', 'a', 'b'], CHAIN_NOW);
    expect(cliRes.code).toBe(USAGE_EXIT);
    expect(cliRes.stderr).toContain('NEXT_USAGE');
  });
});


test('P1 withdrawn checkpoint next offers executable done through the normal entry', () => {
  testClock.set('2026-11-20T00:00:00Z');
  const dir = fixture(project => {
    project.stage = 'parts'; project.versions = [];
    project.signoffs = arr(project.signoffs).slice(0, 2);
    retimeFixture(project, Date.parse('2026-11-16T00:00:00Z'));
    for (const raw of arr(obj(project.plan).steps)) obj(raw).status = 'pending';
  });
  const words = join(dir, 'withdraw-words.txt'); const reason = join(dir, 'withdraw-reason.txt');
  writeFileSync(words, 'Keep this evidence for parts review.'); writeFileSync(reason, 'Retire the synthetic checkpoint.');
  stepStatusCommand(['assemble', 'in-progress', dir, '--by', 'agent']);
  stepStatusCommand(['assemble', 'at-checkpoint', dir, '--by', 'agent']);
  const before = JSON.parse(runMainCapture(['next', dir, '--json'], testClock.now()).stdout) as NextReport;
  expect(before.moves.some(move => move.review_act?.kind === 'signoff-checkpoint' && move.review_act.step_id === 'assemble')).toBe(true);
  expect(planCommand(['checkpoint-withdraw', 'assemble', dir, '--by', 'operator', '--reason-file', reason, '--quote-file', words]).exit).toBe(0);
  const bytes = readFileSync(join(dir, 'project.json'));
  const result = runMainCapture(['next', dir, '--json'], testClock.now());
  expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: '' });
  const after = JSON.parse(result.stdout) as NextReport;
  expect(after.refusals).toEqual([]);
  expect(after.moves.some(move => move.review_act?.kind === 'signoff-checkpoint' && move.review_act.step_id === 'assemble')).toBe(false);
  expect(after.awaits).not.toContain('signoffs[checkpoint=assemble]');
  const done = after.moves.find(move => move.command?.startsWith('rig-create step-status assemble done'));
  expect(done).toBeDefined();
  expect(readFileSync(join(dir, 'project.json'))).toEqual(bytes);
  const executed = runMainCapture([...done!.command!.slice('rig-create '.length).split(/\s+/), dir], testClock.now());
  expect({ code: executed.code, stderr: executed.stderr }).toEqual({ code: 0, stderr: '' });
});
