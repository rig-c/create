import { expect, mock, test } from 'bun:test';
import { cpSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXAMPLE_ANCHOR } from '../scripts/example-time.ts';
import { amendCommand } from '../src/amend.ts';
import { asArray, checkProject, isObject } from '../src/check.ts';
import * as cli from '../src/cli.ts';
import { nextCommand, nextProject, type NextReport } from '../src/next.ts';
import { OWNER_CHAT_SOURCE } from '../src/owner-chat.ts';
import { advanceCommand, stepStatusCommand } from '../src/progress-writers.ts';
import { recordCommand } from '../src/record.ts';
import { Refusal } from '../src/refusal.ts';
import { signoffCommand } from '../src/signoff.ts';
import { stepPlanCommand } from '../src/step-plans.ts';
import type { JsonObject } from '../src/templates.ts';
import { gitEnv, run, tempDir } from './helpers.ts';

const DIRECTION_STEPS = [
  'rigc render',
  'rig-create record motion',
  'rig-create scene write',
  'rig-create direction write',
  'rig-parts compose',
  'rig-create record direction',
];
const BUILD_STEPS = [
  'rig-parts assemble', 'rig-parts check-parts', 'rig-create record parts',
  'rig-parts rig', 'rig-parts check', 'rig-create record rig',
];

function commands(report: NextReport, prefix: string) {
  return report.moves.flatMap(move =>
    move.command?.split(' && ').some(command => command.startsWith(`${prefix} `)) ? [move.command] : []);
}

function planMoves(report: NextReport) {
  return report.moves.filter(move => move.act.startsWith('Tell the owner the plan in chat before advancing'));
}

