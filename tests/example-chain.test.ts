import { expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { applyChainSeed, checkExampleChain, validateChainSteps, type ChainStep } from '../scripts/generate-example-chain.ts';
import { readTemplate, type JsonObject } from '../src/templates.ts';
import { sha256 } from '../src/choices.ts';
import { stepHash } from '../src/step-hash.ts';
import { STAGE_PROGRESS_SINCE } from '../src/stage-progress.ts';
import { checkProject, testClock } from './clock.ts';
import { clockedCli } from './helpers.ts';

const hash = 'a'.repeat(64);
function receipt(): ChainStep[] {
  return [
    { kind: 'seed', step: 'declare plan', command: [], exit: 0, output_sha256: hash, consumes: [], bindings: {},
      seed: { field: 'plan.steps', value: [], citation: 'docs/PROJECT.md:450', first_consumer: 1,
        first_consumer_command: ['rig-create', 'signoff', 'plan-approved'] } },
    { kind: 'writer', step: 'approve plan', command: ['rig-create', 'signoff', 'plan-approved'], exit: 0,
      output_sha256: hash, consumes: ['declare plan'], bindings: { 'plan.steps': hash } },
  ];
}

test('a declared seed precedes its own binding consumer', () => {
  expect(() => validateChainSteps(receipt())).not.toThrow();
  const steps = receipt();
  steps.reverse();
  expect(() => validateChainSteps(steps)).toThrow('seed must precede its declared first consumer');
});

test('the real generator seed path rejects a mislabelled apply before changing the source record', () => {
  const project = readTemplate('project.json');
  const original = structuredClone(project);
  expect(() => applyChainSeed(project, 'inputs[]', [], candidate => {
    candidate.inputs = [];
    (candidate.signoffs as JsonObject[]).push({ stage: 'interview', by: 'user' });
  })).toThrow('seed changes a path outside its declared field');
  expect(project).toEqual(original);
  expect(() => applyChainSeed(project, 'inputs[]', [], candidate => {
    candidate.inputs = ['different inventory'];
  })).toThrow('written subtree differs from declared value');
  (project.plan as JsonObject).steps = [{ id: 'assemble', status: 'pending' }];
  const renamed = { id: 'camera', status: 'pending' };
  expect(() => applyChainSeed(project, 'plan.steps[camera]', renamed, candidate => {
    (candidate.plan as JsonObject).steps = [renamed];
  })).toThrow('seed changes a path outside its declared field');
});

test('status seeds on the real generator path reject backward and unsupported progress', () => {
  const project = readTemplate('project.json');
  (project.plan as JsonObject).steps = [{ id: 'assemble', status: 'done' }];
  const setStatus = (value: string): void => {
    applyChainSeed(project, 'plan.steps[assemble].status', value, candidate => {
      ((candidate.plan as JsonObject).steps as JsonObject[])[0]!.status = value;
    });
  };
  expect(() => setStatus('pending')).toThrow('status must move forward to a supported value');
  expect(() => setStatus('invented-status')).toThrow('status must move forward to a supported value');
});

test('the real generator seed path preserves the fields a plan signature bound', () => {
  const project = readTemplate('project.json');
  const step: JsonObject = { id: 'assemble', status: 'pending', bar: 'original bar', checkpoint: null };
  (project.plan as JsonObject).steps = [step];
  project.signoffs = [{ stage: 'plan-approved', step_hashes: { assemble: stepHash(step) } }];
  const changed = { ...step, bar: 'changed bar' };
  expect(() => applyChainSeed(project, 'plan.steps[assemble]', changed, candidate => {
    (candidate.plan as JsonObject).steps = [changed];
  })).toThrow('seed changes a signed plan');
  expect(() => applyChainSeed(project, 'plan.steps', [], candidate => {
    (candidate.plan as JsonObject).steps = [];
  })).toThrow('seed changes a signed plan');
  const progressed = applyChainSeed(project, 'plan.steps[assemble].status', 'done', candidate => {
    ((candidate.plan as JsonObject).steps as JsonObject[])[0]!.status = 'done';
  });
  expect(stepHash(((progressed.plan as JsonObject).steps as JsonObject[])[0]!)).toBe(stepHash(step));
});

test('a seed declares its actual consuming command and that command must run after it', () => {
  const steps = receipt();
  steps[0]!.seed!.first_consumer_command = ['rig-create', 'review-package'];
  expect(() => validateChainSteps(steps)).toThrow('seed must precede its declared first consumer');
});

test('a seed cannot change an already-bound field or byte', () => {
  const steps = receipt();
  steps.unshift({ kind: 'writer', step: 'earlier binding', command: ['rig-create'], exit: 0,
    output_sha256: hash, consumes: [], bindings: { 'plan.steps[assemble].bar': hash } });
  steps[1]!.seed!.first_consumer = 2;
  expect(() => validateChainSteps(steps)).toThrow('seed changes an already-bound field or byte');
  const inputs = receipt();
  inputs[0]!.seed!.field = 'inputs[]';
  inputs[0]!.seed!.value = [{ path: 'inputs/painting.png', sha256: hash, bytes: 8, origin: 'synthetic' }];
  inputs.unshift({ kind: 'writer', step: 'bind source', command: ['rig-create'], exit: 0,
    output_sha256: hash, consumes: [], bindings: { 'inputs[]': hash } });
  inputs[1]!.seed!.first_consumer = 2;
  expect(() => validateChainSteps(inputs)).toThrow('seed changes an already-bound field or byte');
});

test('a seed cannot set a binding record, including one nested in an allowed declaration', () => {
  const steps = receipt();
  steps[0]!.seed!.field = 'signoffs';
  expect(() => validateChainSteps(steps)).toThrow('seeded binding field');
  steps[0]!.seed!.field = 'versions[]';
  steps[0]!.seed!.value = { n: 1, review_package: { files: [] } };
  expect(() => validateChainSteps(steps)).toThrow('seeded binding field');
});

test('stage seeds are refused by the mutation path and receipt validator', () => {
  const project = readTemplate('project.json');
  expect(() => applyChainSeed(project, 'project.stage', 'parts', candidate => { candidate.stage = 'parts'; })).toThrow('unsupported seed kind');
  const steps = receipt();
  steps[0]!.seed!.field = 'project.stage';
  steps[0]!.seed!.value = 'parts';
  expect(() => validateChainSteps(steps)).toThrow('unsupported seed kind');
});

test('the ordinary check rejects an invalid seeded value', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chain-invalid-'));
  try {
    const project = readTemplate('project.json');
    project.stage = 'invented-stage';
    writeFileSync(join(dir, 'project.json'), `${JSON.stringify(project)}\n`);
    expect(() => checkExampleChain(dir, testClock.now())).toThrow('STAGE_UNKNOWN');
  } finally { rmSync(dir, { recursive: true }); }
});

