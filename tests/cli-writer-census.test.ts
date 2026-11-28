import { expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { JOB_COMMENT_ONLY_ACT_SCHEMA, type JobOwnerHost } from '@rig-c/review/job-host';
import { OPTIONS_SPEC, optionContext, sha256 } from '../src/choices.ts';
import { CLI_COMMAND_NAMES, JOB_SUBCOMMANDS, main } from '../src/cli.ts';
import { commentCommand } from '../src/comment-act.ts';
import { freshProjectRecord, GITIGNORE } from '../src/init.ts';
import { closeCreateJob, withdrawCreateJobAct } from '../src/job-close.ts';
import { JOB_BINDING_FILE, jobHash, writePrivateJson } from '../src/job-outbox.ts';
import { currentJobIdentity } from '../src/job-publication.ts';
import { jobRuntimeExecArgv } from '../src/job-writer.ts';
import { runningCreateVersion } from '../src/pins.ts';
import { BASELINE_PATHS } from '../src/project-step-commit.ts';
import type { JsonObject } from '../src/templates.ts';
import { TEST_NOW } from './clock.ts';
import { checkpointWorkspace } from './checkpoint-evidence-fixture.ts';
import { fixture } from './fixtures.ts';
import { gitEnv, run, stagedCreateRegistry, tempDir } from './helpers.ts';

const CLOCKED_CLI = join(import.meta.dir, 'cli-at.ts');

type Repo = { dir: string; env: Record<string, string>; repoRoot?: string };

function git(repo: Repo, ...args: string[]): string {
  const cwd = repo.repoRoot ?? repo.dir;
  const r = run(['git', '--literal-pathspecs', ...args], cwd, repo.env);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed (${r.code}): ${r.stderr}`);
  return r.stdout;
}

function sharedBytes(dir: string): Record<string, string | null> {
  return Object.fromEntries(
    BASELINE_PATHS.map(name => {
      const p = join(dir, name);
      return [name, existsSync(p) ? readFileSync(p, 'utf8') : null];
    }),
  );
}

function assertCleanSharedPaths(repo: Repo, label: string, requireSharedChange: boolean, before?: Record<string, string | null>): void {
  if (requireSharedChange && before) {
    const after = sharedBytes(repo.dir);
    const changed = BASELINE_PATHS.filter(name => before[name] !== after[name]);
    expect(changed.length, `${label} must mutate at least one shared path (${BASELINE_PATHS.join(', ')})`).toBeGreaterThan(0);
  }
  const relPrefix = repo.repoRoot ? `${repo.dir.slice(repo.repoRoot.length + 1)}/` : '';
  const targets = BASELINE_PATHS.map(name => `${relPrefix}${name}`);
  const status = git(repo, 'status', '--porcelain', '--', ...targets);
  expect(status, `${label} left a dirty shared tree:\n${status}`).toBe('');
}

let clockTick = TEST_NOW;
function nextIso(): string {
  clockTick += 1_000;
  return new Date(clockTick).toISOString();
}

function runCli(repo: Repo, ...args: string[]): void {
  const r = run([process.execPath, ...jobRuntimeExecArgv(), CLOCKED_CLI, nextIso(), ...args], repo.dir, repo.env);
  expect({ cmd: args.slice(0, 2).join(' '), code: r.code, stderr: r.code === 0 ? '' : r.stderr })
    .toEqual({ cmd: args.slice(0, 2).join(' '), code: 0, stderr: '' });
}

test('#1168 census: every CLI command in COMMANDS and JOB_SUBCOMMANDS is accounted for and every shared-file writer ends with a clean tree', async () => {
  const env = gitEnv({ name: 'Census Runner', email: 'census@example.test' });

  // Non-project-record or read-only commands in COMMANDS / JOB_SUBCOMMANDS:
  // - Read-only inspectors: intake, interview, next, history, handoff, job acts
  // - Auxiliary file / collection writers that do not mutate project.json/package.json/bun.lock:
  //   checkpoint-table, structure-snapshot, scene, split-captions, collection, job reconcile
  // - Initializers tested explicitly for clean initial commit: init
  const NON_SHARED_MUTATION_COMMANDS = new Set([
    'intake',
    'interview',
    'next',
    'history',
    'handoff',
    'checkpoint-table',
    'structure-snapshot',
    'scene',
    'split-captions',
    'collection',
    'init',
    'job acts',
    'job reconcile',
  ]);

  const SHARED_WRITER_COMMANDS = new Set([
    'packages',
    'input',
    'owner-language',
    'intake-report',
    'interview-options',
    'interview-answer',
    'interview-decision',
    'record',
    'collection-binding',
    'signoff',
    'comment',
    'diff-classes',
    'plan',
    'checkpoint-evidence',
    'pause',
    'resume',
    'advance',
    'step-status',
    'amend',
    'ledger',
    'restart',
    'correction',
    'direction',
    'derived',
    'job open',
    'job withdraw-act',
    'job close',
  ]);

  const allTableEntries = [
    ...CLI_COMMAND_NAMES,
    ...JOB_SUBCOMMANDS.map(sub => `job ${sub}`),
  ].sort();
  const classifiedEntries = [
    ...NON_SHARED_MUTATION_COMMANDS,
    ...SHARED_WRITER_COMMANDS,
  ].sort();

  // Fails immediately if a new CLI command or job subcommand is added without census coverage.
  expect(allTableEntries).toEqual(classifiedEntries);

  const exercisedSharedWriters = new Set<string>();
  const exercise = (commandKey: string, repo: Repo, fn: () => void | Promise<void>) => async () => {
    const before = sharedBytes(repo.dir);
    await fn();
    assertCleanSharedPaths(repo, commandKey, true, before);
    exercisedSharedWriters.add(commandKey);
  };

  // 0. Verify `init` itself leaves a clean shared tree, and read-only commands keep shared paths clean.
  const initDir = join(tempDir(), 'census-init');
  const initRes = run([process.execPath, ...jobRuntimeExecArgv(), CLOCKED_CLI, nextIso(), 'init', initDir, '--no-install'], tempDir(), env);
  expect(initRes.code).toBe(0);
  const initRepo: Repo = { dir: initDir, env };
  git(initRepo, 'config', '--local', 'user.name', 'Census Runner');
  git(initRepo, 'config', '--local', 'user.email', 'census@example.test');
  assertCleanSharedPaths(initRepo, 'init', false);
  for (const ro of [['intake', initDir], ['next', initDir], ['history', initDir]] as const) {
    runCli(initRepo, ...ro);
    assertCleanSharedPaths(initRepo, ro[0], false);
  }

  // 1. Exercise input, owner-language, plan (propose/feedback/add/revise/remove/replace/bar-amend/checkpoint-withdraw), interview-decision, interview-options, interview-answer on initRepo
  writeFileSync(join(initDir, 'inputs/painting.png'), readFileSync(join(import.meta.dir, '../templates/example-current/inputs/painting.png')));
  await exercise('input', initRepo, () => {
    runCli(initRepo, 'input', 'add', 'inputs/painting.png', initDir, '--origin', 'census source');
    runCli(initRepo, 'input', 'painting', 'inputs/painting.png', initDir);
  })();

  await exercise('owner-language', initRepo, () => {
    runCli(initRepo, 'owner-language', 'set', 'en', initDir);
  })();

  mkdirSync(join(initDir, 'plans'), { recursive: true });
  mkdirSync(join(initDir, 'scratch'), { recursive: true });
  writeFileSync(join(initDir, 'plans/parts.md'), 'Build a standing idle character. Use core projection.\n');
  writeFileSync(join(initDir, 'scratch/fb.txt'), 'Keep outlines crisp.\n');
  writeFileSync(join(initDir, 'scratch/reason.txt'), 'Follow plan.\n');
  writeFileSync(join(initDir, 'scratch/val.json'), '"character.idle"\n');
  writeFileSync(join(initDir, 'scratch/quote.txt'), 'Build a standing idle character.');
  writeFileSync(join(initDir, 'scratch/assemble.json'), '{"project":"core"}\n');
  writeFileSync(join(initDir, 'scratch/assemble-quote.txt'), 'Use core projection.');

  const saidAt = new Date(TEST_NOW).toISOString();
  runCli(initRepo, 'plan', 'propose', 'parts', initDir, '--file', 'plans/parts.md', '--by', 'agent');
  assertCleanSharedPaths(initRepo, 'plan propose', true);

  await exercise('interview-decision', initRepo, () => {
    runCli(initRepo, 'interview-decision', 'rig_type', initDir, '--by', 'agent', '--reasoning-file', 'scratch/reason.txt', '--value-file', 'scratch/val.json', '--plan-quote-file', 'scratch/quote.txt');
    runCli(initRepo, 'interview-decision', 'assemble', initDir, '--by', 'agent', '--reasoning-file', 'scratch/reason.txt', '--value-file', 'scratch/assemble.json', '--plan-quote-file', 'scratch/assemble-quote.txt');
  })();

  await exercise('plan', initRepo, () => {
    runCli(initRepo, 'plan', 'feedback', 'parts', initDir, '--words-file', 'scratch/fb.txt', '--by', 'owner', '--said-at', saidAt, '--relayed-by', 'agent');
    runCli(initRepo, 'plan', 'add', 'assemble', initDir, '--by', 'agent', '--phase', 'rig', '--order', '1', '--does', 'Assemble parts.', '--produces', 'Parts output.', '--rests-on', 'assemble', '--bar', 'Parts check exits with <= 0 refusals.', '--checkpoint-proposed', 'false');
    runCli(initRepo, 'plan', 'revise', 'assemble', initDir, '--by', 'agent', '--does', 'Assemble parts cleanly.');
    runCli(initRepo, 'plan', 'replace', 'assemble', initDir, '--by', 'agent', '--phase', 'rig', '--order', '1', '--does', 'Assemble parts v2.', '--produces', 'Parts output.', '--rests-on', 'assemble', '--bar', 'Parts check exits with <= 0 refusals.', '--checkpoint-proposed', 'false');
    writeFileSync(join(initDir, 'scratch/bar-words.txt'), 'Keep parts check refusals = 0.\n');
    writeFileSync(join(initDir, 'scratch/bar-text.txt'), 'Parts check exits with refusals = 0.');
    runCli(initRepo, 'plan', 'bar-amend', 'assemble', initDir, '--by', 'operator', '--reason-file', 'scratch/reason.txt', '--quote-file', 'scratch/bar-words.txt', '--bar-file', 'scratch/bar-text.txt');
    runCli(initRepo, 'plan', 'add', 'seethrough', initDir, '--by', 'agent', '--phase', 'rig', '--order', '2', '--does', 'Temp.', '--produces', 'Temp.', '--rests-on', 'seethrough', '--bar', 'Parts check exits with <= 0 refusals.', '--checkpoint-proposed', 'false');
    runCli(initRepo, 'plan', 'remove', 'seethrough', initDir, '--by', 'agent');
  })();

  const projNow = JSON.parse(readFileSync(join(initDir, 'project.json'), 'utf8')) as JsonObject;
  const optSet = {
    schema: OPTIONS_SPEC,
    id: 'census-rig-type',
    question: 'rig_type',
    stage: 'interview',
    drafted_by: 'agent',
    drafted_at: new Date(clockTick + 500).toISOString(),
    context: optionContext(projNow, 'interview', clockTick + 500, initDir),
    assembly: { rule: 'single' },
    asks: [{
      id: 'rig_type',
      prompt: 'Choose rig type.',
      options: [
        { id: 'idle', kind: 'value', label: 'Idle', effect: 'Standing idle.', fragment: 'character.idle', recommended: true, reason: 'Default.' },
        { id: 'bust', kind: 'value', label: 'Bust', effect: 'Bust idle.', fragment: 'character.bust', recommended: false },
        { id: 'other', kind: 'other', label: 'Other', effect: 'Other.', recommended: false },
        { id: 'auto', kind: 'auto', label: 'Auto', effect: 'Auto.', recommended: false },
      ],
    }],
  };
  mkdirSync(join(initDir, 'evidence/interview'), { recursive: true });
  const optBytes = `${JSON.stringify(optSet, null, 2)}\n`;
  writeFileSync(join(initDir, 'evidence/interview/rig_type.json'), optBytes);

  await exercise('interview-options', initRepo, () => {
    runCli(initRepo, 'interview-options', 'rig_type', initDir, '--file', 'evidence/interview/rig_type.json');
  })();

  writeFileSync(join(initDir, 'scratch/pick.txt'), 'Choose character.idle.\n');
  await exercise('interview-answer', initRepo, () => {
    runCli(initRepo, 'interview-answer', 'rig_type', initDir, '--set', 'evidence/interview/rig_type.json', '--sha256', sha256(Buffer.from(optBytes)), '--pick', 'rig_type=idle', '--by', 'owner', '--owner-chat', 'scratch/pick.txt', '--said-at', new Date(clockTick).toISOString(), '--relayed-by', 'agent');
  })();

  // 2. packages upgrade
  const pkgDir = fixture(() => {}, 'example-current/project.json');
  const registry = stagedCreateRegistry();
  const pkgRepo: Repo = { dir: pkgDir, env: runningCreateVersion() === '2.0.0' ? { ...env, ...registry } : { ...env, ...registry } };
  const pkgManifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as JsonObject;
  (pkgManifest.dependencies as JsonObject)['@rig-c/create'] = '2.0.0';
  delete (pkgManifest.dependencies as JsonObject)['@rig-c/review'];
  writeFileSync(join(pkgDir, 'package.json'), `${JSON.stringify(pkgManifest, null, 2)}\n`);
  expect(run([process.execPath, 'install', '--ignore-scripts'], pkgDir, pkgRepo.env).code).toBe(0);
  git(pkgRepo, 'init', '-q');
  git(pkgRepo, 'config', '--local', 'user.name', 'Census Runner');
  git(pkgRepo, 'config', '--local', 'user.email', 'census@example.test');
  git(pkgRepo, 'add', '--', '.');
  git(pkgRepo, 'commit', '-qm', 'Seed legacy package pin');
  await exercise('packages', pkgRepo, () => {
    runCli(pkgRepo, 'packages', 'upgrade', pkgDir, '--by', 'census-operator');
  })();

  // 3. signoff, pause, resume, step-status, advance, direction, record, comment, correction, ledger, amend, derived, intake-report, diff-classes, restart
  const numDir = fixture(p => {
    const stamp = new Date(TEST_NOW).toISOString();
    for (const raw of (p.inputs as JsonObject[])) raw.at = stamp;
  }, 'example-numbered/example-project.json');
  const numRepo: Repo = { dir: numDir, env };
  writeFileSync(join(numDir, '.gitignore'), GITIGNORE);
  git(numRepo, 'init', '-q');
  git(numRepo, 'config', '--local', 'user.name', 'Census Runner');
  git(numRepo, 'config', '--local', 'user.email', 'census@example.test');
  git(numRepo, 'add', '--', '.');
  git(numRepo, 'commit', '-qm', 'Seed numbered repo');

  mkdirSync(join(numDir, 'scratch'), { recursive: true });
  writeFileSync(join(numDir, 'scratch/words.txt'), 'Owner words for census.\n');

  await exercise('amend', numRepo, () => {
    writeFileSync(join(numDir, 'inputs/census-amend.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>\n');
    runCli(numRepo, 'amend', 'parts', numDir, '--kind', 'part', '--target', 'panel', '--change', 'inputs/census-amend.svg', '--by', 'owner', '--verbatim-file', 'scratch/words.txt');
  })();

  await exercise('derived', numRepo, () => {
    writeFileSync(join(numDir, 'evidence/census-prep.png'), 'prepared bytes');
    runCli(numRepo, 'derived', 'add', numDir, '--source', 'inputs/painting.png', '--file', 'evidence/census-prep.png', '--operation', 'crop');
  })();

  await exercise('restart', numRepo, () => {
    runCli(numRepo, 'restart', numDir, '--by', 'owner', '--owner-chat', 'scratch/words.txt', '--said-at', new Date(TEST_NOW).toISOString(), '--relayed-by', 'agent');
  })();

  // intake-report & diff-classes
  const partsStageDir = fixture(p => {
    p.stage = 'parts';
    delete p.diff_map;
  }, 'example-numbered/example-project.json');
  const partsStageRepo: Repo = { dir: partsStageDir, env };
  writeFileSync(join(partsStageDir, '.gitignore'), GITIGNORE);
  git(partsStageRepo, 'init', '-q');
  git(partsStageRepo, 'config', '--local', 'user.name', 'Census Runner');
  git(partsStageRepo, 'config', '--local', 'user.email', 'census@example.test');
  git(partsStageRepo, 'add', '--', '.');
  git(partsStageRepo, 'commit', '-qm', 'Seed parts-stage repo');

  await exercise('intake-report', partsStageRepo, () => {
    const preflight = readFileSync(join(import.meta.dir, 'fixtures/intake/preflight.json'));
    writeFileSync(join(partsStageDir, 'evidence/census-intake.json'), preflight);
    runCli(partsStageRepo, 'intake-report', partsStageDir, '--id', 'c1', '--report', 'evidence/census-intake.json', '--sha256', sha256(preflight), '--parts-version', '2.16.0', '--by', 'agent');
  })();

  await exercise('diff-classes', partsStageRepo, () => {
    const repRel = 'evidence/census-diff.json';
    cpSync(join(import.meta.dir, '../templates/example-numbered/evidence/diff-components.json'), join(partsStageDir, repRel));
    const classesOut = run([process.execPath, ...jobRuntimeExecArgv(), CLOCKED_CLI, nextIso(), 'diff-classes', partsStageDir, '--diff-report', repRel], partsStageDir, env).stdout;
    const classes = JSON.parse(classesOut) as { id: string; key: { coverage_band: string; border_parts: string[] } }[];
    const triage = Object.fromEntries(classes.map(c => [c.id, { status: 'in-painting', why: `Measured ${c.key.coverage_band} border ${c.key.border_parts[0] ?? 'edge'}.` }]));
    mkdirSync(join(partsStageDir, 'scratch'), { recursive: true });
    writeFileSync(join(partsStageDir, 'scratch/triage.json'), `${JSON.stringify({ classes: triage })}\n`);
    runCli(partsStageRepo, 'diff-classes', partsStageDir, '--diff-report', repRel, '--triage-file', 'scratch/triage.json', '--by', 'agent');
  })();

  // checkpoint-evidence
  const cw = checkpointWorkspace();
  const cpRepo: Repo = { dir: cw.root, env };
  writeFileSync(join(cw.root, '.gitignore'), GITIGNORE);
  git(cpRepo, 'init', '-q');
  git(cpRepo, 'config', '--local', 'user.name', 'Census Runner');
  git(cpRepo, 'config', '--local', 'user.email', 'census@example.test');
  git(cpRepo, 'add', '--', '.');
  git(cpRepo, 'commit', '-qm', 'Seed checkpoint workspace');
  await exercise('checkpoint-evidence', cpRepo, () => {
    mkdirSync(join(cw.root, 'scratch'), { recursive: true });
    writeFileSync(join(cw.root, 'scratch/packets.json'), `${JSON.stringify([cw.packet], null, 2)}\n`);
    runCli(cpRepo, 'checkpoint-evidence', cw.root, '--file', 'scratch/packets.json');
  })();

  // signoff, pause, resume, step-status, advance, direction, record, correction, ledger, comment
  const curDir = realpathSync(fixture(p => {
    p.stage = 'parts';
    p.signoffs = (p.signoffs as JsonObject[]).filter(s => ['interview', 'plan-approved'].includes(String(s.stage)));
    p.advances = (p.advances as JsonObject[]).slice(0, 2);
    delete (p.current as JsonObject).rig;
    delete (p.current as JsonObject).motion;
    delete (p.current as JsonObject).direction;
    delete p.scenes;
    delete p.directions;
    delete p.direction_contract;
    delete (p.interview as JsonObject).rigging_context;
    for (const item of (((p.interview as JsonObject).post as JsonObject).items as JsonObject[])) item.guide = null;
    for (const wp of ((p.interview as JsonObject).waypoints as JsonObject[])) {
      if (['turn', 'meshes'].includes(String(wp.id))) wp.guide = null;
    }
    (p.interview as JsonObject).step_plans = ((p.interview as JsonObject).step_plans as JsonObject[]).filter(plan => plan.step === 'parts');
    (p.plan as JsonObject).steps = ((p.plan as JsonObject).steps as JsonObject[]).filter(step => ['seethrough', 'assemble'].includes(String(step.id)));
    for (const step of ((p.plan as JsonObject).steps as JsonObject[])) {
      step.status = 'pending';
      step.status_history = [];
    }
  }, 'example-current/project.json'));
  const curRepo: Repo = { dir: curDir, env };
  git(curRepo, 'init', '-q');
  git(curRepo, 'config', '--local', 'user.name', 'Census Runner');
  git(curRepo, 'config', '--local', 'user.email', 'census@example.test');
  git(curRepo, 'add', '--', '.');
  git(curRepo, 'commit', '-qm', 'Seed current census repo');
  mkdirSync(join(curDir, 'scratch'), { recursive: true });
  writeFileSync(join(curDir, 'scratch/words.txt'), 'Owner words.\n');

  await exercise('signoff', curRepo, () => {
    runCli(curRepo, 'signoff', 'paused', curDir, '--by', 'owner', '--verbatim-file', 'scratch/words.txt');
  })();
  await exercise('pause', curRepo, () => {
    runCli(curRepo, 'pause', curDir, '--by', 'owner', '--verbatim-file', 'scratch/words.txt');
  })();
  await exercise('resume', curRepo, () => {
    runCli(curRepo, 'resume', 'parts', curDir, '--by', 'owner', '--verbatim-file', 'scratch/words.txt');
  })();
  await exercise('step-status', curRepo, () => {
    for (const id of ['seethrough', 'assemble']) {
      runCli(curRepo, 'step-status', id, 'in-progress', curDir, '--by', 'agent');
      runCli(curRepo, 'step-status', id, 'done', curDir, '--by', 'agent');
    }
  })();
  await exercise('advance', curRepo, () => {
    runCli(curRepo, 'advance', 'parts-review', curDir, '--parts-check', 'evidence/parts-check.json', '--parts', 'outputs/parts/rig');
  })();
  await exercise('direction', curRepo, () => {
    runCli(curRepo, 'direction', '--adopt', curDir);
  })();

  // comment (--from-review & --close), record, correction, and ledger on a full current fixture
  const fullCurDir = realpathSync(fixture(p => {
    p.stage = 'direction-review';
    p.signoffs = (p.signoffs as JsonObject[]).filter(s => String(s.stage) !== 'direction-review');
    p.advances = (p.advances as JsonObject[]).filter(a => String(a.stage) !== 'accepted');
    delete p.corrections_contract;
  }, 'example-current/project.json'));
  const fullCurRepo: Repo = { dir: fullCurDir, env };
  git(fullCurRepo, 'init', '-q');
  git(fullCurRepo, 'config', '--local', 'user.name', 'Census Runner');
  git(fullCurRepo, 'config', '--local', 'user.email', 'census@example.test');
  git(fullCurRepo, 'add', '--', '.');
  git(fullCurRepo, 'commit', '-qm', 'Seed full current repo');
  mkdirSync(join(fullCurDir, 'scratch'), { recursive: true });

  await exercise('record', fullCurRepo, () => {
    cpSync(join(fullCurDir, 'outputs/direction'), join(fullCurDir, 'outputs/direction.next'), { recursive: true });
    runCli(fullCurRepo, 'record', 'direction', fullCurDir, '--from', 'outputs/direction.next', '--direction', 'specs/direction/direction.json');
  })();

  writeFileSync(join(fullCurDir, 'scratch/corr.txt'), 'Adjust camera settle at seam.\n');
  await exercise('correction', fullCurRepo, () => {
    runCli(fullCurRepo, 'correction', '--adopt', fullCurDir);
    runCli(fullCurRepo, 'correction', 'record', fullCurDir, '--id', 'c-dir-1', '--path', 'described', '--stage', 'direction-review', '--by', 'owner', '--verbatim-file', 'scratch/corr.txt');
  })();
  await exercise('ledger', fullCurRepo, () => {
    runCli(fullCurRepo, 'ledger', 'add', 'L1', fullCurDir, '--by', 'agent', '--check', 'seam', '--bar', 'delta <= 8', '--note', 'corrections[c-dir-1]', '--verbatim-file', 'scratch/corr.txt');
    runCli(fullCurRepo, 'ledger', 'retire', 'L1', fullCurDir, '--by', 'owner', '--reason-file', 'scratch/corr.txt');
  })();

  // comment ingest & close
  const jobId = 'census-job-1';
  const origin = 'http://127.0.0.1:43211';
  const identity = currentJobIdentity({
    root: fullCurDir,
    stateDir: join(tempDir(), 'census-state'),
    fingerprint: 'census-fp',
    reviewer: { id: 'owner', role: 'owner' },
  }, fullCurDir);
  const fullProj = JSON.parse(readFileSync(join(fullCurDir, 'project.json'), 'utf8')) as JsonObject;
  fullProj.review_job = { jobId, origin };
  writeFileSync(join(fullCurDir, 'project.json'), `${JSON.stringify(fullProj, null, 2)}\n`);
  git(fullCurRepo, 'add', '--', 'project.json');
  git(fullCurRepo, 'commit', '-qm', 'Bind census job');
  writePrivateJson(join(fullCurDir, JOB_BINDING_FILE), {
    schema: 'rig-create/job-binding@1',
    identity,
    jobId,
    origin,
    fetchCapability: 'cap-fetch',
    listenerIncarnation: 'inc-1',
  }, true);
  const headCommit = git(fullCurRepo, 'rev-parse', 'HEAD').trim();
  const recordHash = jobHash(readFileSync(join(fullCurDir, 'project.json')));
  const modelPath = 'specs/rig/config.json';
  const initialConfigSha = sha256(readFileSync(join(fullCurDir, modelPath)));
  const commentActBytes = JSON.stringify({
    schema: JOB_COMMENT_ONLY_ACT_SCHEMA,
    jobId,
    actId: 'act-comment-1',
    publicationId: 'pub-1',
    at: new Date(clockTick).toISOString(),
    authority: { actor: 'human', channel: 'review-ui', reviewer: { id: 'owner', role: 'owner' } },
    kind: 'comments',
    source: {
      sourceHash: '1'.repeat(64),
      projectHash: recordHash,
      package: { id: 'pkg', revision: '1' },
      selector: null,
      model: { path: modelPath, sha256: initialConfigSha },
      direction: null,
      optionSet: null,
      appliedResult: null,
      plan: null,
      parts: null,
      commit: headCommit,
    },
    value: { comments: [{ text: 'Check loop transition.' }] },
  });
  await exercise('comment', fullCurRepo, () => {
    commentCommand(['--from-review', 'act-comment-1', fullCurDir], ++clockTick, {
      fetch: () => ({ bytes: commentActBytes }),
    });
    writeFileSync(join(fullCurDir, modelPath), `${readFileSync(join(fullCurDir, modelPath), 'utf8').trimEnd()}\n\n`);
    const afterSha = sha256(readFileSync(join(fullCurDir, modelPath)));
    expect(main(['comment', '--close', '0', fullCurDir, '--act-sha256', jobHash(commentActBytes), '--after', `${modelPath}=${afterSha}`, '--reason', 'Addressed', '--by', 'agent'], ++clockTick)).toBe(0);
  })();

  // 4. collection-binding
  const colRoot = join(tempDir(), 'census-col');
  expect(run([process.execPath, ...jobRuntimeExecArgv(), CLOCKED_CLI, nextIso(), 'init', '--collection', colRoot, '--no-install'], tempDir(), env).code).toBe(0);
  const colRepo: Repo = { dir: colRoot, env };
  git(colRepo, 'config', '--local', 'user.name', 'Census Runner');
  git(colRepo, 'config', '--local', 'user.email', 'census@example.test');
  const memberDir = join(colRoot, 'members/alpha');
  cpSync(join(import.meta.dir, '../templates/example-current'), memberDir, { recursive: true });
  const mRec = JSON.parse(readFileSync(join(memberDir, 'project.json'), 'utf8')) as JsonObject;
  mRec.name = 'alpha';
  delete mRec.collection;
  writeFileSync(join(memberDir, 'project.json'), `${JSON.stringify(mRec, null, 2)}\n`);
  const cRec = JSON.parse(readFileSync(join(colRoot, 'collection.json'), 'utf8')) as JsonObject;
  cRec.members = [{ name: 'alpha', project: 'members/alpha/project.json', input: null, note: null }];
  writeFileSync(join(colRoot, 'collection.json'), `${JSON.stringify(cRec, null, 2)}\n`);
  git(colRepo, 'add', '--', '.');
  git(colRepo, 'commit', '-qm', 'Seed member');
  const memberRepo: Repo = { dir: memberDir, env, repoRoot: colRoot };
  await exercise('collection-binding', memberRepo, () => {
    runCli(memberRepo, 'collection-binding', memberDir);
  })();

  // 5. job open, job withdraw-act, job close
  const jobOpenDir = realpathSync(fixture(() => {}, 'example-current/project.json'));
  const jobOpenRepo: Repo = { dir: jobOpenDir, env };
  git(jobOpenRepo, 'init', '-q');
  git(jobOpenRepo, 'config', '--local', 'user.name', 'Census Runner');
  git(jobOpenRepo, 'config', '--local', 'user.email', 'census@example.test');
  git(jobOpenRepo, 'add', '--', '.');
  git(jobOpenRepo, 'commit', '-qm', 'Seed job open repo');

  await exercise('job open', jobOpenRepo, async () => {
    const child = Bun.spawn(
      [process.execPath, ...jobRuntimeExecArgv(), CLOCKED_CLI, nextIso(), 'job', 'open', jobOpenDir, '--reviewer', 'owner', '--role', 'owner', '--current', 'parts'],
      { cwd: jobOpenDir, env, stdout: 'pipe', stderr: 'pipe' },
    );
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let out = '';
    try {
      while (!out.includes('published (publication ')) {
        const chunk = await reader.read();
        if (chunk.done) break;
        out += decoder.decode(chunk.value, { stream: true });
      }
    } finally {
      reader.releaseLock();
      child.kill('SIGTERM');
      await child.exited;
    }
    expect(out).toContain('published (publication ');
  })();

  const bindMockJob = (id: string, actId: string) => {
    const mockId = currentJobIdentity({
      root: jobOpenDir,
      stateDir: join(tempDir(), `state-${id}`),
      fingerprint: 'census-fp-2',
      reviewer: { id: 'owner', role: 'owner' },
    }, jobOpenDir);
    const p = JSON.parse(readFileSync(join(jobOpenDir, 'project.json'), 'utf8')) as JsonObject;
    p.review_job = { jobId: id, origin };
    writeFileSync(join(jobOpenDir, 'project.json'), `${JSON.stringify(p, null, 2)}\n`);
    git(jobOpenRepo, 'add', '--', 'project.json');
    git(jobOpenRepo, 'commit', '-qm', `Bind ${id}`);
    writePrivateJson(join(jobOpenDir, JOB_BINDING_FILE), {
      schema: 'rig-create/job-binding@1',
      identity: mockId,
      jobId: id,
      origin,
      fetchCapability: 'cap-fetch',
      listenerIncarnation: `inc-${id}`,
    }, true);
    const act = {
      schema: JOB_COMMENT_ONLY_ACT_SCHEMA,
      jobId: id,
      actId,
      publicationId: 'pub-1',
      at: new Date(TEST_NOW).toISOString(),
      authority: { actor: 'human', channel: 'review-ui', reviewer: { id: 'owner', role: 'owner' } },
      kind: 'comments',
      source: {
        sourceHash: 'a'.repeat(64),
        projectHash: 'b'.repeat(64),
        selector: { kind: 'current', output: 'parts' },
        manifest: { path: 'review-live.json', sha256: 'c'.repeat(64) },
      },
      value: { comments: [{ id: 'c1', text: 'Pending comment.' }] },
    };
    return async () => ({
      reused: true,
      origin,
      stop: () => {},
      session: {
        jobId: id,
        authorize: () => {},
        status: () => ({ generation: 1 }),
        hostCredentials: () => ({ agent: 'cap-agent', owner: 'cap-owner' }),
      },
      ports: {
        handleJobApi: async (req: Request) => {
          const body = await req.json() as { verb: string; after?: unknown };
          if (body.verb === 'next') {
            return Response.json({
              ok: true,
              value: body.after ? { status: 'timeout', cursor: 'end', events: [] } : { status: 'events', cursor: 'end', events: [{ type: 'act', act }] },
            });
          }
          return Response.json({ ok: true, value: { closed: true } });
        },
      },
    } as unknown as JobOwnerHost);
  };

  mkdirSync(join(jobOpenDir, 'scratch'), { recursive: true });
  writeFileSync(join(jobOpenDir, 'scratch/w.txt'), 'Withdraw comment.\n');
  const hostW = bindMockJob('census-w', 'act-cw');
  await exercise('job withdraw-act', jobOpenRepo, async () => {
    await withdrawCreateJobAct(jobOpenDir, 'act-cw', {
      '--by': 'owner',
      '--owner-chat': join(jobOpenDir, 'scratch/w.txt'),
      '--said-at': new Date(TEST_NOW).toISOString(),
      '--relayed-by': 'agent',
    }, ++clockTick, hostW);
  })();

  const hostC = bindMockJob('census-c', 'act-cc');
  await exercise('job close', jobOpenRepo, async () => {
    await closeCreateJob(jobOpenDir, hostC, false, { '--discard-acts': 'Superseded', '--by': 'agent' }, ++clockTick);
  })();

  // Every single shared-file writer in the CLI command table was exercised and verified clean!
  expect([...exercisedSharedWriters].sort()).toEqual([...SHARED_WRITER_COMMANDS].sort());
}, 120_000);
