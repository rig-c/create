import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyChainSeed, checkExampleChain, validateChainSteps, type ChainStep } from '../scripts/generate-example-chain.ts';
import { readTemplate, type JsonObject } from '../src/templates.ts';
import { checkProject } from '../src/check.ts';
import { sha256 } from '../src/choices.ts';
import { stepHash } from '../src/step-hash.ts';

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
  expect(() => applyChainSeed(project, 'project.stage', 'parts', candidate => {
    candidate.stage = 'parts';
    (candidate.signoffs as JsonObject[]).push({ stage: 'interview', by: 'user' });
  })).toThrow('seed changes a path outside its declared field');
  expect(project).toEqual(original);
  expect(() => applyChainSeed(project, 'project.stage', 'parts', candidate => {
    candidate.stage = 'rigging';
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

test('the ordinary check rejects an invalid seeded value', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chain-invalid-'));
  try {
    const project = readTemplate('project.json');
    project.stage = 'invented-stage';
    writeFileSync(join(dir, 'project.json'), `${JSON.stringify(project)}\n`);
    expect(() => checkExampleChain(dir)).toThrow('STAGE_UNKNOWN');
  } finally { rmSync(dir, { recursive: true }); }
});

const shipped = join(import.meta.dir, '../templates/example-chain');
function readProject(): JsonObject {
  return JSON.parse(readFileSync(join(shipped, 'project.json'), 'utf8')) as JsonObject;
}

test('the finished chain binds its own approved parts, package model and signed direction', () => {
  const checked = checkExampleChain(shipped);
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
  expect(receipt.steps.filter(step => step.kind === 'writer')).toHaveLength(41);
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
  ['1-parts-verdict', 1, 22, 'parts', 0],
  ['2-rigging-answers', 2, 28, 'rigging-interview', 4],
  ['3-rig-review', 3, 46, 'rig-review', 0],
  ['4-direction-post', 4, 64, 'post', 0],
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
  expect(declaration.pending.commands[0]).toBe(chain.steps[index]!.command.join(' '));
  expect(declaration.pending.command_roles).toHaveLength(declaration.pending.commands.length);
  const project = JSON.parse(readFileSync(join(root, 'project.json'), 'utf8')) as JsonObject;
  const signoffs = project.signoffs as JsonObject[];
  const awaited = ['parts-review', 'rigging-interview', 'rig-review', 'direction-review'][stage - 1];
  expect(signoffs.some(signoff => signoff.stage === awaited)).toBe(false);
  if (stage === 1) {
    expect(declaration.files.some(file => file.path === 'evidence/parts-review.json')).toBe(false);
    expect(declaration.pending.command_roles).toEqual(['producer', 'producer', 'human']);
  }
  if (stage === 2) {
    expect(report.refusals.map(finding => [finding.code, finding.path])).toEqual(
      ['bones', 'meshes', 'constraints', 'motion'].map(id => ['INTERVIEW_INCOMPLETE', `interview.waypoints[${id}].guide`]));
    expect(declaration.pending.command_roles).toEqual(['human', 'agent', 'human', 'agent', 'human', 'agent', 'human', 'human']);
  }
  if (stage === 3) expect((project.versions as JsonObject[])[0]!.verdicts).toEqual([]);
  if (stage === 4) expect((project.versions as JsonObject[]).some(version => version.kind === 'post')).toBe(false);
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