const shipped = join(import.meta.dir, '../templates/example-chain');
function readProject(): JsonObject {
  return JSON.parse(readFileSync(join(shipped, 'project.json'), 'utf8')) as JsonObject;
}

test('the finished chain binds its own approved parts, package model and signed direction', () => {
  const checked = checkExampleChain(shipped, testClock.now());
  expect(checked.refusals).toEqual([]);
  expect(checked.warnings).toEqual([]);
  const project = readProject();
  const versions = project.versions as JsonObject[];
  const rig = versions[0]!;
  const post = versions[1]!;
  const pkg = rig.review_package as JsonObject;
  const files = pkg.files as JsonObject[];
  const direction = JSON.parse(readFileSync(join(shipped, 'evidence/direction/v2.json'), 'utf8')) as JsonObject;
  const model = (direction.rig as JsonObject).model as JsonObject;
  expect(model.path).toBe('derived/review/v1/out/check/build/skeleton.model.json');
  expect(model.sha256).toBe(files.find(file => file.path === 'out/check/build/skeleton.model.json')!.sha256);
  expect(model.sha256).toBe(sha256(readFileSync(join(shipped, String(model.path)))));
  expect(post.rig_version).toBe(rig.n);
  const verdict = JSON.parse(readFileSync(join(shipped, 'evidence/parts-review.json'), 'utf8')) as {
    source: { files: { path: string; sha256: string }[] };
  };
  expect(verdict.source.files).toHaveLength(7);
  for (const source of verdict.source.files) {
    const suffix = source.path.split('/input/')[1]!;
    const packaged = files.find(file => file.path === `out/${suffix}`)!;
    expect(packaged.sha256).toBe(source.sha256);
    expect(readFileSync(join(shipped, 'derived/review/v1', String(packaged.path))))
      .toEqual(readFileSync(join(shipped, 'evidence', source.path)));
  }
  const receipt = JSON.parse(readFileSync(join(shipped, 'chain.json'), 'utf8')) as { steps: ChainStep[]; stack_equals_painting: boolean };
  validateChainSteps(receipt.steps);
  expect(receipt.stack_equals_painting).toBe(true);
  expect(receipt.steps.filter(step => step.kind === 'writer')).toHaveLength(55);
  expect(receipt.steps.some(step => step.command.slice(0, 4).join(' ') === 'rig-create input add inputs/painting.png')).toBe(true);
  expect(receipt.steps.some(step => step.command.slice(0, 4).join(' ') === 'rig-create input add inputs/background.png')).toBe(true);
  expect(receipt.steps.some(step => step.seed?.field === 'inputs[]')).toBe(false);
  expect(receipt.steps.some(step => step.seed?.field.startsWith('scenes'))).toBe(false);
  const sceneWrite = receipt.steps.findIndex(step => step.command.slice(0, 3).join(' ') === 'rig-create scene write');
  expect(sceneWrite).toBeGreaterThan(receipt.steps.findIndex(step => step.command.slice(0, 4).join(' ') === 'rig-create input add inputs/background.png'));
  expect(sceneWrite).toBeLessThan(receipt.steps.findIndex(step => step.command.slice(0, 3).join(' ') === 'rig-create direction write'));
  expect(direction.schema).toBe('rig-create/direction@2');
  expect(direction.scene).toEqual({ n: 1, path: 'evidence/scene/s1.json', sha256: (project.scenes as JsonObject[])[0]!.sha256 });
  const moves = project.advances as JsonObject[];
  const stages = ['plan-approved', 'parts', 'parts-review', 'rigging-interview', 'rigging', 'rig-review', 'post-interview', 'post', 'direction-review', 'accepted'];
  expect(moves.map(move => move.stage)).toEqual(stages);
  expect(receipt.steps.filter(step => step.command[1] === 'advance').map(step => step.command)).toEqual(
    stages.map(stage => ['rig-create', 'advance', stage, '--by', 'user', '--verbatim-file', 'evidence/approval.txt',
      ...(stage === 'parts-review' ? ['--parts-check', 'evidence/parts-check.json', '--parts', 'derived/drafts/chain/input'] : [])]));
  const partsCheck = receipt.steps.find(step => step.step === 'parts-stage check report')!;
  expect(partsCheck.kind).toBe('producer');
  expect(partsCheck.output_sha256).toBe(sha256(readFileSync(join(shipped, 'evidence/parts-check.json'))));
  expect(moves.find(move => move.stage === 'parts-review')!.parts_check).toMatchObject({ path: 'evidence/parts-check.json', parts: 'derived/drafts/chain/input', exit_code: 0 });
  expect(receipt.steps.some(step => step.seed?.field === 'project.stage')).toBe(false);
  expect(receipt.steps.every(step => step.exit === 0)).toBe(true);
  expect(receipt.steps.some(step => step.command.join(' ') === 'rig-create direction check 2 --json')).toBe(true);
  const split = receipt.steps.find(step => step.seed?.field === 'split.parts')!;
  expect(receipt.steps[split.seed!.first_consumer]!.command[1]).toBe('split-captions');
  const partsVerdict = receipt.steps.find(step => step.step === 'synthetic review-tool parts verdict (tests/parts-package.ts)')!;
  expect(partsVerdict.kind).toBe('producer');
  expect(partsVerdict.output_sha256).toBe(sha256(readFileSync(join(shipped, 'evidence/parts-review.json'))));
  const rigReview = receipt.steps.findIndex(step => step.command[1] === 'signoff' && step.command[2] === 'rig-review');
  for (const id of ['camera', 'timing', 'composition']) {
    const index = receipt.steps.findIndex(step => step.seed?.field === `plan.steps[${id}]`);
    expect(index).toBeGreaterThan(rigReview);
    expect(index).toBeLessThan(receipt.steps[index]!.seed!.first_consumer);
    expect(receipt.steps[index]!.seed!.first_consumer_command).toEqual(['rig-create', 'interview-options', 'camera_depth']);
  }
  for (const name of ['rig-review', 'direction-review']) {
    const signoff = (project.signoffs as JsonObject[]).find(s => s.stage === name)!;
    expect(signoff.target).toBeDefined();
  }
});