async function replay(destination: string, skipSignoffs = false): Promise<void> {
  const dir = join(destination, 'example-current');
  let writers = 0;
  let humanWriters = 0;
  let skippedSignoffs = 0;
  let now = 0;
  let directionStep = 0;
  let buildStep = 0;
  const toldByStage = new Map<string, string[]>();
  const main = cli.main;
  const observePlanMoves = (report: NextReport) => {
    const plans = planMoves(report);
    if (plans.length > 1) throw new Error(`next at ${report.stage} printed ${plans.length} plan moves`);
    if (plans.length === 1) {
      const plan = plans[0]!;
      if (plan.role !== 'agent' || plan.command !== null) {
        throw new Error(`plan move at ${report.stage} must be a non-blocking agent move`);
      }
      const planIndex = report.moves.indexOf(plan);
      const advanceIndex = report.moves.findIndex(move => move.field === 'stage' && move.command?.startsWith('rig-create advance '));
      if (advanceIndex < 0 || planIndex > advanceIndex) {
        throw new Error(`plan move at ${report.stage} must appear before advance`);
      }
      const seen = toldByStage.get(report.stage) ?? [];
      seen.push(plan.act);
      toldByStage.set(report.stage, seen);
    }
  };
  const assertOffered = (prefix: string, at: number) => {
    const report = JSON.parse(nextCommand([dir, '--json'], at).stdout) as NextReport;
    observePlanMoves(report);
    const offered = commands(report, prefix);
    if (offered.length === 0) throw new Error(`next at ${report.stage} omitted ${prefix}`);
    if (prefix.startsWith('rig-create signoff ') && !offered.some(command =>
      ['--by', '--owner-chat', '--said-at', '--relayed-by'].every(flag => command.includes(` ${flag} `)))) {
      throw new Error(`next at ${report.stage} omitted the owner chat relay for ${prefix}`);
    }
    if (BUILD_STEPS.includes(prefix)) {
      const expected = BUILD_STEPS[buildStep];
      const future = BUILD_STEPS.slice(buildStep + 1).filter(step => commands(report, step).length > 0);
      if (prefix !== expected || future.length > 0) {
        throw new Error(`next at ${report.stage} expected ${expected}, called ${prefix}, offered early: ${future.join(', ')}`);
      }
      buildStep++;
    }
    if (DIRECTION_STEPS.includes(prefix)) {
      const expected = DIRECTION_STEPS[directionStep];
      const future = DIRECTION_STEPS.slice(directionStep + 1).filter(step => commands(report, step).length > 0);
      if (prefix !== expected || future.length > 0) {
        throw new Error(`next at ${report.stage} expected ${expected}, called ${prefix}, offered early: ${future.join(', ')}`);
      }
      directionStep++;
    }
    return { report, offered };
  };
  mock.module('../src/cli.ts', () => ({
    ...cli,
    main(args: string[], at: number) {
      const writer = args[0];
      if (writer === 'signoff' && skipSignoffs) {
        const stage = args[1]!;
        const report = JSON.parse(nextCommand([dir, '--json'], now).stdout) as NextReport;
        const advanceIdx = report.moves.findIndex(move => move.role === 'agent' && move.command?.startsWith('rig-create advance '));
        const signoffIdx = report.moves.findIndex(move => move.command?.startsWith(`rig-create signoff ${stage} `));
        if (advanceIdx < 0) throw new Error(`next at ${report.stage} did not offer advance without signoff`);
        if (signoffIdx <= advanceIdx) throw new Error(`optional signoff at ${report.stage} sat in front of advance`);
        if (!report.moves[signoffIdx]?.act.startsWith(`optional: if the owner said something about ${stage}`)) {
          throw new Error(`optional signoff at ${report.stage} did not describe optional relay`);
        }
        if (report.awaits.some(target => target.startsWith('signoffs['))) {
          throw new Error(`next at ${report.stage} still awaited ${report.awaits.join(', ')}`);
        }
        skippedSignoffs++;
        now = at;
        return 0;
      }
      if (writer !== 'init') {
        const words = writer === 'structure-snapshot' ? 1 : writer === 'plan' || writer === 'step-status' ? 3 : 2;
        const { report, offered } = assertOffered(`rig-create ${args.slice(0, words).join(' ')}`, now);
        if (writer === 'record' && (args[1] === 'parts' || args[1] === 'rig')) {
          const config = args[args.indexOf('--config') + 1];
          if (!offered.some(command => command.endsWith(` --config ${config}`))) {
            throw new Error(`next omitted the config bound by the staged ${args[1]} run`);
          }
        }
        const matchedMove = report.moves.find(move => move.command !== null && offered.includes(move.command));
        if (matchedMove?.role === 'human') humanWriters++;
        writers++;
      }
      now = at;
      return main(args, at);
    },
  }));
  Bun.spawnSync = new Proxy(Bun.spawnSync, {
    apply(target, receiver, args) {
      const [command, options] = args;
      if (options?.cwd === dir && Array.isArray(command) && typeof command[1] === 'string') {
        if (command[1].endsWith('/rigc.cjs') && command[2] === 'render') {
          const { offered } = assertOffered('rigc render', now);
          expect(offered[0]).not.toContain('--loop-seam');
          const spec = join(dir, 'specs/motion/loop-seam.json');
          mkdirSync(join(dir, 'specs/motion'), { recursive: true });
          writeFileSync(spec, JSON.stringify({ channel_delta: 9, pixels_above: 2, warmup_cap: 6 }));
          try {
            expect(commands(nextProject(dir, now), 'rigc render')).toEqual([
              offered[0]!.replace(/\)$/, ' --loop-seam-bar 9,2 --loop-seam-cap 6)'),
            ]);
          } finally { unlinkSync(spec); }
        }
        if (command[1].endsWith('/rig-parts.cjs') && typeof command[2] === 'string') {
          const prefix = `rig-parts ${command[2]}`;
          // The second check-parts call creates retained arrival evidence, outside staging.
          if (command[2] !== 'check-parts' || command.includes('outputs/parts.next/rig')) assertOffered(prefix, now);
        }
      }
      return Reflect.apply(target, receiver, args);
    },
  });
  const { generateExampleCurrent } = await import('../scripts/generate-example-current.ts');
  generateExampleCurrent(destination);
  if (buildStep !== BUILD_STEPS.length) throw new Error(`replay finished after ${buildStep} of ${BUILD_STEPS.length} build steps`);
  if (directionStep !== DIRECTION_STEPS.length) throw new Error(`replay finished after ${directionStep} of ${DIRECTION_STEPS.length} direction steps`);
  if (skipSignoffs) {
    const project = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
    if (asArray(project.signoffs).length !== 0) throw new Error(`expected 0 signoffs, found ${asArray(project.signoffs).length}`);
    if (skippedSignoffs !== 7) throw new Error(`expected 7 skipped signoff stops, saw ${skippedSignoffs}`);
    if (humanWriters !== 3) throw new Error(`expected 3 human pick writers, saw ${humanWriters}`);
    const stages = [...toldByStage.keys()];
    if (JSON.stringify(stages) !== JSON.stringify(['plan-approved', 'rigging-interview', 'post-interview'])) {
      throw new Error(`unexpected plan-told stages: ${stages.join(', ')}`);
    }
    for (const [stg, acts] of toldByStage) {
      if (acts.length !== 1) throw new Error(`expected plan move once at ${stg}, saw ${acts.length}`);
    }
    if (!toldByStage.get('plan-approved')![0]!.includes('Build a standing idle character. Use core projection and keep the synthetic painted outlines.')) {
      throw new Error('plan-approved move omitted plans/parts.md text');
    }
    if (!toldByStage.get('rigging-interview')![0]!.includes('Keep the painted view. Keep the torso rigid.')
      || !toldByStage.get('rigging-interview')![0]!.includes('Give the body a four-second breathing loop.')) {
      throw new Error('rigging-interview move omitted rigging/motion plan text');
    }
    if (!toldByStage.get('post-interview')![0]!.includes('camera: Prepare synthetic camera. timing: Prepare synthetic timing. composition: Prepare synthetic composition.')) {
      throw new Error('post-interview move omitted post plan.steps summary');
    }
    const finalJson = JSON.parse(nextCommand([dir, '--json'], now).stdout) as NextReport;
    if (!finalJson.accepted || finalJson.moves.length !== 0 || finalJson.awaits.length !== 0 || finalJson.refusals.length !== 0) {
      throw new Error(`unexpected next --json at accepted: ${JSON.stringify(finalJson)}`);
    }
    const finalText = nextCommand([dir], now).stdout;
    if (finalText !== 'next: example-current — stage: accepted\nno remaining move (project is accepted)') {
      throw new Error(`unexpected next text at accepted:\n${finalText}`);
    }
  }
  console.log(`offered_writers=${writers} human_writers=${humanWriters} skipped_signoffs=${skippedSignoffs} build_steps=${buildStep} direction_steps=${directionStep}`);
}

