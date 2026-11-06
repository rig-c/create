/** A synthetic lifecycle with declared inputs and writer-produced create records. */
import { setSystemTime } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { main } from '../src/cli.ts';
import { asArray, checkProject, collectItems, isObject } from '../src/check.ts';
import { applicableAsks, optionContext, OPTIONS_SPEC, sha256 } from '../src/choices.ts';
import { interviewStageOfGuide } from '../src/stages.ts';
import { stepHash } from '../src/step-hash.ts';
import { STRUCTURE_SCHEMA } from '../src/structure.ts';
import type { Json, JsonObject } from '../src/templates.ts';
import { generatorArgs } from './generator-args.ts';
import { generateExampleParts } from './generate-example-parts.ts';
import { generateExampleMeshDraft } from './generate-example-draft.ts';
import { partsPackage } from '../tests/parts-package.ts';

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

const seedField = /^(project\.stage|plan\.steps(?:\[[a-z_-]+\](?:\.status)?)?|split\.parts|versions\[\]|inputs\[\])$/;
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

/** This is the mutation path used by every generator seed, before writing project.json. */
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

function chainFiles(dir: string, prefix = ''): Record<string, Buffer> {
  const files: Record<string, Buffer> = {};
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === '.git') continue;
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(files, chainFiles(join(dir, entry.name), name));
    else files[name] = readFileSync(join(dir, entry.name));
  }
  return files;
}

/** Validate the actual execution order before publishing its receipt. Indices are zero-based. */
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

/** The finished record, including seeded declarations, passes the ordinary project checker. */
export function checkExampleChain(dir: string): ReturnType<typeof checkProject> {
  const report = checkProject(dir);
  if (report.refusals.length) throw new Error(JSON.stringify(report.refusals));
  const project = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
  for (const input of asArray(project.inputs).filter(isObject)) {
    const bytes = readFileSync(join(dir, String(input.path)));
    if (input.sha256 !== sha256(bytes) || input.bytes !== bytes.length) throw new Error('seeded source inventory differs from its file');
  }
  return report;
}

