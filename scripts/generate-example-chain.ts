/** A single synthetic lifecycle. Binding records must enter through public writers. */
import { setSystemTime } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { main } from '../src/cli.ts';
import { asArray, checkProject, collectItems, isObject } from '../src/check.ts';
import { applicableAsks, optionContext, OPTIONS_SPEC, sha256 } from '../src/choices.ts';
import { interviewStageOfGuide } from '../src/stages.ts';
import { stepHash } from '../src/step-hash.ts';
import { STRUCTURE_SCHEMA } from '../src/structure.ts';
import type { Json, JsonObject } from '../src/templates.ts';
import { generatorArgs } from './generator-args.ts';
import { generateExampleParts } from './generate-example-parts.ts';
import { generateExampleDraft } from './generate-example-draft.ts';
import { partsPackage } from '../tests/parts-package.ts';

export interface ChainStep {
  kind: 'seed' | 'writer' | 'producer';
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
      const consumer = steps.findIndex(candidate => candidate.kind === 'writer' && candidate.consumes.includes(step.step));
      if (consumer <= index || seed.first_consumer !== consumer) throw new Error(`${step.step}: seed must precede its first consumer`);
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
    const ready = pending.filter(index => steps[index]!.seed!.field !== 'split.parts' || args[0] === 'split-captions');
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
  const seed = (field: string, value: Json, citation: string, apply: (project: JsonObject) => void): void => {
    const entry: ChainStep = { kind: 'seed', step: `seed-${steps.length}`, command: [], exit: 0,
      output_sha256: sha256(Buffer.from(JSON.stringify(value))), consumes: [], bindings: {},
      seed: { field, value, citation, first_consumer: -1 } };
    const project = load();
    const signed = asArray(project.plan && isObject(project.plan) ? project.plan.steps : []).filter(isObject)
      .filter(step => asArray(project.signoffs).filter(isObject).some(s => isObject(s.step_hashes) && String(step.id) in s.step_hashes))
      .map(step => [String(step.id), stepHash(step)]);
    apply(project);
    for (const [id, hash] of signed) {
      const step = asArray((project.plan as JsonObject).steps).filter(isObject).find(step => step.id === id);
      if (!step || stepHash(step) !== hash) throw new Error(`${field}: seed changes a signed plan`);
    }
    steps.push(entry); pending.push(steps.length - 1);
    json('project.json', project);
  };
  const stage = (value: string): void => seed('project.stage', value, 'docs/PROJECT.md:528,966', p => { p.stage = value; });
  const status = (ids: string[]): void => {
    for (const id of ids) seed(`plan.steps[${id}].status`, 'done', 'docs/PROJECT.md:81,84', p => {
      const step = asArray((p.plan as JsonObject).steps).filter(isObject).find(s => s.id === id)!;
      step.status = 'done';
    });
  };
  const sign = (name: string, flags: string[] = []): void => writer(['signoff', name, '--by', 'user', '--verbatim-file', 'evidence/approval.txt', ...flags]);
  const producer = (name: string, command: string[], files: Record<string, Buffer>): void => {
    const outputs = Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)).map(([path, bytes]) => [path, sha256(bytes)]));
    steps.push({ kind: 'producer', step: name, command, exit: 0, output_sha256: sha256(Buffer.from(JSON.stringify(outputs))),
      outputs, consumes: [], bindings: {} });
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
      json(path, set);
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
    write('evidence/approval.txt', 'Approve this synthetic geometric example.\n');
    const input = generateExampleParts(join(scratch, 'parts-producer'));
    producer('assemble synthetic parts', ['generateExampleParts', '../parts-producer'], input);
    write('inputs/painting.png', readFileSync(join(scratch, 'parts-producer/painting.png')));
    write('evidence/split-config.json', readFileSync(join(scratch, 'parts-producer/config.json')));
    const painting = readFileSync(join(dir, 'inputs/painting.png'));
    const inputPath = relative(dir, join(dir, 'inputs/painting.png')).split('\\').join('/');
    const inputs = [{ path: inputPath, sha256: sha256(painting), bytes: painting.length, origin: 'synthetic, generated by generateExampleParts' }];
    seed('inputs[]', inputs, 'docs/PROJECT.md:51,757', p => { p.inputs = inputs; });
    const ids = ['seethrough', 'assemble', 'bones', 'meshes', 'constraints', 'motion', 'camera', 'timing', 'composition'];
    const plan = ids.map((id, index) => ({ id, phase: index < 6 ? 'rig' : 'post', order: index + 1,
      does: `Execute synthetic ${id}`, produces: `Synthetic ${id} output`,
      rests_on: [id === 'camera' ? 'camera_depth' : id === 'timing' ? 'post_timing' : id === 'composition' ? 'post_composition' : id],
      bar: 'The synthetic output matches its declared input.', checkpoint_proposed: id === 'assemble', checkpoint: null, status: 'pending' }));
    seed('plan.steps', plan, 'docs/PROJECT.md:450,480', p => { (p.plan as JsonObject).steps = plan; });
    const manifest = JSON.parse(input['parts.json']!.toString()) as { parts: { name: string }[] };
    const split = manifest.parts.map(part => ({ name: part.name, label: 'rigid', note: 'Synthetic geometric block.' }));
    seed('split.parts', split, 'docs/PROJECT.md:399,756', p => { (p.split as JsonObject).parts = split; });
    choices('interview'); sign('interview');
    stage('plan-approved'); sign('plan-approved');
    stage('parts'); status(['seethrough', 'assemble']);
    sign('parts', ['--checkpoint', 'assemble']);
    const draft = generateExampleDraft(join(scratch, 'draft-producer'), input);
    producer('labelled draft producer', ['generateExampleDraft', '../draft-producer', 'same generated parts'], draft);
    const draftRoot = 'derived/drafts/chain';
    for (const [path, bytes] of Object.entries(input)) write(`${draftRoot}/input/${path}`, bytes);
    for (const [path, bytes] of Object.entries(draft)) write(`${draftRoot}/${path}`, bytes);
    writer(['draft-rig', 'chain', '--config', `${draftRoot}/config.json`, '--from', `${draftRoot}/out`, '--parts', `${draftRoot}/input`]);
    const declaredDraft = asArray(load().drafts).filter(isObject)[0]!;
    json('evidence/structure.json', { schema: STRUCTURE_SCHEMA, draft_id: 'chain', config: declaredDraft.config, entries: [] });
    const partsDir = `${draftRoot}/input`;
    const verdict = partsPackage({ input, partsDir, verdict: 'evidence/parts-review.json', edit: v => { v.updatedAt = new Date().toISOString(); } });
    write('evidence/parts-review.json', verdict.files['evidence/parts-review.json']!);
    const diff = Bun.spawnSync([process.execPath, join(import.meta.dir, '../node_modules/@rig-c/parts/bin/rig-parts.cjs'),
      'diff-components', '--stack', 'assembled/render/recomposite_rig.png', '--painting', 'painting.png', '--parts', 'assembled/rig/parts.json',
      '--floor', '2', '--threshold', '40', '--out', 'diff-components.json'],
    { cwd: join(scratch, 'parts-producer'), stdout: 'pipe', stderr: 'pipe', timeout: 600_000 });
    if (diff.exitCode !== 0) throw new Error(`diff-components exit ${diff.exitCode}: ${diff.stderr}`);
    const reportBytes = readFileSync(join(scratch, 'parts-producer/diff-components.json'));
    producer('assembly difference report', ['rig-parts', 'diff-components', '--stack', 'assembled/render/recomposite_rig.png', '--painting', 'painting.png',
      '--parts', 'assembled/rig/parts.json', '--floor', '2', '--threshold', '40', '--out', 'diff-components.json'], { 'diff-components.json': reportBytes });
    write('evidence/diff-components.json', reportBytes);
    write(`${partsDir}/recomposite_rig.png`, readFileSync(join(scratch, 'parts-producer/assembled/render/recomposite_rig.png')));
    const diffReport = JSON.parse(reportBytes.toString()) as { stack: { sha256: string }; painting: { sha256: string }; components: { id: string }[] };
    stage('parts-review');
    sign('parts-review', ['--draft', 'chain', '--structure-file', 'evidence/structure.json', '--evidence', 'evidence/parts-review.json', '--diff-report', 'evidence/diff-components.json',
      ...diffReport.components.flatMap(c => ['--component', `${c.id}=in-painting:the generated synthetic painting contains this component`])]);
    stage('rigging-interview'); choices('rigging-interview'); sign('rigging-interview');
    stage('rigging'); status(['bones', 'meshes', 'constraints', 'motion']);
    const built = generateExampleDraft(join(scratch, 'rig-producer'), input);
    producer('production rig and compiled model', ['generateExampleDraft', '../rig-producer', 'same approved parts'], built);
    for (const [path, bytes] of Object.entries(input)) write(`outputs/v1/out/${path}`, bytes);
    for (const [path, bytes] of Object.entries(built)) {
      if (!path.startsWith('out/')) write(`evidence/v1/${path}`, bytes);
      else {
        const suffix = path.slice(4);
        write(`outputs/v1/out/${suffix.startsWith('check/') ? suffix : `rig/${suffix}`}`, bytes);
      }
    }
    write('evidence/setup.png', readFileSync(join(scratch, 'parts-producer/assembled/render/recomposite_rig.png')));
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
    seed('versions[]', version, 'docs/PROJECT.md:580,595', p => { p.versions = [...asArray(p.versions), version]; });
    writer(['review-package', '1', '--config', 'evidence/v1/config.json', '--from', 'outputs/v1/out']);
    stage('rig-review');
    writer(['review', '1', '--verdict', 'accepted', '--by', 'user', '--review', 'rig-review', '--verbatim-file', 'evidence/approval.txt', '--source', 'synthetic example']);
    sign('rig-review', ['--version', '1']);
    stage('post-interview'); choices('post-interview'); sign('post-interview');
    stage('post'); status(['camera', 'timing', 'composition']);
    writer(['direction', '--adopt']);
    const cite = (id: string): JsonObject => {
      const answer = collectItems(load(), { collection: null }).find(i => i.id === id)!.raw as JsonObject;
      return { guide: id, asks: [id], quote: answer.verbatim as string };
    };
    json('evidence/direction-input.json', { schema: 'rig-create/direction@1', rig: { version: 1, model: binding('derived/review/v1/out/check/build/skeleton.model.json') },
      take: { duration: 4, loop: false }, camera: { space: 'rig-world-y-up', keys: [
        { time: 0, box: { x: -64, y: 0, width: 128, height: 128 }, easing: 'linear' },
        { time: 4, box: { x: -60, y: 4, width: 120, height: 120 }, easing: 'hold' } ] },
      timing: { keys: [{ time: 0, source_time: 0, easing: 'linear' }, { time: 4, source_time: 4, easing: 'hold' }] },
      citations: { camera: cite('camera_depth'), timing: cite('post_timing') } });
    writer(['direction', 'write', '2', '--file', 'evidence/direction-input.json', '--rig', '1']);
    writer(['direction', 'check', '2', '--json']);
    stage('direction-review');
    writer(['review', '2', '--verdict', 'accepted', '--by', 'user', '--review', 'direction-review', '--verbatim-file', 'evidence/approval.txt', '--source', 'synthetic example']);
    sign('direction-review', ['--version', '2']);
    stage('accepted'); writer(['interview', '--check', '--json']);
    writer(['split-captions', '--config', 'evidence/split-config.json'], 'evidence/captions.json');
    const checked = checkExampleChain(dir);
    validateChainSteps(steps);
    json('chain.json', { claim: 'Every binding record is writer-produced; stage, plan/split, rig declarations and source inventory are declared seeds.',
      index_base: 0, stack_equals_painting: diffReport.stack.sha256 === diffReport.painting.sha256,
      steps, check: { refusals: checked.refusals, warnings: checked.warnings } });
    write('README.md', '# Synthetic bound chain\n\n'
      + 'The geometric painting and parts come from generateExampleParts. The labelled draft and production model come from generateExampleDraft on those exact parts.\n\n'
      + 'The setup still is the assembly recomposite, retained as synthetic setup evidence. The example demonstrates record binding. Rendered motion and camera behaviour require separate producer validation.\n\n'
      + 'Approvals, verdicts, the review package and authored direction are written through the public create CLI. Forward stages, plan/split declarations, the rig version declaration and source inventory are declared seeds, listed with their first consumer in chain.json.\n\n'
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