if (process.argv[2] === '--replay-current-example') {
  await replay(process.argv[3]!, process.argv[4] === '--skip-signoffs');
} else {
  test('#1057 the current example replays only writers offered by next', () => {
    const root = tempDir();
    const result = run([process.execPath, import.meta.path, '--replay-current-example', join(root, 'replay')], root, gitEnv());
    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('current example: accepted; 0 refusals, 0 warnings');
    expect(result.stdout).toMatch(/offered_writers=[1-9][0-9]* human_writers=10 skipped_signoffs=0 build_steps=6 direction_steps=6/);
    console.log(result.stdout.trimEnd().split('\n').at(-1));
  }, 120_000);

  test('#1062 current path reaches accepted with the 3 post-interview picks only, tells each stage plan once, and prints no missing-signoff move at accepted', () => {
    const root = tempDir();
    const result = run([process.execPath, import.meta.path, '--replay-current-example', join(root, 'replay-nosign'), '--skip-signoffs'], root, gitEnv());
    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('current example: accepted; 0 refusals, 0 warnings');
    expect(result.stdout).toMatch(/offered_writers=58 human_writers=3 skipped_signoffs=7 build_steps=6 direction_steps=6/);
  }, 120_000);

  test('#1062 a mid-walk relay signoff is still accepted, validated and bound, direction step plans are quoted, and accepted ignores lapsed optional signoffs', () => {
    const dir = join(tempDir(), 'current-midwalk-signoff');
    cpSync(join(import.meta.dir, '../templates/example-current'), dir, { recursive: true });
    const recordPath = join(dir, 'project.json');
    const full = JSON.parse(readFileSync(recordPath, 'utf8')) as JsonObject;
    const now = EXAMPLE_ANCHOR + 90_000;

    const stripSignoffs = (record: JsonObject): JsonObject => {
      const copy = structuredClone(record);
      copy.signoffs = [];
      for (const adv of asArray(copy.advances).filter(isObject)) {
        adv.signoff = null;
        adv.signoffs_before = [];
      }
      delete (copy.interview as JsonObject).rigging_context;
      for (const step of asArray((copy.plan as JsonObject).steps).filter(isObject)) {
        step.checkpoint = null;
      }
      return copy;
    };
    for (const [id, name] of [
      ['camera_depth', 'camera_depth.json'],
      ['post_timing', 'post_timing.json'],
      ['post_composition', 'post_composition.json'],
    ] as const) {
      const optionPath = join(dir, 'evidence/interview', name);
      const optionSet = JSON.parse(readFileSync(optionPath, 'utf8')) as JsonObject;
      delete (optionSet.context as JsonObject).signoff_at;
      const bytes = `${JSON.stringify(optionSet, null, 2)}\n`;
      writeFileSync(optionPath, bytes);
      const item = asArray(((full.interview as JsonObject).post as JsonObject).items)
        .filter(isObject).find(entry => entry.id === id)!;
      (((item.guide as JsonObject).choice as JsonObject).set as JsonObject).sha256 =
        new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
    }

    // 1. Mid-walk at rig-review with 0 prior signoffs: optional relay signoff validates, binds current.rig, and clears from next.
    const atRigReview = stripSignoffs(full);
    atRigReview.stage = 'rig-review';
    atRigReview.advances = asArray(atRigReview.advances).slice(0, 6);
    const current = atRigReview.current as JsonObject;
    delete current.motion;
    delete current.direction;
    (atRigReview.plan as JsonObject).steps = asArray((atRigReview.plan as JsonObject).steps).filter(s => isObject(s) && s.phase === 'rig');
    for (const item of asArray(((atRigReview.interview as JsonObject).post as JsonObject).items).filter(isObject)) item.guide = null;
    writeFileSync(recordPath, `${JSON.stringify(atRigReview, null, 2)}\n`);

    const beforeSign = nextProject(dir, now);
    expect(beforeSign.awaits).toEqual(['project.stage']);
    expect(beforeSign.moves.map(move => [move.role, move.field])).toEqual([
      ['agent', 'stage'],
      ['human', 'signoffs'],
    ]);

    const emptyWords = join(dir, 'scratch/empty.txt');
    mkdirSync(join(dir, 'scratch'), { recursive: true });
    writeFileSync(emptyWords, '   \n');
    expect(() => signoffCommand(['rig-review', dir, '--by', 'owner', '--owner-chat', emptyWords,
      '--said-at', new Date(now).toISOString(), '--relayed-by', 'operator'], now))
      .toThrow(expect.objectContaining({ code: 'OWNER_CHAT_INVALID' } satisfies Partial<Refusal>));

    const words = join(dir, 'scratch/rig-words.txt');
    writeFileSync(words, 'The synthetic rig looks good; keep going.\n');
    const saidAt = new Date(now - 500).toISOString();
    expect(signoffCommand(['rig-review', dir, '--by', 'owner', '--owner-chat', words,
      '--said-at', saidAt, '--relayed-by', 'operator'], now).exit).toBe(0);

    const signedProject = JSON.parse(readFileSync(recordPath, 'utf8')) as JsonObject;
    expect(asArray(signedProject.signoffs)).toHaveLength(1);
    expect(asArray(signedProject.signoffs)[0]).toMatchObject({
      stage: 'rig-review',
      by: 'owner',
      source: OWNER_CHAT_SOURCE,
      said_at: saidAt,
      relayed_by: 'operator',
      target: { subject: 'current.rig' },
    });

    const afterSign = nextProject(dir, now + 1000);
    expect(afterSign.moves.map(move => [move.role, move.field])).toEqual([['agent', 'stage']]);
    expect(advanceCommand(['post-interview', dir], now + 2000).exit).toBe(0);
    const advanced = JSON.parse(readFileSync(recordPath, 'utf8')) as JsonObject;
    expect(asArray(advanced.advances).at(-1)).toMatchObject({
      stage: 'post-interview',
      signoff: { stage: 'rig-review', checkpoint: null, at: new Date(now).toISOString() },
    });
    expect(checkProject(dir, undefined, { now: now + 2000, readOnly: true }).refusals.filter(r => r.code !== 'INTERVIEW_INCOMPLETE')).toEqual([]);

    // 2. When a proposed direction step plan exists at post-interview, the plan move quotes plans/direction.md once.
    const atPostInterview = stripSignoffs(full);
    atPostInterview.stage = 'post-interview';
    atPostInterview.advances = asArray(atPostInterview.advances).slice(0, 7);
    delete (atPostInterview.current as JsonObject).motion;
    delete (atPostInterview.current as JsonObject).direction;
    for (const step of asArray((atPostInterview.plan as JsonObject).steps).filter(isObject)) {
      if (step.phase === 'post') {
        step.status = 'pending';
        delete step.status_history;
      }
    }
    writeFileSync(recordPath, `${JSON.stringify(atPostInterview, null, 2)}\n`);
    mkdirSync(join(dir, 'plans'), { recursive: true });
    writeFileSync(join(dir, 'plans/direction.md'), 'Hold a fixed camera on the painted backdrop for one four-second loop.\n');
    expect(stepPlanCommand(['propose', 'direction', dir, '--file', 'plans/direction.md', '--by', 'agent'], now + 3000).exit).toBe(0);
    const postReport = nextProject(dir, now + 4000);
    const postPlans = planMoves(postReport);
    expect(postPlans).toHaveLength(1);
    expect(postPlans[0]).toMatchObject({
      role: 'agent',
      field: 'interview.step_plans',
      command: null,
      act: expect.stringContaining('from plans/direction.md): "Hold a fixed camera on the painted backdrop for one four-second loop."'),
    });

    // 3. At accepted with 0 signoffs or with a reopened historical optional signoff, next offers no missing-signoff move.
    const acceptedZero = stripSignoffs(full);
    writeFileSync(recordPath, `${JSON.stringify(acceptedZero, null, 2)}\n`);
    expect(checkProject(dir, undefined, { now: now + 10_000, readOnly: true })).toMatchObject({ refusals: [], warnings: [] });
    expect(nextProject(dir, now + 10_000)).toMatchObject({
      stage: 'accepted',
      effective_stage: 'accepted',
      accepted: true,
      awaits: [],
      moves: [],
    });
    expect(nextCommand([dir], now + 10_000).stdout).toBe(
      'next: example-current — stage: accepted\nno remaining move (project is accepted)',
    );

    const acceptedUnsigned = stripSignoffs(full);
    const rigSignoff = structuredClone(asArray(full.signoffs).filter(isObject).find(s => s.stage === 'rig-review')!);
    acceptedUnsigned.signoffs = [rigSignoff];
    const reopenAt = new Date(EXAMPLE_ANCHOR + 40_500).toISOString();
    acceptedUnsigned.reopens = [{
      id: 'reopen-rig',
      stage: 'rig-review',
      from_stage: 'rig-review',
      by: 'owner',
      at: reopenAt,
      verbatim: 'Adjust the rig timing.\n',
      source: OWNER_CHAT_SOURCE,
      said_at: reopenAt,
      relayed_by: 'operator',
      steps_before: [],
    }];
    writeFileSync(recordPath, `${JSON.stringify(acceptedUnsigned, null, 2)}\n`);
    expect(checkProject(dir, undefined, { now: now + 10_000, readOnly: true }).refusals).toEqual([]);
    const acceptedNext = nextProject(dir, now + 10_000);
    expect(acceptedNext).toMatchObject({ stage: 'accepted', effective_stage: 'accepted', accepted: true, awaits: [], moves: [] });
    expect(acceptedNext.warnings?.map(w => w.code)).toEqual(['REOPEN_SIGNOFF_LAPSED']);
    const acceptedLines = nextCommand([dir], now + 10_000).stdout.split('\n');
    expect([acceptedLines[0], acceptedLines.at(-1)]).toEqual([
      'next: example-current — stage: accepted',
      'no remaining move (project is accepted)',
    ]);
  });

  test('#1062 an unsigned current project walked to accepted recovers from amendments without signoff stops', () => {
    const root = tempDir();
    const walkRoot = join(root, 'walk');
    const walkResult = run([process.execPath, import.meta.path, '--replay-current-example', walkRoot, '--skip-signoffs'], root, gitEnv());
    expect(walkResult.code, `${walkResult.stdout}\n${walkResult.stderr}`).toBe(0);
    const walkedDir = join(walkRoot, 'example-current');
    const walkedRecord = JSON.parse(readFileSync(join(walkedDir, 'project.json'), 'utf8')) as JsonObject;
    expect(walkedRecord.stage).toBe('accepted');
    expect(asArray(walkedRecord.signoffs)).toEqual([]);

    let t = EXAMPLE_ANCHOR + 5 * 60_000;
    const recordAmend = (dir: string, stage: string) => {
      mkdirSync(join(dir, 'evidence'), { recursive: true });
      mkdirSync(join(dir, 'scratch'), { recursive: true });
      writeFileSync(join(dir, 'evidence/change.json'), `{"amended":"${stage}"}\n`);
      const wordsFile = join(dir, 'scratch/amend-words.txt');
      writeFileSync(wordsFile, `Owner requested adjustment at ${stage}.\n`);
      const saidAt = new Date(t - 500).toISOString();
      expect(amendCommand([
        stage, dir,
        '--kind', 'config-field',
        '--target', 'motion',
        '--change', 'evidence/change.json',
        '--by', 'owner',
        '--owner-chat', wordsFile,
        '--said-at', saidAt,
        '--relayed-by', 'example-agent',
      ], t).exit).toBe(0);
      t += 1000;
    };

    // 1) Amending rig-review resumes at rig-review, offers advance post-interview, and recovers all the way to accepted with 0 signoffs.
    const rigDir = join(root, 'amend-rig-review');
    cpSync(walkedDir, rigDir, { recursive: true });
    recordAmend(rigDir, 'rig-review');

    const rigCheck = checkProject(rigDir, undefined, { now: t, readOnly: true });
    expect(rigCheck.refusals).toEqual([]);
    expect(rigCheck.stage).toBe('accepted');
    expect(rigCheck.effective_stage).toBe('rig-review');

    const rigNext = nextProject(rigDir, t);
    expect(rigNext.effective_stage).toBe('rig-review');
    expect(rigNext.accepted).toBe(false);
    expect(rigNext.awaits).toEqual(['project.stage']);
    expect(rigNext.moves[0]).toMatchObject({
      role: 'agent',
      field: 'stage',
      awaits: 'project.stage',
      command: `rig-create advance post-interview ${rigDir}`,
      act: 'advance stage from rig-review to post-interview',
    });

    expect(advanceCommand(['post-interview', rigDir], t += 1000).exit).toBe(0);
    expect(nextProject(rigDir, t += 1000).moves.some(m => m.command === `rig-create advance post ${rigDir}`)).toBe(true);
    expect(advanceCommand(['post', rigDir], t += 1000).exit).toBe(0);
    expect(checkProject(rigDir, undefined, { now: t, readOnly: true }).effective_stage).toBe('post');

    for (const id of ['camera', 'timing', 'composition']) {
      expect(nextProject(rigDir, t).moves.some(m => m.command === `rig-create step-status ${id} in-progress ${rigDir} --by agent`)).toBe(true);
      expect(stepStatusCommand([id, 'in-progress', rigDir, '--by', 'agent'], t += 1000).exit).toBe(0);
      expect(nextProject(rigDir, t).moves.some(m => m.command === `rig-create step-status ${id} done ${rigDir} --by agent`)).toBe(true);
      expect(stepStatusCommand([id, 'done', rigDir, '--by', 'agent'], t += 1000).exit).toBe(0);
    }

    expect(nextProject(rigDir, t += 1000).moves[0]?.command).toBe(
      `(cd ${rigDir} && rig-parts compose --scene specs/direction/compose-scene.json --out outputs/direction.next)`,
    );
    cpSync(join(rigDir, 'outputs/direction'), join(rigDir, 'outputs/direction.next'), { recursive: true });
    expect(nextProject(rigDir, t += 1000).moves[0]?.command).toBe(
      `rig-create record direction ${rigDir} --from outputs/direction.next --direction specs/direction/direction.json`,
    );
    expect(recordCommand(['direction', rigDir, '--from', 'outputs/direction.next', '--direction', 'specs/direction/direction.json'], t += 1000).exit).toBe(0);

    expect(nextProject(rigDir, t += 1000).moves[0]?.command).toBe(`rig-create advance direction-review ${rigDir}`);
    expect(advanceCommand(['direction-review', rigDir], t += 1000).exit).toBe(0);
    expect(nextProject(rigDir, t += 1000).moves[0]?.command).toBe(`rig-create advance accepted ${rigDir}`);
    expect(advanceCommand(['accepted', rigDir], t += 1000).exit).toBe(0);

    expect(checkProject(rigDir, undefined, { now: t += 1000, readOnly: true })).toMatchObject({
      stage: 'accepted',
      effective_stage: 'accepted',
      refusals: [],
      warnings: [],
    });
    expect(nextProject(rigDir, t)).toMatchObject({
      stage: 'accepted',
      effective_stage: 'accepted',
      accepted: true,
      awaits: [],
      moves: [],
    });
    expect(asArray((JSON.parse(readFileSync(join(rigDir, 'project.json'), 'utf8')) as JsonObject).signoffs)).toEqual([]);

    // 2) Amending post directly at accepted resumes at post (not interview), offers reset step-status + compose/record moves, and advances back to accepted.
    const postDir = join(root, 'amend-post');
    cpSync(walkedDir, postDir, { recursive: true });
    recordAmend(postDir, 'post');

    const postCheck = checkProject(postDir, undefined, { now: t, readOnly: true });
    expect(postCheck.refusals).toEqual([]);
    expect(postCheck.effective_stage).toBe('post');
    const postNext = nextProject(postDir, t);
    expect(postNext.effective_stage).toBe('post');
    expect(postNext.moves.map(m => m.command)).toEqual([
      `(cd ${postDir} && rig-parts compose --scene specs/direction/compose-scene.json --out outputs/direction.next)`,
      `rig-create step-status camera in-progress ${postDir} --by agent`,
      `rig-create step-status timing in-progress ${postDir} --by agent`,
      `rig-create step-status composition in-progress ${postDir} --by agent`,
    ]);
    for (const id of ['camera', 'timing', 'composition']) {
      expect(stepStatusCommand([id, 'in-progress', postDir, '--by', 'agent'], t += 1000).exit).toBe(0);
      expect(stepStatusCommand([id, 'done', postDir, '--by', 'agent'], t += 1000).exit).toBe(0);
    }
    cpSync(join(postDir, 'outputs/direction'), join(postDir, 'outputs/direction.next'), { recursive: true });
    expect(recordCommand(['direction', postDir, '--from', 'outputs/direction.next', '--direction', 'specs/direction/direction.json'], t += 1000).exit).toBe(0);
    expect(nextProject(postDir, t += 1000).moves[0]?.command).toBe(`rig-create advance direction-review ${postDir}`);
    expect(advanceCommand(['direction-review', postDir], t += 1000).exit).toBe(0);
    expect(advanceCommand(['accepted', postDir], t += 1000).exit).toBe(0);
    expect(nextProject(postDir, t += 1000)).toMatchObject({
      stage: 'accepted',
      effective_stage: 'accepted',
      accepted: true,
      awaits: [],
      moves: [],
    });
  }, 120_000);
}