test.each([
  ['out/parts.json', 'REVIEW_PACKAGE_PARTS_MISMATCH'],
  ['out/parts/torso.png', 'REVIEW_PACKAGE_PART_FILE_MISMATCH'],
])('the chain actually exercises the identity guard for %s', (path, code) => {
  const candidate = readProject();
  const pkg = (candidate.versions as JsonObject[])[0]!.review_package as JsonObject;
  const file = (pkg.files as JsonObject[]).find(file => file.path === path)!;
  // Alter the candidate identity only. Never rewrite or rebind retained files.
  file.sha256 = 'f'.repeat(64);
  expect(checkProject(shipped, candidate).refusals.map(finding => finding.code)).toContain(code);
});

test('two fresh generator runs reproduce every shipped byte', () => {
  const root = mkdtempSync(join(tmpdir(), 'chain-reproduce-'));
  const inventory = (dir: string, prefix = ''): Record<string, string> => {
    const result: Record<string, string> = {};
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) Object.assign(result, inventory(join(dir, entry.name), name));
      else result[name] = sha256(readFileSync(join(dir, entry.name)));
    }
    return result;
  };
  try {
    const script = join(import.meta.dir, '../scripts/generate-example-chain.ts');
    for (const name of ['first', 'second']) {
      const command = Bun.spawnSync([process.execPath, script, join(root, name), '--check'], { stdout: 'pipe', stderr: 'pipe', timeout: 30_000 });
      expect(command.stderr.toString()).toBe('');
      expect(command.exitCode).toBe(0);
      expect(command.stdout.toString()).toContain('example chain reproduces byte for byte');
    }
    expect(inventory(join(root, 'first/project'))).toEqual(inventory(join(root, 'second/project')));
    expect(inventory(join(root, 'first/project'))).toEqual(inventory(shipped));
  } finally { rmSync(root, { recursive: true }); }
}, 60_000);

