import { afterEach, describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { JOB_COMMENTS_ACT_SCHEMA, startJobHost, type ActV3, type JobOwnerHost } from '@rig-c/review/job-host';
import { main } from '../src/cli.ts';
import { checkProject, PLAN_STEP_ANSWER_SINCE } from '../src/check.ts';
import { outputSetHash } from '../src/current.ts';
import { openCreateJob } from '../src/job-host.ts';
import { prepareDraftManifest, readPublished, readRecordPublished } from '../src/job-publication.ts';
import { stageIndex } from '../src/stages.ts';
import { acknowledgePublication, enqueuePublication, jobHostStateRoot, readWriterBinding, reconcilePublication } from '../src/job-outbox.ts';
import { jobRuntimeExecArgv } from '../src/job-writer.ts';
import { baselineOf, newFindings } from '../src/refusal-baseline.ts';
import { agentCall, partsStructureSnapshot, pendingJobActs } from '../src/job-acts.ts';
import { freshProjectRecord } from '../src/init.ts';
import { renderAgentGuide } from '../src/agent-guide.ts';
import { optionContext } from '../src/choices.ts';
import { NEXT_SCHEMA, nextCommand, nextProject, type NextMove, type NextReport } from '../src/next.ts';
import { OWNER_CHAT_SOURCE } from '../src/owner-chat.ts';
import { LAST_NUMBERED_CREATE_RELEASE } from '../src/numbered-retirement.ts';
import { Refusal, USAGE_EXIT } from '../src/refusal.ts';
import { EXAMPLE_NOW } from '../scripts/example-time.ts';
import { planCommand, stepStatusCommand, amendCommand, signoffCommand, testClock } from './clock.ts';
import { seedStoredPartsVerdictAct, seedStoredVerdict, seedStoredVersionSignoff, selectHistoricalSignoffTarget } from './historical-review-fixture.ts';
import { plantLegacyReopen, arr, fixture, obj, retimeFixture, retainSignoffs, waypoint } from './fixtures.ts';
import { ownerChatArgs, tempDir, treeDigest } from './helpers.ts';
import { seedRetainedDirectionPost, seedRetainedDraft, seedRetainedRigVersion, seedRetainedScene } from './numbered-seed.ts';
import { recordPartsReceipt } from './parts-receipt-fixture.ts';
import { latestPartsVerdictStatus } from '../src/parts-verdict-record.ts';
import { selectAnswerHashes } from '../src/signoff-answers.ts';
import { stepHash } from '../src/step-hash.ts';
import type { JsonObject } from '../src/templates.ts';

const REPO = join(import.meta.dir, '..');
const CHAIN_DIR = join(REPO, 'templates/example-chain');
const CHECKPOINTS_DIR = join(CHAIN_DIR, 'checkpoints');
const REMESH_DIR = join(REPO, 'templates/example-remesh');
const CHAIN_NOW = EXAMPLE_NOW;

afterEach(() => testClock.reset());

test('#467 next keeps numbered direction review read-only with or without a live verdict', () => {
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
  expectNumberedPostReadOnly(before);
  expect(before.moves.some(move => move.awaits === 'signoffs[stage=direction-review]')).toBe(false);

  post.verdicts = accepted!;
  writeFileSync(file, `${JSON.stringify(project, null, 2)}\n`);
  const after = nextProject(dir, CHAIN_NOW);
  expect(after.refusals).toEqual([]);
  expect(after.moves.some(move => move.review_act?.kind === 'review-verdict' && move.review_act.stage === 'direction-review')).toBe(false);
  expect(after.moves.some(move => move.command?.includes('--plan'))).toBe(false);
  expectNumberedPostReadOnly(after);
  expect(after.moves.some(move => move.awaits === 'signoffs[stage=direction-review]')).toBe(false);
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

function isRecordAdoption(command: string | null): boolean {
  return command !== null && command.startsWith('rig-create record ') && printedArgs(command).includes('--adopt');
}

function expectRetiredVerdict(report: NextReport, awaits: string): void {
  expect(report.awaits).toContain(awaits);
  const moves = report.moves.filter(move => move.awaits === awaits);
  expect(moveTuples(moves)).toEqual([['human', null, null]]);
  expect(moves[0]?.act).toContain('NUMBERED_ACT_RETIRED');
  expect(moves[0]?.act).toContain(`Create ${LAST_NUMBERED_CREATE_RELEASE}`);
}

function expectNumberedPostReadOnly(report: NextReport): void {
  expect(report.moves).toContainEqual(expect.objectContaining({
    role: 'agent', field: 'versions', awaits: 'versions', command: null,
    act: expect.stringContaining('NUMBERED_ACT_RETIRED: Numbered scenes and posts are read-only.'),
  }));
  expect(report.moves.some(move => move.field.startsWith('current.') || move.review_act?.stage === 'direction-review'
    || /^rig-create (?:direction (?:--adopt|write)|scene write|advance direction-review|signoff direction-review)\b/.test(move.command ?? ''))).toBe(false);
}

function moveTuples(moves: NextMove[]) {
  return moves.map(move => [move.role, move.command === null ? null : printedArgs(move.command).slice(0, 3).join(' '),
    move.review_act?.kind ?? null]);
}

function expectOwnerChatSignoff(moves: NextMove[], stage: string, dir: string, selector: string[] = []): void {
  const signoffs = moves.filter(move => move.awaits === `signoffs[stage=${stage}]`);
  expect(moveTuples(signoffs)).toEqual([['human', `rig-create signoff ${stage}`, null]]);
  expect(signoffs[0]!.review_act).toBeUndefined();
  expect(signoffs[0]!.act).toBe('Relay the owner chat signoff with exact words, owner date and relay identity.');
  expect(printedArgs(signoffs[0]!.command!)).toEqual(['rig-create', 'signoff', stage, dir, ...selector,
    '--by', '<owner>', '--owner-chat', '<words file>', '--said-at', '<ISO date>', '--relayed-by', '<operator>']);
}

function preparePrintedOptions(dir: string, command: string, now: number): string[] {
  const argv = printedArgs(command).slice(1);
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
      const allMoves = report.moves;
      // The checkpoint recipes predate the Review workflow and owner-chat commands.
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
        // so its moves are the human chat question step, owner-chat relay, and optional Review display.
        const interview = project.interview as { framing: Record<string, unknown>[]; waypoints: Record<string, unknown>[] };
        expect(interview.framing[0]?.pending_options).toBeDefined();
        expect(chatMoves.map(m => m.field)).toEqual(['interview.framing[rig_type].pending_options']);
        expect(report.moves[0]).toMatchObject({
          role: 'human',
          field: 'interview.framing[rig_type].pending_options',
          awaits: 'interview.framing[rig_type].answer',
          command: null,
          act: expect.stringContaining('ask the owner in chat for interview.framing[rig_type] (option set chain-rig_type)'),
        });
        expect(report.moves[0]?.review_act).toBeUndefined();
        // Disagreement 2: reference, seethrough, assemble have no pending_options in project.json,
        // and plan.steps is [], so next names those missing fields in unanswered_by_record instead of guessing.
        expect(interview.framing[1]?.pending_options).toBeUndefined();
        expect(report.moves[1]?.unanswered_by_record).toBe('interview.framing[reference].pending_options');
        expect(report.moves[2]?.unanswered_by_record).toBe('interview.waypoints[seethrough].pending_options');
        expect(report.moves[3]?.unanswered_by_record).toBe('interview.waypoints[assemble].pending_options');
        expect((project.plan as { steps: unknown[] }).steps).toEqual([]);
        expect(report.moves.some(move => move.review_act?.kind === 'signoff' && move.review_act.stage === 'interview')).toBe(false);
      } else if (spec.name === '0b-plan-pending') {
        expect(report.awaits).toEqual(spec.pending.awaits);
        expect(report.moves).toEqual([]);
        expectOwnerChatSignoff(allMoves, 'plan-approved', cpDir);
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
        expect(chatMoves.map(m => m.field)).toEqual(['interview.waypoints[bones].pending_options']);
        expect(report.moves[0]).toMatchObject({
          role: 'human',
          field: 'interview.waypoints[bones].pending_options',
          awaits: 'interview.waypoints[bones].guide',
          command: null,
          act: expect.stringContaining('ask the owner in chat for interview.waypoints[bones] (option set chain-bones)'),
        });
        expect(report.moves[0]?.review_act).toBeUndefined();
        expect(report.moves[1]?.unanswered_by_record).toBe('interview.waypoints[meshes].pending_options');
        expect(report.moves[2]?.unanswered_by_record).toBe('interview.waypoints[constraints].pending_options');
        expect(report.moves[3]?.unanswered_by_record).toBe('interview.waypoints[turn].pending_options');
        expect(report.moves[4]?.unanswered_by_record).toBe('interview.waypoints[motion].pending_options');
      } else if (spec.name === '3-rig-review') {
        expect(project.current).toBeUndefined();
        expect(report.refusals).toEqual([]);
        expect(report.awaits).toEqual(['versions[n=1].verdicts[review=rig-review]']);
        expectRetiredVerdict({ ...report, moves: allMoves }, 'versions[n=1].verdicts[review=rig-review]');
      } else if (spec.name === '4-direction-post') {
        expect(project.current).toBeUndefined();
        expect(allMoves.some(move => isRecordAdoption(move.command))).toBe(false);
        expect(report.refusals).toEqual([]);
        expectNumberedPostReadOnly({ ...report, moves: allMoves });
        expect(project.scenes).toBeUndefined();
      }
    });
  }
});

