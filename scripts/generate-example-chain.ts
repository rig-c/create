/** Frozen numbered chain fixture checker and retained seed/receipt validators. */
import { deepStrictEqual } from 'node:assert';
import { cpSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { asArray, checkProject, isObject } from '../src/check.ts';
import { sha256 } from '../src/choices.ts';
import { stepHash } from '../src/step-hash.ts';
import type { Json, JsonObject } from '../src/templates.ts';
import { fileHashes, observe, readerResults, repinNumberedCopy } from './check-example-numbered.ts';
import { generatorArgs } from './generator-args.ts';

const fixture = join(import.meta.dir, '../templates/example-chain');
const baseline = join(import.meta.dir, 'example-chain-baseline.json');

export interface ChainStep {
  kind: 'seed' | 'writer' | 'producer';
  authored_by?: 'agent';
  step: string;
  command: string[];
  exit: number;
  output_sha256: string;
  output_path?: string;
  outputs?: Record<string, string>;
  consumes: string[];
  bindings: Record<string, string>;
  seed?: {
    field: string;
    value: Json;
    citation: string;
    first_consumer: number;
    first_consumer_command: string[];
  };
}

const seedField = /^(plan\.steps(?:\[[a-z_-]+\](?:\.status)?)?|split\.parts|versions\[\]|inputs\[\])$/;
const bindingFields = new Set(['signoffs', 'step_hashes', 'answer_hashes', 'review_package', 'direction', 'diff_map', 'accepted_parts', 'structure', 'choice']);

function containsBinding(value: Json): boolean {
  if (Array.isArray(value)) return value.some(containsBinding);
  if (value === null || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => bindingFields.has(key)
    || (key === 'verdicts' && (!Array.isArray(child) || child.length > 0))
    || (key === 'checkpoint' && child !== null)
    || containsBinding(child));
}

function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`)
    || a.startsWith(`${b}[`) || b.startsWith(`${a}[`);
}

function child(value: Json | undefined, key: string): Json | undefined {
  if (Array.isArray(value)) return value[Number(key)];
  return isObject(value) ? value[key] : undefined;
}

function changedPaths(before: Json | undefined, after: Json | undefined, path: string[] = []): string[][] {
  if (isDeepStrictEqual(before, after)) return [];
  if (Array.isArray(before) && Array.isArray(after) || isObject(before) && isObject(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    return [...keys].flatMap(key => changedPaths(child(before, key), child(after, key), [...path, key]));
  }
  return [path];
}

/** Retain the seed mutation validator used to verify chain.json seed declarations. */
export function applyChainSeed(project: JsonObject, field: string, value: Json, apply: (candidate: JsonObject) => void): JsonObject {
  if (!seedField.test(field) || containsBinding(value)) throw new Error(`${field}: seeded binding field or unsupported seed kind`);
  const next = structuredClone(project);
  apply(next);
  let target: string[];
  if (field === 'versions[]') {
    if (!isObject(value) || value.kind !== 'rig' || asArray(next.versions).length !== asArray(project.versions).length + 1) {
      throw new Error('versions[]: expected one new rig declaration');
    }
    target = ['versions', String(asArray(project.versions).length)];
  } else if (field.startsWith('plan.steps[')) {
    const match = /^plan\.steps\[([a-z_-]+)\](\.status)?$/.exec(field)!;
    const steps = asArray((next.plan as JsonObject).steps);
    const index = steps.findIndex(step => isObject(step) && step.id === match[1]);
    if (index < 0) throw new Error(`${field}: step missing`);
    const previous = asArray((project.plan as JsonObject).steps);
    const previousIndex = previous.findIndex(step => isObject(step) && step.id === match[1]);
    const expectedIndex = previousIndex < 0 ? previous.length : previousIndex;
    if (index !== expectedIndex) throw new Error(`${field}: seed changes a path outside its declared field`);
    target = ['plan', 'steps', String(index), ...(match[2] ? ['status'] : [])];
  } else {
    target = field.replace(/^project\./, '').replace(/\[\]$/, '').split('.');
  }
  const changes = changedPaths(project, next);
  if (changes.some(path => !target.every((part, index) => path[index] === part))) {
    throw new Error(`${field}: seed changes a path outside its declared field`);
  }
  const actual = target.reduce<Json | undefined>((current, key) => child(current, key), next);
  if (!isDeepStrictEqual(actual, value)) throw new Error(`${field}: written subtree differs from declared value`);
  const statuses = ['pending', 'in-progress', 'at-checkpoint', 'done'];
  for (const step of asArray((project.plan as JsonObject).steps).filter(isObject)) {
    const updated = asArray((next.plan as JsonObject).steps).filter(isObject).find(candidate => candidate.id === step.id);
    const signed = asArray(project.signoffs).filter(isObject).some(s => isObject(s.step_hashes) && String(step.id) in s.step_hashes);
    if (signed && (!updated || stepHash(updated) !== stepHash(step))) throw new Error(`${field}: seed changes a signed plan`);
    if (!updated) continue;
    const from = statuses.indexOf(String(step.status ?? 'pending'));
    const to = statuses.indexOf(String(updated.status ?? 'pending'));
    if (to < 0 || to < from) throw new Error(`${String(step.id)}: status must move forward to a supported value`);
  }
  return next;
}

function matchesCommand(command: string[], declared: string[]): boolean {
  return declared.length > 1 && declared.every((part, index) => command[index] === part);
}

/** Validate the execution order recorded in chain.json. Indices are zero-based. */
export function validateChainSteps(steps: ChainStep[]): void {
  const bound = new Map<string, string>();
  for (const [index, step] of steps.entries()) {
    if (step.exit !== 0) throw new Error(`${step.step}: command exit ${step.exit}`);
    if (!/^[a-f0-9]{64}$/.test(step.output_sha256)) throw new Error(`${step.step}: missing output hash`);
    if (step.kind === 'seed') {
      const seed = step.seed;
      if (!seed || !seedField.test(seed.field) || containsBinding(seed.value)) {
        throw new Error(`${step.step}: seeded binding field or unsupported seed kind`);
      }
      if (seed.field === 'versions[]' && (!isObject(seed.value) || seed.value.kind !== 'rig')) {
        throw new Error(`${step.step}: only a rig version declaration may be seeded`);
      }
      if (!seed.citation.startsWith('docs/PROJECT.md:')) throw new Error(`${step.step}: missing seed citation`);
      const consumer = steps.findIndex((candidate, position) => position > index && candidate.kind === 'writer'
        && matchesCommand(candidate.command, seed.first_consumer_command));
      if (consumer <= index || seed.first_consumer !== consumer || !steps[consumer]!.consumes.includes(step.step)) {
        throw new Error(`${step.step}: seed must precede its declared first consumer`);
      }
      if ([...bound.keys()].some(field => overlaps(field, seed.field))) {
        throw new Error(`${step.step}: seed changes an already-bound field or byte`);
      }
    } else if (step.seed !== undefined) throw new Error(`${step.step}: seed must be declared as kind seed`);
    for (const [field, hash] of Object.entries(step.bindings)) bound.set(field, hash);
  }
}

/** The finished record, including seeded declarations, passes the ordinary project checker at `now`. */
export function checkExampleChain(dir: string, now: number): ReturnType<typeof checkProject> {
  const report = checkProject(dir, undefined, { now });
  if (report.refusals.length) throw new Error(JSON.stringify(report.refusals));
  const project = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
  for (const input of asArray(project.inputs).filter(isObject)) {
    const bytes = readFileSync(join(dir, String(input.path)));
    if (input.sha256 !== sha256(bytes) || input.bytes !== bytes.length) throw new Error('registered source inventory differs from its file');
  }
  return report;
}

export function measureChainExample(destination: string, expectedFiles?: Record<string, string>) {
  if (existsSync(destination)) throw new Error('chain example needs a fresh directory');
  const files = fileHashes(fixture);
  if (expectedFiles) {
    for (const [path, digest] of Object.entries(expectedFiles)) {
      if (files[path] !== digest) throw new Error(`${path}: frozen fixture file is missing or its SHA-256 differs`);
    }
    for (const path of Object.keys(files)) {
      if (!Object.hasOwn(expectedFiles, path)) throw new Error(`${path}: unexpected frozen fixture file`);
    }
  }
  cpSync(fixture, destination, { recursive: true, force: false, errorOnExist: true });
  repinNumberedCopy(destination);
  const chain = JSON.parse(readFileSync(join(destination, 'chain.json'), 'utf8')) as {
    steps: ChainStep[];
    checkpoints: { name: string }[];
  };
  validateChainSteps(chain.steps);
  const checkpoints = chain.checkpoints.map(({ name }) => {
    const checkpointDir = join(destination, 'checkpoints', name);
    repinNumberedCopy(checkpointDir);
    return { name, check: observe(checkpointDir, ['interview', '--check'], true) };
  });
  return { files, readers: readerResults(destination), checkpoints };
}

if (import.meta.main) {
  const usage = 'usage: bun scripts/generate-example-chain.ts <fresh dir> --check';
  const { destination, check } = generatorArgs(import.meta.file, usage);
  if (!check) throw new Error(usage);
  const expected = JSON.parse(readFileSync(baseline, 'utf8')) as ReturnType<typeof measureChainExample>;
  const measured = measureChainExample(resolve(destination), expected.files);
  deepStrictEqual(measured.readers, expected.readers, 'frozen chain reader results differ');
  deepStrictEqual(measured.checkpoints, expected.checkpoints, 'frozen chain checkpoint reader results differ');
  console.log(`example chain: ${Object.keys(measured.files).length} file hashes, ${measured.readers.length} reader results and ${measured.checkpoints.length} checkpoints match`);
}