interface CheckpointDeclaration {
  schema: string;
  stage: number;
  name: string;
  chain_step: number;
  pending: { act: string; commands: string[]; command_roles: string[]; awaits: string[] };
  expected_findings: { refusals: { code: string; path: string }[]; warnings: unknown[] };
  project_sha256: string;
  files: { path: string; sha256: string }[];
}

function fileInventory(dir: string, prefix = ''): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(result, fileInventory(join(dir, entry.name), path));
    else result[path] = sha256(readFileSync(join(dir, entry.name)));
  }
  return result;
}

test.each([
  ['1-parts-verdict', 1, 30, 'parts', 0],
  ['2-rigging-answers', 2, 38, 'rigging-interview', 4],
  ['3-rig-review', 3, 60, 'rig-review', 0],
  ['4-direction-post', 4, 81, 'post', 0],
] as const)('checkpoint %s preserves its complete prefix and pending state', (name, stage, index, projectStage, count) => {
  const root = join(shipped, 'checkpoints', name);
  const declaration = JSON.parse(readFileSync(`${root}.json`, 'utf8')) as CheckpointDeclaration;
  const chain = JSON.parse(readFileSync(join(shipped, 'chain.json'), 'utf8')) as {
    checkpoints: { stage: number; name: string; chain_step: number }[];
    steps: ChainStep[];
  };
  expect(declaration.schema).toBe('rig-create/example-checkpoint@1');
  expect(declaration.stage).toBe(stage);
  expect(declaration.chain_step).toBe(index);
  expect(chain.checkpoints).toContainEqual({ stage, name, chain_step: index });
  expect(declaration.project_sha256).toBe(sha256(readFileSync(join(root, 'project.json'))));
  expect(fileInventory(root)).toEqual(Object.fromEntries(declaration.files.map(file => [file.path, file.sha256])));
  expect(declaration.files.every(file => !file.path.startsWith('checkpoints/') && file.path !== 'chain.json')).toBe(true);
  const report = checkProject(root);
  expect(report.stage).toBe(projectStage);
  expect(report.refusals).toHaveLength(count);
  expect(report.warnings).toEqual([]);
  expect(declaration.expected_findings).toEqual({ refusals: report.refusals, warnings: report.warnings });
  expect(declaration.pending.commands[0].split(' --sha256 ')[0]).toBe(chain.steps[index]!.command.join(' ').split(' --sha256 ')[0]!);
  expect(declaration.pending.command_roles).toHaveLength(declaration.pending.commands.length);
  const project = JSON.parse(readFileSync(join(root, 'project.json'), 'utf8')) as JsonObject;
  const signoffs = project.signoffs as JsonObject[];
  const awaited = ['parts-review', 'rigging-interview', 'rig-review', 'direction-review'][stage - 1];
  expect(signoffs.some(signoff => signoff.stage === awaited)).toBe(false);
  if (stage === 1) {
    expect(declaration.files.some(file => file.path === 'evidence/parts-review.json')).toBe(false);
    expect(declaration.files.some(file => file.path === 'evidence/structure.json')).toBe(false);
    expect(declaration.pending.command_roles).toEqual(['producer', 'agent', 'producer', 'human', 'human']);
  }
  if (stage === 2) {
    expect(report.refusals.map(finding => [finding.code, finding.path])).toEqual(
      ['bones', 'meshes', 'constraints', 'motion'].map(id => ['INTERVIEW_INCOMPLETE', `interview.waypoints[${id}].guide`]));
    expect(declaration.pending.command_roles).toEqual(['human', 'agent', 'agent', 'human', 'agent', 'agent', 'human', 'agent', 'agent', 'human', 'human']);
  }
  if (stage === 3) expect((project.versions as JsonObject[])[0]!.verdicts).toEqual([]);
  if (stage === 1 || stage === 4) {
    expect(declaration.pending.awaits).toContain('project.stage');
    expect(declaration.pending.commands).toContain(`rig-create advance ${stage === 1 ? 'parts-review' : 'direction-review'} --by user --verbatim-file evidence/approval.txt${stage === 1 ? ' --parts-check evidence/parts-check.json --parts derived/drafts/chain/input' : ''}`);
  }
  if (stage === 4) {
    expect((project.versions as JsonObject[]).some(version => version.kind === 'post')).toBe(false);
    expect(declaration.files.some(file => file.path === 'evidence/direction-input.json')).toBe(false);
    expect(project.scenes).toBeUndefined();
    expect(declaration.files.some(file => file.path === 'inputs/background.png')).toBe(false);
    expect(declaration.pending.commands[0]).toBe('copy parts-producer background part inputs/background.png');
    expect(declaration.pending.commands).toContain('agent draft evidence/direction-input.json');
    expect(declaration.pending.command_roles).toEqual(['producer', 'human', 'agent', 'human', 'agent', 'human', 'agent', 'human', 'human', 'human']);
  }
});