export function generateExampleChain(destination: string): Record<string, Buffer> {
  const scratch = resolve(destination);
  if (existsSync(scratch)) throw new Error('chain generation needs a fresh directory');
  mkdirSync(scratch, { recursive: true });
  const dir = join(scratch, 'project');
  const steps: ChainStep[] = [];
  const pending: number[] = [];
  const checkpoints: { stage: number; name: string; chain_step: number; files: Record<string, Buffer>; awaits: string[]; act: string }[] = [];
  const checkpoint = (stage: number, name: string, act: string, awaits: string[]): void => {
    checkpoints.push({ stage, name, chain_step: steps.length, files: chainFiles(dir), awaits, act });
  };
  const originalCwd = process.cwd();
  let clock = Date.parse('2026-11-06T01:00:00Z');
  const tick = (): void => { setSystemTime(new Date(clock)); clock += 1000; };
  const load = (): JsonObject => JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
  const write = (path: string, bytes: string | Uint8Array): void => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), bytes);
  };
  const json = (path: string, value: unknown): void => write(path, `${JSON.stringify(value, null, 2)}\n`);
  const binding = (path: string): JsonObject => ({ path, sha256: sha256(readFileSync(join(dir, path))) });
  const writer = (args: string[], outputPath?: string): void => {
    if (args[0] === 'interview-answer' && args[1] === 'bones') {
      checkpoint(2, '2-rigging-answers', 'Choose the rigging interview answers and approve their plan',
        ['interview.waypoints[bones].guide', 'interview.waypoints[meshes].guide', 'interview.waypoints[constraints].guide', 'interview.waypoints[motion].guide', 'signoffs[stage=rigging-interview]']);
    }
    if (args[0] === 'review' && args[1] === '1') {
      checkpoint(3, '3-rig-review', 'Review and approve the rig', ['versions[n=1].verdicts[review=rig-review]', 'signoffs[stage=rig-review]']);
    }
    tick();
    const stdout = process.stdout.write;
    const stderr = process.stderr.write;
    let output = '';
    const capture = ((chunk: string | Uint8Array): boolean => { output += Buffer.from(chunk).toString(); return true; }) as typeof stdout;
    process.stdout.write = capture;
    process.stderr.write = capture;
    let exit: number;
    try { exit = main(args); } finally { process.stdout.write = stdout; process.stderr.write = stderr; }
    if (exit !== 0) throw new Error(`${args.join(' ')}: exit ${exit}\n${output}`);
    const ready = pending.filter(index => matchesCommand(['rig-create', ...args], steps[index]!.seed!.first_consumer_command));
    const consumes = ready.map(index => {
      pending.splice(pending.indexOf(index), 1);
      steps[index]!.seed!.first_consumer = steps.length;
      return steps[index]!.step;
    });
    if (outputPath) write(outputPath, output);
    const project = load();
    const bindings: Record<string, string> = {};
    for (const input of asArray(project.inputs).filter(isObject)) {
      bindings['inputs[]'] = sha256(Buffer.from(JSON.stringify(project.inputs)));
      bindings[String(input.path)] = String(input.sha256);
    }
    for (const signoff of asArray(project.signoffs).filter(isObject)) {
      if (isObject(signoff.step_hashes)) for (const [id, hash] of Object.entries(signoff.step_hashes)) {
        bindings[`plan.steps[${id}].approval`] = String(hash);
      }
    }
    if (args[0] === 'split-captions') bindings['split.parts'] = sha256(Buffer.from(JSON.stringify((project.split as JsonObject).parts)));
    steps.push({ kind: 'writer', step: `writer-${steps.length}`, command: ['rig-create', ...args], exit,
      output_path: outputPath ?? 'project.json', output_sha256: sha256(readFileSync(join(dir, outputPath ?? 'project.json'))), consumes, bindings });
  };
  const seed = (field: string, value: Json, citation: string, consumer: string[], apply: (project: JsonObject) => void): void => {
    const entry: ChainStep = { kind: 'seed', step: `seed-${steps.length}`, command: ['seed', field, JSON.stringify(value)], exit: 0,
      output_sha256: sha256(Buffer.from(JSON.stringify(value))), consumes: [], bindings: {},
      seed: { field, value, citation, first_consumer: -1, first_consumer_command: ['rig-create', ...consumer] } };
    const project = applyChainSeed(load(), field, value, apply);
    steps.push(entry); pending.push(steps.length - 1);
    json('project.json', project);
  };
  const stage = (value: string, consumer: string[]): void => seed('project.stage', value, 'docs/PROJECT.md:528,966', consumer, p => { p.stage = value; });
  const status = (ids: string[], consumer: string[]): void => {
    for (const id of ids) seed(`plan.steps[${id}].status`, 'done', 'docs/PROJECT.md:81,84', consumer, p => {
      const step = asArray((p.plan as JsonObject).steps).filter(isObject).find(s => s.id === id)!;
      step.status = 'done';
    });
  };
  const sign = (name: string, flags: string[] = []): void => writer(['signoff', name, '--by', 'user', '--verbatim-file', 'evidence/approval.txt', ...flags]);
  const producer = (name: string, command: string[], files: Record<string, Buffer>, authored_by?: 'agent'): void => {
    const outputs = Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)).map(([path, bytes]) => [path, sha256(bytes)]));
    const paths = Object.keys(outputs);
    const output = paths.length === 1 ? { output_path: paths[0], output_sha256: outputs[paths[0]!]! }
      : { output_sha256: sha256(Buffer.from(JSON.stringify(outputs))) };
    steps.push({ kind: 'producer', step: name, command, exit: 0, ...output, ...(authored_by ? { authored_by } : {}),
      outputs, consumes: [], bindings: {} });
  };
  const materialize = (name: string, command: string[], files: Record<string, Buffer>, authoredBy?: 'agent'): void => {
    for (const [path, bytes] of Object.entries(files)) write(path, bytes);
    producer(name, command, files, authoredBy);
  };
  const agentJson = (name: string, path: string, value: unknown): void => {
    materialize(name, ['agent', 'draft', path], { [path]: Buffer.from(`${JSON.stringify(value, null, 2)}\n`) }, 'agent');
  };
  const choices = (phase: string): void => {
    const items = collectItems(load(), { collection: null }).filter(item => interviewStageOfGuide(item.id, item.kind === 'post', true) === phase);
    for (const item of items) {
      tick();
      const project = load();
      const asks = applicableAsks(project, item, { asks: [] });
      const values: Record<string, Json> = {
        rig_type: 'character.idle', reference: 'none', camera_depth: { camera: 'push_in', depth: false },
        post_timing: { duration: 4, loop: false }, post_composition: { framing: 'whole synthetic plate' },
      };
      const value = values[item.id] ?? {};
      const set: JsonObject = { schema: OPTIONS_SPEC, id: `chain-${item.id}`, question: item.id, stage: phase,
        drafted_by: 'agent', drafted_at: new Date().toISOString(), context: optionContext(project, phase, Date.now()),
        assembly: { rule: item.kind === 'waypoint' ? 'merge' : 'single' },
        asks: asks.map((ask): JsonObject => ({ id: ask, prompt: `Choose ${ask} for the synthetic plate.`, options: [
          { id: 'keep', kind: 'value', label: `Use the synthetic ${ask}`, effect: 'Keep the declared geometric example.',
            fragment: item.kind !== 'waypoint' ? value : ask === 'projection' ? { project: 'core' } : ask === 'ground' ? { ground: 'plain' } : { [ask]: `synthetic ${ask}` },
            recommended: true, reason: 'Matches the synthetic geometric inputs.' },
          { id: 'alternative', kind: 'value', label: `Change ${ask}`, effect: 'Use the alternate synthetic choice.',
            fragment: item.kind === 'waypoint' ? { [ask]: `alternate ${ask}` } : value, recommended: false },
          { id: 'other', kind: 'other', label: 'Other', effect: 'Supply different words.', recommended: false },
          { id: 'auto', kind: 'auto', label: 'Delegate', effect: 'Ask the agent to decide.', recommended: false },
        ] })) };
      const path = `evidence/interview/${item.id}.json`;
      agentJson(`agent-drafted option set ${item.id}`, path, set);
      writer(['interview-options', item.id, '--file', path]);
      writer(['interview-answer', item.id, '--set', path, '--sha256', String(binding(path).sha256), '--by', 'user', ...asks.flatMap(ask => ['--pick', `${ask}=keep`])]);
    }
  };
  try {
    tick();
    // init's temporary Git repository is excluded from all generated template bytes.
    process.chdir(scratch);
    writer(['init', 'project', '--no-install']);
    process.chdir(dir);
    materialize('agent-prepared approval words', ['agent', 'draft', 'evidence/approval.txt'],
      { 'evidence/approval.txt': Buffer.from('Approve this synthetic geometric example.\n') }, 'agent');
    const input = generateExampleParts(join(scratch, 'parts-producer'));
    producer('assemble synthetic parts', ['generateExampleParts', '../parts-producer'], input);
    materialize('retain synthetic painting and split config', ['copy', 'parts-producer painting and config', 'project inputs and evidence'], {
      'inputs/painting.png': readFileSync(join(scratch, 'parts-producer/painting.png')),
      'evidence/split-config.json': readFileSync(join(scratch, 'parts-producer/config.json')),
    });
    const painting = readFileSync(join(dir, 'inputs/painting.png'));
    const inputPath = relative(dir, join(dir, 'inputs/painting.png')).split('\\').join('/');
    const inputs = [{ path: inputPath, sha256: sha256(painting), bytes: painting.length, origin: 'synthetic, generated by generateExampleParts' }];
    seed('inputs[]', inputs, 'docs/PROJECT.md:51,757', ['interview-options', 'rig_type'], p => { p.inputs = inputs; });
    const ids = ['seethrough', 'assemble', 'bones', 'meshes', 'constraints', 'motion'];
    const plan = ids.map((id, index) => ({ id, phase: 'rig', order: index + 1,
      does: `Execute synthetic ${id}`, produces: `Synthetic ${id} output`,
      rests_on: [id],
      bar: 'The synthetic output matches its declared input.', checkpoint_proposed: id === 'assemble', checkpoint: null, status: 'pending' }));
    seed('plan.steps', plan, 'docs/PROJECT.md:450,480', ['interview-options', 'rig_type'], p => { (p.plan as JsonObject).steps = plan; });
    const manifest = JSON.parse(input['parts.json']!.toString()) as { parts: { name: string }[] };
    const split = manifest.parts.map(part => ({ name: part.name, label: 'rigid', note: 'Synthetic geometric block.' }));
    seed('split.parts', split, 'docs/PROJECT.md:399,756', ['split-captions'], p => { (p.split as JsonObject).parts = split; });
    choices('interview'); sign('interview');
    stage('plan-approved', ['signoff', 'plan-approved']); sign('plan-approved');
    stage('parts', ['signoff', 'parts']); status(['seethrough', 'assemble'], ['signoff', 'parts']);
    sign('parts', ['--checkpoint', 'assemble']);
    const draft = generateExampleMeshDraft(join(scratch, 'draft-producer'), input);
    producer('labelled draft producer', ['generateExampleMeshDraft', '../draft-producer', 'same generated parts'], draft);
    const draftRoot = 'derived/drafts/chain';
    materialize('retain labelled draft inputs and outputs', ['copy', 'draft producer and assembled parts', draftRoot], {
      ...Object.fromEntries(Object.entries(input).map(([path, bytes]) => [`${draftRoot}/input/${path}`, bytes])),
      ...Object.fromEntries(Object.entries(draft).map(([path, bytes]) => [`${draftRoot}/${path}`, bytes])),
      [`${draftRoot}/input/recomposite_rig.png`]: readFileSync(join(scratch, 'parts-producer/assembled/render/recomposite_rig.png')),
    });
    writer(['draft-rig', 'chain', '--config', `${draftRoot}/config.json`, '--from', `${draftRoot}/out`, '--parts', `${draftRoot}/input`]);
    const declaredDraft = asArray(load().drafts).filter(isObject)[0]!;
    agentJson('agent-prepared structure snapshot', 'evidence/structure.json', { schema: STRUCTURE_SCHEMA, draft_id: 'chain', config: declaredDraft.config, entries: [] });
    const partsDir = `${draftRoot}/input`;
    checkpoint(1, '1-parts-verdict', 'Export the synthetic review-tool parts verdict, then approve the parts',
      ['evidence/parts-review.json', 'signoffs[stage=parts-review]', 'project.stage']);
    const verdict = partsPackage({ input, partsDir, verdict: 'evidence/parts-review.json', edit: v => { v.updatedAt = new Date().toISOString(); } });
    write('evidence/parts-review.json', verdict.files['evidence/parts-review.json']!);
    producer('synthetic review-tool parts verdict (tests/parts-package.ts)', ['partsPackage', 'tests/parts-package.ts'],
      { 'evidence/parts-review.json': readFileSync(join(dir, 'evidence/parts-review.json')) });
    const diff = Bun.spawnSync([process.execPath, join(import.meta.dir, '../node_modules/@rig-c/parts/bin/rig-parts.cjs'),
      'diff-components', '--stack', 'assembled/render/recomposite_rig.png', '--painting', 'painting.png', '--parts', 'assembled/rig/parts.json',
      '--floor', '2', '--threshold', '40', '--out', 'diff-components.json'],
    { cwd: join(scratch, 'parts-producer'), stdout: 'pipe', stderr: 'pipe', timeout: 600_000 });
    if (diff.exitCode !== 0) throw new Error(`diff-components exit ${diff.exitCode}: ${diff.stderr}`);
    const reportBytes = readFileSync(join(scratch, 'parts-producer/diff-components.json'));
    write('evidence/diff-components.json', reportBytes);
    producer('assembly difference report', ['rig-parts', 'diff-components', '--stack', 'assembled/render/recomposite_rig.png', '--painting', 'painting.png',
      '--parts', 'assembled/rig/parts.json', '--floor', '2', '--threshold', '40', '--out', 'diff-components.json'], { 'evidence/diff-components.json': reportBytes });
    const diffReport = JSON.parse(reportBytes.toString()) as { stack: { sha256: string }; painting: { sha256: string }; components: { id: string }[] };
    stage('parts-review', ['signoff', 'parts-review']);
    sign('parts-review', ['--draft', 'chain', '--structure-file', 'evidence/structure.json', '--evidence', 'evidence/parts-review.json', '--diff-report', 'evidence/diff-components.json',
      ...diffReport.components.flatMap(c => ['--component', `${c.id}=in-painting:the generated synthetic painting contains this component`])]);
    stage('rigging-interview', ['interview-options', 'bones']); choices('rigging-interview'); sign('rigging-interview');
    stage('rigging', ['interview', '--check']); status(['bones', 'meshes', 'constraints', 'motion'], ['interview', '--check']);
    writer(['interview', '--check', '--json']);
    const built = generateExampleMeshDraft(join(scratch, 'rig-producer'), input);
    producer('production rig and compiled model', ['generateExampleMeshDraft', '../rig-producer', 'same approved parts'], built);
    const productionFiles: Record<string, Buffer> = Object.fromEntries(Object.entries(input).map(([path, bytes]) => [`outputs/v1/out/${path}`, bytes]));
    for (const [path, bytes] of Object.entries(built)) {
      if (!path.startsWith('out/')) productionFiles[`evidence/v1/${path}`] = bytes;
      else {
        const suffix = path.slice(4);
        productionFiles[`outputs/v1/out/${suffix.startsWith('check/') ? suffix : `rig/${suffix}`}`] = bytes;
      }
    }
    productionFiles['evidence/setup.png'] = readFileSync(join(scratch, 'parts-producer/assembled/render/recomposite_rig.png'));
    materialize('retain production inputs, outputs and setup evidence', ['copy', 'production rig and assembled setup', 'outputs/v1/out and evidence'], productionFiles);
    const sections: JsonObject = {};
    const config = JSON.parse(built['config.json']!.toString()) as JsonObject;
    for (const name of Object.keys(config).filter(name => ['assemble', 'bones', 'meshes', 'regions', 'motion'].includes(name))) {
      const guide = name === 'regions' ? 'meshes' : name;
      const item = collectItems(load(), { collection: null }).find(item => item.id === guide)!;
      const answer = item.raw as JsonObject;
      sections[name] = [{ entry: name, guide, quote: answer.verbatim as string, asks: asArray(answer.asks).filter(isObject).map(ask => ask.id) }];
    }
    const version: JsonObject = { n: 1, kind: 'rig', rig_version: null, at: new Date().toISOString(), built_by: 'agent',
      built_with: Object.fromEntries(['@rig-c/parts', '@rig-c/core'].map(name => [name, JSON.parse(readFileSync(join(import.meta.dir, '../node_modules', name, 'package.json'), 'utf8')).version as string])),
      changed: 'Build the synthetic approved parts.', outputs: [{ ...binding('outputs/v1/out/check/build/skeleton.model.json'), bytes: built['out/check/build/skeleton.model.json']!.length }],
      evidence: [{ kind: 'still', ...binding('evidence/setup.png'), camera: 'fixed', frame: 'setup' }],
      verdicts: [], answers_feedback: [], review_origin: null, provenance: { config: binding('evidence/v1/config.json'), sections } };
    seed('versions[]', version, 'docs/PROJECT.md:580,595', ['review-package', '1'], p => { p.versions = [...asArray(p.versions), version]; });
    writer(['review-package', '1', '--config', 'evidence/v1/config.json', '--from', 'outputs/v1/out']);
    stage('rig-review', ['review', '1']);
    writer(['review', '1', '--verdict', 'accepted', '--by', 'user', '--review', 'rig-review', '--verbatim-file', 'evidence/approval.txt', '--source', 'synthetic example']);
    sign('rig-review', ['--version', '1']);
    stage('post-interview', ['interview-options', 'camera_depth']);
    for (const [index, id] of ['camera', 'timing', 'composition'].entries()) {
      const step: JsonObject = { id, phase: 'post', order: ids.length + index + 1, does: `Execute synthetic ${id}`,
        produces: `Synthetic ${id} output`, rests_on: [{ camera: 'camera_depth', timing: 'post_timing', composition: 'post_composition' }[id]!],
        bar: 'The synthetic output matches its declared input.', checkpoint_proposed: false, checkpoint: null, status: 'pending' };
      seed(`plan.steps[${id}]`, step, 'docs/PROJECT.md:479,480', ['interview-options', 'camera_depth'], p => {
        (p.plan as JsonObject).steps = [...asArray((p.plan as JsonObject).steps), step];
      });
    }
    choices('post-interview'); sign('post-interview');
    stage('post', ['direction', '--adopt']); status(['camera', 'timing', 'composition'], ['direction', '--adopt']);
    writer(['direction', '--adopt']);
    checkpoint(4, '4-direction-post', 'Author the direction post and approve its review',
      ['evidence/direction-input.json', 'versions[n=2]', 'signoffs[stage=direction-review]', 'project.stage']);
    const cite = (id: string): JsonObject => {
      const answer = collectItems(load(), { collection: null }).find(i => i.id === id)!.raw as JsonObject;
      return { guide: id, asks: [id], quote: answer.verbatim as string };
    };
    agentJson('agent-authored direction input', 'evidence/direction-input.json', { schema: 'rig-create/direction@1', rig: { version: 1, model: binding('derived/review/v1/out/check/build/skeleton.model.json') },
      take: { duration: 4, loop: false }, camera: { space: 'rig-world-y-up', keys: [
        { time: 0, box: { x: -64, y: 0, width: 128, height: 128 }, easing: 'linear' },
        { time: 4, box: { x: -60, y: 4, width: 120, height: 120 }, easing: 'hold' } ] },
      timing: { keys: [{ time: 0, source_time: 0, easing: 'linear' }, { time: 4, source_time: 4, easing: 'hold' }] },
      citations: { camera: cite('camera_depth'), timing: cite('post_timing') } });
    writer(['direction', 'write', '2', '--file', 'evidence/direction-input.json', '--rig', '1']);
    writer(['direction', 'check', '2', '--json']);
    stage('direction-review', ['review', '2']);
    writer(['review', '2', '--verdict', 'accepted', '--by', 'user', '--review', 'direction-review', '--verbatim-file', 'evidence/approval.txt', '--source', 'synthetic example']);
    sign('direction-review', ['--version', '2']);
    stage('accepted', ['interview', '--check']); writer(['interview', '--check', '--json']);
    writer(['split-captions', '--config', 'evidence/split-config.json'], 'evidence/captions.json');
    const checked = checkExampleChain(dir);
    validateChainSteps(steps);
    json('chain.json', { claim: 'Create signoffs, rig/post review verdicts, packages and authored direction use public writers. The parts verdict is a synthetic review-tool export. Input declarations are seeds.',
      seed_kinds: [
        { kind: 'forward project.stage', fields: ['project.stage'] },
        { kind: 'plan.steps (setup and status progress)', fields: ['plan.steps', 'split.parts'] },
        { kind: 'rig version declaration', fields: ['versions[]'] },
        { kind: 'source inventory', fields: ['inputs[]'] },
      ],
      index_base: 0, stack_equals_painting: diffReport.stack.sha256 === diffReport.painting.sha256,
      checkpoints: checkpoints.map(({ stage, name, chain_step }) => ({ stage, name, chain_step })),
      steps, check: { refusals: checked.refusals, warnings: checked.warnings } });
    for (const saved of checkpoints) {
      for (const [path, bytes] of Object.entries(saved.files)) write(`checkpoints/${saved.name}/${path}`, bytes);
      const closingStage = ['parts-review', 'rigging-interview', 'rig-review', 'direction-review'][saved.stage - 1]!;
      const end = steps.findIndex(step => step.command[1] === 'signoff' && step.command[2] === closingStage);
      const acts = steps.slice(saved.chain_step, end + 1);
      const commands = acts.map(step => {
        const args = [...step.command];
        const hashIndex = args.indexOf('--sha256');
        if (step.command[1] === 'interview-answer' && hashIndex >= 0) {
          const path = args[args.indexOf('--set') + 1]!;
          args[hashIndex + 1] = `<sha256 of ${path}>`;
        }
        return args.join(' ');
      });
      const command_roles = acts.map(step => {
        if (step.kind === 'seed') return 'seed';
        if (step.authored_by === 'agent') return 'agent';
        if (step.kind === 'producer') return 'producer';
        if (step.command[1] === 'interview-options' || step.command[1] === 'direction' && step.command[2] === 'check') return 'agent';
        return 'human';
      });
      const report = checkProject(join(dir, 'checkpoints', saved.name));
      json(`checkpoints/${saved.name}.json`, { schema: 'rig-create/example-checkpoint@1', stage: saved.stage, name: saved.name,
        chain_step: saved.chain_step, pending: { act: saved.act, commands, command_roles, awaits: saved.awaits },
        expected_findings: { refusals: report.refusals, warnings: report.warnings },
        project_sha256: sha256(saved.files['project.json']!),
        files: Object.entries(saved.files).map(([path, bytes]) => ({ path, sha256: sha256(bytes) })) });
    }
    write('README.md', '# Synthetic bound chain\n\n'
      + 'The geometric painting and parts come from generateExampleParts. The labelled draft and production model come from generateExampleMeshDraft on those exact parts, with a producer-made torso mesh.\n\n'
      + 'The setup still is the assembly recomposite, retained as synthetic setup evidence. The example demonstrates record binding. Rendered motion and camera behaviour require separate producer validation.\n\n'
      + 'The public create CLI writes signoffs, rig/post review verdicts, the review package and authored direction. The parts verdict is a synthetic review-tool export from tests/parts-package.ts, recorded as a producer step.\n\n'
      + 'Four seed kinds cover forward stages, plan.steps (setup and status progress) with split.parts, the rig version declaration and source inventory. Each seed declares its consuming command and records that command’s step index in chain.json.\n\n'
      + 'checkpoints/ contains frozen prefix projects and adjacent pending-act declarations. Stage 1 precedes the synthetic review-tool parts verdict export. Stage 2 precedes the first rigging answer and still needs later option sets to be agent-drafted in declared steps before registration by public writers. Pending answers use the SHA-256 of the file drafted during the walk. Stage 3 precedes rig review. Stage 4 precedes the declared agent-authored direction input and direction write. In-window stage seeds remain explicit pending steps. Every file authored or copied for a later writer has a declared producer step with output hashes. The chain_step indices are zero-based. Stage 2 has four expected INTERVIEW_INCOMPLETE findings for its unanswered rigging guides. The other three prefixes have no findings. tests/example-chain.test.ts checks these states.\n\n'
      + 'Reproduce with `bun scripts/generate-example-chain.ts <fresh-dir> --check` from the create repository.\n');
    return chainFiles(dir);
  } finally { process.chdir(originalCwd); setSystemTime(); }
}

if (import.meta.main) {
  const { destination, check } = generatorArgs(import.meta.file, 'usage: generate-example-chain.ts <fresh dir> [--check]');
  const files = generateExampleChain(destination);
  const root = join(import.meta.dir, '../templates/example-chain');
  if (check) {
    const committed = chainFiles(root);
    if (JSON.stringify(Object.keys(committed)) !== JSON.stringify(Object.keys(files))) throw new Error('chain file inventory differs');
    for (const [path, bytes] of Object.entries(files)) {
      if (!committed[path]!.equals(bytes)) throw new Error(`${path}: chain differs`);
    }
    console.log('example chain reproduces byte for byte through writers and declared seeds');
  } else for (const [path, bytes] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), bytes);
  }
}