describe('Frozen Bar 2 — No suggested agent move refuses on a scratch copy', () => {
  test('recognizes record adoption with the project directory before or after the flag', () => {
    expect(isRecordAdoption("rig-create record rig --adopt 'project with spaces'")).toBe(true);
    expect(isRecordAdoption("rig-create record rig 'project with spaces' --adopt")).toBe(true);
    expect(isRecordAdoption('rig-create direction --adopt project')).toBe(false);
  });

  test('every standalone agent move executes with exit 0, no new refusals, and clean inputs stay clean', () => {
    const targets: { name: string; dir: string; now: number }[] = [
      ...readdirSync(CHECKPOINTS_DIR)
        .filter(name => !name.endsWith('.json'))
        .sort()
        .map(name => ({ name: `checkpoint:${name}`, dir: join(CHECKPOINTS_DIR, name), now: CHAIN_NOW })),
      { name: 'example-chain', dir: CHAIN_DIR, now: CHAIN_NOW },
      { name: 'example-remesh', dir: REMESH_DIR, now: CHAIN_NOW },
      { name: 'example-numbered', dir: fixture(() => {}, 'example-numbered/example-project.json'), now: CHAIN_NOW },
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
        // Adoption is offered as an explicit migration and verified by its own read-only next tests.
        if (isRecordAdoption(move.command)) continue;
        if (move.act.startsWith('NUMBERED_ACT_RETIRED:')) {
          expect(move.command).toBeNull();
          continue;
        }
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
      fixture(() => {}, 'example-numbered/example-project.json'),
    ];

    for (const dir of dirs) {
      const report = nextProject(dir, CHAIN_NOW);
      for (const move of report.moves) {
        if (move.role === 'agent' || move.role === 'producer') {
          if (move.command === null) {
            expect(move.role).toBe('agent');
            expect(move.field).toMatch(/^(?:drafts|versions)$/);
            expect(move.awaits).toBe(move.field);
            expect(move.act).toMatch(/^NUMBERED_ACT_RETIRED: Numbered (?:drafts|rig registrations|scenes and posts) are read-only\./);
            continue;
          }
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
      fixture(() => {}, 'example-numbered/example-project.json'),
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
    plantLegacyReopen(dir, 'parts', { by: 'owner', wordsFile: words });

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
    expectRetiredVerdict(report, 'signoffs[stage=parts-review]');

    // The remesh example retains its accepted stage while resuming at parts-review.
    const remeshReport = nextProject(REMESH_DIR, CHAIN_NOW);
    expect(remeshReport).toMatchObject({ refusals: [], stage: 'accepted', effective_stage: 'parts-review' });
    const remeshLapses = remeshReport.moves.filter(m => m.lapse?.code === 'AMENDED_STEP');
    expect(remeshLapses.length).toBeGreaterThan(0);
    for (const move of remeshLapses) {
      expect(move.role).toBe('human');
      expect(move.field).toBe('amendments[0]');
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

  test('#755 later current re-signoffs of the same stage or checkpoint heal an amendment lapse in next', () => {
    const dir = fixture();
    const words = join(dir, 'words.txt');
    writeFileSync(join(dir, 'replacement.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>\n');
    writeFileSync(words, 'Re-approve the synthetic stage after the amendment.\n');

    const beforeAmendAt = Date.parse('2026-11-19T00:00:00Z');
    testClock.set(new Date(beforeAmendAt));
    signoffCommand(['post-interview', dir, '--by', 'owner', '--verbatim-file', words]);

    const amendAt = Date.parse('2026-11-20T00:00:00Z');
    testClock.set(new Date(amendAt));
    amendCommand([
      'rigging',
      dir,
      '--kind',
      'part',
      '--target',
      'panel',
      '--change',
      'replacement.svg',
      '--by',
      'owner',
      '--verbatim-file',
      words,
    ]);
    expect(nextProject(dir, amendAt).moves.filter(m => m.lapse?.code === 'AMENDED_STEP' && m.command === null).map(m => m.awaits)).toEqual([
      'signoffs[checkpoint=constraints]',
      'signoffs[stage=post-interview]',
    ]);

    testClock.set(new Date(amendAt + 60_000));
    signoffCommand(['post-interview', dir, '--by', 'owner', '--verbatim-file', words]);
    testClock.set(new Date(amendAt + 120_000));
    signoffCommand(['post-interview', dir, '--by', 'owner', '--verbatim-file', words]);
    expect(nextProject(dir, amendAt + 120_000).moves.filter(m => m.lapse?.code === 'AMENDED_STEP' && m.command === null).map(m => m.awaits)).toEqual([
      'signoffs[checkpoint=constraints]',
    ]);

    testClock.set(new Date(amendAt + 180_000));
    signoffCommand(['rigging', dir, '--checkpoint', 'constraints', '--by', 'owner', '--verbatim-file', words]);
    testClock.set(new Date(amendAt + 240_000));
    signoffCommand(['rigging', dir, '--checkpoint', 'constraints', '--by', 'owner', '--verbatim-file', words]);

    const checked = checkProject(dir, undefined, { now: amendAt + 240_000 });
    expect(checked.refusals).toEqual([]);
    expect(checked.amendments?.[0]?.lapsed.filter(a => a.stage === 'post-interview')).toHaveLength(2);
    expect(checked.amendments?.[0]?.lapsed.filter(a => a.checkpoint === 'constraints')).toHaveLength(2);

    const healed = nextProject(dir, amendAt + 240_000);
    expect(healed.refusals).toEqual([]);
    expect(healed.moves.filter(m => m.lapse !== undefined)).toEqual([]);
    expect(healed.moves.some(m => m.act.startsWith('re-approve '))).toBe(false);
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

  test('plant 3: an accepted numbered project retains acceptance without offering migration', () => {
    for (const dir of [CHAIN_DIR, fixture(() => {}, 'example-numbered/example-project.json')]) {
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

  test.each([
    { state: 'accepted project', accepted: true },
    { state: 'bounced rig', accepted: false },
  ])('#846/#856 next shows only open interview comments and executable moves ($state)', ({ accepted }) => {
    const dir = join(realpathSync(tempDir()), 'routed interview comments');
    cpSync(accepted ? CHAIN_DIR : join(CHECKPOINTS_DIR, '3-rig-review'), dir, { recursive: true });
    if (!accepted) {
      seedStoredVerdict(dir, 1, {
        review: 'rig-review',
        verdict: 'bounced',
        by: 'owner',
        at: CHAIN_NOW,
        verbatim: 'Revise the synthetic rig.',
        source: 'synthetic fixture',
      });
    }
    const file = join(dir, 'project.json');
    const original = readFileSync(file, 'utf8');
    const project = JSON.parse(original) as JsonObject;
    const originalReceipts = arr(project.review_acts);
    const receiptPath = `review_acts[${originalReceipts.length}]`;
    const question = 'motion';
    const waypoint = arr(obj(project.interview).waypoints).map(obj).find(row => row.id === question)!;
    const answer = obj(waypoint.guide);
    const choice = obj(answer.choice);
    const set = obj(choice.set);
    const setFile = { path: String(set.path), sha256: String(set.sha256) };
    const setId = String(JSON.parse(readFileSync(join(dir, setFile.path), 'utf8')).id);
    const record = { path: 'project.json', sha256: sha256(original) };
    const binding = {
      record,
      selection: { kind: 'option-set', questionId: question, setId },
      inputs: [],
      optionSet: { id: setId, sha256: setFile.sha256 },
      optionSetFile: setFile,
      plan: null,
      subjects: [{ kind: 'interview-picks', questionId: question, setId }],
      files: [setFile, record],
    };
    // Use #838's synthetic record-act envelope, with a source and survey bound to this chain's answer.
    const envelope = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/record-acts/picks.json'), 'utf8')) as JsonObject;
    const act4 = {
      ...envelope,
      at: answer.at!,
      source: { sourceHash: sha256(JSON.stringify({ schema: 'rig-review-job-record-source/1', ...binding })),
        projectHash: record.sha256, subject: 'option-set', ...binding },
      value: {
        questionId: question,
        note: choice.note ?? '',
        selections: arr(choice.picks).map(obj).map(pick => ({
          itemId: pick.ask!, optionId: pick.option_id!, otherText: pick.other_text ?? null,
        })),
      },
    };
    const comments: { text: string; anchor?: { name: string } }[] = [
      { text: '  General owner comment.\r\n' },
      { text: 'At the edge.\n끝', anchor: { name: 'painting.png' } },
    ];
    const act6 = { ...act4, schema: JOB_COMMENTS_ACT_SCHEMA, value: { ...act4.value, comments } };
    const saveReceipt = (act: JsonObject, feedbackRoute?: JsonObject) => {
      const bytes = JSON.stringify(act);
      project.review_acts = [...originalReceipts, {
        schema: 'rig-create/review-act@1', kind: 'interview-picks', question,
        jobId: envelope.jobId!, actId: envelope.actId!, bytes, sha256: sha256(bytes),
        version_hash: sha256(JSON.stringify(choice)),
        ...(feedbackRoute === undefined ? {} : { feedback_route: feedbackRoute }),
      }];
      writeFileSync(file, JSON.stringify(project));
    };
    const check = () => checkProject(dir, undefined, { now: CHAIN_NOW, readOnly: true });
    const nextText = () => nextCommand([dir], CHAIN_NOW);
    const nextJson = () => nextCommand([dir, '--json'], CHAIN_NOW);
    const baseline = { check: check(), text: nextText(), json: nextJson() };

    saveReceipt(act4);
    expect(check()).toEqual(baseline.check);
    expect(nextText()).toEqual(baseline.text);
    expect(nextJson()).toEqual(baseline.json);

    saveReceipt(act6);
    const legacy = check();
    expect(legacy.refusals).toEqual([]);
    expect(legacy.warnings).toHaveLength(baseline.check.warnings.length + 1);
    expect(legacy.warnings).toContainEqual(expect.objectContaining({ code: 'REVIEW_ANSWER_COMMENTS_UNROUTED', path: receiptPath }));
    expect(nextJson()).toEqual(baseline.json);
    expect(nextText()).toEqual(baseline.text);

    const route = { question, comments: comments.map((comment, index) => ({ order: index + 1, ...comment })) };
    saveReceipt(act6, route);
    const routedCheck = check();
    expect(routedCheck).toEqual(baseline.check);
    const feedbackOpen = () => check().warnings.filter(w => w.code === 'FEEDBACK_OPEN');
    const beforeFeedbackOpen = feedbackOpen();
    expect(beforeFeedbackOpen).toHaveLength(accepted ? 0 : 1);
    const json = nextJson();
    expect(json.exit).toBe(0);
    const baseReport = JSON.parse(baseline.json.stdout) as NextReport;
    const report = JSON.parse(json.stdout) as NextReport;
    expect(report).toMatchObject({ accepted, refusals: [] });
    const commentPaths = comments.map((_, index) => `${receiptPath}.feedback_route.comments[${index}]`);
    const routedWarnings = (report: NextReport) => (report.warnings ?? []).filter(w => w.code === 'REVIEW_ANSWER_COMMENT_ROUTED');
    const warnings = routedWarnings(report);
    expect(warnings.map(({ code, path }) => ({ code, path }))).toEqual(commentPaths.map(path => ({
      code: 'REVIEW_ANSWER_COMMENT_ROUTED', path,
    })));
    for (const [index, warning] of warnings.entries()) {
      const comment = comments[index]!;
      expect(warning.message).toContain(`project.json.${warning.path}`);
      expect(warning.message).toContain(`interview answer ${question}, owner comment ${index + 1}`);
      expect(warning.message).toContain(comment.text);
      if (comment.anchor) expect(warning.message).toContain(JSON.stringify(comment.anchor));
    }
    const text = nextText();
    expect(text.stdout).toContain(warnings.map(w => `  WARN [${w.code}]: ${w.message}\n`).join(''));
    const commentMoves = report.moves.slice(baseReport.moves.length);
    expect(commentMoves).toHaveLength(2);
    expect(report.moves).toEqual([...baseReport.moves, ...commentMoves]);
    expect(report.awaits).toEqual([...baseReport.awaits, ...commentPaths]);

    const reasonFile = join(dir, 'comment reason.txt');
    const reason = 'The synthetic guide already covers this comment.';
    writeFileSync(reasonFile, reason);
    const executeMove = (index: number) => {
      const move = commentMoves[index]!;
      expect(move).toMatchObject({ role: 'agent', field: commentPaths[index], awaits: commentPaths[index] });
      expect(move.act).toContain('--resolved-by-answer');
      const argv = printedArgs(move.command!);
      expect(argv).toEqual(['rig-create', 'interview-answer', question, dir, '--close-comment',
        '--job', String(envelope.jobId), '--act', String(envelope.actId), '--order', String(index + 1), '--by', 'agent', '--reason-file', '<file>']);
      expect(runMainCapture(argv.slice(1).map(arg => arg === '<file>' ? reasonFile : arg), CHAIN_NOW)).toMatchObject({ code: 0, stderr: '' });
    };
    executeMove(0);
    const closed = JSON.parse(readFileSync(file, 'utf8')) as JsonObject;
    expect(closed.interview_comment_closures).toEqual([{
      jobId: envelope.jobId, actId: envelope.actId, question, order: 1, by: 'agent', at: new Date(CHAIN_NOW).toISOString(),
      reason, resolution: { kind: 'no-change' },
    }]);
    const partial = JSON.parse(nextJson().stdout) as NextReport;
    expect(routedWarnings(partial)).toEqual([warnings[1]!]);
    expect(partial.moves).toEqual([...baseReport.moves, commentMoves[1]!]);
    expect(partial.awaits).toEqual([...baseReport.awaits, commentPaths[1]!]);
    expect(nextText().stdout).toContain(comments[1]!.text);
    expect(nextText().stdout).not.toContain(comments[0]!.text);
    expect(feedbackOpen()).toEqual(beforeFeedbackOpen);
    executeMove(1);
    expect(nextJson()).toEqual(baseline.json);
    expect(nextText()).toEqual(baseline.text);
    expect(feedbackOpen()).toEqual(beforeFeedbackOpen);

    saveReceipt(act6, { ...route, question: 'bones' });
    const refused = JSON.parse(nextJson().stdout) as NextReport;
    expect(refused.refusals).toContainEqual(expect.objectContaining({ code: 'REVIEW_FEEDBACK_ROUTE_INVALID', field: receiptPath }));
    expect(refused.warnings).toBeUndefined();
  });

  test('plant 4 (lagging stage): after human signoff the resolving advance is emitted as an agent move that leaves a clean scratch copy (#981: lag is no finding)', () => {
    const dir = join(tempDir(), 'stage-lagging');
    cpSync(join(CHECKPOINTS_DIR, '0b-plan-pending'), dir, { recursive: true });
    testClock.set(new Date(CHAIN_NOW));
    signoffCommand(['plan-approved', dir, '--by', 'user', '--verbatim-file', join(dir, 'evidence/approval.txt')]);

    const report = nextProject(dir, CHAIN_NOW);
    expect(report.refusals).toEqual([]);
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

      host = await openCreateJob(apiDir, { id: 'synthetic-owner', role: 'owner' }, Date.now(), options => startJobHost({
        ...options,
        readPublished: async input => {
          const context = await readPublished(input);
          const sel = input.result.selector;
          return sel?.kind === 'draft' && 'id' in sel
            ? { ...context, subjects: [{ kind: 'parts-verdict', draftId: sel.id }] }
            : context;
        },
      }));
      expect(seedRetainedDraft([
        'chain',
        apiDir,
        '--config',
        'derived/drafts/chain/config.json',
        '--from',
        'derived/drafts/chain/out',
        '--parts',
        'derived/drafts/chain/input',
        '--json',
      ], Date.now()).exit).toBe(0);

      for (const args of [
        ['structure-snapshot', apiDir, '--draft', 'chain', '--out', 'evidence/structure-chain.json'],
        ['diff-classes', apiDir, '--diff-report', 'evidence/diff-components.json', '--by', 'agent'],
        ['advance', 'parts-review', apiDir, '--parts-check', 'evidence/parts-check.json', '--parts', 'derived/drafts/chain/input'],
      ]) {
        const child = Bun.spawn([process.execPath, ...jobRuntimeExecArgv(), join(REPO, 'src/cli.ts'), ...args],
          { cwd: apiDir, stdout: 'pipe', stderr: 'pipe' });
        const [stderr, exit] = await Promise.all([new Response(child.stderr).text(), child.exited, new Response(child.stdout).text()]);
        expect({ exit, stderr }).toEqual({ exit: 0, stderr: '' });
      }
      const apiProj = JSON.parse(readFileSync(join(apiDir, 'project.json'), 'utf8')) as JsonObject;
      const draftResult = { path: prepareDraftManifest(apiDir, apiProj, 'chain'), selector: { kind: 'draft' as const, id: 'chain' } };
      const binding = readWriterBinding(apiDir)!;
      const outboxEntry = enqueuePublication(apiDir, binding, draftResult);
      const pubReqId = randomUUID();
      await reconcilePublication(apiDir, outboxEntry, async pending => {
        const reply = await agentCall(host!, {
          schema: binding.identity.apiSchema,
          verb: 'publish',
          requestId: pubReqId,
          idempotencyKey: pubReqId,
          expectedGeneration: host!.session.status().generation,
          result: draftResult,
          freeze: { kind: 'producer-held', holdId: pending.id, record: { path: 'project.json', sha256: pending.recordHash } },
        });
        expect(reply.ok).toBe(true);
        const pub = host!.session.status().publication!;
        acknowledgePublication(pending, pub.publicationId, pub.generation, pubReqId, [{ kind: 'parts-verdict', draftId: 'chain' }]);
      });
      const publication = host.session.status().publication!;
      const session = host.session as unknown as {
        jobId: string;
        store: { update(jobId: string, rev: null, fn: (row: { data: { generation: number; publications: Record<string, { retained: { source: unknown } }>; asks: Record<string, unknown> } }) => { data: unknown }): unknown };
        event(data: unknown, value: object): unknown;
      };
      const askId = randomUUID();
      session.store.update(session.jobId, null, ({ data }) => {
        const ask = { askId, publicationId: publication.publicationId, subject: { kind: 'parts-verdict', draftId: 'chain' }, source: structuredClone(data.publications[publication.publicationId]!.retained.source), status: 'pending' };
        data.generation++;
        data.asks[askId] = ask;
        session.event(data, { type: 'pending', ask });
        return { data };
      });

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
          askId,
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

      seedStoredPartsVerdictAct(apiDir, committed.value as unknown as JsonObject, {
        now: Date.now(),
        checkProjectHash: true,
        checkArrival: true,
      });

      const apiNow = Date.now();
      const apiReport = nextProject(apiDir, apiNow);
      expect(apiReport.moves.some(move => move.command?.startsWith('rig-create structure-snapshot'))).toBe(false);
      expect(apiReport.moves.some(move => move.review_act?.kind === 'signoff' && move.review_act.stage === 'parts-review')).toBe(false);
      const recorded = JSON.parse(readFileSync(join(apiDir, 'project.json'), 'utf8')) as JsonObject;
      expect(arr(recorded.signoffs).map(obj)).toContainEqual(expect.objectContaining({ stage: 'parts-review', draft_id: 'chain' }));
      expect(checkProject(apiDir, undefined, { now: apiNow, readOnly: true }).refusals.map(f => f.code)).toEqual([]);
    } finally {
      host?.stop();
      rmSync(jobHostStateRoot(apiDir), { recursive: true, force: true });
      rmSync(apiDir, { recursive: true, force: true });
    }
  }, 30_000);

  test('#674 numbered rig and direction feedback remain visible without authoring moves', () => {
    // rig-review: accepted followed by changes-requested
    const rigDir = join(tempDir(), 'rig-withdrawn');
    cpSync(join(CHECKPOINTS_DIR, '3-rig-review'), rigDir, { recursive: true });
    const bounceWords = join(rigDir, 'bounce.txt');
    writeFileSync(bounceWords, 'Please adjust the shoulder pivot.\n');
    testClock.set(new Date(CHAIN_NOW));
    seedStoredVerdict(rigDir, 1, {
      review: 'rig-review',
      verdict: 'accepted',
      by: 'user',
      at: CHAIN_NOW,
      verbatim: readFileSync(join(rigDir, 'evidence/approval.txt'), 'utf8'),
      source: 'synthetic example',
    });
    // After acceptance alone, review-verdict is no longer awaited.
    const acceptedRig = nextProject(rigDir, CHAIN_NOW);
    expect(acceptedRig.awaits).toEqual(['signoffs[stage=rig-review]']);
    expectRetiredVerdict(acceptedRig, 'signoffs[stage=rig-review]');

    // Now a human changes-requested (bounced) verdict withdraws the earlier acceptance.
    testClock.set(new Date(CHAIN_NOW + 1000));
    seedStoredVerdict(rigDir, 1, {
      review: 'rig-review',
      verdict: 'bounced',
      by: 'user',
      at: CHAIN_NOW + 1000,
      verbatim: readFileSync(bounceWords, 'utf8'),
      source: 'synthetic bounce',
      on_items: [{ id: 'bones', answer_was: 'user' }],
    });
    const rigReport = nextProject(rigDir, CHAIN_NOW + 1000);
    expect(rigReport.refusals).toEqual([]);
    expectRetiredVerdict(rigReport, 'versions[n=1].verdicts[review=rig-review]');
    expect(rigReport.moves.some(move => move.field.startsWith('current.') || /\brig-version\b/.test(move.command ?? ''))).toBe(false);
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
    const rigArgs = ['2', rigDir,
      ...Object.entries(bindings).flatMap(([flag, file]) => [flag, `rebuild-source/${file}`]),
      '--at-pointer', '/finished_at', '--by', 'registrant', '--answers', '1:1'];
    const beforeRigRebuild = checkProject(rigDir, undefined, { now: CHAIN_NOW + 1000, readOnly: true });
    expect(seedRetainedRigVersion(rigArgs, CHAIN_NOW + 1000).exit).toBe(0);
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
      seedRetainedScene(
        [
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
      ).exit,
    ).toBe(0);
    expect(
      seedRetainedDirectionPost(
        ['write', '2', postDir, '--file', 'evidence/direction-input.json', '--rig', '1'],
        CHAIN_NOW,
      ).exit,
    ).toBe(0);
    expect(runMainCapture(['direction', 'check', '2', postDir, '--json'], CHAIN_NOW).code).toBe(0);
    expect(runMainCapture(['advance', 'direction-review', postDir], CHAIN_NOW).code).toBe(0);

    seedStoredVerdict(postDir, 2, {
      review: 'direction-review',
      verdict: 'accepted',
      by: 'user',
      at: CHAIN_NOW,
      verbatim: readFileSync(join(postDir, 'evidence/approval.txt'), 'utf8'),
      source: 'synthetic example',
    });
    const acceptedPost = nextProject(postDir, CHAIN_NOW);
    expectNumberedPostReadOnly(acceptedPost);

    const postBounceWords = join(postDir, 'bounce-post.txt');
    writeFileSync(postBounceWords, 'Tighten the final camera hold.\n');
    testClock.set(new Date(CHAIN_NOW + 2000));
    seedStoredVerdict(postDir, 2, {
      review: 'direction-review',
      verdict: 'bounced',
      by: 'user',
      at: CHAIN_NOW + 2000,
      verbatim: readFileSync(postBounceWords, 'utf8'),
      source: 'synthetic direction bounce',
      on_items: [{ id: 'camera_depth', answer_was: 'user' }],
    });

    // The numbered bounce remains recorded and next leaves the retained outputs in place.
    const beforeRebuildBytes = readFileSync(join(postDir, 'project.json'));
    const closedReport = nextProject(postDir, CHAIN_NOW + 2000);
    expect(closedReport.moves.some(move => move.command?.startsWith('rig-create amend '))).toBe(false);
    expect(closedReport.moves.some(move => move.command?.startsWith('rig-create reopen '))).toBe(false);
    expect(readFileSync(join(postDir, 'project.json'))).toEqual(beforeRebuildBytes);
    const postReport = nextProject(postDir, CHAIN_NOW + 3000);
    expect(postReport.refusals).toEqual([]);
    expectNumberedPostReadOnly(postReport);
    const rebuiltArgs = ['write', '3', postDir, '--file', 'evidence/direction-input.json',
      '--rig', '1', '--answers', '2:1'];
    const beforeRebuild = checkProject(postDir, undefined, { now: CHAIN_NOW + 3000, readOnly: true });
    expect(seedRetainedDirectionPost(rebuiltArgs, CHAIN_NOW + 3000).exit).toBe(0);
    const afterRebuild = checkProject(postDir, undefined, { now: CHAIN_NOW + 3000, readOnly: true });
    expect(newFindings(baselineOf(beforeRebuild), afterRebuild.refusals)).toEqual([]);
    expect(afterRebuild.refusals).toEqual([]);
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

    // Seed the retained draft record on disk.
    const recordRes = seedRetainedDraft(
      [
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
    expect(recordRes.exit).toBe(0);

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
    expectRetiredVerdict(afterReport, 'review_acts[kind=parts-verdict,draft_id=chain]');
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
  expect(before.moves.find(move => move.field === 'plan.steps[assemble].status')).toMatchObject({
    role: 'agent',
    command: expect.stringContaining('rig-create step-status assemble done'),
  });
  expect(planCommand(['checkpoint-withdraw', 'assemble', dir, '--by', 'operator', '--reason-file', reason, '--quote-file', words]).exit).toBe(0);
  const bytes = readFileSync(join(dir, 'project.json'));
  const result = runMainCapture(['next', dir, '--json'], testClock.now());
  expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: '' });
  const after = JSON.parse(result.stdout) as NextReport;
  expect(after.refusals).toEqual([]);
  expect(after.moves.some(move => move.field === 'plan.steps[assemble].checkpoint')).toBe(false);
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
  }, 'example-numbered/example-project.json'));
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
  expect(after.moves).toHaveLength(1);
  expectOwnerChatSignoff(after.moves, 'rigging-interview', dir);
  expect(after.moves[0]!.unanswered_by_record).toBeUndefined();
  expect(after.awaits).toEqual(['signoffs[stage=rigging-interview]']);
  const context = readRecordPublished({ root: dir,
    record: { path: 'project.json', sha256: sha256(readFileSync(join(dir, 'project.json'))) },
    result: { kind: 'plan' }, phase: 'inventory' }, CHAIN_NOW);
  expect(context.subjects).toEqual([]);
});


test('#983 fresh init record prints a runnable step plan proposal instead of option registration', () => {
  const dir = join(tempDir(), "synthetic project's folder");
  mkdirSync(join(dir, 'evidence'), { recursive: true });
  writeFileSync(join(dir, 'project.json'), JSON.stringify(freshProjectRecord('synthetic-fresh', CHAIN_NOW)));
  mkdirSync(join(dir, 'inputs'));
  cpSync(join(CHAIN_DIR, 'inputs/painting.png'), join(dir, 'inputs/painting.png'));
  expect(runMainCapture(['input', 'add', 'inputs/painting.png', dir, '--origin', 'synthetic source'], CHAIN_NOW)).toMatchObject({ code: 0, stderr: '' });
  const bytes = readFileSync(join(dir, 'project.json'));
  const report = nextProject(dir, CHAIN_NOW);
  expect(report.moves.some(move => move.command?.startsWith('rig-create interview-options '))).toBe(false);
  const move = report.moves.find(move => move.command?.startsWith('rig-create plan propose parts '))!;
  expect(move.role).toBe('agent');
  mkdirSync(join(dir, 'plans'));
  writeFileSync(join(dir, 'plans/parts.md'), 'One synthetic plan for the whole figure.\n');
  const argv = printedArgs(move.command!).slice(1).map(arg => arg === '<plans/parts.md>' ? 'plans/parts.md' : arg);
  expect(runMainCapture(argv, CHAIN_NOW)).toMatchObject({ code: 0, stderr: '' });
  expect(readFileSync(join(dir, 'project.json'))).not.toEqual(bytes);
  const after = nextProject(dir, CHAIN_NOW);
  expect(after.moves.some(move => move.field === 'interview.step_plans' || move.review_act?.question_id === 'rig_type')).toBe(false);
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

test('#490 numbered post stays read-only even before a direction contract exists', () => {
  const dir = join(tempDir(), 'post-writers');
  cpSync(join(CHECKPOINTS_DIR, '4-direction-post'), dir, { recursive: true });
  const file = join(dir, 'project.json');
  const project = JSON.parse(readFileSync(file, 'utf8')) as JsonObject;
  delete project.direction_contract;
  writeFileSync(file, JSON.stringify(project));
  const before = treeDigest(dir);
  const report = nextProject(dir, CHAIN_NOW);
  expect(report.refusals).toEqual([]);
  expectNumberedPostReadOnly(report);
  expect(treeDigest(dir)).toEqual(before);
});

test.each([
  ['1-parts-verdict', 'parts', 'assemble', false],
  ['1-parts-verdict', 'parts', 'assemble', true],
  ['3-rig-review', 'rigging', 'meshes', false],
  ['4-direction-post', 'post', 'camera', false],
] as const)('#1136 %s offers executable done at %s/%s (signed=%p)', (waypointName, stage, id, signed) => {
  testClock.set(CHAIN_NOW);
  const dir = join(tempDir(), 'checkpoint-order');
  cpSync(join(CHECKPOINTS_DIR, waypointName), dir, { recursive: true });
  const file = join(dir, 'project.json');
  const project = JSON.parse(readFileSync(file, 'utf8')) as JsonObject;
  project.stage = stage;
  project.advances = arr(project.advances).filter(row => stageIndex(String(obj(row).stage)) <= stageIndex(stage));
  const step = arr(obj(project.plan).steps).map(obj).find(step => step.id === id)!;
  obj(step.checkpoint).value = true;
  step.checkpoint_proposed = true;
  for (const signoff of arr(project.signoffs).map(obj)) {
    if (signoff.step_hashes && obj(signoff.step_hashes)[id] !== undefined) obj(signoff.step_hashes)[id] = stepHash(step);
  }
  const startedAt = Date.parse(String(obj(arr(project.advances).at(-1)).at)) + 1000;
  step.status = 'at-checkpoint';
  step.status_history = [
    { from_status: 'pending', status: 'in-progress', by: 'agent', at: new Date(startedAt).toISOString(), checkpoint_required: true, signoff: null },
    { from_status: 'in-progress', status: 'at-checkpoint', by: 'agent', at: new Date(startedAt + 1000).toISOString(), checkpoint_required: true, signoff: null },
  ];
  if (!signed) project.signoffs = arr(project.signoffs).filter(row => obj(row).checkpoint !== id);
  writeFileSync(file, JSON.stringify(project));
  const result = runMainCapture(['next', dir, '--json'], CHAIN_NOW);
  expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: '' });
  const report = JSON.parse(result.stdout) as NextReport;
  expect(report.refusals).toEqual([]);
  expect(report.awaits).not.toContain(`signoffs[checkpoint=${id}]`);
  expect(report.moves.some(move => move.command?.includes(`--checkpoint ${id}`))).toBe(false);
  const done = report.moves.find(move => move.field === `plan.steps[${id}].status`);
  expect(done?.role).toBe('agent');
  expect(done?.command).toBe(`rig-create step-status ${id} done ${dir} --by agent`);
  expect(runMainCapture(printedArgs(done!.command!).slice(1), CHAIN_NOW))
    .toEqual({ code: 0, stdout: `step-status: ${id} done\n`, stderr: '' });
  const saved = JSON.parse(readFileSync(file, 'utf8')) as JsonObject;
  const completed = arr(obj(saved.plan).steps).map(obj).find(step => step.id === id)!;
  expect(completed.status).toBe('done');
  expect(arr(completed.status_history).at(-1)).toMatchObject({
    checkpoint_required: true,
    signoff: signed ? { stage, checkpoint: id } : null,
  });
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
  expectRetiredVerdict(ready, 'review_acts[kind=parts-verdict,draft_id=chain]');
  expect(ready.moves.some(move => move.review_act?.kind === 'signoff')).toBe(false);
  expect(JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')).stage).toBe('parts-review');
});


test.each(['generic', 'per-draft'])('#490 legacy approved %s snapshot for another draft is retained and next selects a fresh path', slot => {
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
  expect(snapshot.command).toContain('--draft chain');
  expect(row).toMatchObject({ actId: 'parts-sign', args: null, command: null, unavailable: { code: 'NUMBERED_ACT_RETIRED' } });
  expectRetiredVerdict(next, 'signoffs[stage=parts-review]');
  expect(snapshot.awaits).toBe(selected.path);
  expect(runMainCapture(printedArgs(snapshot.command!).slice(1), CHAIN_NOW)).toMatchObject({ code: 0, stderr: '' });
  expect(partsStructureSnapshot(dir, project, 'chain')).toEqual({ ...selected, valid: true });
  expect(readFileSync(join(dir, path), 'utf8')).toBe(wrong);
  expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
});



test.each([{ foreground: false, custom: false }, { foreground: true, custom: false }, { foreground: false, custom: true }, { foreground: true, custom: true }])('#502 retained numbered scene form writes exact roles and rects %j', ({ foreground, custom }) => {
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
  expectNumberedPostReadOnly(report);
  const sceneArgs = ['write', dir, '--rig', '1', '--background', background,
    '--citations-file', 'evidence/printed-scene-citations.json'];
  if (foreground) sceneArgs.push('--foreground', 'inputs/foreground.png');
  if (custom) sceneArgs.push('--background-rect', '-48,10,96,96');
  if (custom && foreground) sceneArgs.push('--foreground-rect', '-40,12,80,80');
  expect(seedRetainedScene(sceneArgs, CHAIN_NOW).exit).toBe(0);
  const after = JSON.parse(readFileSync(file, 'utf8')) as JsonObject;
  expect(after.plan).toEqual(beforePlan);
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

test('#561 tower shows rig repair at post-interview and gates only covered approval', () => {
  const dir = postInterviewPlan();
  const file = join(dir, 'project.json');
  const project = JSON.parse(readFileSync(file, 'utf8')) as JsonObject;
  const now = Date.parse(PLAN_STEP_ANSWER_SINCE) + 3_600_000;
  const answeredAt = new Date(now + 1000).toISOString();
  const rigApproval = arr(project.signoffs).map(obj).find(row => row.stage === 'rigging-interview')!;
  // The earlier approval binds the old guide, but does not cover the pending definition.
  rigApproval.steps = arr(rigApproval.steps).filter(id => id !== 'bones');
  const laterApproval: JsonObject = { ...structuredClone(rigApproval), at: answeredAt };
  delete obj(laterApproval.answer_hashes).bones;
  project.signoffs = [...arr(project.signoffs), laterApproval];
  arr(obj(project.plan).steps).map(obj).find(step => step.id === 'bones')!.status = 'pending';
  writeFileSync(file, JSON.stringify(project));
  expect(checkProject(dir, undefined, { now }).refusals).toEqual([]);

  const guide = obj(waypoint(project, 'bones').guide);
  const set = obj(obj(guide.choice).set);
  const path = String(set.path);
  const words = join(dir, 'correction.txt');
  writeFileSync(words, 'Use the synthetic alternate chains, placement, and length.');
  expect(runMainCapture(['interview-options', 'bones', dir, '--file', path], now)).toMatchObject({ code: 0, stderr: '' });
  const picks = arr(obj(guide.choice).picks).flatMap(pick => ['--pick', `${String(obj(pick).ask)}=alternative`]);
  expect(runMainCapture(['interview-answer', 'bones', dir, '--set', path, '--sha256', String(set.sha256), '--by', 'user',
    ...ownerChatArgs(words, answeredAt), ...picks], now + 1000)).toMatchObject({ code: 0, stderr: '' });
  const corrected = JSON.parse(readFileSync(file, 'utf8')) as JsonObject;
  const bones = waypoint(corrected, 'bones');
  expect(bones.guide).toMatchObject({ at: answeredAt });
  expect(arr(bones.history)).toContainEqual(guide);

  const result = runMainCapture(['next', dir, '--json'], now + 2000);
  expect(result).toMatchObject({ code: 0, stderr: '' });
  const report = JSON.parse(result.stdout) as NextReport;
  const stale = { code: 'PLAN_STEP_PREDATES_ANSWER', field: 'plan.steps[bones]' };
  const repair = { field: 'plan.steps[bones]', awaits: 'plan.steps[bones]', command: expect.stringContaining('plan revise bones ') };
  expect(report.effective_stage).toBe('post-interview');
  expect(report.refusals).toContainEqual(expect.objectContaining(stale));
  expect(report.refusals.map(finding => finding.code)).toContain('SIGNOFF_ANSWERS_STALE');
  expect(report.moves).toContainEqual(expect.objectContaining(repair));
  expect(report.awaits).toContain(repair.awaits);
  expect(report.moves.some(move => move.awaits === 'signoffs[stage=rigging-interview]')).toBe(false);

  // Isolate the plan refusal to exercise the ordinary post-interview return as well.
  const previous = arr(corrected.signoffs).map(obj).find(row => row.stage === 'rigging-interview')!;
  delete obj(previous.answer_hashes).bones;
  writeFileSync(file, JSON.stringify(corrected));
  const scoped = nextProject(dir, now + 2000);
  expect(scoped.refusals).toEqual([expect.objectContaining(stale)]);
  expect(scoped.moves).toContainEqual(expect.objectContaining(repair));
  expect(scoped.awaits).toContain(repair.awaits);
  expectOwnerChatSignoff(scoped.moves, 'post-interview', dir);
});

test('#561 tower shows stale bones repair and missing answered meshes before rig approval', () => {
  const dir = realpathSync(fixture(project => {
    project.stage = 'rigging-interview';
    project.versions = []; project.scenes = [];
    delete project.direction_contract;
    retainSignoffs(project, row => stageIndex(String(row.stage)) < stageIndex('rigging-interview'));
    project.advances = arr(project.advances).filter(row => stageIndex(String(obj(row).stage)) <= stageIndex('rigging-interview'));
    for (const item of arr(obj(obj(project.interview).post).items).map(obj)) item.guide = null;
    const plan = obj(project.plan);
    plan.steps = arr(plan.steps).filter(row => obj(row).phase === 'rig' && obj(row).id !== 'meshes');
    for (const step of arr(plan.steps).map(obj)) {
      if (['seethrough', 'assemble'].includes(String(step.id))) continue;
      step.status = 'pending'; delete step.status_history;
      if (step.id === 'bones') step.drafted_at = PLAN_STEP_ANSWER_SINCE;
    }
  }, 'example-numbered/example-project.json'));
  const before = readFileSync(join(dir, 'project.json'));
  const report = nextProject(dir, CHAIN_NOW);
  expect(report.effective_stage).toBe('rigging-interview');
  expect(report.refusals).toEqual([expect.objectContaining({ code: 'PLAN_STEP_PREDATES_ANSWER', field: 'plan.steps[bones]' })]);
  expect(report.moves.map(move => printedArgs(move.command!).slice(1, 4))).toEqual([
    ['plan', 'revise', 'bones'], ['plan', 'add', 'meshes'],
  ]);
  expect(report.moves[1]).toMatchObject({ role: 'agent', unanswered_by_record: 'plan.steps' });
  expect(report.moves[1]?.command).toContain('--rests-on meshes');
  expect(report.awaits).toEqual(['plan.steps[bones]', 'plan.steps']);
  expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
  const argv = printedArgs(report.moves[1]!.command!).slice(1);
  const values: Record<string, string> = { '<work>': 'Implement the approved synthetic meshes.',
    '<result>': 'Synthetic meshes with the requested topology.', '<acceptance bar>': 'Match the recorded meshes guide.' };
  expect(argv.slice(0, 3)).toEqual(['plan', 'add', 'meshes']);
  expect(runMainCapture(argv.map(arg => values[arg] ?? arg), CHAIN_NOW))
    .toMatchObject({ code: 0, stdout: expect.stringContaining('plan: add meshes'), stderr: '' });
  const after = nextProject(dir, CHAIN_NOW);
  expect(after.refusals).toEqual(report.refusals);
  expect(after.moves).toEqual([report.moves[0]!]);
});

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
  }, 'example-numbered/example-project.json'));
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

test('#557 bounced parts verdict preserves the rejected draft and its feedback without authoring a new draft', () => {
  const dir = bouncedPartsFixture();
  const file = join(dir, 'project.json');
  const before = readFileSync(file);
  const project = JSON.parse(before.toString()) as JsonObject;
  expect(latestPartsVerdictStatus(project, 'chain')).toBe('changes-requested');
  const next = nextProject(dir, CHAIN_NOW);
  expect(next.refusals).toEqual([]);
  expect(next.stage).toBe('parts-review');
  expect(next.effective_stage).toBe('parts-review');
  expect(next.moves).toEqual([expect.objectContaining({
    role: 'agent', field: 'drafts[chain]', awaits: 'drafts[chain]', command: null,
    act: expect.stringContaining('preserve the draft and its evidence'),
  })]);
  expect(readFileSync(file)).toEqual(before);
});

test('#1030 a current parts-review project keeps rejected draft feedback without offering a replacement draft', () => {
  const dir = bouncedPartsFixture();
  const file = join(dir, 'project.json');
  const project = JSON.parse(readFileSync(file, 'utf8')) as JsonObject;
  writeFileSync(file, JSON.stringify({ ...project, current: {} }));
  const next = nextProject(dir, CHAIN_NOW);
  expect(next.refusals).toEqual([]);
  expect(next.effective_stage).toBe('parts-review');
  expect(next.moves).toContainEqual(expect.objectContaining({ field: 'drafts[chain]', command: null,
    act: expect.stringContaining("Read the owner's comments in Review") }));
  expect(next.moves).toContainEqual(expect.objectContaining({ command: expect.stringContaining('rig-create record parts ') }));
  expect(next.moves.some(move => /draft-rig|chain-retouch-|rig-create advance /.test(move.command ?? move.act))).toBe(false);
});

test('#557 a retained replacement draft discovers fresh evidence and reports the retired verdict gate', () => {
  const dir = bouncedPartsFixture();
  const retained = ['evidence/parts-check.json', 'evidence/diff-components.json', 'evidence/structure-chain.json'];
  const bytes = retained.map(path => readFileSync(join(dir, path)));
  const id = 'chain-retouch-1';
  cpSync(join(dir, 'derived/drafts/chain'), join(dir, `derived/drafts/${id}`), { recursive: true });
  const registration = [id, dir, '--config', `derived/drafts/${id}/config.json`, '--from', `derived/drafts/${id}/out`, '--parts', `derived/drafts/${id}/input`];
  expect(seedRetainedDraft(registration, CHAIN_NOW + 1000).exit).toBe(0);
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
  expectRetiredVerdict(ready, `review_acts[kind=parts-verdict,draft_id=${id}]`);
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
    expect(seedRetainedDraft([id, dir, '--config', `derived/drafts/${id}/config.json`,
      '--from', `derived/drafts/${id}/out`, '--parts', `derived/drafts/${id}/input`], CHAIN_NOW + index * 1000).exit).toBe(0);
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
  expectRetiredVerdict(next, `review_acts[kind=parts-verdict,draft_id=${id}]`);
  expect(next.moves.some(move => move.role === 'producer')).toBe(false);
  expect(next.moves.some(move => move.command?.startsWith('rig-create structure-snapshot') || move.command?.startsWith('rig-create diff-classes'))).toBe(false);
  expect(next.awaits.some(path => path.includes(`evidence/parts-${id}`))).toBe(false);
  expect(next.moves.some(move => move.command?.includes(`evidence/parts-${id}`))).toBe(false);
  expect(existsSync(join(dir, `evidence/parts-${id}`))).toBe(false);
  expect(readFileSync(file)).toEqual(before);
  for (const [index, path] of paths.entries()) expect(readFileSync(join(dir, path))).toEqual(retained[index]);
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

  expect(nextProject(dir, CHAIN_NOW).refusals).toContainEqual(expect.objectContaining({
    code: 'PLAN_STEP_PREDATES_ANSWER',
    field: 'plan.steps[camera]',
  }));
  expect(runMainCapture(['plan', 'revise', 'camera', dir, '--by', 'agent',
    '--reason', 'Keep the camera step after reviewing the recorded delegation.'], CHAIN_NOW + 1))
    .toMatchObject({ code: 0, stderr: '' });

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

test('#596 numbered post with an open step stays read-only until there is a current record', () => {
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
  }, 'example-numbered/example-project.json'));

  const beforeAdopt = nextProject(dir, CHAIN_NOW);
  expect(beforeAdopt.refusals).toEqual([]);
  expectNumberedPostReadOnly(beforeAdopt);
  const file = join(dir, 'project.json');
  const beforeContract = readFileSync(file);
  writeFileSync(file, JSON.stringify({ ...JSON.parse(beforeContract.toString()), current: {} }));
  const currentBeforeContract = nextProject(dir, CHAIN_NOW);
  expect(currentBeforeContract.refusals).toEqual([]);
  expect(currentBeforeContract.awaits).not.toContain('direction_contract');
  expect(currentBeforeContract.moves.find(move => move.field === 'current.direction')).toMatchObject({
    role: 'agent', awaits: 'current.direction',
    command: `rig-create record direction ${dir} --from outputs/direction.next --direction specs/direction/direction.json`,
  });
  expect(currentBeforeContract.moves.some(move => move.command?.startsWith('rig-create direction --adopt '))).toBe(false);
  expect(currentBeforeContract.moves.some(move => move.command?.startsWith('rig-create advance direction-review '))).toBe(false);
  writeFileSync(file, beforeContract);
  expect(runMainCapture(['direction', '--adopt', dir], CHAIN_NOW)).toMatchObject({ code: 0, stderr: '' });

  const afterAdopt = nextProject(dir, CHAIN_NOW);
  expect(afterAdopt.refusals).toEqual([]);
  expectNumberedPostReadOnly(afterAdopt);

  const current = JSON.parse(readFileSync(file, 'utf8')) as JsonObject;
  current.current = {};
  writeFileSync(file, JSON.stringify(current));
  const withCurrent = nextProject(dir, CHAIN_NOW);
  expect(withCurrent.refusals).toEqual([]);
  expect(withCurrent.moves.find(move => move.field === 'current.direction')?.command).toBe(
    `rig-create record direction ${dir} --from outputs/direction.next --direction specs/direction/direction.json`,
  );
  expect(withCurrent.moves.some(move => move.command?.startsWith('rig-create direction write 3 '))).toBe(false);
  expect(withCurrent.moves.filter(move => move.field.startsWith('plan.steps[')))
    .toEqual(afterAdopt.moves.filter(move => move.field.startsWith('plan.steps[')));
});

test('#1030 next keeps stale current repairs and defers missing builds until their stages', () => {
  const dir = fixture(project => {
    const frames = { path: 'outputs/motion/frames.json', sha256: sha256('{}'), bytes: 2 };
    const report = { path: 'outputs/direction/check/check.json', sha256: sha256('{}'), bytes: 2 };
    const run = { path: 'outputs/direction/compose-run.json', sha256: sha256('{}'), bytes: 2 };
    const metadata = { at: new Date(CHAIN_NOW).toISOString(), built_by: 'agent', built_with: {} };
    project.current = {
      direction: { ...metadata, files: [report, run], files_sha256: outputSetHash([report, run]),
        built_from: [{ path: frames.path, sha256: frames.sha256 }], run: { path: run.path, sha256: run.sha256 },
        report: { path: report.path, sha256: report.sha256 } },
      motion: { ...metadata, files: [frames], files_sha256: outputSetHash([frames]),
        built_from: [{ path: 'specs/motion/schedule.json', sha256: sha256('[]') }],
        rebuild: { recorded: false, note: 'Synthetic render without a run record' } },
    };
  }, 'project.json', { 'specs/motion/schedule.json': '[]', 'outputs/motion/frames.json': '{}' });
  const outputs = (report: NextReport) => report.moves.filter(move => move.field.startsWith('current.'));
  expect(outputs(nextProject(dir, CHAIN_NOW))).toEqual([]);

  writeFileSync(join(dir, 'specs/motion/schedule.json'), '[1]');
  const before = treeDigest(dir);
  const report = nextProject(dir, CHAIN_NOW);
  expect(report.refusals.filter(finding => finding.code === 'CURRENT_MALFORMED')).toEqual([]);
  expect(report.warnings?.filter(warning => warning.code === 'OUTPUT_STALE').map(warning => warning.path))
    .toEqual(['current.motion', 'current.direction']);
  const moves = outputs(report);
  const fields = ['current.motion', 'current.direction'];
  expect(moves.map(move => move.field)).toEqual(fields);
  expect(report.awaits.filter(field => fields.includes(field))).toEqual(fields);
  expect(moves[0]).toMatchObject({ role: 'agent', command: null,
    act: expect.stringContaining('Obtain the render arguments from the operator') });
  expect(moves[1]).toMatchObject({ role: 'agent', command: null,
    act: expect.stringContaining('obtain the compose arguments from the operator') });
  expect(treeDigest(dir)).toEqual(before);
});

const DEFAULT_RIG_CONFIG = 'specs/rig/config.json';

function adoptionFixture({ current = false, config }: { current?: boolean; config?: string } = {}) {
  const at = '2026-10-01T00:00:00.000Z';
  const older = 'outputs/v1/out/rig/rig.json';
  const latest = 'outputs/v2/out/rig/rig.json';
  const parts = 'outputs/v2/out/parts.json';
  const frames = 'outputs/v2/idle/frames.json';
  const post = 'outputs/v3/compose/take.json';
  const bindings = (...paths: string[]) => paths.map(path => ({ path, sha256: sha256('{}'), bytes: 2 }));
  const configBinding = config && config !== DEFAULT_RIG_CONFIG ? bindings(config)[0] : undefined;
  const dir = realpathSync(fixture(project => {
    project.stage = 'interview';
    project.signoffs = [];
    project.advances = [];
    project.plan = { steps: [] };
    project.scenes = [];
    project.review_acts = [];
    delete project.direction_contract;
    const interview = obj(project.interview);
    for (const item of arr(interview.waypoints).map(obj)) {
      if (item.id !== 'seethrough' && item.id !== 'assemble') delete item.guide;
    }
    for (const item of arr(obj(interview.post).items).map(obj)) delete item.guide;
    const build = { at, built_by: 'agent', built_with: { '@rig-c/parts': '2.57.0' }, provenance: { sections: {} }, evidence: [], verdicts: [] };
    if (current) project.current = {};
    project.versions = [
      { ...build, n: 1, kind: 'rig', outputs: bindings(older) },
      { ...build, n: 2, kind: 'rig', outputs: bindings(latest, parts, frames),
        ...(configBinding && { provenance: { sections: {}, config: configBinding } }),
        verdicts: [{ review: 'rig-review', verdict: 'accepted', by: 'user', at, verbatim: 'Accept the synthetic rig.', on_items: [] }] },
      { ...build, n: 3, kind: 'post', rig_version: 2, outputs: bindings(post) },
    ];
  }, 'example-numbered/example-project.json', { [older]: '{}', [latest]: '{}', [parts]: '{}', [frames]: '{}', [post]: '{}',
    ...(config ? { [config]: '{}' } : {}) }));
  const file = join(dir, 'project.json');
  return { dir, file, latest, frames, post };
}

test('#1030/#1044 next offers in-place adoption in a current project using verified outputs of the latest live numbered version', () => {
  const numbered = adoptionFixture();
  expect(obj(JSON.parse(readFileSync(numbered.file, 'utf8'))).current).toBeUndefined();
  const legacy = nextProject(numbered.dir, CHAIN_NOW);
  expect(legacy.refusals).toEqual([]);
  expect(legacy.moves.filter(move => move.field.startsWith('current.') || isRecordAdoption(move.command))).toEqual([]);

  const { dir, file, latest, frames } = adoptionFixture({ current: true });
  const moves = () => nextProject(dir, CHAIN_NOW).moves.filter(move => isRecordAdoption(move.command));
  const before = treeDigest(dir);
  expect(nextProject(dir, CHAIN_NOW).refusals).toEqual([]);
  expect(moves().map(move => [move.command, move.act])).toEqual([
    [`rig-create record parts --adopt ${dir}`, 'Adopt the bound parts output of v2 in place.'],
    [`rig-create record rig --adopt ${dir}`, 'Adopt the bound rig output of v2 in place.'],
    [`rig-create record motion --adopt ${dir}`, 'Adopt the bound motion output of v2 in place.'],
    [`rig-create record direction --adopt ${dir}`, 'Adopt the bound direction output of v3 in place.'],
  ]);
  expect(treeDigest(dir)).toEqual(before);

  const original = readFileSync(file);
  for (const kind of ['parts', 'motion', 'direction', 'rig']) {
    const command = moves().find(move => move.field === `current.${kind}`)!.command!;
    expect(runMainCapture(printedArgs(command).slice(1), CHAIN_NOW).code).toBe(0);
    expect(moves().some(move => move.field === `current.${kind}`)).toBe(false);
  }
  expect(moves()).toEqual([]);
  writeFileSync(file, original);

  writeFileSync(join(dir, latest), '[]');
  rmSync(join(dir, frames));
  expect(moves().map(move => move.field)).toEqual(['current.parts', 'current.direction']);

  const project = JSON.parse(readFileSync(file, 'utf8')) as JsonObject;
  const reopenedAt = new Date(CHAIN_NOW - 500).toISOString();
  project.reopens = [{ stage: 'post', from_stage: 'direction-review', at: reopenedAt, by: 'owner', verbatim: 'Revisit the post.',
    source: OWNER_CHAT_SOURCE, said_at: reopenedAt, relayed_by: 'synthetic-relay', steps_before: [] }];
  writeFileSync(file, JSON.stringify(project));
  expect(moves().map(move => move.field)).toEqual(['current.parts']);

  delete project.reopens;
  writeFileSync(file, JSON.stringify({ ...project, current: {} }));
  const outputs = nextProject(dir, CHAIN_NOW).moves.filter(move => move.field.startsWith('current.'));
  expect(outputs.map(move => move.command)).toEqual([
    `rig-create record parts --adopt ${dir}`,
    `rig-create record parts ${dir} --from outputs/parts.next --config specs/rig/config.json`,
    `rig-create record rig ${dir} --from outputs/rig.next --config specs/rig/config.json`,
    `rig-create record motion ${dir} --from outputs/motion.next`,
    `rig-create record direction --adopt ${dir}`,
    `rig-create record direction ${dir} --from outputs/direction.next --direction specs/direction/direction.json`,
  ]);
});

test('#1030/#1044 adopted rig and motion need canonical replacements before downstream producer recording', () => {
  const { dir, frames, post } = adoptionFixture();
  const adoption = runMainCapture(['record', 'rig', '--adopt', dir], CHAIN_NOW);
  expect(adoption.code).toBe(0);
  expect(adoption.stderr).toContain('Adopting this output will stop numbered verdict moves from being offered for this project.');
  expect(existsSync(join(dir, DEFAULT_RIG_CONFIG))).toBe(false);
  const outputChoices = (root = dir) => {
    const result = nextProject(root, CHAIN_NOW);
    expect(result.refusals).toEqual([]);
    expect(result.warnings?.filter(warning => warning.code === 'OUTPUT_STALE') ?? []).toEqual([]);
    return result.moves.filter(move => /^current\.(rig|motion|direction)$/.test(move.field));
  };
  const adoptable = outputChoices();
  expect(adoptable.map(move => move.command)).toEqual([
    null,
    `rig-create record motion --adopt ${dir}`,
    `rig-create record direction --adopt ${dir}`,
  ]);
  expect(adoptable[0]?.act).toContain('Rebuild the adopted rig as a canonical output under outputs/rig/. Record the replacement before recording dependent producer outputs.');
  expect(adoptable[0]?.act).toContain('RECORD_CONFIG_MISMATCH: current.rig');
  const parts = nextProject(dir, CHAIN_NOW).moves.filter(move => move.field === 'current.parts');
  expect(parts.map(move => move.command)).toEqual([`rig-create record parts --adopt ${dir}`, null]);
  expect(parts[1]!.act).toContain('RECORD_CONFIG_MISMATCH: current.parts');

  // Unavailable numbered files leave the canonical producers as the recovery route.
  rmSync(join(dir, frames));
  const missingMotion = outputChoices();
  expect(missingMotion.map(move => move.field)).toEqual(['current.rig', 'current.direction']);
  expect(missingMotion[0]).toMatchObject({
    command: null,
    act: expect.stringContaining('RECORD_CONFIG_MISMATCH: current.rig'),
  });
  expect(missingMotion[1]?.command).toBe(`rig-create record direction --adopt ${dir}`);

  writeFileSync(join(dir, frames), '{}');
  expect(runMainCapture(printedArgs(adoptable[1]!.command!).slice(1), CHAIN_NOW).code).toBe(0);
  rmSync(join(dir, post));
  const missingDirection = outputChoices();
  expect(missingDirection.map(move => move.field)).toEqual(['current.rig', 'current.motion']);
  expect(missingDirection[1]).toMatchObject({ command: null,
    act: expect.stringContaining('Rebuild current.rig first. Rebuild the adopted motion as a canonical output') });

  const motionOnly = adoptionFixture();
  expect(runMainCapture(['record', 'motion', '--adopt', motionOnly.dir], CHAIN_NOW).code).toBe(0);
  rmSync(join(motionOnly.dir, motionOnly.post));
  const withoutAdoptedRig = outputChoices(motionOnly.dir);
  const rig = withoutAdoptedRig.filter(move => move.field === 'current.rig');
  expect(rig.map(move => move.command)).toEqual([`rig-create record rig --adopt ${motionOnly.dir}`, null]);
  expect(rig[1]!.act).toContain('RECORD_CONFIG_MISMATCH: current.rig');
  expect(withoutAdoptedRig.find(move => move.field === 'current.motion')?.command)
    .toBe(`rig-create record motion ${motionOnly.dir} --from outputs/motion.next`);
  expect(withoutAdoptedRig.some(move => move.field === 'current.direction')).toBe(false);

  mkdirSync(dirname(join(motionOnly.dir, DEFAULT_RIG_CONFIG)), { recursive: true });
  writeFileSync(join(motionOnly.dir, DEFAULT_RIG_CONFIG), '{}');
  const recovered = nextProject(motionOnly.dir, CHAIN_NOW).moves;
  for (const kind of ['parts', 'rig']) {
    expect(recovered.filter(move => move.field === `current.${kind}`).map(move => move.command)).toEqual([
      `rig-create record ${kind} --adopt ${motionOnly.dir}`,
      `rig-create record ${kind} ${motionOnly.dir} --from outputs/${kind}.next --config ${DEFAULT_RIG_CONFIG}`,
    ]);
  }
});

test.each([
  { source: 'the default config', config: DEFAULT_RIG_CONFIG },
  { source: 'provenance.config', config: 'evidence/rig source.json' },
])('#1044 next offers the adopted rig replacement using $source', ({ config }) => {
  const { dir, file } = adoptionFixture({ config });
  expect(runMainCapture(['record', 'rig', '--adopt', dir], CHAIN_NOW).code).toBe(0);
  const rig = obj(obj(obj(JSON.parse(readFileSync(file, 'utf8'))).current).rig);
  expect(rig.built_from).toEqual(config === DEFAULT_RIG_CONFIG ? [] : [{ path: config, sha256: sha256('{}') }]);
  const before = treeDigest(dir);
  const report = nextProject(dir, CHAIN_NOW);
  expect(report.refusals).toEqual([]);
  const replacements = report.moves.filter(move => move.field === 'current.rig');
  expect(moveTuples(replacements)).toEqual([['agent', 'rig-create record rig', null]]);
  expect(printedArgs(replacements[0]!.command!)).toEqual(['rig-create', 'record', 'rig', dir, '--from', 'outputs/rig.next', '--config', config]);
  expect(treeDigest(dir)).toEqual(before);
});

test('#1030 stale rig hides both adoption and producer offers for missing downstream kinds', () => {
  const input = 'evidence/rig source.json';
  const { dir, post } = adoptionFixture({ config: input });
  expect(runMainCapture(['record', 'rig', '--adopt', dir], CHAIN_NOW).code).toBe(0);
  rmSync(join(dir, post));
  expect(nextProject(dir, CHAIN_NOW).moves.some(move => move.command === `rig-create record motion --adopt ${dir}`)).toBe(true);
  mkdirSync(dirname(join(dir, DEFAULT_RIG_CONFIG)), { recursive: true });
  writeFileSync(join(dir, DEFAULT_RIG_CONFIG), '{}');
  writeFileSync(join(dir, input), '[]');
  const result = nextProject(dir, CHAIN_NOW);
  expect(result.refusals).toEqual([]);
  expect(result.warnings?.filter(warning => warning.code === 'OUTPUT_STALE').map(warning => warning.path)).toEqual(['current.rig']);
  expect(result.moves.filter(move => move.field.startsWith('current.')).map(move => move.field)).toEqual(['current.parts', 'current.parts', 'current.rig']);
  expect(moveTuples(result.moves.filter(move => move.field === 'current.rig'))).toEqual([['agent', null, null]]);
  expect(result.awaits).not.toContain('current.motion');
  expect(result.awaits).not.toContain('current.direction');
});

test('#1030 stale adopted motion and direction keep rebuild guidance after the canonical rig prerequisite', () => {
  const { dir, file } = adoptionFixture();
  for (const kind of ['rig', 'motion', 'direction']) {
    expect(runMainCapture(['record', kind, '--adopt', dir], CHAIN_NOW).code).toBe(0);
  }
  const record = JSON.parse(readFileSync(file, 'utf8')) as JsonObject;
  const current = obj(record.current);
  for (const kind of ['motion', 'direction']) {
    const input = `specs/${kind}/synthetic.json`;
    mkdirSync(dirname(join(dir, input)), { recursive: true });
    writeFileSync(join(dir, input), '[]');
    obj(current[kind]).built_from = [{ path: input, sha256: sha256('{}') }];
  }
  writeFileSync(file, JSON.stringify(record));
  const original = treeDigest(dir);
  const report = nextProject(dir, CHAIN_NOW);
  expect(report.refusals).toEqual([]);
  expect(report.warnings?.filter(warning => warning.code === 'OUTPUT_STALE').map(warning => warning.path))
    .toEqual(['current.motion', 'current.direction']);
  const outputs = report.moves.filter(move => /^current\.(rig|motion|direction)$/.test(move.field));
  expect(outputs.map(move => move.field)).toEqual(['current.rig', 'current.motion', 'current.direction']);
  expect(outputs[0]?.act).toContain('Rebuild the adopted rig as a canonical output');
  expect(outputs[1]).toMatchObject({ command: null, act: expect.stringContaining('Obtain the render arguments from the operator') });
  expect(outputs[2]).toMatchObject({ command: null, act: expect.stringContaining('obtain the compose arguments from the operator') });
  expect(treeDigest(dir)).toEqual(original);
});

test('#1030 canonical rig replacement surfaces stale adopted motion then stale adopted direction', () => {
  const { dir } = adoptionFixture();
  for (const kind of ['parts', 'rig', 'motion', 'direction']) {
    expect(runMainCapture(['record', kind, '--adopt', dir], CHAIN_NOW).code).toBe(0);
  }
  expect(nextProject(dir, CHAIN_NOW).moves.filter(move => move.field.startsWith('current.'))).toEqual([]);

  const producer = join(REPO, 'templates/example-draft');
  const from = 'outputs/rig.next';
  const config = 'specs/rig/config.json';
  cpSync(join(producer, 'out'), join(dir, from), { recursive: true });
  mkdirSync(dirname(join(dir, config)), { recursive: true });
  cpSync(join(producer, 'config.json'), join(dir, config));
  const model = readFileSync(join(dir, from, 'check/build/skeleton.model.json'));
  writeFileSync(join(dir, from, 'check/check.json'), JSON.stringify({
    spec: 'rig-parts-check/1', bar_outcomes: {}, build: { model_sha256: sha256(model) }, PASS: true,
  }));
  // A fixture outside Git gets record's ignore and commit WARNs, which this test does not exercise.
  expect(runMainCapture(['record', 'rig', dir, '--from', from, '--config', config], CHAIN_NOW))
    .toMatchObject({ code: 0 });
  const original = treeDigest(dir);

  const report = nextProject(dir, CHAIN_NOW);
  const fields = ['current.motion', 'current.direction'];
  expect(report.refusals).toEqual([]);
  expect(report.warnings?.filter(warning => warning.code === 'OUTPUT_STALE').map(warning => warning.path)).toEqual(fields);
  expect(report.awaits.filter(field => field.startsWith('current.'))).toEqual(fields);
  expect(report.moves.filter(move => move.field.startsWith('current.'))).toEqual([
    expect.objectContaining({ field: fields[0], command: null, act: expect.stringContaining('Obtain the render arguments from the operator') }),
    expect.objectContaining({ field: fields[1], command: null, act: expect.stringContaining('obtain the compose arguments from the operator') }),
  ]);
  expect(treeDigest(dir)).toEqual(original);
});

test('#579 after a rig-review reopen, next omits history rig versions and lapsed rig-review signoff, keeps numbered registrations read-only, and keeps post stages free of history rigs', () => {
  const dir = join(tempDir(), 'reopen-rig-review');
  cpSync(join(CHECKPOINTS_DIR, '3-rig-review'), dir, { recursive: true });
  const file = join(dir, 'project.json');

  // Control: a project without a reopen keeps today's next output.
  const unreopened = nextProject(dir, CHAIN_NOW);
  expect(unreopened.refusals).toEqual([]);
  expect(unreopened.awaits).toEqual(['versions[n=1].verdicts[review=rig-review]']);
  expectRetiredVerdict(unreopened, 'versions[n=1].verdicts[review=rig-review]');

  // Step 1: Rig v1 is accepted and rig-review is signed on it.
  const approvalWords = readFileSync(join(dir, 'evidence/approval.txt'), 'utf8');
  testClock.set(new Date(CHAIN_NOW));
  seedStoredVerdict(dir, 1, {
    review: 'rig-review',
    verdict: 'accepted',
    by: 'user',
    at: CHAIN_NOW,
    verbatim: approvalWords,
    source: 'synthetic example',
  });
  seedStoredVersionSignoff(dir, 'rig-review', 1, { by: 'user', at: CHAIN_NOW, verbatim: approvalWords });

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
    const res = seedRetainedRigVersion(
      [
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
    expect(res.exit).toBe(0);
  };

  // Register Rig v2 (built before any reopen).
  const v2At = CHAIN_NOW + 1000;
  registerRig(2, new Date(v2At).toISOString(), v2At);

  // Step 2: Reopen rig-review.
  const reopenAt = CHAIN_NOW + 2000;
  const reopenWords = join(dir, 'reopen-words.txt');
  writeFileSync(reopenWords, 'Reopen rig-review to rebuild the synthetic rig.\n');
  testClock.set(new Date(reopenAt));
  plantLegacyReopen(dir, 'rig-review', { by: 'owner', wordsFile: reopenWords });

  // Attempting to sign rig-review on the history acceptance refuses: the CLI writer is retired (exit 2)
  // and target selection refuses with RIG_VERSION_UNACCEPTED, leaving project.json byte-identical.
  const beforeRefusedSign = readFileSync(file);
  const refusedSign = runMainCapture(
    ['signoff', 'rig-review', dir, '--by', 'user', '--verbatim-file', join(dir, 'evidence/approval.txt')],
    reopenAt,
  );
  expect(refusedSign.code).toBe(USAGE_EXIT);
  expect(refusedSign.stderr).toContain('NUMBERED_WRITER_REMOVED');
  expect(() => selectHistoricalSignoffTarget(dir, JSON.parse(readFileSync(file, 'utf8')) as JsonObject, 'rig-review', undefined, reopenAt))
    .toThrow(expect.objectContaining({ code: 'RIG_VERSION_UNACCEPTED' }));
  expect(readFileSync(file)).toEqual(beforeRefusedSign);

  const staleProject = JSON.parse(readFileSync(file, 'utf8')) as JsonObject;
  expect(() => optionContext(staleProject, 'post-interview', reopenAt, dir))
    .toThrow(expect.objectContaining({ code: 'INTERVIEW_OPTIONS_STALE' }));

  const beforePostReopenRig = nextProject(dir, reopenAt);
  expect(beforePostReopenRig.refusals).toEqual([]);
  expect(beforePostReopenRig.moves).toContainEqual(expect.objectContaining({
    role: 'agent', field: 'versions', awaits: 'versions', command: null,
    act: expect.stringContaining('Numbered rig registrations are read-only.'),
  }));
  expect(beforePostReopenRig.moves.some(move => move.field.startsWith('current.') || /\brig-version\b/.test(move.command ?? ''))).toBe(false);
  expect(checkProject(dir, undefined, { now: reopenAt, readOnly: true }).warnings).toContainEqual({
    code: 'RIG_CHECK_REPORT_MISSING', path: 'versions[v2].registration.check_report',
    message: expect.stringContaining('rig-parts check --rig <rig dir> --parts <parts dir> --source <painting> --requirements <requirements file> --out <check dir>'),
  });
  expect(beforePostReopenRig.moves.some(m => m.lapse !== undefined)).toBe(false);
  expect(beforePostReopenRig.moves.some(m => m.review_act?.version_id === 'v1' || m.review_act?.version_id === 'v2')).toBe(false);
  expect(beforePostReopenRig.moves.some(m => m.review_act?.kind === 'signoff')).toBe(false);

  const v3At = reopenAt + 1000;
  setBuildTime(new Date(v3At).toISOString());
  const postReopenBindings = { ...bindings, '--check-report': 'check.json' };
  expect(seedRetainedRigVersion([
    '3', dir, ...Object.entries(postReopenBindings).flatMap(([flag, path]) => [flag, `rebuild-source/${path}`]),
    '--at-pointer', '/finished_at', '--by', 'registrant',
  ], v3At).exit).toBe(0);
  const reboundProject = JSON.parse(readFileSync(file, 'utf8')) as JsonObject;
  // #981: rig-version no longer binds a parts approval.
  expect(arr(reboundProject.versions).map(obj).find(v => v.n === 3)?.accepted_parts).toBeUndefined();

  // After registration, the live replacement rig carries the pending verdict gate.
  const afterPostReopenRig = nextProject(dir, v3At);
  expect(afterPostReopenRig.refusals).toEqual([]);
  expect(afterPostReopenRig.awaits.filter(field => !field.startsWith('current.'))).toEqual(['versions[n=3].verdicts[review=rig-review]']);
  expect(afterPostReopenRig.moves.some(m => m.lapse !== undefined)).toBe(false);
  expect(afterPostReopenRig.moves.some(m => m.review_act?.version_id === 'v1' || m.review_act?.version_id === 'v2')).toBe(false);
  expect(afterPostReopenRig.moves.some(m => m.command?.includes('--rig 1') || m.command?.includes('--rig 2'))).toBe(false);
  expect(afterPostReopenRig.moves.some(m => m.review_act?.kind === 'signoff')).toBe(false);
  expectRetiredVerdict(afterPostReopenRig, 'versions[n=3].verdicts[review=rig-review]');

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
  seedStoredVerdict(dir, 3, {
    review: 'rig-review',
    verdict: 'accepted',
    by: 'user',
    at: acceptAt,
    verbatim: approvalWords,
    source: 'synthetic example',
  });
  seedStoredVersionSignoff(dir, 'rig-review', 3, { by: 'user', at: acceptAt, verbatim: approvalWords });
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
  expect(runMainCapture(['direction', '--adopt', dir], acceptAt + 3000)).toMatchObject({ code: 0, stderr: '' });

  // At post stage after the rig-review reopen, next omits both the live and historical numbered writers.
  const atPost = nextProject(dir, acceptAt + 3000);
  expect(atPost.refusals).toEqual([]);
  expect(atPost.moves.some(m => m.lapse !== undefined)).toBe(false);
  expect(atPost.moves.some(m => m.review_act?.version_id === 'v1' || m.review_act?.version_id === 'v2')).toBe(false);
  expectNumberedPostReadOnly(atPost);

  // Seed the retained scene on rig v3 to exercise the historical post reader.
  const composition = arr(obj(obj(JSON.parse(readFileSync(file, 'utf8')).interview).post).items).map(obj)
    .find(item => item.id === 'post_composition')!;
  const guide = obj(composition.guide);
  const background = String(obj(obj(obj(guide.value).scene).background).path);
  if (!existsSync(join(dir, background))) {
    cpSync(join(CHAIN_DIR, 'inputs/background.png'), join(dir, background));
    expect(runMainCapture(['input', 'add', background, dir, '--origin', 'synthetic prepared scene plate'], acceptAt + 3000))
      .toMatchObject({ code: 0, stderr: '' });
  }
  const citationsPath = 'evidence/printed-scene-citations.json';
  writeFileSync(join(dir, citationsPath), JSON.stringify({ background: {
    guide: 'post_composition', asks: ['post_composition'], quote: guide.verbatim,
  } }));
  const sceneArgs = ['write', dir, '--rig', '3', '--background', background, '--citations-file', citationsPath];
  expect(seedRetainedScene(sceneArgs, acceptAt + 3000).exit).toBe(0);
  expectNumberedPostReadOnly(nextProject(dir, acceptAt + 3000));
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
    seedRetainedDirectionPost(
      ['write', '4', dir, '--file', 'evidence/direction-input.json', '--rig', '3'],
      acceptAt + 4000,
    ).exit,
  ).toBe(0);
  expect(runMainCapture(['advance', 'direction-review', dir], acceptAt + 5000)).toMatchObject({ code: 0, stderr: '' });

  const atDirectionReview = nextProject(dir, acceptAt + 5000);
  expect(atDirectionReview.refusals).toEqual([]);
  expect(atDirectionReview.moves.some(m => m.lapse !== undefined)).toBe(false);
  expect(atDirectionReview.moves.some(m => m.review_act?.version_id === 'v1' || m.review_act?.version_id === 'v2' || m.review_act?.version_id === 'v3')).toBe(false);
  expect(atDirectionReview.moves.some(m => m.command?.includes('--rig 1') || m.command?.includes('--rig 2') || m.command?.includes('--rig 3'))).toBe(false);
  expectNumberedPostReadOnly(atDirectionReview);

  // Consumer-clone shape: post v4 is reviewed and signed at direction-review, then rig-review is reopened,
  // a new rig v5 is registered, accepted and signed, and a new unreviewed post v6 reaches direction-review.
  testClock.set(new Date(acceptAt + 5500));
  seedStoredVerdict(dir, 4, {
    review: 'direction-review',
    verdict: 'accepted',
    by: 'user',
    at: acceptAt + 5500,
    verbatim: approvalWords,
    source: 'synthetic example',
  });
  seedStoredVersionSignoff(dir, 'direction-review', 4, { by: 'user', at: acceptAt + 5500, verbatim: approvalWords });

  const reopen2At = acceptAt + 6000;
  testClock.set(new Date(reopen2At));
  plantLegacyReopen(dir, 'rig-review', { by: 'owner', wordsFile: reopenWords });

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
  seedStoredVerdict(dir, 5, {
    review: 'rig-review',
    verdict: 'accepted',
    by: 'user',
    at: acceptV5At,
    verbatim: approvalWords,
    source: 'synthetic example',
  });
  seedStoredVersionSignoff(dir, 'rig-review', 5, { by: 'user', at: acceptV5At, verbatim: approvalWords });
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
    seedRetainedScene(
      ['write', dir, '--rig', '5', '--background', 'inputs/background.png', '--citations-file', 'evidence/printed-scene-citations.json'],
      acceptV5At + 3000,
    ).exit,
  ).toBe(0);
  const afterV5SceneProject = JSON.parse(readFileSync(file, 'utf8')) as JsonObject;
  const latestV5Scene = obj(arr(afterV5SceneProject.scenes).at(-1));
  const v5ModelPath = 'derived/review/v5/out/check/build/skeleton.model.json';
  dirDoc.scene = { n: latestV5Scene.n!, path: latestV5Scene.path!, sha256: latestV5Scene.sha256! };
  dirDoc.rig = { version: 5, model: { path: v5ModelPath, sha256: sha256(readFileSync(join(dir, v5ModelPath))) } };
  writeFileSync(join(dir, 'evidence/direction-input.json'), JSON.stringify(dirDoc));
  expect(
    seedRetainedDirectionPost(
      ['write', '6', dir, '--file', 'evidence/direction-input.json', '--rig', '5'],
      acceptV5At + 4000,
    ).exit,
  ).toBe(0);
  expect(runMainCapture(['advance', 'direction-review', dir], acceptV5At + 5000)).toMatchObject({ code: 0, stderr: '' });

  const afterSignedPostReopen = nextProject(dir, acceptV5At + 5000);
  expect(afterSignedPostReopen.refusals).toEqual([]);
  expectNumberedPostReadOnly(afterSignedPostReopen);
  expect(afterSignedPostReopen.moves.some(m => m.lapse !== undefined)).toBe(false);
}, 30_000);

test('#587 after a parts-review reopen, next reports the retired verdict gate on a retained draft', () => {
  const dir = join(realpathSync(tempDir()), 'reopen-parts-review-draft-verdict');
  cpSync(join(CHECKPOINTS_DIR, '3-rig-review'), dir, { recursive: true });
  const file = join(dir, 'project.json');
  const words = join(dir, 'words.txt');
  writeFileSync(words, 'Synthetic owner words.\n');

  // Record accepted rig v1, register rig v2, and bounce rig v2 so both REOPEN_VERDICT_LAPSED and FEEDBACK_OPEN are live warnings after reopen.
  const ownerWords = readFileSync(words, 'utf8');
  testClock.set(new Date(CHAIN_NOW));
  seedStoredVerdict(dir, 1, {
    review: 'rig-review',
    verdict: 'accepted',
    by: 'user',
    at: CHAIN_NOW,
    verbatim: ownerWords,
    source: 'synthetic example',
  });
  seedStoredVersionSignoff(dir, 'rig-review', 1, { by: 'user', at: CHAIN_NOW, verbatim: ownerWords });

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
    seedRetainedRigVersion(
      [
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
    ).exit,
  ).toBe(0);

  testClock.set(new Date(CHAIN_NOW + 2000));
  seedStoredVerdict(dir, 2, {
    review: 'rig-review',
    verdict: 'bounced',
    by: 'user',
    at: CHAIN_NOW + 2000,
    verbatim: ownerWords,
    source: 'synthetic bounce',
    on_items: [{ id: 'rig_type', answer_was: 'user' }],
  });

  // Reopen parts-review, seed the retained draft, then record its structure and diff evidence.
  const reopenAt = CHAIN_NOW + 3000;
  testClock.set(new Date(reopenAt));
  plantLegacyReopen(dir, 'parts-review', { by: 'user', wordsFile: words });

  const draftId = 'chain-reopened';
  cpSync(join(dir, 'derived/drafts/chain'), join(dir, `derived/drafts/${draftId}`), { recursive: true });
  expect(
    seedRetainedDraft(
      [
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
    ).exit,
  ).toBe(0);
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
    expect(report.moves).toHaveLength(1);
    expectRetiredVerdict(report, `review_acts[kind=parts-verdict,draft_id=${draftId}]`);
  }
});

test('#656 after a reopen to rigging-interview with a lapsed post-interview signoff, next shows post-interview as future work without job open --plan', () => {
  const dir = join(realpathSync(tempDir()), 'reopen-rigging-interview-lapsed-post');
  cpSync(join(CHECKPOINTS_DIR, '4-direction-post'), dir, { recursive: true });
  const words = join(dir, 'words.txt');
  writeFileSync(words, 'Reopen to rigging-interview.\n');
  const reopenAt = Date.parse('2026-11-06T02:00:00Z');
  testClock.set(new Date(reopenAt));
  plantLegacyReopen(dir, 'rigging-interview', { by: 'owner', wordsFile: words });

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
  expect(rigMoves.some(m => m.command?.includes('--plan'))).toBe(false);
  expect(rigMoves.some(m => m.role === 'human' && m.command?.includes('signoff rigging-interview') && m.command.includes('--owner-chat'))).toBe(true);
});

test.each([
  { label: 'an unmet motion bar', motion: 'in-progress', advance: false },
  { label: 'every bar met', motion: 'done', advance: true },
])('#754 next at rigging with $label does not offer job open --rig', ({ motion, advance }) => {
  const dir = join(tempDir(), 'rigging-rig-open');
  cpSync(join(CHECKPOINTS_DIR, '3-rig-review'), dir, { recursive: true });
  const file = join(dir, 'project.json');
  const project = JSON.parse(readFileSync(file, 'utf8')) as JsonObject;
  project.stage = 'rigging';
  project.advances = arr(project.advances).filter(entry => obj(entry).stage !== 'rig-review');
  arr(obj(project.plan).steps).map(obj).find(step => step.id === 'motion')!.status = motion;
  writeFileSync(file, `${JSON.stringify(project, null, 2)}\n`);
  const report = nextProject(dir, CHAIN_NOW);
  expect(report.effective_stage).toBe('rigging');
  expect(report.moves.some(move => (move.command ?? '').includes('job open') && (move.command ?? '').includes('--rig'))).toBe(false);
  expect(report.moves.some(move => move.command === `rig-create advance rig-review ${dir}`)).toBe(advance);
  // #681: motion has no checkpoint, so it goes from in-progress straight to done.
  if (!advance) expect(report.moves.map(move => move.command)).toContain(`rig-create step-status motion done ${dir} --by agent`);
});

test('#773 a reopened rigging reports retired draft review and registration without suggesting current writes', () => {
  const dir = join(tempDir(), 'reopen-draft');
  cpSync(join(CHECKPOINTS_DIR, '3-rig-review'), dir, { recursive: true });
  const approvalWords = readFileSync(join(dir, 'evidence/approval.txt'), 'utf8');
  testClock.set(new Date(CHAIN_NOW));
  seedStoredVerdict(dir, 1, {
    review: 'rig-review',
    verdict: 'accepted',
    by: 'user',
    at: CHAIN_NOW,
    verbatim: approvalWords,
    source: 'synthetic example',
  });
  seedStoredVersionSignoff(dir, 'rig-review', 1, { by: 'user', at: CHAIN_NOW, verbatim: approvalWords });
  const reopenAt = CHAIN_NOW + 2000;
  const reopenWords = join(dir, 'reopen-words.txt');
  writeFileSync(reopenWords, 'Reopen rigging to rebuild the synthetic rig.\n');
  testClock.set(new Date(reopenAt));
  plantLegacyReopen(dir, 'rigging', { by: 'owner', wordsFile: reopenWords });
  // Finish the reopened rig steps so only the draft decides which registration moves show.
  const reopened = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
  for (const step of arr(obj(reopened.plan).steps).map(obj)) if (step.phase === 'rig') step.status = 'done';
  writeFileSync(join(dir, 'project.json'), `${JSON.stringify(reopened, null, 2)}\n`);

  // A compiled draft built after the reopen, with no verdict yet.
  const draftId = 'reopened';
  const draft = `derived/drafts/${draftId}`;
  cpSync(join(dir, 'derived/drafts/chain/input'), join(dir, draft, 'out'), { recursive: true });
  for (const file of ['config.json', 'interview-requirements.json']) cpSync(join(dir, 'derived/drafts/chain', file), join(dir, draft, file));
  cpSync(join(REPO, 'tests/fixtures/rig-registration/rig'), join(dir, draft, 'out/rig'), { recursive: true });
  cpSync(join(REPO, 'tests/fixtures/rig-registration/build'), join(dir, draft, 'out/check/build'), { recursive: true });
  expect(seedRetainedDraft([draftId, dir, '--config', `${draft}/config.json`, '--from', `${draft}/out`,
    '--parts', `${draft}/out`], reopenAt + 500).exit).toBe(0);

  const report = nextProject(dir, reopenAt + 1000);
  expect(report.refusals).toEqual([]);
  expectRetiredVerdict(report, `drafts[${draftId}]`);
  expect(report.moves).toContainEqual(expect.objectContaining({
    role: 'agent', field: 'versions', awaits: 'versions', command: null,
    act: expect.stringContaining('Numbered rig registrations are read-only.'),
  }));
  const project = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
  writeFileSync(join(dir, 'project.json'), JSON.stringify({ ...project, current: {} }));
  const withCurrent = nextProject(dir, reopenAt + 1000);
  expect(withCurrent.refusals).toEqual([]);
  expect(withCurrent.moves.some(move => move.review_act?.kind === 'review-verdict')).toBe(false);
  expect(withCurrent.awaits).not.toContain(`drafts[${draftId}]`);
  expect(withCurrent.moves).toContainEqual(expect.objectContaining({
    field: 'current.rig', command: `rig-create record rig ${dir} --from outputs/rig.next --config specs/rig/config.json`,
  }));
  expect(withCurrent.moves.some(move => move.command?.startsWith('rig-create rig-version '))).toBe(false);
});