test('the labelled draft, package and production model retain a producer-made mesh on unchanged parts', () => {
  for (const path of ['derived/drafts/chain/out/mesh_report.json', 'derived/review/v1/out/rig/mesh_report.json', 'outputs/v1/out/rig/mesh_report.json']) {
    const report = JSON.parse(readFileSync(join(shipped, path), 'utf8')) as { part: string; vertices: number; triangles: number }[];
    expect(report).toContainEqual(expect.objectContaining({ part: 'torso' }));
    expect(report.find(part => part.part === 'torso')!.vertices).toBeGreaterThan(0);
    expect(report.find(part => part.part === 'torso')!.triangles).toBeGreaterThan(0);
  }
  for (const path of ['derived/drafts/chain/out/check/build/skeleton.model.json', 'derived/review/v1/out/check/build/skeleton.model.json', 'outputs/v1/out/check/build/skeleton.model.json']) {
    const model = JSON.parse(readFileSync(join(shipped, path), 'utf8')) as { skins: { attachments: Record<string, Record<string, { kind: string; triangles: number[] }>> }[] };
    const attachments = model.skins.flatMap(skin => Object.values(skin.attachments).flatMap(slot => Object.entries(slot)));
    const torso = attachments.find(([name]) => name === 'torso')![1];
    expect(torso.kind).toBe('mesh');
    expect(torso.triangles.length).toBeGreaterThan(0);
  }
});


