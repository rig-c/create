import { afterEach, expect, test } from 'bun:test';
import { cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { checkProject } from '../src/check.ts';
import { freshProjectRecord } from '../src/init.ts';
import { nextProject, type NextReport } from '../src/next.ts';
import { Refusal } from '../src/refusal.ts';
import { INTERVIEW_VALUE_READERS, STEP_PLAN_SCHEMA, VALUE_QUESTIONS } from '../src/stages.ts';
import { interviewDecisionCommand } from '../src/choice-writers.ts';
import { selectAnswerHashes } from '../src/signoff-answers.ts';
import type { JsonObject } from '../src/templates.ts';
import { main } from '../src/cli.ts';
import { planCommand, testClock } from './clock.ts';
import { arr, obj } from './fixtures.ts';
import { cli as spawnCli, clockedCli, gitEnv, run, tempDir } from './helpers.ts';

const REPO = join(import.meta.dir, '..');
const CHAIN_DIR = join(REPO, 'templates/example-chain');
const PLAN_TEXT = 'Across the whole figure I will cut the parts along the painted outlines, because the joints read clearly there.\n';

afterEach(() => testClock.reset());

function quiet<T>(run: () => T): T {
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try { return run(); } finally { process.stdout.write = write; }
}

/** A fresh init record with its painting registered, as the agent first meets it. */
function freshProject(): string {
  const dir = join(tempDir(), 'synthetic-fresh');
  mkdirSync(join(dir, 'inputs'), { recursive: true });
  mkdirSync(join(dir, 'evidence'));
  writeFileSync(join(dir, 'project.json'), JSON.stringify(freshProjectRecord('synthetic-fresh', testClock.now())));
  cpSync(join(CHAIN_DIR, 'inputs/painting.png'), join(dir, 'inputs/painting.png'));
  expect(quiet(() => main(['input', 'add', 'inputs/painting.png', dir, '--origin', 'synthetic source'], testClock.now()))).toBe(0);
  return dir;
}

function stepPlans(dir: string): JsonObject[] {
  return arr(obj(JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')).interview).step_plans).map(obj);
}

function refusalOf(run: () => unknown): Refusal {
  try { run(); } catch (error) { if (error instanceof Refusal) return error; throw error; }
  throw new Error('expected a refusal');
}

test('next on a fresh project proposes the parts plan instead of option sets', () => {
  const dir = freshProject();
  const report = nextProject(dir, testClock.now());
  expect(report.moves.some(move => move.command?.includes('interview-options'))).toBe(false);
  expect(report.moves.some(move => move.command?.includes('interview-answer'))).toBe(false);
  const move = report.moves.find(move => move.field === 'interview.step_plans');
  expect(move).toMatchObject({ role: 'agent', awaits: 'interview.step_plans[step=parts]' });
  expect(move?.command).toStartWith('rig-create plan propose parts ');
  expect(report.moves.filter(move => move.field === 'interview.step_plans')).toHaveLength(1);
});

test('plan propose binds the plan and inputs by sha256 and answers the step questions', () => {
  const dir = freshProject();
  mkdirSync(join(dir, 'plans'));
  writeFileSync(join(dir, 'plans/parts.md'), PLAN_TEXT);
  const before = checkProject(dir, undefined, { now: testClock.now() }).refusals.filter(r => r.code === 'INTERVIEW_INCOMPLETE');
  expect(before.length).toBeGreaterThan(0);
  const result = planCommand(['propose', 'parts', dir, '--file', join(dir, 'plans/parts.md'), '--by', 'agent']);
  expect(result.exit).toBe(0);
  const [entry] = stepPlans(dir);
  const painting = readFileSync(join(dir, 'inputs/painting.png'));
  expect(entry).toMatchObject({
    schema: STEP_PLAN_SCHEMA, step: 'parts', path: 'plans/parts.md', bytes: Buffer.byteLength(PLAN_TEXT),
    sha256: createHash('sha256').update(PLAN_TEXT).digest('hex'), by: 'agent', feedback: [],
    inputs: [{ path: 'inputs/painting.png', sha256: createHash('sha256').update(painting).digest('hex') }],
  });
  const report = checkProject(dir, undefined, { now: testClock.now() });
  expect(report.refusals.filter(r => r.code === 'INTERVIEW_INCOMPLETE')).toEqual([]);
  expect(report.refusals.filter(r => r.code.startsWith('STEP_PLAN_'))).toEqual([]);
  // The same bytes again are a no-op; next no longer asks for the parts plan.
  const bytes = readFileSync(join(dir, 'project.json'));
  expect(planCommand(['propose', 'parts', dir, '--file', join(dir, 'plans/parts.md'), '--by', 'agent']).exit).toBe(0);
  expect(readFileSync(join(dir, 'project.json'))).toEqual(bytes);
  expect(nextProject(dir, testClock.now()).moves.some(move => move.field === 'interview.step_plans')).toBe(false);

  // Editing the plan leaves feedback bound to the old bytes; check warns until it is proposed again.
  writeFileSync(join(dir, 'plans/parts.md'), `${PLAN_TEXT}Hands stay one rigid piece.\n`);
  expect(checkProject(dir, undefined, { now: testClock.now() }).warnings.map(w => w.code)).toContain('STEP_PLAN_STALE');
  testClock.set(testClock.now() + 60_000);
  expect(planCommand(['propose', 'parts', dir, '--file', join(dir, 'plans/parts.md'), '--by', 'agent']).exit).toBe(0);
  expect(stepPlans(dir)).toHaveLength(2);
  expect(checkProject(dir, undefined, { now: testClock.now() }).warnings.map(w => w.code)).not.toContain('STEP_PLAN_STALE');
});

test('plan propose refuses a file outside the project and leaves the record unchanged', () => {
  const dir = freshProject();
  const outside = join(tempDir(), 'plan.md');
  writeFileSync(outside, PLAN_TEXT);
  const bytes = readFileSync(join(dir, 'project.json'));
  expect(refusalOf(() => planCommand(['propose', 'parts', dir, '--file', outside, '--by', 'agent'])).code).toBe('STEP_PLAN_FILE_INVALID');
  expect(refusalOf(() => planCommand(['propose', 'bones', dir, '--file', outside, '--by', 'agent'])).code).toBe('PLAN_OPTION_INVALID');
  expect(readFileSync(join(dir, 'project.json'))).toEqual(bytes);
});

test('plan feedback attaches relayed chat and Review comments to the plan it was made about', () => {
  const dir = freshProject();
  mkdirSync(join(dir, 'plans'));
  writeFileSync(join(dir, 'plans/parts.md'), PLAN_TEXT);
  const words = join(dir, 'evidence/words.txt');
  writeFileSync(words, 'Keep the sleeves separate from the arms.');
  expect(refusalOf(() => planCommand(['feedback', 'parts', dir, '--words-file', words, '--by', 'owner',
    '--said-at', testClock.iso(), '--relayed-by', 'synthetic-relay'])).code).toBe('STEP_PLAN_MISSING');
  planCommand(['propose', 'parts', dir, '--file', join(dir, 'plans/parts.md'), '--by', 'agent']);
  const firstSha = stepPlans(dir)[0]!.sha256 as string;
  const saidAt = testClock.iso();
  testClock.set(testClock.now() + 1_000);
  expect(planCommand(['feedback', 'parts', dir, '--words-file', words, '--by', 'owner', '--said-at', saidAt, '--relayed-by', 'synthetic-relay']).exit).toBe(0);
  expect(stepPlans(dir)[0]!.feedback).toEqual([{ source: 'owner chat, relayed', owner_words: 'Keep the sleeves separate from the arms.',
    by: 'owner', said_at: saidAt, relayed_by: 'synthetic-relay', at: testClock.iso() }]);

  // A comment on the earlier plan stays with it after a new proposal.
  writeFileSync(join(dir, 'plans/parts.md'), `${PLAN_TEXT}Sleeves are their own parts.\n`);
  testClock.set(testClock.now() + 1_000);
  planCommand(['propose', 'parts', dir, '--file', join(dir, 'plans/parts.md'), '--by', 'agent']);
  testClock.set(testClock.now() + 1_000);
  expect(planCommand(['feedback', 'parts', dir, '--words-file', words, '--by', 'owner', '--said-at', saidAt,
    '--relayed-by', 'synthetic-relay', '--comment-id', 'comment-1', '--sha256', firstSha]).exit).toBe(0);
  const [first, second] = stepPlans(dir);
  expect(arr(first!.feedback).map(entry => obj(entry).source)).toEqual(['owner chat, relayed', 'review comment']);
  expect(obj(arr(first!.feedback)[1]).comment_id).toBe('comment-1');
  expect(second!.feedback).toEqual([]);
  expect(checkProject(dir, undefined, { now: testClock.now() }).refusals.filter(r => r.code.startsWith('STEP_PLAN_') || r.code.startsWith('OWNER_CHAT_'))).toEqual([]);

  // A said-at after the write is refused before any byte moves.
  const bytes = readFileSync(join(dir, 'project.json'));
  expect(refusalOf(() => planCommand(['feedback', 'parts', dir, '--words-file', words, '--by', 'owner',
    '--said-at', new Date(testClock.now() + 3_600_000).toISOString(), '--relayed-by', 'synthetic-relay', '--comment-id', 'comment-2'])).code).toBe('STEP_PLAN_FEEDBACK_INVALID');
  expect(readFileSync(join(dir, 'project.json'))).toEqual(bytes);
});

test('check refuses a malformed step plan by code', () => {
  const dir = freshProject();
  const file = join(dir, 'project.json');
  const project = JSON.parse(readFileSync(file, 'utf8')) as JsonObject;
  obj(project.interview).step_plans = [{ schema: STEP_PLAN_SCHEMA, step: 'parts', path: '../plan.md', sha256: 'x', bytes: 1, inputs: [], by: 'agent', at: testClock.iso(), feedback: [] },
    { schema: STEP_PLAN_SCHEMA, step: 'rigging', path: 'plans/rigging.md', sha256: 'a'.repeat(64), bytes: 1, inputs: [], by: 'agent', at: testClock.iso(), feedback: [{ source: 'review comment', words: 'x' }] }];
  const codes = checkProject(dir, project, { now: testClock.now() }).refusals.map(r => [r.code, r.path]);
  expect(codes).toContainEqual(['STEP_PLAN_INVALID', 'interview.step_plans[0]']);
  expect(codes).toContainEqual(['STEP_PLAN_FEEDBACK_INVALID', 'interview.step_plans[1].feedback[0]']);
});

test('an old project with answered option sets checks as before and next asks no step plan', () => {
  const report = checkProject(CHAIN_DIR, undefined, { now: testClock.now() });
  expect(report.refusals).toEqual([]);
  expect(report.warnings.filter(w => w.code.startsWith('STEP_PLAN_'))).toEqual([]);
  for (const name of ['0a-interview-options', '0b-plan-pending', '2-rigging-answers']) {
    const dir = join(CHAIN_DIR, 'checkpoints', name);
    expect(checkProject(dir, undefined, { now: testClock.now() }).refusals.filter(r => r.code.startsWith('STEP_PLAN_'))).toEqual([]);
    expect(nextProject(dir, testClock.now()).moves.some(move => move.field === 'interview.step_plans')).toBe(false);
  }
});

/** Value-reading sites that are not readers of an answer's value: why each is exempt. */
const NOT_VALUE_READERS: Record<string, string> = {
  'check.ts turn': 'decides whether a turn waypoint exists and skips it in a stage-order rule; reads no value',
  'next.ts camera_depth': 'maps the post plan step id to its guide id for a move label',
  'next.ts post_timing': 'maps the post plan step id to its guide id for a move label',
};
const GUIDE_IDS = ['rig_type', 'reference', 'seethrough', 'assemble', 'turn', 'bones', 'meshes', 'constraints', 'motion', 'camera_depth', 'post_timing', 'post_composition'];
const READ_SITE = /(\.id === |itemFor\(|resolvedValue\(|citedValues\(|\[\s*'camera'\s*,)/;

test('#983 every source site that reads an interview value is listed in INTERVIEW_VALUE_READERS', () => {
  const src = join(REPO, 'src');
  const found = new Set<string>();
  for (const file of readdirSync(src).filter(name => name.endsWith('.ts') && name !== 'stages.ts')) {
    for (const line of readFileSync(join(src, file), 'utf8').split('\n')) {
      if (!READ_SITE.test(line)) continue;
      for (const id of GUIDE_IDS) if (line.includes(`'${id}'`)) found.add(`${file} ${id}`);
    }
  }
  const listed = new Set(INTERVIEW_VALUE_READERS.map(reader => `${reader.file} ${reader.question}`));
  expect([...found].filter(site => !listed.has(site) && !(site in NOT_VALUE_READERS)).sort()).toEqual([]);
  expect([...listed].filter(site => !found.has(site)).sort()).toEqual([]);
  expect(VALUE_QUESTIONS).toEqual(['rig_type', 'assemble', 'turn', 'meshes', 'camera_depth', 'post_timing', 'post_composition']);
});

function proposeParts(dir: string, text: string): void {
  mkdirSync(join(dir, 'plans'), { recursive: true });
  writeFileSync(join(dir, 'plans/parts.md'), text);
  expect(planCommand(['propose', 'parts', dir, '--file', 'plans/parts.md', '--by', 'agent']).exit).toBe(0);
}

function decide(dir: string, question: string, value: unknown, quote: string): string {
  const files = join(tempDir(), 'decision');
  mkdirSync(files, { recursive: true });
  writeFileSync(join(files, 'why.md'), 'The plan states this value.\n');
  writeFileSync(join(files, 'value.json'), JSON.stringify(value));
  writeFileSync(join(files, 'quote.txt'), quote);
  return interviewDecisionCommand([question, dir, '--by', 'agent', '--reasoning-file', join(files, 'why.md'),
    '--value-file', join(files, 'value.json'), '--plan-quote-file', join(files, 'quote.txt')], testClock.now());
}

const PARTS_PLAN = `${PLAN_TEXT}This is a standing character with an idle loop.
The parts are projected from their core masks on a plain ground.
`;

test('#983 under a step plan next offers each value question and interview-decision records it as a delegation', () => {
  const dir = freshProject();
  proposeParts(dir, PARTS_PLAN);
  const moves = nextProject(dir, testClock.now()).moves.filter(move => move.command?.includes('--plan-quote-file'));
  expect(moves.map(move => move.awaits).sort()).toEqual(['interview.framing[rig_type].answer', 'interview.waypoints[assemble].guide'].sort());
  expect(moves.every(move => move.role === 'agent')).toBe(true);
  testClock.set(testClock.now() + 1000);
  decide(dir, 'rig_type', 'character.idle', 'This is a standing character with an idle loop.');
  testClock.set(testClock.now() + 1000);
  decide(dir, 'assemble', { project: 'core', ground: 'plain' }, 'The parts are projected from their core masks\non a plain ground.');
  const project = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'));
  const sha = stepPlans(dir)[0]?.sha256;
  const assemble = obj(arr(obj(project.interview).waypoints).map(obj).find(w => w.id === 'assemble')?.guide);
  expect(assemble).toMatchObject({ delegated: true, by: 'agent', source: 'step plan', step_plan: { step: 'parts', sha256: sha },
    agent_decision: { by: 'agent', value: { project: 'core', ground: 'plain' } } });
  expect(arr(assemble.asks).map(obj).map(ask => ask.id)).not.toContain('ground');
  const report = checkProject(dir, undefined, { now: testClock.now() });
  const codes = [...report.refusals, ...report.warnings].map(f => f.code);
  for (const code of ['INTERVIEW_CHOICE_REQUIRED', 'GUIDE_ASKS_MALFORMED', 'GUIDE_ASK_UNANSWERED', 'STEP_PLAN_VALUE_UNSAID', 'INTERVIEW_INCOMPLETE']) expect(codes).not.toContain(code);
  expect(nextProject(dir, testClock.now()).moves.filter(move => move.command?.includes('--plan-quote-file'))).toEqual([]);
});

test('#983 a value the plan does not say warns STEP_PLAN_VALUE_UNSAID; the writer refuses by code', () => {
  const dir = freshProject();
  const unplanned = refusalOf(() => decide(dir, 'rig_type', 'character.idle', 'anything'));
  expect(unplanned.code).toBe('STEP_PLAN_MISSING');
  proposeParts(dir, PARTS_PLAN);
  const before = readFileSync(join(dir, 'project.json'));
  expect(refusalOf(() => decide(dir, 'reference', 'none', 'anything')).code).toBe('INTERVIEW_OPTIONS_USAGE');
  expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
  testClock.set(testClock.now() + 1000);
  decide(dir, 'rig_type', 'character.idle', 'This is a game character.');
  const report = checkProject(dir, undefined, { now: testClock.now() });
  expect(report.warnings.filter(w => w.code === 'STEP_PLAN_VALUE_UNSAID').map(w => w.path)).toEqual(['interview.framing[rig_type].answer']);
  expect(report.refusals.map(r => r.code)).not.toContain('STEP_PLAN_VALUE_UNSAID');
  // Re-recording a step-plan value keeps the earlier one in history and clears the warning.
  testClock.set(testClock.now() + 1000);
  decide(dir, 'rig_type', 'character.idle', 'This is a standing character with an idle loop.');
  expect(checkProject(dir, undefined, { now: testClock.now() }).warnings.map(w => w.code)).not.toContain('STEP_PLAN_VALUE_UNSAID');
  const project = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'));
  expect(arr(arr(obj(project.interview).framing).map(obj).find(f => f.id === 'rig_type')?.history)).toHaveLength(1);
});

function cli(argv: string[]): { code: number; stderr: string } {
  let stderr = '';
  const err = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => { stderr += String(chunk); return true; }) as typeof process.stderr.write;
  try { return { code: quiet(() => main(argv, testClock.now())), stderr }; } finally { process.stderr.write = err; }
}

function approvePartsPlan(dir: string): void {
  proposeParts(dir, PARTS_PLAN);
  testClock.set(testClock.now() + 1000);
  decide(dir, 'rig_type', 'character.idle', 'This is a standing character with an idle loop.');
  decide(dir, 'assemble', { project: 'core', ground: 'plain' }, 'The parts are projected from their core masks on a plain ground.');
  for (const [id, order] of [['seethrough', '1'], ['assemble', '2']] as const) {
    expect(cli(['plan', 'add', id, dir, '--by', 'agent', '--phase', 'rig', '--order', order, '--does', 'work', '--produces', 'result',
      '--rests-on', id, '--bar', 'the parts check passes', '--checkpoint-proposed', 'false']).code).toBe(0);
  }
  const words = join(tempDir(), 'words.txt');
  writeFileSync(words, 'Go ahead with the plan.\n');
  const sign = (stage: string) => {
    testClock.set(testClock.now() + 1000);
    return cli(['signoff', stage, dir, '--by', 'synthetic-owner', '--owner-chat', words,
      '--said-at', new Date(testClock.now() - 500).toISOString(), '--relayed-by', 'agent']);
  };
  expect(sign('interview').code).toBe(0);
  expect(cli(['advance', 'plan-approved', dir]).code).toBe(0);
  const signed = sign('plan-approved');
  expect(signed.stderr).not.toContain('SIGNOFF_ANSWERS_UNANSWERED');
  expect(signed.code).toBe(0);
}

test('#983 sign-offs bind a plan-covered question to its step plan; a changed plan makes the binding stale', () => {
  const dir = freshProject();
  approvePartsPlan(dir);
  const signoffs = arr(JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')).signoffs).map(obj);
  expect(Object.keys(obj(signoffs.at(-1)?.answer_hashes)).sort()).toEqual(['assemble', 'seethrough']);
  expect(Object.keys(obj(signoffs[0]?.answer_hashes))).toContain('seethrough');
  expect(cli(['advance', 'parts', dir]).code).toBe(0);
  expect(checkProject(dir, undefined, { now: testClock.now() }).refusals.map(r => r.code)).toEqual([]);
  // A changed plan is a new revision of every question it covers.
  testClock.set(testClock.now() + 1000);
  proposeParts(dir, `${PARTS_PLAN}The hair is cut into finer locks.\n`);
  const stale = checkProject(dir, undefined, { now: testClock.now() }).refusals.filter(r => r.code === 'SIGNOFF_ANSWERS_STALE').map(r => r.path);
  expect(stale).toContain('signoffs[1].answer_hashes[seethrough]');
  // #997: an answered value delegated under the plan is covered by it too, so its binding is stale as well.
  expect(stale).toContain('signoffs[1].answer_hashes[assemble]');
});

test('#1054 a fresh project records current parts and advances with a retained check', () => {
  const root = tempDir();
  const dir = join(root, "synthetic owner's project");
  const source = join(dir, 'inputs/source');
  const env = gitEnv({ name: 'Synthetic author', email: 'synthetic@example.test' });
  expect(spawnCli(['init', dir, '--no-install'], root, env).code).toBe(0);
  cpSync(join(REPO, 'templates/example-composed-direction/inputs/source'), source, { recursive: true });
  expect(cli(['input', 'add', 'inputs/source/painting.png', dir, '--origin', 'synthetic source']).code).toBe(0);
  approvePartsPlan(dir);
  expect(cli(['advance', 'parts', dir]).code).toBe(0);
  for (const id of ['seethrough', 'assemble']) {
    for (const status of ['in-progress', 'at-checkpoint', 'done']) {
      testClock.set(testClock.now() + 1000);
      expect(cli(['step-status', id, status, dir, '--by', 'agent'])).toMatchObject({ code: 0, stderr: '' });
    }
  }

  const projectFile = join(dir, 'project.json');
  const bytes = readFileSync(projectFile, 'utf8');
  expect(JSON.parse(bytes).current).toBeUndefined();
  const next = () => {
    const result = spawnCli(['next', dir, '--json'], root, env);
    expect(result).toMatchObject({ code: 0, stderr: '' });
    return JSON.parse(result.stdout) as NextReport;
  };
  const fresh = next();
  expect(fresh.refusals).toEqual([]);
  expect(fresh.moves.find(move => move.command !== null)).toMatchObject({
    field: 'current.parts', command: expect.stringContaining('rig-create record parts '),
  });
  expect(fresh.moves.some(move => /draft-rig/.test(`${move.command} ${move.act}`))).toBe(false);
  expect(readFileSync(projectFile, 'utf8')).toBe(bytes);

  const config = 'inputs/source/config.json';
  const staged = 'outputs/parts.next';
  const partsBin = join(REPO, 'node_modules/@rig-c/parts/bin/rig-parts.cjs');
  const assembled = run([process.execPath, partsBin, 'assemble', '--source', 'inputs/source/painting.png',
    '--full', 'inputs/source/layers', '--config', config, '--out', staged], dir, env);
  expect(assembled).toMatchObject({ code: 0, stderr: '' });
  const checked = run([process.execPath, partsBin, 'check-parts', '--parts', `${staged}/rig`, '--out', `${staged}/check`], dir, env);
  expect(checked).toMatchObject({ code: 0, stderr: '' });
  expect(spawnCli(['record', 'parts', dir, '--from', staged, '--config', config], root, env))
    .toMatchObject({ code: 0, stderr: '' });

  const advance = next().moves.find(move => move.field === 'stage')?.command;
  expect(advance).toContain('rig-create advance parts-review ');
  // Run the printed command unchanged, with the repository CLIs and the test clock.
  writeFileSync(join(root, 'rig-create'), '#!/bin/sh\nexec "$TEST_BUN" "$TEST_CLI" "$TEST_TIME" "$@"\n', { mode: 0o700 });
  const [clockedEntry, at] = clockedCli();
  const moved = run(['/bin/sh', '-c', advance!], root, {
    ...env, TEST_BUN: process.execPath, TEST_CLI: clockedEntry!, TEST_TIME: at!,
    PATH: [root, join(REPO, 'node_modules/.bin'), env.PATH].join(':'),
  });
  expect(moved).toMatchObject({ code: 0, stderr: '' });
  const project = JSON.parse(readFileSync(projectFile, 'utf8')) as JsonObject;
  expect(project.stage).toBe('parts-review');
  const evidence = obj(obj(arr(project.advances).at(-1)).parts_check);
  expect(evidence.parts).toBe('outputs/parts/rig');
  expect(String(evidence.path)).toMatch(/^evidence\/parts-review\.[^/]+\/parts-check\.json$/);
  expect(evidence.sha256).toBe(createHash('sha256').update(readFileSync(join(dir, String(evidence.path)))).digest('hex'));
  expect(checkProject(dir, undefined, { now: testClock.now() }).refusals).toEqual([]);

  const snapshot = next().moves.find(move => move.command?.startsWith('rig-create structure-snapshot '));
  expect(snapshot?.role).toBe('agent');
  expect(next().moves.some(move => move.command?.startsWith('rig-create signoff parts-review '))).toBe(false);
  expect(spawnCli(['structure-snapshot', dir], root, env)).toMatchObject({ code: 0, stderr: '' });
  const signoff = next().moves.find(move => move.command?.startsWith('rig-create signoff parts-review '));
  expect(signoff?.role).toBe('human');
  expect(signoff?.command).toContain("--by '<owner>' --owner-chat '<words file>' --said-at '<ISO date>' --relayed-by '<operator>'");
  const words = join(root, 'parts-approval.txt');
  writeFileSync(words, 'Approve the synthetic parts.\n');
  testClock.set(testClock.now() + 1000);
  expect(spawnCli(['signoff', 'parts-review', dir, '--by', 'synthetic-owner', '--owner-chat', words,
    '--said-at', testClock.iso(), '--relayed-by', 'agent'], root, env)).toMatchObject({ code: 0, stderr: '' });
  expect(next().moves.some(move => move.command?.startsWith('rig-create advance rigging-interview '))).toBe(true);
});

test('#1054 numbered parts keep draft evidence moves', () => {
  const report = nextProject(join(CHAIN_DIR, 'checkpoints/1-parts-verdict'), testClock.now());
  expect(report.stage).toBe('parts');
  expect(report.refusals).toEqual([]);
  expect(report.moves.map(move => [move.role, move.field, move.awaits, move.command?.split(' ').slice(0, 2).join(' ')])).toEqual([
    ['agent', 'drafts[chain]', 'evidence/structure-chain.json', 'rig-create structure-snapshot'],
    ['producer', 'drafts[chain].parts', 'evidence/diff-components.json', 'rig-parts diff-components'],
  ]);
});

test('#997 re-recording a step-plan value with a step resting on it marks that step for revision instead of refusing', () => {
  const dir = freshProject();
  proposeParts(dir, PARTS_PLAN);
  testClock.set(testClock.now() + 1000);
  decide(dir, 'assemble', { project: 'core', ground: 'plain' }, 'The parts are projected from their core masks on a plain ground.');
  expect(cli(['plan', 'add', 'assemble', dir, '--by', 'agent', '--phase', 'rig', '--order', '1', '--does', 'work', '--produces', 'result',
    '--rests-on', 'assemble', '--bar', 'the parts check passes', '--checkpoint-proposed', 'false']).code).toBe(0);
  testClock.set(testClock.now() + 1000);
  decide(dir, 'assemble', { project: 'core', ground: 'plain' }, 'The parts are projected from their core masks on a plain ground.');
  const codes = checkProject(dir, undefined, { now: testClock.now() }).refusals.map(r => r.code);
  expect(codes).not.toContain('PLAN_STEP_PREDATES_ANSWER');
});

test('#983 without a covering plan a silent rests_on question still refuses the sign-off by code', () => {
  const dir = freshProject();
  const project = () => JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
  expect(refusalOf(() => selectAnswerHashes(dir, project(), { stage: 'plan-approved' }, ['seethrough'])).code).toBe('SIGNOFF_ANSWERS_UNANSWERED');
  proposeParts(dir, PARTS_PLAN);
  expect(Object.keys(obj(selectAnswerHashes(dir, project(), { stage: 'plan-approved' }, ['seethrough'])))).toEqual(['seethrough']);
  // A rigging question is not covered by the parts plan.
  expect(refusalOf(() => selectAnswerHashes(dir, project(), { stage: 'plan-approved' }, ['bones'])).code).toBe('SIGNOFF_ANSWERS_UNANSWERED');
});
