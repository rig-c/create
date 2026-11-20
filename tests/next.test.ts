import { afterEach, describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { ActV3, JobOwnerHost } from '@rig-c/review/job-host';
import { main } from '../src/cli.ts';
import { reopenCommand as ingestReopen } from '../src/reopen.ts';
import { exportedReopen } from './reopen-act-fixture.ts';
import { checkProject } from '../src/check.ts';
import { openCreateJob } from '../src/job-host.ts';
import { readRecordPublished } from '../src/job-publication.ts';
import { stageIndex } from '../src/stages.ts';
import { JOB_BINDING_FILE, jobHostStateRoot } from '../src/job-outbox.ts';
import { jobRuntimeExecArgv } from '../src/job-writer.ts';
import { baselineOf, newFindings } from '../src/refusal-baseline.ts';
import { partsStructureSnapshot, pendingJobActs } from '../src/job-acts.ts';
import { freshProjectRecord } from '../src/init.ts';
import { renderAgentGuide } from '../src/agent-guide.ts';
import { optionContext } from '../src/choices.ts';
import { NEXT_SCHEMA, nextCommand, nextProject, type NextReport } from '../src/next.ts';
import { Refusal, USAGE_EXIT } from '../src/refusal.ts';
import { EXAMPLE_NOW } from '../scripts/example-time.ts';
import { planCommand, stepStatusCommand, amendCommand, reopenCommand, reviewCommand, signoffCommand, testClock } from './clock.ts';
import { arr, fixture, obj, retimeFixture, retainSignoffs } from './fixtures.ts';
import { tempDir, ownerChatArgs } from './helpers.ts';
import { recordPartsReceipt } from './parts-receipt-fixture.ts';
import { latestPartsVerdictStatus } from '../src/parts-verdict-record.ts';
import { selectAnswerHashes } from '../src/signoff-answers.ts';
import type { JsonObject } from '../src/templates.ts';

const REPO = join(import.meta.dir, '..');
const CHAIN_DIR = join(REPO, 'templates/example-chain');
const CHECKPOINTS_DIR = join(CHAIN_DIR, 'checkpoints');
const REMESH_DIR = join(REPO, 'templates/example-remesh');
const CHAIN_NOW = EXAMPLE_NOW;

afterEach(() => testClock.reset());

test('#467 next routes direction verdict ingest to record-page sign-off', () => {
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
  expect(pendingSignoff?.act).toContain('after ingesting the accepted direction-review verdict for v2');
  expect(pendingSignoff?.act).toContain('job open --plan');

  post.verdicts = accepted!;
  writeFileSync(file, `${JSON.stringify(project, null, 2)}\n`);
  const after = nextProject(dir, CHAIN_NOW);
  expect(after.refusals).toEqual([]);
  expect(after.moves.some(move => move.review_act?.kind === 'review-verdict' && move.review_act.stage === 'direction-review')).toBe(false);
  const blockedSignoff = after.moves.find(move => move.review_act?.kind === 'signoff' && move.review_act.stage === 'direction-review');
  expect(blockedSignoff).toBeDefined();
  expect(blockedSignoff?.act).toContain('ingest signoff direction-review --from-review <actId>, then advance accepted');
  expect(blockedSignoff).toMatchObject({
    command: null,
    act: expect.stringContaining('record page with job open --plan'),
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

function printedArgs(command: string): string[] {
  const words: string[] = [];
  let word = '', quote = '', started = false;
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;
    if (quote) {
      if (char === quote) quote = '';
      else word += char;
      started = true;
    } else if (char === "'" || char === '"') { quote = char; started = true; }
    else if (char === '\\') { word += command[++i]!; started = true; }
    else if (/\s/.test(char)) { if (started) { words.push(word); word = ''; started = false; } }
    else { word += char; started = true; }
  }
  expect(quote).toBe('');
  if (started) words.push(word);
  return words;
}

function preparePrintedOptions(dir: string, command: string, now: number): string[] {
  const argv = printedArgs(command).slice(1);
  if (argv[0] === 'scene') {
    const project = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
    const item = arr(obj(obj(project.interview).post).items).map(obj).find(item => item.id === 'post_composition')!;
    const guide = obj(item.guide);
    const background = String(obj(obj(obj(guide.value).scene).background).path);
    if (!existsSync(join(dir, background))) {
      cpSync(join(CHAIN_DIR, 'inputs/background.png'), join(dir, background));
      expect(runMainCapture(['input', 'add', background, dir, '--origin', 'synthetic prepared scene plate'], now)).toMatchObject({ code: 0, stderr: '' });
    }
    writeFileSync(join(dir, 'evidence/printed-scene-citations.json'), JSON.stringify({ background: {
      guide: 'post_composition', asks: ['post_composition'], quote: guide.verbatim,
    } }));
    return argv.map(arg => arg === '<background.png>' ? background
      : arg === '<scene-citations.json>' ? 'evidence/printed-scene-citations.json' : arg);
  }
  if (argv[0] === 'direction' && argv[1] === 'write') {
    const project = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
    const doc = JSON.parse(readFileSync(join(CHAIN_DIR, 'evidence/direction/v2.json'), 'utf8')) as JsonObject;
    const scene = obj(arr(project.scenes).at(-1));
    doc.scene = { n: scene.n!, path: scene.path!, sha256: scene.sha256! };
    writeFileSync(join(dir, 'evidence/printed-direction.json'), JSON.stringify(doc));
    return argv.map(arg => arg === '<direction.json>' ? 'evidence/printed-direction.json' : arg);
  }
  if (argv[0] !== 'interview-options') return argv;
  const project = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
  const question = argv[1]!;
  const set = JSON.parse(readFileSync(join(CHAIN_DIR, `evidence/interview/${question}.json`), 'utf8')) as JsonObject;
  set.id = `printed-${question}`;
  set.drafted_at = new Date(now).toISOString();
  set.context = optionContext(project, String(set.stage), now, dir);
  const file = 'evidence/printed-options.json';
  writeFileSync(join(dir, file), JSON.stringify(set));
  return argv.map(arg => arg === '<option-set.json>' ? file : arg);
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
      // Compare the checkpoint's original moves; exported-act execution tests
      // separately exercise the four commands surrounding each human move.
      const chatMoves=report.moves.filter(move=>move.command?.includes('--owner-chat'));
      for(const move of chatMoves){
        expect(move.role).toBe('human');expect(move.command).toContain('--said-at');expect(move.command).toContain('--relayed-by');
      }
      report.moves = report.moves.filter(move => !move.command?.startsWith('rig-create job ')
        && !move.command?.includes('--from-review') && !move.command?.includes('--owner-chat'));
      const project = JSON.parse(readFileSync(join(cpDir, 'project.json'), 'utf8')) as Record<string, unknown>;

      expect(report.schema).toBe(NEXT_SCHEMA);
      expect(report.stage).toBe(String(project.stage));

      if (spec.name === '0a-interview-options') {
        // The question's registered set takes precedence over the frozen signoff move.
        expect(report.awaits).toEqual(spec.pending.awaits.filter(field => field !== 'signoffs[stage=interview]'));
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
        expect(report.moves.some(move => move.review_act?.kind === 'signoff' && move.review_act.stage === 'interview')).toBe(false);
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
        // The frozen checkpoint predates #557: evidence now comes before the
        // advance, and the owner is asked only after that advance is recorded.
        expect(project.review_acts ?? []).toEqual([]);
        expect(report.moves.find(m => m.role === 'agent')).toMatchObject({
          field: 'drafts[chain]', awaits: 'evidence/structure-chain.json',
          command: `rig-create structure-snapshot ${cpDir} --draft chain`,
        });
        expect(report.moves.find(m => m.role === 'producer')?.command).toBe(
          `rig-parts diff-components --stack ${cpDir}/derived/drafts/chain/input/recomposite_rig.png --painting ${cpDir}/inputs/painting.png --parts ${cpDir}/derived/drafts/chain/input/parts.json --floor 2 --threshold 40 --out ${cpDir}/evidence/diff-components.json`,
        );
        expect(report.moves.some(m => m.command?.startsWith('rig-create advance parts-review'))).toBe(false);
        expect(report.moves.some(m => m.review_act?.kind === 'parts-verdict')).toBe(false);
        expect(report.moves.some(m => m.review_act?.kind === 'signoff')).toBe(false);
      } else if (spec.name === '2-rigging-answers') {
        expect(report.awaits).toEqual(spec.pending.awaits.filter(field => field !== 'signoffs[stage=rigging-interview]'));
        expect(report.refusals.map(r => [r.code, r.field])).toEqual([
          ['INTERVIEW_INCOMPLETE', 'interview.waypoints[bones].guide'],
          ['INTERVIEW_INCOMPLETE', 'interview.waypoints[meshes].guide'],
          ['INTERVIEW_INCOMPLETE', 'interview.waypoints[constraints].guide'],
          ['INTERVIEW_INCOMPLETE', 'interview.waypoints[turn].guide'],
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
        expect(report.moves[3]?.unanswered_by_record).toBe('interview.waypoints[turn].pending_options');
        expect(report.moves[4]?.unanswered_by_record).toBe('interview.waypoints[motion].pending_options');
      } else if (spec.name === '3-rig-review') {
        // The generated historical pending fixture lists two acts; a fresh job now folds approval.
        expect(report.awaits).toEqual(['versions[n=1].verdicts[review=rig-review]']);
        expect(report.moves.map(m => String(m.role))).toEqual(['human']);
        expect(report.moves[0]).toMatchObject({
          role: 'human',
          field: 'versions[v1].verdicts',
          awaits: 'versions[n=1].verdicts[review=rig-review]',
          command: null,
          review_act: { kind: 'review-verdict', stage: 'rig-review', version_id: 'v1', review: 'rig-review' },
        });
        expect(report.moves).toHaveLength(1);
        expect(report.moves[0]!.act).toContain('approve once');
      } else if (spec.name === '4-direction-post') {
        // The runnable agent move matches pending.commands[7] verbatim (`rig-create advance direction-review`),
        // and its role is 'agent' (decided by stage="post", plan.steps all done, signoffs[6]),
        // whereas pending.command_roles[7] mislabelled advance as 'human'.
        const agentMove = report.moves.find(m => m.role === 'agent');
        expect(agentMove?.command).toBe(`rig-create scene write ${cpDir} --rig 1 --background '<background.png>' --citations-file '<scene-citations.json>'`);
        expect(report.moves.some(move => move.command?.includes('advance direction-review'))).toBe(false);
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
  test('every standalone agent move executes with exit 0, no new refusals, and clean inputs stay clean', () => {
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
      for (const [moveIndex, move] of agentMoves.entries()) {
        // Review workflows require one live host and a human export between commands;
        // their complete ordered execution is covered in job-acts.test.ts (#502).
        if (move.command?.startsWith('rig-create job ') || move.command?.includes('--from-review')) continue;
        expect(typeof move.command).toBe('string');
        expect(move.command!.startsWith('rig-create ')).toBe(true);
        const scratch = join(tempDir(), 'scratch');
        cpSync(target.dir, scratch, { recursive: true });
        const printed = nextProject(scratch, target.now).moves.filter(m => m.role === 'agent')[moveIndex]!.command!;
        const argv = preparePrintedOptions(scratch, printed, target.now);
        const run = runMainCapture(argv, target.now);
        expect(run.stderr, `${target.name} -> ${move.command}`).toBe('');
        expect(run.code, `${target.name} -> ${move.command}`).toBe(0);
        const afterCheck = checkProject(scratch, undefined, { now: target.now, readOnly: true });
        const beforeCheck = checkProject(target.dir, undefined, { now: target.now, readOnly: true });
        expect(newFindings(baselineOf(beforeCheck), afterCheck.refusals), `${target.name} -> ${move.command} new refusals`).toEqual([]);
        if (beforeCheck.refusals.length === 0) expect(afterCheck.refusals).toEqual([]);
        executedCount++;
      }
    }
    expect(executedCount).toBeGreaterThanOrEqual(3);
  });
});

describe('Frozen Bar 3 — Agent commands never invent human acts', () => {
  const FORBIDDEN_WRITERS = [
    /^rig-create\s+signoff\b(?!.*--from-review\b)/,
    /^rig-create\s+review\b(?!.*--from-review\b)/,
    /^rig-create\s+parts-review\b(?!.*--from-review\b)/,
    /^rig-create\s+interview-answer\b(?!.*--from-review\b)/,
    /^rig-create\s+reopen\b/,
    /^rig-create\s+pause\b/,
    /^rig-create\s+resume\b/,
    /^rig-create\s+amend\b/,
    /--by\s+user\b/,
    /--by\s+owner\b/,
  ];

  test('agent moves never record human acts and ordinary Review acts retain tool routing', () => {
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
          if(move.command!==null){
            expect(move.command).toMatch(/^rig-create (?:interview-answer|signoff) /);
            for(const flag of ['--owner-chat','--said-at','--relayed-by'])expect(move.command).toContain(flag);
            expect(move.command).not.toContain('--from-review');
          } else expect(move.command).toBeNull();
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
    reopenCommand(['parts', dir, '--by', 'owner', ...ownerChatArgs(words)]);

    const report = nextProject(dir, reopenAt);
    expect(report.refusals).toEqual([]);
    const lapseMoves = report.moves.filter(m => m.lapse !== undefined && !m.command?.includes('--owner-chat'));
    for(const move of report.moves.filter(m=>m.lapse && m.command?.includes('--owner-chat'))){
      expect(move.role).toBe('human');expect(move.act).toContain(move.lapse!.code);expect(move.command).toContain('--said-at');
    }
    expect(lapseMoves.map(m => [m.role, m.field, m.lapse?.code, m.lapse?.target_field])).toEqual([
      ['human', 'reopens[0]', 'REOPEN_SIGNOFF_LAPSED', 'signoffs[2]'],
      ['human', 'reopens[0]', 'REOPEN_SIGNOFF_LAPSED', 'signoffs[3]'],
      ['human', 'reopens[0]', 'REOPEN_SIGNOFF_LAPSED', 'signoffs[4]'],
      ['human', 'reopens[0]', 'REOPEN_SIGNOFF_LAPSED', 'signoffs[6]'],
    ]);
    for (const move of lapseMoves) {
      expect(move.command).toBeNull();
      expect(move.act).toContain('reopens[0]');
      expect(move.act).toContain(move.lapse!.code);
    }

    // Also verify example-remesh (which is reopened to parts-review).
    const remeshReport = nextProject(REMESH_DIR, CHAIN_NOW);
    const remeshLapses = remeshReport.moves.filter(m => m.lapse !== undefined && !m.command?.includes('--owner-chat'));
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
      command: `rig-create advance parts ${dir}`,
    });

    const scratch = join(tempDir(), 'stage-lagging-scratch');
    cpSync(dir, scratch, { recursive: true });
    const argv = printedArgs(advanceMove!.command!).slice(1);
    const run = runMainCapture(argv.map(arg => arg === dir ? scratch : arg), CHAIN_NOW);
    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    const afterCheck = checkProject(scratch, undefined, { now: CHAIN_NOW, readOnly: true });
    expect(afterCheck.refusals).toEqual([]);
  });

  test('plant 5 (parts-verdict receipts): legacy CLI approval retains snapshot repair; API approval follows prepared evidence', async () => {
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
      awaits: 'evidence/structure-chain.json',
      command: `rig-create structure-snapshot ${cliDir} --draft chain`,
    });
    const cliScratch = join(tempDir(), 'parts-cli-scratch');
    cpSync(cliDir, cliScratch, { recursive: true });
    const cliRun = runMainCapture(
      printedArgs(cliSnapshotMove!.command!).slice(1).map(arg => arg === cliDir ? cliScratch : arg),
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

      for (const args of [
        ['structure-snapshot', apiDir, '--draft', 'chain', '--out', 'evidence/structure-chain.json'],
        ['diff-classes', apiDir, '--diff-report', 'evidence/diff-components.json', '--by', 'agent'],
        ['advance', 'parts-review', apiDir, '--parts-check', 'evidence/parts-check.json', '--parts', 'derived/drafts/chain/input'],
        ['job', 'open', apiDir, '--reviewer', 'synthetic-owner', '--role', 'owner'],
      ]) {
        const child = Bun.spawn([process.execPath, ...jobRuntimeExecArgv(), join(REPO, 'src/cli.ts'), ...args],
          { cwd: apiDir, stdout: 'pipe', stderr: 'pipe' });
        const [stderr, exit] = await Promise.all([new Response(child.stderr).text(), child.exited, new Response(child.stdout).text()]);
        expect({ exit, stderr }).toEqual({ exit: 0, stderr: '' });
      }
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
      expect(apiReport.moves.some(move => move.command?.startsWith('rig-create structure-snapshot'))).toBe(false);
      expect(apiReport.moves.some(move => move.review_act?.kind === 'signoff' && move.review_act.stage === 'parts-review')).toBe(false);
      const recorded = JSON.parse(readFileSync(join(apiDir, 'project.json'), 'utf8')) as JsonObject;
      expect(arr(recorded.signoffs).map(obj)).toContainEqual(expect.objectContaining({ stage: 'parts-review', draft_id: 'chain' }));
      expect(checkProject(apiDir, undefined, { now: apiNow, readOnly: true }).refusals.map(f => f.code)).toEqual(['STAGE_LAGGING']);
    } finally {
      host?.stop();
      rmSync(jobHostStateRoot(apiDir), { recursive: true, force: true });
      rmSync(apiDir, { recursive: true, force: true });
    }
  });

  test('plant 6 (human bounce): rig and direction reviews name the agent rebuild instead of stale human acts', async () => {
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
    expect(rigReport.moves).toHaveLength(1);
    expect(rigReport.moves[0]).toMatchObject({ role: 'agent', field: 'versions', awaits: 'versions[n=2]' });
    expect(rigReport.moves[0]!.command).toContain('rig-version 2');
    expect(rigReport.moves[0]!.command).toContain("--check-report '<check.json>'");
    expect(rigReport.moves[0]!.command).toContain('--answers 1:1');
    expect(printedArgs(rigReport.moves[0]!.command!).slice(1, 4)).toEqual(['rig-version', '2', rigDir]);
    expect(rigReport.moves[0]!.act).toContain('answers_feedback');
    // Reuse the existing synthetic registration cohort, with no producer run.
    cpSync(join(REPO, 'tests/fixtures/rig-registration'), join(rigDir, 'rebuild-source'), { recursive: true });
    const putRebuild = (path: string, value: unknown): void => writeFileSync(join(rigDir, 'rebuild-source', path),
      typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value));
    putRebuild('config.json', { key: 'synthetic', requirements: 'requirements.json' });
    putRebuild('requirements.json', { spec: 'spine-parts-requirements/1', fps: 4, requirements: [], setup_painting: { required: true } });
    putRebuild('adapter.json', []);
    putRebuild('check.json', { spec: 'rig-parts-check/1', bar_outcomes: { gate: { status: 'PASS' } },
      build: { model_sha256: sha256(readFileSync(join(rigDir, 'rebuild-source/build/skeleton.model.json'))) } });
    cpSync(join(rigDir, 'derived/drafts/chain/input'), join(rigDir, 'rebuild-source/parts'), { recursive: true });
    putRebuild('run.json', { spec: 'rigc-run/1', package: { name: 'rig-c', version: '3.4.1' }, command: 'build',
      started_at: '2026-11-06T20:44:40.000Z', finished_at: '2026-11-06T20:44:41.000Z',
      inputs: [{ role: 'rig', path: '../rig/rig.json', sha256: '1'.repeat(64) }, { role: 'motion', path: '../rig/motion.json', sha256: '2'.repeat(64) }],
      outputs: [{ path: '../compile-report.json', sha256: '3'.repeat(64) }, { path: 'skeleton.model.json', sha256: '4'.repeat(64) }] });
    const bindings: Record<string, string> = { '--parts': 'parts', '--rig': 'rig', '--build': 'build', '--idle': 'idle',
      '--config': 'config.json', '--path-adapter': 'adapter.json', '--compile-report': 'compile-report.json', '--check-report': 'check.json',
      '--toolchain-lock': 'package-lock.json', '--run-record': 'run.json', '--at-source': 'at-source.json' };
    const rigArgs = printedArgs(rigReport.moves[0]!.command!).slice(1);
    for (const [index, arg] of rigArgs.entries()) {
      if (arg.startsWith('<')) rigArgs[index] = bindings[rigArgs[index - 1]!] ? `rebuild-source/${bindings[rigArgs[index - 1]!]}`
        : arg === '<pointer>' ? '/finished_at' : 'registrant';
    }
    const beforeRigRebuild = checkProject(rigDir, undefined, { now: CHAIN_NOW + 1000, readOnly: true });
    expect(runMainCapture(rigArgs, CHAIN_NOW + 1000)).toMatchObject({ code: 0, stderr: '' });
    const afterRigRebuild = checkProject(rigDir, undefined, { now: CHAIN_NOW + 1000, readOnly: true });
    expect(newFindings(baselineOf(beforeRigRebuild), afterRigRebuild.refusals)).toEqual([]);
    expect(afterRigRebuild.refusals).toEqual([]);


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

    const beforeReopen = readFileSync(join(postDir, 'project.json'));
    const closedReport = nextProject(postDir, CHAIN_NOW + 2000);
    expect(closedReport.moves).toHaveLength(5);
    expect(closedReport.moves.find(move => move.role === 'human')).toMatchObject({ field: 'reopens', awaits: 'reopens[stage=direction-review]',
      review_act: { kind: 'reopen', stage: 'direction-review' }, command: null });
    const commands = closedReport.moves.filter(move => move.role === 'agent').map(move => move.command!);
    expect(commands).toEqual([
      `rig-create job open ${postDir} --plan --reviewer '<reviewer>' --role owner`,
      `rig-create job acts ${postDir} --json`,
      `rig-create reopen direction-review ${postDir} --from-review '<actId>'`,
      `rig-create job close ${postDir}`,
    ]);
    expect(JSON.stringify(closedReport)).not.toContain('Until create#493');
    expect(closedReport.moves.some(move => move.command?.includes('direction write'))).toBe(false);
    expect(readFileSync(join(postDir, 'project.json'))).toEqual(beforeReopen);
    const exported = await exportedReopen(postDir, 'direction-review', CHAIN_NOW + 3000);
    const reopenArgs = printedArgs(commands[2]!).slice(2).map(arg => arg === '<actId>' ? exported.act.actId : arg);
    const previousCwd = process.cwd();
    try {
      process.chdir(tempDir());
      expect(ingestReopen(reopenArgs, CHAIN_NOW + 3000, { fetch: () => ({ bytes: exported.bytes }) }).exit).toBe(0);
    } finally { process.chdir(previousCwd); }
    const reopened = JSON.parse(readFileSync(join(postDir, 'project.json'), 'utf8')) as JsonObject;
    // The unit fixture's injected read grant has no host; model the printed job close before the next writer.
    rmSync(join(postDir, JOB_BINDING_FILE));
    expect(obj(arr(reopened.reopens).at(-1))).toMatchObject({ by: exported.act.authority.reviewer.id, verbatim: exported.act.value.words, source: `review act ${exported.act.jobId}/${exported.act.actId}` });
    expect(checkProject(postDir, undefined, { now: CHAIN_NOW + 3000, readOnly: true }).warnings.map(row => row.code)).toContain('FEEDBACK_OPEN');
    const postReport = nextProject(postDir, CHAIN_NOW + 3000);
    expect(postReport.moves).toHaveLength(1);
    expect(postReport.moves[0]).toMatchObject({ role: 'agent', field: 'versions', awaits: 'versions[n=3]' });
    expect(postReport.moves[0]!.command).toContain('direction write 3');
    expect(postReport.moves[0]!.command).toContain('--answers 2:1');
    const rebuiltArgs = printedArgs(postReport.moves[0]!.command!).slice(1).map(arg =>
      arg === '<direction.json>' ? 'evidence/direction-input.json' : arg === '<rig-version>' ? '1' : arg);
    expect(rebuiltArgs.slice(0, 4)).toEqual(['direction', 'write', '3', postDir]);
    const beforeRebuild = checkProject(postDir, undefined, { now: CHAIN_NOW + 3000, readOnly: true });
    expect(runMainCapture(rebuiltArgs, CHAIN_NOW + 3000)).toMatchObject({ code: 0, stderr: '' });
    const afterRebuild = checkProject(postDir, undefined, { now: CHAIN_NOW + 3000, readOnly: true });
    expect(newFindings(baselineOf(beforeRebuild), afterRebuild.refusals)).toEqual([]);
    expect(afterRebuild.refusals).toEqual([]);
    expect(postReport.moves[0]!.act).toContain('answers_feedback');
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

    mkdirSync(join(dir, `evidence/parts-${draftId}`), { recursive: true });
    // Route 1: Draft's own report exists over the same stack and painting sha256 -> move points at it.
    const reportWithOwnDiff = nextProject(dir, CHAIN_NOW + 1000);
    const copyMove = reportWithOwnDiff.moves.find(m => m.field === `drafts[${draftId}].parts`);
    expect(copyMove).toMatchObject({
      role: 'producer',
      field: `drafts[${draftId}].parts`,
      awaits: `evidence/parts-${draftId}/diff-components.json`,
      command: `cp ${dir}/derived/drafts/${draftId}/diff-components.json ${dir}/evidence/parts-${draftId}/diff-components.json`,
    });

    const copyExec = Bun.spawnSync(copyMove!.command!.split(/\s+/), {
      cwd: dir,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(copyExec.exitCode).toBe(0);
    const copiedReport = JSON.parse(
      readFileSync(join(dir, `evidence/parts-${draftId}/diff-components.json`), 'utf8'),
    ) as { definition: { inside_sha256: string | null } };
    expect(copiedReport.definition.inside_sha256).toBe(expectedInsideSha);
    expect(nextProject(dir, CHAIN_NOW + 1000).awaits).not.toContain(`evidence/parts-${draftId}/diff-components.json`);
    const afterCopyCheck = checkProject(dir, undefined, { now: CHAIN_NOW + 1000, readOnly: true });
    expect(afterCopyCheck.refusals).toEqual(beforeCheck.refusals);

    // Route 2: Without the draft's own report, next emits rig-parts diff-components with the real stack path and --figure.
    rmSync(join(dir, `evidence/parts-${draftId}/diff-components.json`));
    rmSync(join(draftRoot, 'diff-components.json'));

    const reportWithoutOwnDiff = nextProject(dir, CHAIN_NOW + 1000);
    const rerunMove = reportWithoutOwnDiff.moves.find(m => m.field === `drafts[${draftId}].parts`);
    expect(rerunMove).toMatchObject({
      role: 'producer',
      field: `drafts[${draftId}].parts`,
      awaits: `evidence/parts-${draftId}/diff-components.json`,
      command: `rig-parts diff-components --stack ${dir}/derived/drafts/${draftId}/build/render/recomposite_rig.png --painting ${dir}/inputs/painting.png --parts ${dir}/derived/drafts/${draftId}/build/rig/parts.json --figure ${dir}/derived/drafts/${draftId}/build/render/figure_rig.png --floor 2 --threshold 40 --out ${dir}/evidence/parts-${draftId}/diff-components.json`,
    });

    const rerunArgs = rerunMove!.command!.slice('rig-parts '.length).split(/\s+/);
    const rerunExec = Bun.spawnSync([process.execPath, rigPartsBin, ...rerunArgs], {
      cwd: dir,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(rerunExec.exitCode).toBe(0);
    const rerunReport = JSON.parse(
      readFileSync(join(dir, `evidence/parts-${draftId}/diff-components.json`), 'utf8'),
    ) as { definition: { inside_sha256: string | null } };
    expect(rerunReport.definition.inside_sha256).toBe(expectedInsideSha);
    expect(nextProject(dir, CHAIN_NOW + 1000).awaits).not.toContain(`evidence/parts-${draftId}/diff-components.json`);
    const afterRerunCheck = checkProject(dir, undefined, { now: CHAIN_NOW + 1000, readOnly: true });
    expect(afterRerunCheck.refusals).toEqual(beforeCheck.refusals);
  });

  test('plant 8 (parts-review agent diff-classes move): missing map withholds the fresh human verdict until evidence is ready', () => {
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
        `rig-create diff-classes ${dir} --diff-report evidence/diff-components.json --by agent`,
    });
    expect(report.moves.some(m => m.review_act?.kind === 'parts-verdict')).toBe(false);
    expect(report.moves.some(m => m.review_act?.kind === 'signoff')).toBe(false);
    const snapshot = report.moves.find(m => m.command?.startsWith('rig-create structure-snapshot'))!;
    expect(runMainCapture(printedArgs(snapshot.command!).slice(1), CHAIN_NOW + 1000)).toMatchObject({ code: 0, stderr: '' });

    const execArgs = printedArgs(diffMove!.command!).slice(1);
    const execRes = runMainCapture(execArgs, CHAIN_NOW + 1000);
    expect(execRes.stderr).toBe('');
    expect(execRes.code).toBe(0);

    const afterReport = nextProject(dir, CHAIN_NOW + 1000);
    expect(afterReport.awaits).not.toContain('diff_map');
    expect(afterReport.moves.find(m => m.field === 'diff_map')).toBeUndefined();
    expect(afterReport.moves.find(m => m.review_act?.kind === 'parts-verdict')).toMatchObject({ role: 'human', command: null });
    expect(afterReport.moves.some(m => m.review_act?.kind === 'signoff')).toBe(false);
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
  const executed = runMainCapture(printedArgs(done!.command!).slice(1), testClock.now());
  expect({ code: executed.code, stderr: executed.stderr }).toEqual({ code: 0, stderr: '' });
});


test('#478 answered rigging guides request plan steps before the publishable sign-off', () => {
  testClock.set(new Date(CHAIN_NOW));
  const ids = ['bones', 'meshes', 'constraints', 'motion'];
  const dir = realpathSync(fixture(project => {
    project.stage = 'rigging-interview';
    project.versions = [];
    project.scenes = [];
    delete project.direction_contract;
    retainSignoffs(project, signature => stageIndex(String(signature.stage)) < stageIndex('rigging-interview'));
    project.advances = arr(project.advances).filter(value => stageIndex(String(obj(value).stage)) <= stageIndex('rigging-interview'));
    for (const item of arr(obj(obj(project.interview).post).items).map(obj)) item.guide = null;
    obj(project.plan).steps = arr(obj(project.plan).steps).filter(value => ['seethrough', 'assemble'].includes(String(obj(value).id)));
  }, 'example-project.json'));
  const beforeBytes = readFileSync(join(dir, 'project.json'));
  const before = nextProject(dir, CHAIN_NOW);
  expect(before.refusals).toEqual([]);
  expect(before.moves.map(move => move.role)).toEqual(['agent', 'agent', 'agent', 'agent', 'human']);
  for (const [index, id] of ids.entries()) {
    expect(before.moves[index]).toMatchObject({
      role: 'agent', field: 'plan.steps', awaits: 'plan.steps', unanswered_by_record: 'plan.steps',
      command: `rig-create plan add ${id} ${dir} --by agent --phase rig --order ${index + 3} --does '<work>' --produces '<result>' --rests-on ${id} --bar '<acceptance bar>' --checkpoint-proposed false`,
      act: expect.stringContaining('approval at rigging-interview'),
    });
  }
  expect(before.moves.at(-1)).toMatchObject({
    role: 'human', unanswered_by_record: 'plan.steps',
    review_act: { kind: 'signoff', stage: 'rigging-interview' },
  });
  expect(readFileSync(join(dir, 'project.json'))).toEqual(beforeBytes);
  for (const [index, id] of ids.entries()) {
    const current = nextProject(dir, CHAIN_NOW);
    const move = current.moves.find(move => move.command?.startsWith(`rig-create plan add ${id} `))!;
    expect(planCommand(printedArgs(move.command!).slice(2).map(arg =>
      arg === '<work>' ? `Implement the approved ${id} guide.` : arg === '<result>' ? `The ${id} result.`
        : arg === '<acceptance bar>' ? `The ${id} result matches the approved guide.` : arg)).exit).toBe(0);
    expect(nextProject(dir, CHAIN_NOW).moves.filter(move => move.command?.startsWith('rig-create plan add')).length).toBe(ids.length - index - 1);
  }
  const after = nextProject(dir, CHAIN_NOW);
  expect(after.refusals).toEqual([]);
  expect(after.moves).toHaveLength(6);
  expect(after.moves[0]!.command).toContain('--owner-chat');
  expect(after.moves[2]).toMatchObject({ role: 'human', review_act: { kind: 'signoff', stage: 'rigging-interview' } });
  expect(after.moves[2]!.unanswered_by_record).toBeUndefined();
  expect(after.awaits).toEqual(['signoffs[stage=rigging-interview]']);
  const context = readRecordPublished({ root: dir,
    record: { path: 'project.json', sha256: sha256(readFileSync(join(dir, 'project.json'))) },
    result: { kind: 'plan' }, phase: 'inventory' }, CHAIN_NOW);
  expect(context.subjects).toEqual([
    { kind: 'signoff', stage: 'rigging-interview' },
    ...['interview', 'plan-approved', 'parts', 'parts-review', 'rigging-interview'].map(stage => ({ kind: 'reopen' as const, stage })),
  ]);
});


test('#490 fresh init record prints runnable option registration without initializing git', () => {
  const dir = join(tempDir(), "synthetic project's folder");
  mkdirSync(join(dir, 'evidence'), { recursive: true });
  writeFileSync(join(dir, 'project.json'), JSON.stringify(freshProjectRecord('synthetic-fresh', CHAIN_NOW)));
  mkdirSync(join(dir, 'inputs'));
  cpSync(join(CHAIN_DIR, 'inputs/painting.png'), join(dir, 'inputs/painting.png'));
  expect(runMainCapture(['input', 'add', 'inputs/painting.png', dir, '--origin', 'synthetic source'], CHAIN_NOW)).toMatchObject({ code: 0, stderr: '' });
  const bytes = readFileSync(join(dir, 'project.json'));
  const report = nextProject(dir, CHAIN_NOW);
  const move = report.moves.find(move => move.command?.startsWith('rig-create interview-options rig_type '))!;
  expect(move.role).toBe('agent');
  const argv = preparePrintedOptions(dir, move.command!, CHAIN_NOW);
  const result = runMainCapture(argv, CHAIN_NOW);
  expect(result).toMatchObject({ code: 0, stderr: '' });
  expect(readFileSync(join(dir, 'project.json'))).not.toEqual(bytes);
  expect(nextProject(dir, CHAIN_NOW).moves.find(move => move.review_act?.question_id === 'rig_type')?.role).toBe('human');
});

test('#490 answers expose current picks, ids, labels, author and time; refresh registers a new set', () => {
  const dir = join(tempDir(), 'answered-interview');
  cpSync(join(CHECKPOINTS_DIR, '0b-plan-pending'), dir, { recursive: true });
  const file = join(dir, 'project.json');
  const project = JSON.parse(readFileSync(file, 'utf8')) as JsonObject;
  project.stage = 'interview'; project.signoffs = []; project.advances = [];
  writeFileSync(file, JSON.stringify(project));
  const before = readFileSync(file);
  const report = JSON.parse(nextCommand([dir, '--json'], CHAIN_NOW).stdout) as NextReport;
  const answer = report.answers!.find(answer => answer.question_id === 'rig_type')!;
  const raw = obj(arr(obj(project.interview).framing)[0]).answer as JsonObject;
  expect(answer.by).toBe(raw.by!); expect(answer.at).toBe(raw.at!);
  expect(answer.picks).toEqual(arr(obj(raw.choice).picks).map(value => ({ ask: obj(value).ask, option_id: obj(value).option_id, label: obj(obj(value).shown).label })));
  expect(readFileSync(file)).toEqual(before);
  expect(runMainCapture(preparePrintedOptions(dir, answer.command!, CHAIN_NOW), CHAIN_NOW)).toMatchObject({ code: 0, stderr: '' });
  expect(obj(arr(obj(JSON.parse(readFileSync(file, 'utf8')).interview).framing)[0]).answer).toEqual(raw);
});

test('#490 post plan additions name the post phase and run before signoff', () => {
  const dir = join(tempDir(), 'post-plan');
  cpSync(join(CHECKPOINTS_DIR, '4-direction-post'), dir, { recursive: true });
  const file = join(dir, 'project.json');
  const project = JSON.parse(readFileSync(file, 'utf8')) as JsonObject;
  project.stage = 'post-interview';
  retainSignoffs(project, row => stageIndex(String(row.stage)) < stageIndex('post-interview'));
  project.advances = arr(project.advances).filter(row => stageIndex(String(obj(row).stage)) <= stageIndex('post-interview'));
  obj(project.plan).steps = arr(obj(project.plan).steps).filter(row => obj(row).phase !== 'post');
  writeFileSync(file, JSON.stringify(project));
  for (const [index, id] of ['camera', 'timing', 'composition'].entries()) {
    const report = nextProject(dir, CHAIN_NOW);
    expect(report.refusals).toEqual([]);
    const move = report.moves.find(move => move.command?.startsWith(`rig-create plan add ${id} `))!;
    expect(move.command).toContain(`--phase post --order ${index + 7}`);
    expect(move.command).toContain(`--rests-on ${id === 'camera' ? 'camera_depth' : id === 'timing' ? 'post_timing' : 'post_composition'}`);
    const result = runMainCapture(printedArgs(move.command!).slice(1), CHAIN_NOW);
    expect(result).toMatchObject({ code: 0, stderr: '' });
  }
  expect(nextProject(dir, CHAIN_NOW).moves.some(move => move.command?.startsWith('rig-create plan add'))).toBe(false);
});

test('#490 post moves run in adoption, scene, direction, advance order', () => {
  const dir = join(tempDir(), 'post-writers');
  cpSync(join(CHECKPOINTS_DIR, '4-direction-post'), dir, { recursive: true });
  const file = join(dir, 'project.json');
  const project = JSON.parse(readFileSync(file, 'utf8')) as JsonObject;
  delete project.direction_contract;
  writeFileSync(file, JSON.stringify(project));
  for (const prefix of ['rig-create direction --adopt', 'rig-create scene write', 'rig-create direction write 2', 'rig-create advance direction-review']) {
    const report = nextProject(dir, CHAIN_NOW);
    expect(report.refusals).toEqual([]);
    const move = report.moves.find(move => move.role === 'agent')!;
    expect(move.command).toStartWith(prefix);
    if (!prefix.includes('advance')) expect(report.moves.some(move => move.command?.includes('advance direction-review'))).toBe(false);
    expect(runMainCapture(preparePrintedOptions(dir, move.command!, CHAIN_NOW), CHAIN_NOW)).toMatchObject({ code: 0, stderr: '' });
  }
  expect(JSON.parse(readFileSync(file, 'utf8')).stage).toBe('direction-review');
});

test('#490 row56a parts checkpoint precedes the executable done move', () => {
  testClock.set(CHAIN_NOW);
  const dir = join(tempDir(), 'checkpoint-order');
  cpSync(join(CHECKPOINTS_DIR, '1-parts-verdict'), dir, { recursive: true });
  const file = join(dir, 'project.json');
  const project = JSON.parse(readFileSync(file, 'utf8')) as JsonObject;
  const step = arr(obj(project.plan).steps).map(obj).find(step => step.id === 'assemble')!;
  step.status = 'at-checkpoint'; step.status_history = arr(step.status_history).filter(row => obj(row).status !== 'done');
  project.signoffs = arr(project.signoffs).filter(row => obj(row).checkpoint !== 'assemble');
  writeFileSync(file, JSON.stringify(project));
  const report = nextProject(dir, CHAIN_NOW);
  expect(report.refusals).toEqual([]);
  expect(report.moves.find(move => move.review_act?.step_id === 'assemble')).toMatchObject({ role: 'human', command: null });
  expect(report.moves.some(move => move.command?.startsWith('rig-create step-status assemble done'))).toBe(false);
  signoffCommand(['parts', dir, '--checkpoint', 'assemble', '--by', 'user', '--verbatim-file', join(dir, 'evidence/approval.txt')]);
  const done = nextProject(dir, CHAIN_NOW).moves.find(move => move.command?.startsWith('rig-create step-status assemble done'))!;
  expect(runMainCapture(printedArgs(done.command!).slice(1), CHAIN_NOW)).toMatchObject({ code: 0, stderr: '' });
});

test('#490 agent guide remains below 10000 rendered bytes', () => {
  expect(Buffer.byteLength(renderAgentGuide())).toBeLessThan(10_000);
});

test('#557 fresh parts prepares check, structure and diff before advance and the single human verdict', () => {
  const dir = join(tempDir(), 'parts-report');
  cpSync(join(CHECKPOINTS_DIR, '1-parts-verdict'), dir, { recursive: true });
  rmSync(join(dir, 'evidence/parts-check.json'));
  const expected = ['rig-parts check-parts', 'rig-create structure-snapshot', 'rig-parts diff-components',
    'rig-create diff-classes', 'rig-create advance parts-review'];
  const require = createRequire(import.meta.url);
  const bin = join(require.resolve('@rig-c/parts/package.json'), '..', 'cli.ts');
  for (const prefix of expected) {
    const report = nextProject(dir, CHAIN_NOW);
    expect(report.refusals).toEqual([]);
    expect(report.moves.some(move => move.review_act?.kind === 'parts-verdict')).toBe(false);
    expect(report.moves.some(move => move.review_act?.kind === 'signoff')).toBe(false);
    const move = report.moves.find(move => move.command !== null)!;
    expect(move.command).toStartWith(prefix);
    if (prefix.startsWith('rig-parts ')) {
      expect(move.role).toBe('producer');
      const run = Bun.spawnSync([process.execPath, bin, ...printedArgs(move.command!).slice(1)], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
      expect({ exit: run.exitCode, stderr: run.stderr.toString() }).toEqual({ exit: 0, stderr: '' });
    } else {
      expect(move.role).toBe('agent');
      expect(runMainCapture(printedArgs(move.command!).slice(1), CHAIN_NOW)).toMatchObject({ code: 0, stderr: '' });
    }
  }
  const ready = nextProject(dir, CHAIN_NOW);
  expect(ready.moves.find(move => move.review_act?.kind === 'parts-verdict')).toMatchObject({ role: 'human', command: null });
  expect(ready.moves.some(move => move.review_act?.kind === 'signoff')).toBe(false);
  expect(JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')).stage).toBe('parts-review');
});


test.each(['generic', 'per-draft'])('#490 legacy approved %s snapshot for another draft is retained and both command views select the same fresh path', slot => {
  const dir = join(tempDir(), 'snapshot-selection');
  cpSync(join(CHECKPOINTS_DIR, '1-parts-verdict'), dir, { recursive: true });
  recordPartsReceipt(dir, 'chain', CHAIN_NOW);
  const project = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
  const path = slot === 'generic' ? 'evidence/structure.json' : 'evidence/structure-chain.json';
  const wrong = JSON.stringify({ schema: 'rig-create/structure-decisions@0', draft_id: 'other-draft', config: obj(arr(project.drafts)[0]).config, entries: [] });
  writeFileSync(join(dir, path), wrong);
  const before = readFileSync(join(dir, 'project.json'));
  const selected = partsStructureSnapshot(dir, project, 'chain');
  expect(selected).toEqual({ path: slot === 'generic' ? 'evidence/structure-chain.json' : 'evidence/structure-chain-1.json', valid: false });
  const next = nextProject(dir, CHAIN_NOW);
  const snapshot = next.moves.find(move => move.command?.startsWith('rig-create structure-snapshot'))!;
  const act = { jobId: 'synthetic', actId: 'parts-sign', kind: 'signoff', at: new Date(CHAIN_NOW).toISOString(),
    source: { selector: { kind: 'draft', id: 'chain' } }, value: { stage: 'parts-review' } } as unknown as ActV3;
  const row = pendingJobActs(project, [act], dir)[0]!;
  expect(printedArgs(snapshot.command!)).toEqual(printedArgs(row.preconditions![0]!.command!));
  expect(row.args).toContain(selected.path);
  expect(next.moves.find(move => move.review_act?.kind === 'signoff')!.act).toContain(selected.path);
  expect(runMainCapture(printedArgs(snapshot.command!).slice(1), CHAIN_NOW)).toMatchObject({ code: 0, stderr: '' });
  expect(partsStructureSnapshot(dir, project, 'chain')).toEqual({ ...selected, valid: true });
  expect(pendingJobActs(project, [act], dir)[0]!.preconditions).toBeUndefined();
  expect(readFileSync(join(dir, path), 'utf8')).toBe(wrong);
  expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
});



test.each([{ foreground: false, custom: false }, { foreground: true, custom: false }, { foreground: false, custom: true }, { foreground: true, custom: true }])('#502 printed scene form executes with exact roles and rects %j', ({ foreground, custom }) => {
  const dir = join(tempDir(), "synthetic scene's folder");
  cpSync(join(CHECKPOINTS_DIR, '4-direction-post'), dir, { recursive: true });
  const file = join(dir, 'project.json');
  const background = 'inputs/background.png';
  cpSync(join(CHAIN_DIR, background), join(dir, background));
  expect(runMainCapture(['input', 'add', background, dir, '--origin', 'synthetic plate'], CHAIN_NOW)).toMatchObject({ code: 0, stderr: '' });
  if (foreground) {
    writeFileSync(join(dir, 'inputs/foreground.png'), Buffer.concat([readFileSync(join(dir, background)), Buffer.from('\n')]));
    expect(runMainCapture(['input', 'add', 'inputs/foreground.png', dir, '--origin', 'synthetic foreground'], CHAIN_NOW)).toMatchObject({ code: 0, stderr: '' });
  }
  const project = JSON.parse(readFileSync(file, 'utf8')) as JsonObject;
  const answer = obj(arr(obj(obj(project.interview).post).items).map(obj).find(item => item.id === 'post_composition')!.guide);
  const binding = obj(obj(answer.choice).set);
  const set = JSON.parse(readFileSync(join(dir, String(binding.path)), 'utf8')) as JsonObject;
  const scene = obj(obj(answer.value).scene);
  const backgroundRect = custom ? { x: -48, y: 10, width: 96, height: 96 } : obj(scene.background).rect!;
  obj(scene.background).rect = backgroundRect;
  if (foreground) scene.foreground = { path: 'inputs/foreground.png', rect: custom ? { x: -40, y: 12, width: 80, height: 80 } : backgroundRect };
  const option = arr(obj(arr(set.asks)[0]).options).map(obj).find(option => option.id === 'keep')!;
  option.fragment = answer.value!;
  const bytes = JSON.stringify(set);
  writeFileSync(join(dir, String(binding.path)), bytes);
  binding.sha256 = sha256(bytes);
  // Bind synthetic setup edits before measuring next or executing any printed writer.
  for (const signature of arr(project.signoffs).map(obj)) {
    const hashes = selectAnswerHashes(dir, project, signature);
    if (hashes) signature.answer_hashes = hashes;
  }
  writeFileSync(file, JSON.stringify(project));
  const citation = { guide: 'post_composition', asks: ['post_composition'], quote: answer.verbatim };
  writeFileSync(join(dir, 'evidence/printed-scene-citations.json'), JSON.stringify({ background: citation, ...(foreground ? { foreground: citation } : {}) }));
  const beforePlan = structuredClone(project.plan);
  const report = nextProject(dir, CHAIN_NOW);
  expect(report.refusals).toEqual([]);
  const command = report.moves.find(move => move.command?.startsWith('rig-create scene write'))!.command!;
  expect(command.includes('--foreground ')).toBe(foreground);
  expect(command.includes('--background-rect')).toBe(custom);
  expect(command.includes('--foreground-rect')).toBe(custom && foreground);
  if (custom) expect(command).toContain("--background-rect '-48,10,96,96'");
  if (custom && foreground) expect(command).toContain("--foreground-rect '-40,12,80,80'");
  const argv = printedArgs(command).slice(1).map(arg => arg === '<background.png>' ? background
    : arg === '<foreground.png>' ? 'inputs/foreground.png'
    : arg === '<scene-citations.json>' ? 'evidence/printed-scene-citations.json' : arg);
  const result = runMainCapture(argv, CHAIN_NOW);
  expect(result).toMatchObject({ code: 0, stderr: '' });
  if (process.env.JOB_ACTS_RECEIPT) appendFileSync(process.env.JOB_ACTS_RECEIPT, JSON.stringify({
    command, argv: ['rig-create', ...argv], exit: result.code, foreground, custom,
    rendered: nextCommand([dir], CHAIN_NOW).stdout, plan_unchanged: true,
  }) + '\n');
  const after = JSON.parse(readFileSync(file, 'utf8')) as JsonObject;
  expect(after.plan).toEqual(beforePlan); // scene write appends a scene, never a composition plan step.
  const doc = JSON.parse(readFileSync(join(dir, String(obj(arr(after.scenes).at(-1)).path)), 'utf8')) as JsonObject;
  expect(arr(doc.plates).map(row => obj(row).role)).toEqual(foreground ? ['background', 'foreground'] : ['background']);
  expect(obj(arr(doc.plates)[0]).rect).toEqual(backgroundRect);
});


function postInterviewPlan(): string {
  const dir = join(tempDir(), "synthetic post plan's folder");
  cpSync(join(CHECKPOINTS_DIR, '4-direction-post'), dir, { recursive: true });
  const file = join(dir, 'project.json');
  const project = JSON.parse(readFileSync(file, 'utf8')) as JsonObject;
  project.stage = 'post-interview';
  retainSignoffs(project, row => stageIndex(String(row.stage)) < stageIndex('post-interview'));
  project.advances = arr(project.advances).filter(row => stageIndex(String(obj(row).stage)) <= stageIndex('post-interview'));
  for (const step of arr(obj(project.plan).steps).map(obj).filter(step => step.phase === 'post')) {
    step.status = 'pending'; delete step.status_history;
  }
  writeFileSync(file, JSON.stringify(project));
  return dir;
}

function followupReceipt(row: object): void {
  if (process.env.NEXT_FOLLOWUP_RECEIPT) appendFileSync(process.env.NEXT_FOLLOWUP_RECEIPT, JSON.stringify(row) + '\n');
}

test('#502 followup composition order follows existing camera 7 timing 8 and unrelated 9', () => {
  const dir = postInterviewPlan();
  const file = join(dir, 'project.json');
  const project = JSON.parse(readFileSync(file, 'utf8')) as JsonObject;
  const steps = arr(obj(project.plan).steps).map(obj);
  const composition = steps.find(step => step.id === 'composition')!;
  composition.id = 'finishing'; composition.order = 9; composition.rests_on = ['camera_depth'];
  expect(steps.find(step => step.id === 'camera')!.order).toBe(7);
  expect(steps.find(step => step.id === 'timing')!.order).toBe(8);
  writeFileSync(file, JSON.stringify(project));
  const before = readFileSync(file);
  const report = nextProject(dir, CHAIN_NOW);
  expect(report.refusals).toEqual([]);
  const adds = report.moves.filter(move => move.command?.startsWith('rig-create plan add '));
  expect(adds).toHaveLength(1);
  const move = adds[0]!;
  expect(move.command).toStartWith('rig-create plan add composition ');
  expect(move.command).toContain('--order 10');
  const existingOrders = steps.map(step => Number(step.order));
  for (const add of adds) {
    const args = printedArgs(add.command!);
    expect(existingOrders).not.toContain(Number(args[args.indexOf('--order') + 1]));
  }
  expect(readFileSync(file)).toEqual(before);
  const argv = printedArgs(move.command!).slice(1).map(arg => arg === '<work>' ? 'Write the approved scene composition'
    : arg === '<result>' ? 'A cited composition scene' : arg === '<acceptance bar>' ? 'Scene roles and placements match the approved choice' : arg);
  const result = runMainCapture(argv, CHAIN_NOW);
  expect(result).toMatchObject({ code: 0, stderr: '' });
  const recorded = arr(obj(JSON.parse(readFileSync(file, 'utf8')).plan).steps).map(obj);
  expect(recorded.find(step => step.id === 'composition')).toMatchObject({ order: 10, phase: 'post', rests_on: ['post_composition'] });
  expect(recorded.filter(step => step.id !== 'composition').map(step => step.order)).toEqual(steps.map(step => step.order));
  followupReceipt({ kind: 'order-measurement', command: move.command, argv: ['rig-create', ...argv], exit: result.code,
    existing_orders: existingOrders, printed_order: 10, recorded_order: recorded.find(step => step.id === 'composition')!.order });
});

test.each([
  { missing: ['composition'], reason: 'plan.steps has no composition post step' },
  { missing: ['composition', 'camera'], reason: 'plan.steps has no camera, composition post steps' },
  { missing: ['camera', 'timing', 'composition'], reason: 'plan.steps has no post steps' },
])('#502 followup post signoff names the missing plan steps %j', ({ missing, reason }) => {
  const dir = postInterviewPlan();
  const file = join(dir, 'project.json');
  const project = JSON.parse(readFileSync(file, 'utf8')) as JsonObject;
  obj(project.plan).steps = arr(obj(project.plan).steps).filter(step => !missing.some(id => id === obj(step).id));
  writeFileSync(file, JSON.stringify(project));
  const before = readFileSync(file);
  const report = nextProject(dir, CHAIN_NOW);
  expect(report.refusals).toEqual([]);
  const signoff = report.moves.find(move => move.review_act?.kind === 'signoff' && move.review_act.stage === 'post-interview')!;
  expect(signoff).toMatchObject({ role: 'human', command: null, unanswered_by_record: 'plan.steps',
    act: `review-tool act signoff for stage post-interview (unanswered by record: ${reason} in project.json)` });
  expect(readFileSync(file)).toEqual(before);
  followupReceipt({ kind: 'post-reason', missing, act: signoff.act });
});

test.each([
  { missing: ['motion'], reason: 'plan.steps has no motion rig step approved at rigging-interview' },
  { missing: ['motion', 'bones'], reason: 'plan.steps has no bones, motion rig steps approved at rigging-interview' },
  { missing: ['bones', 'meshes', 'constraints', 'motion'], reason: 'plan.steps has no rig steps approved at rigging-interview' },
])('#502 followup rig signoff names the missing plan steps %j', ({ missing, reason }) => {
  const dir = realpathSync(fixture(project => {
    project.stage = 'rigging-interview'; project.versions = []; project.scenes = [];
    delete project.direction_contract;
    retainSignoffs(project, row => stageIndex(String(row.stage)) < stageIndex('rigging-interview'));
    project.advances = arr(project.advances).filter(row => stageIndex(String(obj(row).stage)) <= stageIndex('rigging-interview'));
    for (const item of arr(obj(obj(project.interview).post).items).map(obj)) item.guide = null;
    obj(project.plan).steps = arr(obj(project.plan).steps).filter(step => obj(step).phase !== 'post' && !missing.some(id => id === obj(step).id));
    for (const step of arr(obj(project.plan).steps).map(obj).filter(step => !['seethrough', 'assemble'].includes(String(step.id)))) {
      step.status = 'pending'; delete step.status_history;
    }
  }, 'example-project.json'));
  const before = readFileSync(join(dir, 'project.json'));
  const report = nextProject(dir, CHAIN_NOW);
  expect(report.refusals).toEqual([]);
  const signoff = report.moves.find(move => move.review_act?.kind === 'signoff' && move.review_act.stage === 'rigging-interview')!;
  expect(signoff).toMatchObject({ role: 'human', command: null, unanswered_by_record: 'plan.steps',
    act: `review-tool act signoff for stage rigging-interview (unanswered by record: ${reason})` });
  expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
  followupReceipt({ kind: 'rig-reason', missing, act: signoff.act });
});

test('owner chat is offered beside Review for pending interview picks, including shared images',()=>{
  const dir=join(tempDir(),'chat-options');cpSync(CHAIN_DIR,dir,{recursive:true});
  const file=join(dir,'project.json');
  cpSync(join(CHECKPOINTS_DIR,'0a-interview-options/project.json'),file);
  const result=nextProject(dir,CHAIN_NOW);
  const chats=result.moves.filter(move=>move.command?.includes('--owner-chat'));
  expect(chats.length).toBeGreaterThan(0);
  expect(chats.every(move=>move.role==='human')).toBe(true);
  expect(chats.some(move=>move.command?.includes('interview-answer') && move.command.includes('--set') && move.command.includes('--sha256') && move.command.includes('--pick'))).toBe(true);
  expect(result.moves.some(move=>move.command?.includes('job open'))).toBe(true);
});

test('owner chat signoff is absent before the direction verdict and present after acceptance',()=>{
  const dir=join(tempDir(),'chat-direction');cpSync(CHAIN_DIR,dir,{recursive:true});
  const file=join(dir,'project.json');const p=JSON.parse(readFileSync(file,'utf8')) as JsonObject;
  p.stage='direction-review';p.signoffs=arr(p.signoffs).filter(s=>obj(s).stage!=='direction-review');
  p.advances=arr(p.advances).filter(a=>obj(a).stage!=='accepted');
  const version=arr(p.versions).map(obj).find(v=>v.kind==='post')!;const verdicts=version.verdicts;
  version.verdicts=[];writeFileSync(file,JSON.stringify(p,null,2)+'\n');
  expect(nextProject(dir,CHAIN_NOW).moves.some(m=>m.command?.includes('signoff direction-review')&&m.command.includes('--owner-chat'))).toBe(false);
  version.verdicts=verdicts;writeFileSync(file,JSON.stringify(p,null,2)+'\n');
  expect(nextProject(dir,CHAIN_NOW).moves.some(m=>m.command?.includes('signoff direction-review')&&m.command.includes('--owner-chat'))).toBe(true);
});

function bouncedPartsFixture(): string {
  const dir = join(tempDir(), 'parts-retouch-loop');
  cpSync(join(CHECKPOINTS_DIR, '1-parts-verdict'), dir, { recursive: true });
  cpSync(join(CHAIN_DIR, 'evidence/diff-components.json'), join(dir, 'evidence/diff-components.json'));
  expect(runMainCapture(['structure-snapshot', dir, '--draft', 'chain', '--out', 'evidence/structure-chain.json'], CHAIN_NOW)).toMatchObject({ code: 0, stderr: '' });
  expect(runMainCapture(['diff-classes', dir, '--diff-report', 'evidence/diff-components.json', '--by', 'agent'], CHAIN_NOW)).toMatchObject({ code: 0, stderr: '' });
  expect(runMainCapture(['advance', 'parts-review', dir, '--parts-check', 'evidence/parts-check.json', '--parts', 'derived/drafts/chain/input'], CHAIN_NOW)).toMatchObject({ code: 0, stderr: '' });
  recordPartsReceipt(dir, 'chain', CHAIN_NOW, 'changes-requested');
  return dir;
}

test('#557 bounced parts verdict prints the ordered NEW edited_parts scaffold without reasking the rejected draft', () => {
  const dir = bouncedPartsFixture();
  const file = join(dir, 'project.json');
  const before = readFileSync(file);
  const project = JSON.parse(before.toString()) as JsonObject;
  expect(latestPartsVerdictStatus(project, 'chain')).toBe('changes-requested');
  const next = nextProject(dir, CHAIN_NOW);
  expect(next.refusals).toEqual([]);
  expect(next.stage).toBe('parts-review');
  expect(next.effective_stage).toBe('parts-review');
  expect(next.moves.every(move => move.role !== 'human')).toBe(true);
  expect(next.moves[0]!.act).toContain('assemble.edited_parts');
  expect(next.moves[0]!.act).toContain('from_sha256');
  expect(next.moves[0]!.act).toContain('docs/SOURCE.md#handing-a-retouch-to-an-image-editor');
  const commands = next.moves.flatMap(move => move.command === null ? [] : [move.command]);
  expect(commands.map(command => printedArgs(command).slice(0, 2).join(' '))).toEqual([
    'rig-parts build', 'rig-create draft-rig', 'rig-parts check-parts', 'rig-create structure-snapshot',
    'rig-parts diff-components', 'rig-create diff-classes', 'rig-create job',
  ]);
  expect(commands[1]).toContain('chain-retouch-1');
  expect(commands[2]).toContain('evidence/parts-chain-retouch-1');
  expect(commands[3]).toContain('--draft chain-retouch-1');
  expect(commands[4]).toContain('evidence/parts-chain-retouch-1/diff-components.json');
  expect(commands[6]).toContain('--draft chain-retouch-1');
  expect(next.moves.at(-1)!.act).toContain('only after the new evidence is ready');
  expect(commands.some(command => command.includes('advance ') || command.includes('reopen '))).toBe(false);
  expect(readFileSync(file)).toEqual(before);
  mkdirSync(join(dir, 'derived/drafts/chain-retouch-1'));
  expect(nextProject(dir, CHAIN_NOW).moves.find(move => move.command?.startsWith('rig-create draft-rig'))!.command).toContain('chain-retouch-2');
  const unrelated = join(dir, 'derived/drafts/chain-retouch-1/config.json');
  writeFileSync(unrelated, `${JSON.stringify({ key: 'unrelated', assemble: {} })}\n`);
  const unrelatedBytes = readFileSync(unrelated);
  expect(nextProject(dir, CHAIN_NOW).moves.find(move => move.command?.startsWith('rig-create draft-rig'))!.command).toContain('chain-retouch-2');
  expect(readFileSync(unrelated)).toEqual(unrelatedBytes);
});

test('#557 registered retouch discovers fresh evidence despite old files and reaches one verdict while retaining parts-review', () => {
  const dir = bouncedPartsFixture();
  const retained = ['evidence/parts-check.json', 'evidence/diff-components.json', 'evidence/structure-chain.json'];
  const bytes = retained.map(path => readFileSync(join(dir, path)));
  const id = 'chain-retouch-1';
  cpSync(join(dir, 'derived/drafts/chain'), join(dir, `derived/drafts/${id}`), { recursive: true });
  const registration = ['draft-rig', id, dir, '--config', `derived/drafts/${id}/config.json`, '--from', `derived/drafts/${id}/out`, '--parts', `derived/drafts/${id}/input`];
  const result = runMainCapture(registration, CHAIN_NOW + 1000);
  expect({ command: registration.join(' '), ...result }).toMatchObject({ code: 0, stderr: '' });
  const current = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
  expect(current.stage).toBe('parts-review');
  expect(latestPartsVerdictStatus(current, id)).toBeUndefined();
  const initial = nextProject(dir, CHAIN_NOW + 1000);
  expect(initial.refusals).toEqual([]);
  expect(initial.moves[0]!.command).toStartWith('rig-parts check-parts');
  expect(initial.moves[0]!.command).toContain(`evidence/parts-${id}`);
  expect(initial.moves.some(move => move.role === 'human')).toBe(false);
  const load = createRequire(import.meta.url);
  const bin = join(load.resolve('@rig-c/parts/package.json'), '..', 'cli.ts');
  for (const prefix of ['rig-parts check-parts', 'rig-create structure-snapshot', 'rig-parts diff-components', 'rig-create diff-classes']) {
    const next = nextProject(dir, CHAIN_NOW + 1000);
    expect(next.refusals).toEqual([]);
    expect(next.moves.some(move => move.role === 'human')).toBe(false);
    const move = next.moves.find(move => move.command !== null)!;
    expect(move.command).toStartWith(prefix);
    const args = printedArgs(move.command!);
    if (args[0] === 'rig-parts') {
      const run = Bun.spawnSync([process.execPath, bin, ...args.slice(1)], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
      expect({ command: move.command, exit: run.exitCode, stderr: run.stderr.toString() }).toMatchObject({ exit: 0, stderr: '' });
    } else expect(runMainCapture(args.slice(1), CHAIN_NOW + 1000)).toMatchObject({ code: 0, stderr: '' });
  }
  const ready = nextProject(dir, CHAIN_NOW + 1000);
  expect(ready.refusals).toEqual([]);
  expect(ready.stage).toBe('parts-review');
  expect(ready.moves.filter(move => move.role === 'human')).toMatchObject([{ review_act: { kind: 'parts-verdict', draft_id: id } }]);
  expect(ready.moves.find(move => move.command?.startsWith('rig-create job open'))!.command).toContain(`--draft ${id}`);
  expect(ready.moves.some(move => move.command?.includes('advance ') || move.command?.includes('reopen '))).toBe(false);
  for (const [index, path] of retained.entries()) expect(readFileSync(join(dir, path))).toEqual(bytes[index]);
  expect(JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')).stage).toBe('parts-review');
});

test('#557 initial parts-review with many historical drafts reuses global evidence when the current parts root matches stage entry', () => {
  const dir = join(tempDir(), 'initial-parts-many-drafts');
  cpSync(join(CHECKPOINTS_DIR, '1-parts-verdict'), dir, { recursive: true });
  cpSync(join(CHAIN_DIR, 'evidence/diff-components.json'), join(dir, 'evidence/diff-components.json'));
  const file = join(dir, 'project.json');
  const ids = ['historical-one', 'historical-two', 'initial-current'];
  for (const [index, id] of ids.entries()) {
    cpSync(join(dir, 'derived/drafts/chain'), join(dir, `derived/drafts/${id}`), { recursive: true });
    expect(runMainCapture(['draft-rig', id, dir, '--config', `derived/drafts/${id}/config.json`,
      '--from', `derived/drafts/${id}/out`, '--parts', `derived/drafts/${id}/input`], CHAIN_NOW + index * 1000)).toMatchObject({ code: 0, stderr: '' });
  }
  const id = ids.at(-1)!;
  const beforeAdvance = JSON.parse(readFileSync(file, 'utf8')) as JsonObject;
  expect(beforeAdvance.stage).toBe('parts');
  expect(arr(beforeAdvance.drafts)).toHaveLength(4);
  expect(arr(beforeAdvance.review_acts ?? [])).toEqual([]);
  expect(arr(beforeAdvance.advances).map(obj).filter(move => move.from_stage === 'parts' && move.stage === 'parts-review')).toEqual([]);
  expect(runMainCapture(['structure-snapshot', dir, '--draft', id, '--out', `evidence/structure-${id}.json`], CHAIN_NOW + 4000)).toMatchObject({ code: 0, stderr: '' });
  expect(runMainCapture(['diff-classes', dir, '--diff-report', 'evidence/diff-components.json', '--by', 'agent'], CHAIN_NOW + 4000)).toMatchObject({ code: 0, stderr: '' });
  expect(runMainCapture(['advance', 'parts-review', dir, '--parts-check', 'evidence/parts-check.json',
    '--parts', `derived/drafts/${id}/input`], CHAIN_NOW + 4000)).toMatchObject({ code: 0, stderr: '' });
  const before = readFileSync(file);
  const project = JSON.parse(before.toString()) as JsonObject;
  const arrival = arr(project.advances).map(obj).filter(move => move.from_stage === 'parts' && move.stage === 'parts-review').at(-1)!;
  expect(obj(arr(project.drafts).at(-1)).parts).toMatchObject({ path: obj(arrival.parts_check).parts });
  expect(obj(arrival.parts_check).path).toBe('evidence/parts-check.json');
  expect(obj(obj(project.diff_map).report).path).toBe('evidence/diff-components.json');
  const paths = ['evidence/parts-check.json', 'evidence/diff-components.json', `evidence/structure-${id}.json`];
  const retained = paths.map(path => readFileSync(join(dir, path)));
  const next = nextProject(dir, CHAIN_NOW + 5000);
  expect(next.refusals).toEqual([]);
  expect(next.stage).toBe('parts-review');
  expect(next.effective_stage).toBe('parts-review');
  expect(next.moves.filter(move => move.role === 'human')).toMatchObject([{ review_act: { kind: 'parts-verdict', draft_id: id } }]);
  expect(next.moves.some(move => move.role === 'producer')).toBe(false);
  expect(next.moves.some(move => move.command?.startsWith('rig-create structure-snapshot') || move.command?.startsWith('rig-create diff-classes'))).toBe(false);
  expect(next.awaits.some(path => path.includes(`evidence/parts-${id}`))).toBe(false);
  expect(next.moves.some(move => move.command?.includes(`evidence/parts-${id}`))).toBe(false);
  expect(existsSync(join(dir, `evidence/parts-${id}`))).toBe(false);
  expect(readFileSync(file)).toEqual(before);
  for (const [index, path] of paths.entries()) expect(readFileSync(join(dir, path))).toEqual(retained[index]);
});

test('#557 prepared unregistered retouch resumes the same target before and after build without replacing retained files', () => {
  const dir = bouncedPartsFixture();
  const file = join(dir, 'project.json');
  const record = readFileSync(file);
  const id = 'chain-retouch-1';
  const root = join(dir, 'derived/drafts', id);
  const initial = nextProject(dir, CHAIN_NOW);
  const registration = initial.moves.find(move => move.command?.startsWith('rig-create draft-rig'))!.command;
  mkdirSync(root);
  const config = readFileSync(join(dir, 'derived/drafts/chain/config.json'));
  writeFileSync(join(root, 'config.json'), config);
  const prepared = nextProject(dir, CHAIN_NOW);
  expect(prepared.moves[0]!.act).toContain(`Resume derived/drafts/${id}/config.json`);
  expect(prepared.moves.find(move => move.command?.startsWith('rig-create draft-rig'))!.command).toBe(registration);
  expect(prepared.moves.find(move => move.command?.startsWith('rig-parts build'))!.command).toContain(`/derived/drafts/${id}/config.json`);
  expect(readFileSync(join(root, 'config.json'))).toEqual(config);
  // Preparing the allowed retouch declaration must not switch the generated target either.
  const changed = JSON.parse(config.toString()) as JsonObject;
  obj(changed.assemble).edited_parts = { dir: 'edits', receipts: [{ part: 'torso', file: 'torso.png',
    from_sha256: 'a'.repeat(64), sha256: 'b'.repeat(64), editor: 'synthetic editor' }] };
  const edited = `${JSON.stringify(changed, null, 2)}\n`;
  writeFileSync(join(root, 'config.json'), edited);
  const editedNext = nextProject(dir, CHAIN_NOW);
  expect(editedNext.moves.find(move => move.command?.startsWith('rig-create draft-rig'))!.command).toBe(registration);
  expect(readFileSync(join(root, 'config.json'), 'utf8')).toBe(edited);
  expect(editedNext.moves.every(move => move.role !== 'human')).toBe(true);
  // Existence is not proof of a valid build: leave it to the existing registration validator.
  mkdirSync(join(root, 'build'));
  const sentinel = Buffer.from('preserve unrelated or incomplete output\n');
  writeFileSync(join(root, 'build/retained.txt'), sentinel);
  const built = nextProject(dir, CHAIN_NOW);
  expect(built.moves.find(move => move.command?.startsWith('rig-create draft-rig'))!.command).toBe(registration);
  expect(built.moves.some(move => move.command?.startsWith('rig-parts build'))).toBe(false);
  expect(built.moves.some(move => move.command === null && move.act.includes('do not rerun build over it'))).toBe(true);
  expect(readFileSync(join(root, 'build/retained.txt'))).toEqual(sentinel);
  expect(readFileSync(join(root, 'config.json'), 'utf8')).toBe(edited);
  expect(readFileSync(file)).toEqual(record);
});

test.each(['linked-config', 'dangling-target'])('#557 retouch preserves %s collisions instead of treating them as prepared targets', kind => {
  const dir = bouncedPartsFixture();
  const root = join(dir, 'derived/drafts/chain-retouch-1');
  if (kind === 'linked-config') {
    mkdirSync(root);
    symlinkSync(join(dir, 'derived/drafts/chain/config.json'), join(root, 'config.json'));
  } else symlinkSync(join(dir, 'absent-target'), root);
  const before = readFileSync(join(dir, 'project.json'));
  const next = nextProject(dir, CHAIN_NOW);
  expect(next.moves.find(move => move.command?.startsWith('rig-create draft-rig'))!.command).toContain('chain-retouch-2');
  expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
});

test('#596 undecided delegation emits an agent interview-decision move and clears DELEGATION_UNDECIDED', () => {
  const dir = postInterviewPlan();
  const file = join(dir, 'project.json');
  const project = JSON.parse(readFileSync(file, 'utf8')) as JsonObject;
  arr(obj(obj(project.interview).post).items).map(obj).find(item => item.id === 'camera_depth')!.guide = null;
  writeFileSync(file, `${JSON.stringify(project, null, 2)}\n`);

  const optionMove = nextProject(dir, CHAIN_NOW).moves.find(move => move.field === 'interview.post.items[camera_depth].guide')!;
  const optionArgv = preparePrintedOptions(dir, optionMove.command!, CHAIN_NOW);
  expect(runMainCapture(optionArgv, CHAIN_NOW)).toMatchObject({ code: 0, stderr: '' });
  const setBytes = readFileSync(join(dir, 'evidence/printed-options.json'));
  const set = JSON.parse(setBytes.toString('utf8')) as JsonObject;
  const fragment = obj(arr(obj(arr(set.asks)[0]).options).find(opt => obj(opt).kind === 'value')).fragment;
  expect(runMainCapture([
    'interview-answer', 'camera_depth', dir,
    '--set', 'evidence/printed-options.json',
    '--sha256', sha256(setBytes),
    '--by', 'user',
    '--pick', 'camera_depth=auto',
  ], CHAIN_NOW)).toMatchObject({ code: 0, stderr: '' });

  const signRes = runMainCapture(['signoff', 'post-interview', dir, '--by', 'user', '--verbatim-file', join(dir, 'evidence/approval.txt')], CHAIN_NOW + 1000);
  expect(signRes.code).toBe(1);
  expect(signRes.stderr).toContain('DELEGATION_UNDECIDED');

  const report = nextProject(dir, CHAIN_NOW + 1000);
  const decisionMove = report.moves.find(move => move.field === 'interview.post.items[camera_depth].guide');
  expect(decisionMove).toMatchObject({
    role: 'agent',
    field: 'interview.post.items[camera_depth].guide',
    awaits: 'interview.post.items[camera_depth].guide.agent_decision',
  });
  expect(decisionMove!.command).toContain('rig-create interview-decision camera_depth ');
  expect(decisionMove!.command).toContain("--by agent --reasoning-file '<file>' --fragment 'camera_depth=<json>'");
  expect(report.moves.some(move => move.command?.startsWith('rig-create signoff '))).toBe(false);

  const reasonFile = join(dir, 'evidence/camera-reason.txt');
  const fragmentFile = join(dir, 'evidence/camera-fragment.json');
  writeFileSync(reasonFile, 'Choose the synthetic fixed camera frame.\n');
  writeFileSync(fragmentFile, JSON.stringify(fragment));
  const execArgv = printedArgs(decisionMove!.command!).slice(1).map(arg =>
    arg === '<file>' ? reasonFile : arg === 'camera_depth=<json>' ? `camera_depth=${fragmentFile}` : arg);
  expect(runMainCapture(execArgv, CHAIN_NOW + 1000)).toMatchObject({ code: 0, stderr: '' });
  expect(checkProject(dir, undefined, { now: CHAIN_NOW + 1000, readOnly: true }).refusals).toEqual([]);
});

test('#596 a sentence-format delegation without an adopted choice keeps the authored-record move', () => {
  const dir = postInterviewPlan();
  const file = join(dir, 'project.json');
  const project = JSON.parse(readFileSync(file, 'utf8')) as JsonObject;
  arr(obj(obj(project.interview).post).items).map(obj).find(item => item.id === 'camera_depth')!.guide = null;
  writeFileSync(file, `${JSON.stringify(project, null, 2)}\n`);
  const optionMove = nextProject(dir, CHAIN_NOW).moves.find(move => move.field === 'interview.post.items[camera_depth].guide')!;
  const optionArgv = preparePrintedOptions(dir, optionMove.command!, CHAIN_NOW);
  expect(runMainCapture(optionArgv, CHAIN_NOW)).toMatchObject({ code: 0, stderr: '' });
  const setBytes = readFileSync(join(dir, 'evidence/printed-options.json'));
  expect(runMainCapture([
    'interview-answer', 'camera_depth', dir,
    '--set', 'evidence/printed-options.json',
    '--sha256', sha256(setBytes),
    '--by', 'user',
    '--pick', 'camera_depth=auto',
  ], CHAIN_NOW)).toMatchObject({ code: 0, stderr: '' });
  // Strip the adopted choice: the answer now has the preserved sentence-format shape.
  const recorded = JSON.parse(readFileSync(file, 'utf8')) as JsonObject;
  delete obj(arr(obj(obj(recorded.interview).post).items).map(obj).find(item => item.id === 'camera_depth')!.guide).choice;
  writeFileSync(file, `${JSON.stringify(recorded, null, 2)}\n`);

  const move = nextProject(dir, CHAIN_NOW + 1000).moves.find(m => m.field === 'interview.post.items[camera_depth].guide');
  expect(move).toMatchObject({ role: 'human', command: null, awaits: 'interview.post.items[camera_depth].guide.agent_decision' });
});

test('#596 pending Other flags INTERVIEW_CHOICE_REQUIRED and offers the agent option-set redraft before stage signoff', () => {
  const dir = postInterviewPlan();
  const file = join(dir, 'project.json');
  const project = JSON.parse(readFileSync(file, 'utf8')) as JsonObject;
  arr(obj(obj(project.interview).post).items).map(obj).find(item => item.id === 'post_timing')!.guide = null;
  writeFileSync(file, `${JSON.stringify(project, null, 2)}\n`);

  const optionMove = nextProject(dir, CHAIN_NOW).moves.find(move => move.field === 'interview.post.items[post_timing].guide')!;
  const optionArgv = preparePrintedOptions(dir, optionMove.command!, CHAIN_NOW);
  expect(runMainCapture(optionArgv, CHAIN_NOW)).toMatchObject({ code: 0, stderr: '' });
  const setBytes = readFileSync(join(dir, 'evidence/printed-options.json'));
  const otherWordsFile = join(dir, 'evidence/other-timing.txt');
  writeFileSync(otherWordsFile, 'Use a custom synthetic timing beat.\n');
  expect(runMainCapture([
    'interview-answer', 'post_timing', dir,
    '--set', 'evidence/printed-options.json',
    '--sha256', sha256(setBytes),
    '--by', 'user',
    '--pick', 'post_timing=other',
    '--other', `post_timing=${otherWordsFile}`,
  ], CHAIN_NOW)).toMatchObject({ code: 0, stderr: '' });

  const signRes = runMainCapture(['signoff', 'post-interview', dir, '--by', 'user', '--verbatim-file', join(dir, 'evidence/approval.txt')], CHAIN_NOW + 1000);
  expect(signRes.code).toBe(1);
  expect(signRes.stderr).toContain('INTERVIEW_CHOICE_REQUIRED');

  const report = nextProject(dir, CHAIN_NOW + 1000);
  expect(report.refusals.map(r => [r.code, r.field])).toEqual([
    ['INTERVIEW_CHOICE_REQUIRED', 'interview.post.items[post_timing].guide'],
  ]);
  expect(report.moves[0]).toMatchObject({
    role: 'agent',
    field: 'interview.post.items[post_timing].guide',
    awaits: 'interview.post.items[post_timing].guide',
    unanswered_by_record: 'interview.post.items[post_timing].guide',
  });
  expect(report.moves[0]!.command).toContain('rig-create interview-options post_timing ');
  expect(report.moves.some(move => move.command?.startsWith('rig-create signoff '))).toBe(false);
  expect(report.moves.find(move => move.field === 'signoffs')).toMatchObject({
    role: 'human',
    command: null,
    unanswered_by_record: 'interview.post.items[post_timing].guide',
  });
});

test('#596 post stage with in-progress step offers direction --adopt then direction write with the first legal version N', () => {
  const dir = realpathSync(fixture(project => {
    project.stage = 'post';
    project.versions = arr(project.versions).filter(v => obj(v).kind === 'rig');
    delete project.direction_contract;
    retainSignoffs(project, row => stageIndex(String(row.stage)) < stageIndex('direction-review'));
    project.advances = arr(project.advances).filter(row => stageIndex(String(obj(row).stage)) <= stageIndex('post'));
    for (const step of arr(obj(project.plan).steps).map(obj).filter(s => s.phase === 'post')) {
      step.status = step.id === 'camera' ? 'in-progress' : 'pending';
      delete step.status_history;
    }
  }, 'example-project.json'));

  const unAdoptedWrite = runMainCapture(['direction', 'write', '1', dir, '--file', 'evidence/direction/v4.json', '--rig', '2'], CHAIN_NOW);
  expect(unAdoptedWrite.code).toBe(1);
  expect(unAdoptedWrite.stderr).toContain('DIRECTION_CONTRACT_INVALID');

  const beforeAdopt = nextProject(dir, CHAIN_NOW);
  expect(beforeAdopt.refusals).toEqual([]);
  const adoptMove = beforeAdopt.moves.find(move => move.field === 'direction_contract');
  expect(adoptMove).toMatchObject({
    role: 'agent',
    field: 'direction_contract',
    awaits: 'direction_contract',
    command: `rig-create direction --adopt ${dir}`,
  });
  expect(runMainCapture(printedArgs(adoptMove!.command!).slice(1), CHAIN_NOW)).toMatchObject({ code: 0, stderr: '' });

  const wrongVersionWrite = runMainCapture(['direction', 'write', '1', dir, '--file', 'evidence/direction/v4.json', '--rig', '2'], CHAIN_NOW);
  expect(wrongVersionWrite.code).toBe(1);
  expect(wrongVersionWrite.stderr).toContain('DIRECTION_VERSION');

  const afterAdopt = nextProject(dir, CHAIN_NOW);
  expect(afterAdopt.refusals).toEqual([]);
  const writeMove = afterAdopt.moves.find(move => move.field === 'versions');
  expect(writeMove).toMatchObject({
    role: 'agent',
    field: 'versions',
    awaits: 'versions[n=3]',
    command: `rig-create direction write 3 ${dir} --file '<direction.json>' --rig 2`,
  });
});

test('#579 after a rig-review reopen, next omits history rig versions and lapsed rig-review signoff, routes through registering and publishing a post-reopen rig version, and keeps post stages free of history rigs', () => {
  const dir = join(tempDir(), 'reopen-rig-review');
  cpSync(join(CHECKPOINTS_DIR, '3-rig-review'), dir, { recursive: true });
  const file = join(dir, 'project.json');

  // Control: a project without a reopen keeps today's next output.
  const unreopened = nextProject(dir, CHAIN_NOW);
  expect(unreopened.refusals).toEqual([]);
  expect(unreopened.awaits).toEqual(['versions[n=1].verdicts[review=rig-review]']);
  expect(unreopened.moves.filter(m => m.role === 'human')).toEqual([
    expect.objectContaining({
      role: 'human',
      field: 'versions[v1].verdicts',
      awaits: 'versions[n=1].verdicts[review=rig-review]',
      command: null,
      review_act: { kind: 'review-verdict', stage: 'rig-review', version_id: 'v1', review: 'rig-review' },
    }),
  ]);

  // Step 1: Rig v1 is accepted and rig-review is signed on it.
  testClock.set(new Date(CHAIN_NOW));
  reviewCommand([
    '1',
    dir,
    '--verdict',
    'accepted',
    '--by',
    'user',
    '--review',
    'rig-review',
    '--verbatim-file',
    join(dir, 'evidence/approval.txt'),
    '--source',
    'synthetic example',
  ]);
  signoffCommand(['rig-review', dir, '--by', 'user', '--verbatim-file', join(dir, 'evidence/approval.txt')]);

  // Prepare the synthetic registration source cohort for v2 (pre-reopen) and v3 (post-reopen).
  cpSync(join(REPO, 'tests/fixtures/rig-registration'), join(dir, 'rebuild-source'), { recursive: true });
  const putSource = (path: string, value: unknown): void =>
    writeFileSync(
      join(dir, 'rebuild-source', path),
      typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value),
    );
  putSource('config.json', { key: 'synthetic', requirements: 'requirements.json' });
  putSource('requirements.json', {
    spec: 'spine-parts-requirements/1',
    fps: 4,
    requirements: [],
    setup_painting: { required: true },
  });
  putSource('adapter.json', []);
  cpSync(join(dir, 'derived/drafts/chain/input'), join(dir, 'rebuild-source/parts'), { recursive: true });
  cpSync(join(dir, 'outputs/v1/out/check/build/skeleton.model.json'), join(dir, 'rebuild-source/build/skeleton.model.json'));
  putSource('check.json', { spec: 'rig-parts-check/1', bar_outcomes: { gate: { status: 'PASS' } },
    build: { model_sha256: sha256(readFileSync(join(dir, 'rebuild-source/build/skeleton.model.json'))) } });
  const setBuildTime = (iso: string): void => {
    putSource('at-source.json', { finished_at: iso });
    putSource('run.json', {
      spec: 'rigc-run/1',
      package: { name: 'rig-c', version: '3.4.1' },
      command: 'build',
      started_at: iso,
      finished_at: iso,
      inputs: [
        { role: 'rig', path: '../rig/rig.json', sha256: '1'.repeat(64) },
        { role: 'motion', path: '../rig/motion.json', sha256: '2'.repeat(64) },
      ],
      outputs: [
        { path: '../compile-report.json', sha256: '3'.repeat(64) },
        { path: 'skeleton.model.json', sha256: '4'.repeat(64) },
      ],
    });
  };
  const bindings: Record<string, string> = {
    '--parts': 'parts',
    '--rig': 'rig',
    '--build': 'build',
    '--idle': 'idle',
    '--config': 'config.json',
    '--path-adapter': 'adapter.json',
    '--compile-report': 'compile-report.json',
    '--toolchain-lock': 'package-lock.json',
    '--run-record': 'run.json',
    '--at-source': 'at-source.json',
  };
  const registerRig = (n: number, builtIso: string, regNow: number): void => {
    setBuildTime(builtIso);
    const res = runMainCapture(
      [
        'rig-version',
        String(n),
        dir,
        ...Object.entries(bindings).flatMap(([flag, rel]) => [flag, `rebuild-source/${rel}`]),
        '--at-pointer',
        '/finished_at',
        '--by',
        'registrant',
      ],
      regNow,
    );
    expect(res).toMatchObject({ code: 0, stderr: '' });
  };

  // Register Rig v2 (built before any reopen).
  const v2At = CHAIN_NOW + 1000;
  registerRig(2, new Date(v2At).toISOString(), v2At);

  // Step 2: Reopen rig-review.
  const reopenAt = CHAIN_NOW + 2000;
  const reopenWords = join(dir, 'reopen-words.txt');
  writeFileSync(reopenWords, 'Reopen rig-review to rebuild the synthetic rig.\n');
  testClock.set(new Date(reopenAt));
  reopenCommand(['rig-review', dir, '--by', 'owner', ...ownerChatArgs(reopenWords)]);

  // Attempting to sign rig-review on the history acceptance refuses with RIG_VERSION_UNACCEPTED and leaves project.json byte-identical.
  const beforeRefusedSign = readFileSync(file);
  const refusedSign = runMainCapture(
    ['signoff', 'rig-review', dir, '--by', 'user', '--verbatim-file', join(dir, 'evidence/approval.txt')],
    reopenAt,
  );
  expect(refusedSign.code).toBe(1);
  expect(refusedSign.stderr).toContain('RIG_VERSION_UNACCEPTED');
  expect(readFileSync(file)).toEqual(beforeRefusedSign);

  const staleProject = JSON.parse(readFileSync(file, 'utf8')) as JsonObject;
  expect(() => optionContext(staleProject, 'post-interview', reopenAt, dir))
    .toThrow(expect.objectContaining({ code: 'INTERVIEW_OPTIONS_STALE' }));

  // Before registering a post-reopen rig version: next names only the new rig-version registration route.
  const beforePostReopenRig = nextProject(dir, reopenAt);
  expect(beforePostReopenRig.refusals).toEqual([]);
  expect(beforePostReopenRig.awaits).toEqual(['versions[n=3]']);
  expect(beforePostReopenRig.moves).toHaveLength(1);
  expect(beforePostReopenRig.moves[0]).toMatchObject({
    role: 'agent',
    field: 'versions',
    awaits: 'versions[n=3]',
  });
  expect(beforePostReopenRig.moves[0]!.command).toContain(`rig-create rig-version 3 ${dir}`);
  expect(beforePostReopenRig.moves[0]!.command).toContain("--check-report '<check.json>'");
  expect(checkProject(dir, undefined, { now: reopenAt, readOnly: true }).warnings).toContainEqual({
    code: 'RIG_CHECK_REPORT_MISSING', path: 'versions[v2].registration.check_report',
    message: expect.stringContaining('rig-parts check --rig <rig dir> --parts <parts dir> --out <check dir>'),
  });
  expect(beforePostReopenRig.moves[0]!.act).toContain('built after the reopen');
  expect(beforePostReopenRig.moves.some(m => m.lapse !== undefined)).toBe(false);
  expect(beforePostReopenRig.moves.some(m => m.review_act?.version_id === 'v1' || m.review_act?.version_id === 'v2')).toBe(false);
  expect(beforePostReopenRig.moves.some(m => m.review_act?.kind === 'signoff')).toBe(false);

  // Execute the printed rig-version 3 command with a build timestamp after the reopen.
  const v3At = reopenAt + 1000;
  setBuildTime(new Date(v3At).toISOString());
  const postReopenBindings: Record<string, string> = { ...bindings, '--check-report': 'check.json' };
  const printedRigArgs = printedArgs(beforePostReopenRig.moves[0]!.command!).slice(1);
  for (const [index, arg] of printedRigArgs.entries()) {
    if (arg.startsWith('<')) {
      printedRigArgs[index] = postReopenBindings[printedRigArgs[index - 1]!]
        ? `rebuild-source/${postReopenBindings[printedRigArgs[index - 1]!]}`
        : arg === '<pointer>'
          ? '/finished_at'
          : 'registrant';
    }
  }
  expect(runMainCapture(printedRigArgs, v3At)).toMatchObject({ code: 0, stderr: '' });
  const reboundProject = JSON.parse(readFileSync(file, 'utf8')) as JsonObject;
  const approval = arr(reboundProject.signoffs).map(obj).find(s => s.stage === 'parts-review')!;
  expect(arr(reboundProject.versions).map(obj).find(v => v.n === 3)?.accepted_parts)
    .toEqual({ signoff_at: approval.at, evidence: approval.evidence });

  // After registering the post-reopen rig version (v3): next lists only the one-verdict publication route for v3.
  const afterPostReopenRig = nextProject(dir, v3At);
  expect(afterPostReopenRig.refusals).toEqual([]);
  expect(afterPostReopenRig.awaits).toEqual(['versions[n=3].verdicts[review=rig-review]']);
  expect(afterPostReopenRig.moves.some(m => m.lapse !== undefined)).toBe(false);
  expect(afterPostReopenRig.moves.some(m => m.review_act?.version_id === 'v1' || m.review_act?.version_id === 'v2')).toBe(false);
  expect(afterPostReopenRig.moves.some(m => m.command?.includes('--rig 1') || m.command?.includes('--rig 2'))).toBe(false);
  expect(afterPostReopenRig.moves.some(m => m.review_act?.kind === 'signoff')).toBe(false);
  const humanMoves = afterPostReopenRig.moves.filter(m => m.role === 'human');
  expect(humanMoves).toHaveLength(1);
  expect(humanMoves[0]).toMatchObject({
    role: 'human',
    field: 'versions[v3].verdicts',
    awaits: 'versions[n=3].verdicts[review=rig-review]',
    command: null,
    review_act: { kind: 'review-verdict', stage: 'rig-review', version_id: 'v3', review: 'rig-review' },
  });
  expect(humanMoves[0]!.act).toContain('approve once to record the verdict and rig-review signature');
  expect(afterPostReopenRig.moves.map(m => m.command)).toEqual([
    `rig-create job open ${dir} --rig 3 --reviewer '<reviewer>' --role owner`,
    null,
    `rig-create job acts ${dir} --json`,
    `rig-create review 3 ${dir} --from-review '<actId>'`,
    `rig-create job close ${dir}`,
  ]);

  // Post stages after such a reopen (post and direction-review) must not list history rig versions (v1 or v2).
  // Record a still frame on v3, accept v3 at rig-review, sign rig-review on v3, and advance through post-interview to post via writers.
  const v3StillPath = 'outputs/v3/idle/idle@4fps/f0000.png';
  const v3StillSha = sha256(readFileSync(join(dir, v3StillPath)));
  const withStill = JSON.parse(readFileSync(file, 'utf8')) as JsonObject;
  const v3Entry = arr(withStill.versions).map(obj).find(v => v.n === 3)!;
  v3Entry.evidence = [{ kind: 'still', path: v3StillPath, sha256: v3StillSha, camera: 'fixed', frame: 0 }];
  writeFileSync(file, `${JSON.stringify(withStill, null, 2)}\n`);

  const acceptAt = v3At + 1000;
  testClock.set(new Date(acceptAt));
  reviewCommand([
    '3',
    dir,
    '--verdict',
    'accepted',
    '--by',
    'user',
    '--review',
    'rig-review',
    '--verbatim-file',
    join(dir, 'evidence/approval.txt'),
    '--source',
    'synthetic example',
  ]);
  signoffCommand(['rig-review', dir, '--by', 'user', '--verbatim-file', join(dir, 'evidence/approval.txt')]);
  expect(runMainCapture(['advance', 'post-interview', dir], acceptAt + 1000)).toMatchObject({ code: 0, stderr: '' });
  for (const q of ['camera_depth', 'post_timing', 'post_composition']) {
    const optProject = JSON.parse(readFileSync(file, 'utf8')) as JsonObject;
    const set = JSON.parse(readFileSync(join(CHAIN_DIR, `evidence/interview/${q}.json`), 'utf8')) as JsonObject;
    set.id = `printed-${q}`;
    set.drafted_at = new Date(acceptAt + 1000).toISOString();
    set.context = optionContext(optProject, String(set.stage), acceptAt + 1000, dir);
    const setRel = `evidence/printed-${q}.json`;
    const setBytes = JSON.stringify(set);
    writeFileSync(join(dir, setRel), setBytes);
    expect(runMainCapture(['interview-options', q, dir, '--file', setRel], acceptAt + 1000)).toMatchObject({ code: 0, stderr: '' });
    expect(
      runMainCapture(
        ['interview-answer', q, dir, '--set', setRel, '--sha256', sha256(setBytes), '--by', 'user', '--pick', `${q}=keep`],
        acceptAt + 1000,
      ),
    ).toMatchObject({ code: 0, stderr: '' });
  }
  for (const id of ['camera', 'timing', 'composition']) {
    const planMove = nextProject(dir, acceptAt + 1000).moves.find(m => m.command?.startsWith(`rig-create plan add ${id} `))!;
    expect(runMainCapture(printedArgs(planMove.command!).slice(1), acceptAt + 1000)).toMatchObject({ code: 0, stderr: '' });
  }
  testClock.set(new Date(acceptAt + 2000));
  signoffCommand(['post-interview', dir, '--by', 'user', '--verbatim-file', join(dir, 'evidence/approval.txt')]);
  expect(runMainCapture(['advance', 'post', dir], acceptAt + 3000)).toMatchObject({ code: 0, stderr: '' });
  testClock.set(new Date(acceptAt + 3000));
  for (const id of ['camera', 'timing', 'composition']) {
    stepStatusCommand([id, 'in-progress', dir, '--by', 'agent']);
    stepStatusCommand([id, 'at-checkpoint', dir, '--by', 'agent']);
    stepStatusCommand([id, 'done', dir, '--by', 'agent']);
  }
  const adoptMove = nextProject(dir, acceptAt + 3000).moves.find(m => m.field === 'direction_contract')!;
  expect(runMainCapture(printedArgs(adoptMove.command!).slice(1), acceptAt + 3000)).toMatchObject({ code: 0, stderr: '' });

  // At post stage after the rig-review reopen: next binds the live accepted rig v3, never history v1 or v2.
  const atPost = nextProject(dir, acceptAt + 3000);
  expect(atPost.refusals).toEqual([]);
  expect(atPost.moves.some(m => m.lapse !== undefined)).toBe(false);
  expect(atPost.moves.some(m => m.review_act?.version_id === 'v1' || m.review_act?.version_id === 'v2')).toBe(false);
  const sceneMove = atPost.moves.find(m => m.role === 'agent')!;
  expect(sceneMove.command).toContain('--rig 3');

  // Author scene and post v4 on rig v3, advance to direction-review, and verify no history rig versions appear.
  expect(runMainCapture(preparePrintedOptions(dir, sceneMove.command!, acceptAt + 3000), acceptAt + 3000)).toMatchObject({ code: 0, stderr: '' });
  const afterSceneNext = nextProject(dir, acceptAt + 3000);
  const dirWriteMove = afterSceneNext.moves.find(m => m.role === 'agent')!;
  expect(dirWriteMove.command).toContain('direction write 4');
  expect(dirWriteMove.command).toContain('--rig 3');
  const afterSceneProject = JSON.parse(readFileSync(file, 'utf8')) as JsonObject;
  const latestScene = obj(arr(afterSceneProject.scenes).at(-1));
  const v3ModelPath = 'derived/review/v3/out/check/build/skeleton.model.json';
  const dirDoc = JSON.parse(readFileSync(join(CHAIN_DIR, 'evidence/direction-input.json'), 'utf8')) as JsonObject;
  dirDoc.scene = { n: latestScene.n!, path: latestScene.path!, sha256: latestScene.sha256! };
  dirDoc.rig = { version: 3, model: { path: v3ModelPath, sha256: sha256(readFileSync(join(dir, v3ModelPath))) } };
  for (const section of ['camera', 'timing'] as const) {
    const guideId = section === 'camera' ? 'camera_depth' : 'post_timing';
    const guide = obj(arr(obj(obj(afterSceneProject.interview).post).items).map(obj).find(i => i.id === guideId)!.guide);
    obj(obj(dirDoc.citations)[section]).quote = guide.verbatim!;
  }
  writeFileSync(join(dir, 'evidence/direction-input.json'), JSON.stringify(dirDoc));
  expect(
    runMainCapture(
      ['direction', 'write', '4', dir, '--file', 'evidence/direction-input.json', '--rig', '3'],
      acceptAt + 4000,
    ),
  ).toMatchObject({ code: 0, stderr: '' });
  expect(runMainCapture(['advance', 'direction-review', dir], acceptAt + 5000)).toMatchObject({ code: 0, stderr: '' });

  const atDirectionReview = nextProject(dir, acceptAt + 5000);
  expect(atDirectionReview.refusals).toEqual([]);
  expect(atDirectionReview.moves.some(m => m.lapse !== undefined)).toBe(false);
  expect(atDirectionReview.moves.some(m => m.review_act?.version_id === 'v1' || m.review_act?.version_id === 'v2' || m.review_act?.version_id === 'v3')).toBe(false);
  expect(atDirectionReview.moves.some(m => m.command?.includes('--rig 1') || m.command?.includes('--rig 2') || m.command?.includes('--rig 3'))).toBe(false);
  expect(atDirectionReview.moves.find(m => m.review_act?.kind === 'review-verdict')).toMatchObject({
    role: 'human',
    field: 'versions[v4].verdicts',
    awaits: 'versions[n=4].verdicts[review=direction-review]',
    review_act: { kind: 'review-verdict', stage: 'direction-review', version_id: 'v4', review: 'direction-review' },
  });

  // Consumer-clone shape: post v4 is reviewed and signed at direction-review, then rig-review is reopened,
  // a new rig v5 is registered, accepted and signed, and a new unreviewed post v6 reaches direction-review.
  testClock.set(new Date(acceptAt + 5500));
  reviewCommand([
    '4',
    dir,
    '--verdict',
    'accepted',
    '--by',
    'user',
    '--review',
    'direction-review',
    '--verbatim-file',
    join(dir, 'evidence/approval.txt'),
    '--source',
    'synthetic example',
  ]);
  signoffCommand(['direction-review', dir, '--by', 'user', '--verbatim-file', join(dir, 'evidence/approval.txt')]);

  const reopen2At = acceptAt + 6000;
  testClock.set(new Date(reopen2At));
  reopenCommand(['rig-review', dir, '--by', 'owner', ...ownerChatArgs(reopenWords)]);

  const v5At = reopen2At + 1000;
  registerRig(5, new Date(v5At).toISOString(), v5At);
  const v5StillPath = 'outputs/v5/idle/idle@4fps/f0000.png';
  const v5StillSha = sha256(readFileSync(join(dir, v5StillPath)));
  const withV5Still = JSON.parse(readFileSync(file, 'utf8')) as JsonObject;
  const v5Entry = arr(withV5Still.versions).map(obj).find(v => v.n === 5)!;
  v5Entry.evidence = [{ kind: 'still', path: v5StillPath, sha256: v5StillSha, camera: 'fixed', frame: 0 }];
  writeFileSync(file, `${JSON.stringify(withV5Still, null, 2)}\n`);

  const acceptV5At = v5At + 1000;
  testClock.set(new Date(acceptV5At));
  reviewCommand([
    '5',
    dir,
    '--verdict',
    'accepted',
    '--by',
    'user',
    '--review',
    'rig-review',
    '--verbatim-file',
    join(dir, 'evidence/approval.txt'),
    '--source',
    'synthetic example',
  ]);
  signoffCommand(['rig-review', dir, '--by', 'user', '--verbatim-file', join(dir, 'evidence/approval.txt')]);
  expect(runMainCapture(['advance', 'post-interview', dir], acceptV5At + 1000)).toMatchObject({ code: 0, stderr: '' });
  testClock.set(new Date(acceptV5At + 2000));
  signoffCommand(['post-interview', dir, '--by', 'user', '--verbatim-file', join(dir, 'evidence/approval.txt')]);
  expect(runMainCapture(['advance', 'post', dir], acceptV5At + 3000)).toMatchObject({ code: 0, stderr: '' });
  testClock.set(new Date(acceptV5At + 3000));
  for (const id of ['camera', 'timing', 'composition']) {
    stepStatusCommand([id, 'in-progress', dir, '--by', 'agent']);
    stepStatusCommand([id, 'at-checkpoint', dir, '--by', 'agent']);
    stepStatusCommand([id, 'done', dir, '--by', 'agent']);
  }
  expect(
    runMainCapture(
      ['scene', 'write', dir, '--rig', '5', '--background', 'inputs/background.png', '--citations-file', 'evidence/printed-scene-citations.json'],
      acceptV5At + 3000,
    ),
  ).toMatchObject({ code: 0, stderr: '' });
  const afterV5SceneProject = JSON.parse(readFileSync(file, 'utf8')) as JsonObject;
  const latestV5Scene = obj(arr(afterV5SceneProject.scenes).at(-1));
  const v5ModelPath = 'derived/review/v5/out/check/build/skeleton.model.json';
  dirDoc.scene = { n: latestV5Scene.n!, path: latestV5Scene.path!, sha256: latestV5Scene.sha256! };
  dirDoc.rig = { version: 5, model: { path: v5ModelPath, sha256: sha256(readFileSync(join(dir, v5ModelPath))) } };
  writeFileSync(join(dir, 'evidence/direction-input.json'), JSON.stringify(dirDoc));
  expect(
    runMainCapture(
      ['direction', 'write', '6', dir, '--file', 'evidence/direction-input.json', '--rig', '5'],
      acceptV5At + 4000,
    ),
  ).toMatchObject({ code: 0, stderr: '' });
  expect(runMainCapture(['advance', 'direction-review', dir], acceptV5At + 5000)).toMatchObject({ code: 0, stderr: '' });

  const afterSignedPostReopen = nextProject(dir, acceptV5At + 5000);
  expect(afterSignedPostReopen.refusals).toEqual([]);
  expect(afterSignedPostReopen.awaits).toEqual([
    'versions[n=6].verdicts[review=direction-review]',
    'signoffs[stage=direction-review]',
  ]);
  expect(afterSignedPostReopen.moves.some(m => m.lapse !== undefined)).toBe(false);
  expect(afterSignedPostReopen.moves.some(m => m.act.includes('re-approve lapsed'))).toBe(false);
  expect(afterSignedPostReopen.moves.some(m => m.review_act?.version_id !== 'v6' && m.review_act?.version_id !== undefined)).toBe(false);
  expect(afterSignedPostReopen.moves.map(m => m.command)).toEqual([
    `rig-create job open ${dir} --rig 6 --reviewer '<reviewer>' --role owner`,
    null,
    `rig-create job acts ${dir} --json`,
    `rig-create review 6 ${dir} --from-review '<actId>'`,
    `rig-create job close ${dir}`,
    null,
  ]);
  expect(afterSignedPostReopen.moves[1]).toMatchObject({
    role: 'human',
    field: 'versions[v6].verdicts',
    awaits: 'versions[n=6].verdicts[review=direction-review]',
    review_act: { kind: 'review-verdict', stage: 'direction-review', version_id: 'v6', review: 'direction-review' },
  });
  expect(afterSignedPostReopen.moves[5]).toMatchObject({
    role: 'human',
    field: 'signoffs',
    awaits: 'signoffs[stage=direction-review]',
    review_act: { kind: 'signoff', stage: 'direction-review', version_id: 'v6' },
  });
  expect(afterSignedPostReopen.moves[5]!.act).toContain('after ingesting the accepted direction-review verdict for v6');
}, 30_000);

test('#587 after a parts-review reopen and a new prepared draft, next awaits the draft parts verdict via job open --draft ahead of any rig-version move', () => {
  const dir = join(realpathSync(tempDir()), 'reopen-parts-review-draft-verdict');
  cpSync(join(CHECKPOINTS_DIR, '3-rig-review'), dir, { recursive: true });
  const file = join(dir, 'project.json');
  const words = join(dir, 'words.txt');
  writeFileSync(words, 'Synthetic owner words.\n');

  // Record accepted rig v1, register rig v2, and bounce rig v2 so both REOPEN_VERDICT_LAPSED and FEEDBACK_OPEN are live warnings after reopen.
  testClock.set(new Date(CHAIN_NOW));
  reviewCommand([
    '1',
    dir,
    '--verdict',
    'accepted',
    '--by',
    'user',
    '--review',
    'rig-review',
    '--verbatim-file',
    words,
    '--source',
    'synthetic example',
  ]);
  signoffCommand(['rig-review', dir, '--by', 'user', '--verbatim-file', words]);

  cpSync(join(REPO, 'tests/fixtures/rig-registration'), join(dir, 'rebuild-source'), { recursive: true });
  const putSource = (path: string, value: unknown): void =>
    writeFileSync(
      join(dir, 'rebuild-source', path),
      typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value),
    );
  putSource('config.json', { key: 'synthetic', requirements: 'requirements.json' });
  putSource('requirements.json', {
    spec: 'spine-parts-requirements/1',
    fps: 4,
    requirements: [],
    setup_painting: { required: true },
  });
  putSource('adapter.json', []);
  cpSync(join(dir, 'derived/drafts/chain/input'), join(dir, 'rebuild-source/parts'), { recursive: true });
  cpSync(join(dir, 'outputs/v1/out/check/build/skeleton.model.json'), join(dir, 'rebuild-source/build/skeleton.model.json'));
  const v2Iso = new Date(CHAIN_NOW + 1000).toISOString();
  putSource('at-source.json', { finished_at: v2Iso });
  putSource('run.json', {
    spec: 'rigc-run/1',
    package: { name: 'rig-c', version: '3.4.1' },
    command: 'build',
    started_at: v2Iso,
    finished_at: v2Iso,
    inputs: [
      { role: 'rig', path: '../rig/rig.json', sha256: '1'.repeat(64) },
      { role: 'motion', path: '../rig/motion.json', sha256: '2'.repeat(64) },
    ],
    outputs: [
      { path: '../compile-report.json', sha256: '3'.repeat(64) },
      { path: 'skeleton.model.json', sha256: '4'.repeat(64) },
    ],
  });
  expect(
    runMainCapture(
      [
        'rig-version',
        '2',
        dir,
        '--parts',
        'rebuild-source/parts',
        '--rig',
        'rebuild-source/rig',
        '--build',
        'rebuild-source/build',
        '--idle',
        'rebuild-source/idle',
        '--config',
        'rebuild-source/config.json',
        '--path-adapter',
        'rebuild-source/adapter.json',
        '--compile-report',
        'rebuild-source/compile-report.json',
        '--toolchain-lock',
        'rebuild-source/package-lock.json',
        '--run-record',
        'rebuild-source/run.json',
        '--at-source',
        'rebuild-source/at-source.json',
        '--at-pointer',
        '/finished_at',
        '--by',
        'registrant',
      ],
      CHAIN_NOW + 1000,
    ),
  ).toMatchObject({ code: 0, stderr: '' });

  testClock.set(new Date(CHAIN_NOW + 2000));
  reviewCommand([
    '2',
    dir,
    '--verdict',
    'bounced',
    '--by',
    'user',
    '--review',
    'rig-review',
    '--item',
    'rig_type:user',
    '--verbatim-file',
    words,
    '--source',
    'synthetic bounce',
  ]);

  // Reopen parts-review, then draft-rig <id>, structure-snapshot --draft <id>, and diff-classes with a triage file.
  const reopenAt = CHAIN_NOW + 3000;
  testClock.set(new Date(reopenAt));
  reopenCommand(['parts-review', dir, '--by', 'user', ...ownerChatArgs(words)]);

  const draftId = 'chain-reopened';
  cpSync(join(dir, 'derived/drafts/chain'), join(dir, `derived/drafts/${draftId}`), { recursive: true });
  expect(
    runMainCapture(
      [
        'draft-rig',
        draftId,
        dir,
        '--config',
        `derived/drafts/${draftId}/config.json`,
        '--from',
        `derived/drafts/${draftId}/out`,
        '--parts',
        `derived/drafts/${draftId}/input`,
      ],
      reopenAt + 1000,
    ),
  ).toMatchObject({ code: 0, stderr: '' });
  expect(
    runMainCapture(
      ['structure-snapshot', dir, '--draft', draftId, '--out', `evidence/structure-${draftId}.json`],
      reopenAt + 2000,
    ),
  ).toMatchObject({ code: 0, stderr: '' });
  const diffReport = JSON.parse(readFileSync(join(dir, 'evidence/diff-components.json'), 'utf8')) as {
    components: { id: string }[];
  };
  const triagePath = join(dir, 'evidence/diff-triage.json');
  writeFileSync(
    triagePath,
    `${JSON.stringify(
      {
        components: Object.fromEntries(
          diffReport.components.map(c => [c.id, { status: 'in-painting', why: 'synthetic component' }]),
        ),
      },
      null,
      2,
    )}\n`,
  );
  expect(
    runMainCapture(
      ['diff-classes', dir, '--diff-report', 'evidence/diff-components.json', '--triage-file', 'evidence/diff-triage.json', '--by', 'agent'],
      reopenAt + 3000,
    ),
  ).toMatchObject({ code: 0, stderr: '' });

  const checked = checkProject(dir, undefined, { now: reopenAt + 4000, readOnly: true });
  expect(checked.refusals).toEqual([]);
  expect(checked.warnings.map(w => w.code)).toContain('FEEDBACK_OPEN');
  expect(checked.warnings.map(w => w.code)).toContain('REOPEN_VERDICT_LAPSED');

  const beforeNext = readFileSync(file);
  for (const withFeedbackOpen of [true, false]) {
    if (!withFeedbackOpen) {
      const current = JSON.parse(beforeNext.toString('utf8')) as JsonObject;
      current.versions = arr(current.versions).filter(v => obj(v).n !== 2);
      writeFileSync(file, `${JSON.stringify(current, null, 2)}\n`);
    }
    const snapshot = readFileSync(file);
    const report = nextProject(dir, reopenAt + 4000);
    expect(readFileSync(file)).toEqual(snapshot);
    expect(report.stage).toBe('parts-review');
    expect(report.effective_stage).toBe('parts-review');
    expect(report.refusals).toEqual([]);
    expect(report.awaits).toEqual([`review_acts[kind=parts-verdict,draft_id=${draftId}]`]);
    expect(report.moves.some(m => m.command?.includes('rig-version'))).toBe(false);
    expect(report.moves.map(m => m.command)).toEqual([
      `rig-create job open ${dir} --draft ${draftId} --reviewer '<reviewer>' --role owner`,
      null,
      `rig-create job acts ${dir} --json`,
      `rig-create parts-review ${dir} --from-review '<actId>'`,
      `rig-create job close ${dir}`,
    ]);
    expect(report.moves[1]).toMatchObject({
      role: 'human',
      field: 'review_acts',
      awaits: `review_acts[kind=parts-verdict,draft_id=${draftId}]`,
      command: null,
      review_act: {
        kind: 'parts-verdict',
        stage: 'parts-review',
        draft_id: draftId,
      },
    });
  }
});

test('#656 after a reopen to rigging-interview with a lapsed post-interview signoff, next shows post-interview as future work without job open --plan', () => {
  const dir = join(realpathSync(tempDir()), 'reopen-rigging-interview-lapsed-post');
  cpSync(join(CHECKPOINTS_DIR, '4-direction-post'), dir, { recursive: true });
  const words = join(dir, 'words.txt');
  writeFileSync(words, 'Reopen to rigging-interview.\n');
  const reopenAt = Date.parse('2026-11-06T02:00:00Z');
  testClock.set(new Date(reopenAt));
  reopenCommand(['rigging-interview', dir, '--by', 'owner', ...ownerChatArgs(words)]);

  const report = nextProject(dir, reopenAt);
  expect(report.stage).toBe('rigging-interview');
  expect(report.effective_stage).toBe('rigging-interview');
  expect(report.refusals).toEqual([]);

  const postMoves = report.moves.filter(m => m.awaits === 'signoffs[stage=post-interview]');
  expect(postMoves).toHaveLength(1);
  expect(postMoves[0]).toMatchObject({
    role: 'human',
    field: 'reopens[0]',
    awaits: 'signoffs[stage=post-interview]',
    command: null,
    review_act: { kind: 'signoff', stage: 'post-interview' },
    lapse: expect.objectContaining({ code: 'REOPEN_SIGNOFF_LAPSED' }),
  });

  const rigMoves = report.moves.filter(m => m.awaits === 'signoffs[stage=rigging-interview]');
  expect(rigMoves.some(m => m.role === 'agent' && m.command?.includes('job open') && m.command.includes('--plan'))).toBe(true);
});