test('agent-authored inputs are declared at their true position before public writer consumption', () => {
  const chain = JSON.parse(readFileSync(join(shipped, 'chain.json'), 'utf8')) as { steps: ChainStep[] };
  const inputs: [string, string[]][] = [
    ['evidence/approval.txt', ['rig-create', 'signoff', 'interview']],
    ['inputs/painting.png', ['rig-create', 'interview-options', 'rig_type']],
    ['evidence/split-config.json', ['rig-create', 'split-captions']],
    ['evidence/setup.png', ['rig-create', 'review-package', '1']],
    ['evidence/v1/config.json', ['rig-create', 'review-package', '1']],
    ['inputs/background.png', ['rig-create', 'input', 'add', 'inputs/background.png']],
    ['evidence/scene-citations.json', ['rig-create', 'scene', 'write']],
    ['evidence/direction-input.json', ['rig-create', 'direction', 'write']],
  ];
  for (const id of ['rig_type', 'reference', 'seethrough', 'assemble', 'bones', 'meshes', 'constraints', 'motion', 'camera_depth', 'post_timing', 'post_composition']) {
    const path = `evidence/interview/${id}.json`;
    inputs.push([path, ['rig-create', 'interview-options', id]]);
    const draft = chain.steps.find(step => step.step === `agent-drafted option set ${id}`)!;
    expect(draft.kind).toBe('producer');
    expect(draft.authored_by).toBe('agent');
    expect(draft.command).toEqual(['agent', 'draft', path]);
    expect(draft.output_path).toBe(path);
  }
  for (const [name, consumer] of [
    ['retain labelled draft inputs and outputs', ['rig-create', 'draft-rig']],
    ['retain production inputs, outputs and setup evidence', ['rig-create', 'review-package', '1']],
  ] as const) {
    const copy = chain.steps.find(step => step.step === name)!;
    for (const path of Object.keys(copy.outputs!)) inputs.push([path, [...consumer]]);
  }
  for (const [path, consumer] of inputs) {
    const producer = chain.steps.findIndex(step => step.outputs?.[path] !== undefined);
    const writer = chain.steps.findIndex(step => consumer.every((arg, index) => step.command[index] === arg));
    expect(producer).toBeGreaterThanOrEqual(0);
    expect(producer).toBeLessThan(writer);
    expect(chain.steps[producer]!.outputs![path]).toBe(sha256(readFileSync(join(shipped, path))));
  }
});

