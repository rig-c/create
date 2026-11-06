import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkExampleChain, validateChainSteps, type ChainStep } from '../scripts/generate-example-chain.ts';
import { readTemplate, type JsonObject } from '../src/templates.ts';
import { checkProject } from '../src/check.ts';
import { sha256 } from '../src/choices.ts';

const hash = 'a'.repeat(64);
function receipt(): ChainStep[] {
  return [
    { kind: 'seed', step: 'declare plan', command: [], exit: 0, output_sha256: hash, consumes: [], bindings: {},
      seed: { field: 'plan.steps', value: [], citation: 'docs/PROJECT.md:450', first_consumer: 1 } },
    { kind: 'writer', step: 'approve plan', command: ['rig-create', 'signoff', 'plan-approved'], exit: 0,
      output_sha256: hash, consumes: ['declare plan'], bindings: { 'plan.steps': hash } },
  ];
}

test('a declared seed precedes its own binding consumer', () => {
  expect(() => validateChainSteps(receipt())).not.toThrow();
  const steps = receipt();
  steps.reverse();
  expect(() => validateChainSteps(steps)).toThrow('seed must precede its first consumer');
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
  expect(receipt.steps.filter(step => step.kind === 'writer')).toHaveLength(40);
  expect(receipt.steps.every(step => step.exit === 0)).toBe(true);
  expect(receipt.steps.some(step => step.command.join(' ') === 'rig-create direction check 2 --json')).toBe(true);
  const split = receipt.steps.find(step => step.seed?.field === 'split.parts')!;
  expect(receipt.steps[split.seed!.first_consumer]!.command[1]).toBe('split-captions');
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