test('pending rigging answers use available drafted files and run-time hashes', () => {
  const declaration = JSON.parse(readFileSync(join(shipped, 'checkpoints/2-rigging-answers.json'), 'utf8')) as CheckpointDeclaration;
  const available = new Set(declaration.files.map(file => file.path));
  for (const command of declaration.pending.commands) {
    if (command.startsWith('agent draft ')) available.add(command.slice('agent draft '.length));
    if (command.startsWith('rig-create interview-options ')) expect(available.has(command.split(' --file ')[1]!)).toBe(true);
    if (command.startsWith('rig-create interview-answer ')) {
      const path = command.split(' --set ')[1]!.split(' ')[0]!;
      expect(available.has(path)).toBe(true);
      expect(command).toContain(`--sha256 <sha256 of ${path}>`);
      expect(command).not.toMatch(/--sha256 [a-f0-9]{64}/);
    }
  }
});

test.each(['1-parts-verdict', '2-rigging-answers', '3-rig-review', '4-direction-post'])('%s pending writers succeed at the real clock with retained producer inputs', name => {
  const dir = mkdtempSync(join(tmpdir(), 'chain-pending-'));
  const declaration = JSON.parse(readFileSync(join(shipped, 'checkpoints', `${name}.json`), 'utf8')) as CheckpointDeclaration;
  const chain = JSON.parse(readFileSync(join(shipped, 'chain.json'), 'utf8')) as { steps: ChainStep[] };
  const acts = chain.steps.slice(declaration.chain_step, declaration.chain_step + declaration.pending.commands.length);
  try {
    cpSync(join(shipped, 'checkpoints', name), dir, { recursive: true });
    for (const step of acts) {
      if (step.kind === 'producer') {
        for (const [path, hash] of Object.entries(step.outputs!)) {
          const bytes = readFileSync(join(shipped, path));
          expect(sha256(bytes)).toBe(hash);
          mkdirSync(dirname(join(dir, path)), { recursive: true });
          writeFileSync(join(dir, path), bytes);
        }
        continue;
      }
      expect(step.kind).toBe('writer');
      const args = step.command.slice(1);
      const hashIndex = args.indexOf('--sha256');
      if (hashIndex >= 0) args[hashIndex + 1] = sha256(readFileSync(join(dir, args[args.indexOf('--set') + 1]!)));
      const result = Bun.spawnSync([process.execPath, ...clockedCli(), ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
      expect(result.stderr.toString()).toBe('');
      expect(result.exitCode).toBe(0);
    }
    const report = checkProject(dir);
    const current = testClock.now() >= Date.parse(STAGE_PROGRESS_SINCE);
    expect(report.refusals.map(f => f.code)).toEqual(current ? ['STAGE_LAGGING'] : []);
    expect(report.warnings.map(f => f.code)).toEqual(current ? [] : ['STAGE_LAGGING']);
  } finally { rmSync(dir, { recursive: true }); }
}, 30_000);

test('the parts-review structure snapshot is written by structure-snapshot after the verdict, not authored by hand', () => {
  const chain = JSON.parse(readFileSync(join(shipped, 'chain.json'), 'utf8')) as { steps: ChainStep[] };
  const path = 'evidence/structure.json';
  const at = (command: string[]): number => chain.steps.findIndex(step => command.every((arg, index) => step.command[index] === arg));
  const writer = at(['rig-create', 'structure-snapshot']);
  expect(chain.steps[writer]!.kind).toBe('writer');
  expect(chain.steps[writer]!.output_path).toBe(path);
  expect(chain.steps[writer]!.output_sha256).toBe(sha256(readFileSync(join(shipped, path))));
  expect(chain.steps.some(step => step.outputs?.[path] !== undefined)).toBe(false);
  expect(at(['partsPackage'])).toBeLessThan(writer);
  expect(writer).toBeLessThan(at(['rig-create', 'signoff', 'parts-review']));
  const config = JSON.parse(readFileSync(join(shipped, 'derived/drafts/chain/config.json'), 'utf8')) as { meshes: Record<string, unknown> };
  const snapshot = JSON.parse(readFileSync(join(shipped, path), 'utf8')) as { entries: { path: string; value: unknown }[] };
  expect(snapshot.entries).toEqual(Object.entries(config.meshes).map(([part, value]) => ({ path: `/meshes/${part}`, value })));
});
