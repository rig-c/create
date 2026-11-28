/** Generate a synthetic project through the current-path writers from init to acceptance. */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, relative, resolve } from 'node:path';
import { checkProject, collectItems, isObject } from '../src/check.ts';
import { optionContext, OPTIONS_SPEC, sha256 } from '../src/choices.ts';
import { main } from '../src/cli.ts';
import { nextCommand, type NextReport } from '../src/next.ts';
import type { Json, JsonObject } from '../src/templates.ts';
import { EXAMPLE_BREATH_AMP } from './generate-example-draft.ts';
import { generateExampleParts } from './generate-example-parts.ts';
import { EXAMPLE_ANCHOR, EXAMPLE_SOURCE_DATE_EPOCH } from './example-time.ts';
import { generatorArgs } from './generator-args.ts';

const repository = resolve(import.meta.dir, '..');
const installedExample = join(repository, 'templates/example-current');
const painting = 'inputs/painting.png';
const layers = 'derived/layers';
const assembleConfig = 'specs/rig/assemble.json';
const rigConfig = 'specs/rig/config.json';
const requirements = 'specs/rig/interview-requirements.json';
const partsRoot = 'outputs/parts/rig';
const partsCheck = 'evidence/parts-check.json';
const scenePath = 'specs/direction/compose-scene.json';
const seamBudget = { channel_delta: 8, pixels_above: 0, warmup_cap: 12 };
const seamFlags = ['--loop-seam-bar', `${seamBudget.channel_delta},${seamBudget.pixels_above}`, '--loop-seam-cap', String(seamBudget.warmup_cap)];
const postSteps = [['camera', 'camera_depth'], ['timing', 'post_timing'], ['composition', 'post_composition']] as const;
const rigSteps = ['bones', 'meshes', 'constraints', 'motion'];
const partsSteps = ['seethrough', 'assemble'];
const relay = ['--by', 'owner', '--relayed-by', 'example-agent'];

function jsonBytes(value: Json): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function files(dir: string, root = dir): Map<string, Buffer> {
  const result = new Map<string, Buffer>();
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (dir === root && ['.git', 'scratch'].includes(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) for (const [name, bytes] of files(path, root)) result.set(name, bytes);
    else result.set(relative(root, path), readFileSync(path));
  }
  return result;
}

export function generateExampleCurrent(destination: string, stopAfterOptions?: 'camera_depth'): string {
  const scratch = resolve(destination);
  if (existsSync(scratch)) throw new Error('current example needs a fresh directory');
  const dir = join(scratch, 'example-current');
  const producer = join(scratch, 'producer');
  let now = EXAMPLE_ANCHOR;
  const project = (): JsonObject => JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
  const put = (path: string, text: string) => {
    const file = join(dir, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    return file;
  };
  const copy = (source: string, target: string) => {
    const file = join(dir, target);
    mkdirSync(dirname(file), { recursive: true });
    cpSync(source, file, { recursive: true });
  };
  const write = (command: string[], offer: string[] = [], expectedGap = false) => {
    if (offer.length) {
      const report = JSON.parse(nextCommand([dir, '--json'], now).stdout) as NextReport;
      const prefix = `rig-create ${offer.join(' ')} `;
      const offered = report.moves.some(move => move.command?.startsWith(prefix));
      if (!offered && !expectedGap) throw new Error(`next did not offer ${offer.join(' ')} at ${report.stage}`);
      if (!offered) {
        console.log(`next gap at ${report.stage}: ${offer.join(' ')}; moves ${JSON.stringify(report.moves.map(move => move.field))}`);
      }
    }
    now += 1000;
    const stdout = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      const exit = main(command, now);
      if (exit !== 0) throw new Error(`rig-create ${command.slice(0, offer.length || 1).join(' ')} exited ${exit}`);
    } finally {
      process.stdout.write = stdout;
    }
  };
  const advance = (stage: string, flags: string[] = [], gap = false) =>
    write(['advance', stage, dir, ...flags], ['advance', stage], gap);
  const sign = (stage: string, gap = false) => {
    const words = put('scratch/owner-words.txt', `I approve the synthetic ${stage} work as presented.\n`);
    write(['signoff', stage, dir, ...relay, '--owner-chat', words, '--said-at', new Date(now).toISOString()], ['signoff', stage], gap);
  };
  const propose = (step: string, text: string) =>
    write(['plan', 'propose', step, dir, '--file', put(`plans/${step}.md`, text), '--by', 'agent'], ['plan', 'propose', step]);
  const decide = (question: string, value: Json, quote: string) =>
    write(['interview-decision', question, dir, '--by', 'agent', '--reasoning-file', put('scratch/reason.txt', 'Follow the proposed synthetic plan.\n'),
      '--value-file', put('scratch/value.json', jsonBytes(value)), '--plan-quote-file', put('scratch/quote.txt', quote)], ['interview-decision', question]);
  const plan = (step: string, guide: string, phase: string, order: number) =>
    write(['plan', 'add', step, dir, '--by', 'agent', '--phase', phase, '--order', String(order), '--does', `Prepare synthetic ${step}.`,
      '--produces', `Synthetic ${step} evidence.`, '--rests-on', guide, '--bar', 'Retain the proposed synthetic result.', '--checkpoint-proposed', 'false'], ['plan', 'add', step]);
  const status = (steps: readonly string[], value: string) => {
    for (const step of steps) write(['step-status', step, value, dir, '--by', 'agent'], ['step-status', step, value]);
  };
  const record = (kind: string, flags: string[], gap = false) =>
    write(['record', kind, dir, '--from', `outputs/${kind}.next`, ...flags], ['record', kind], gap);
  const produce = (bin: string, ...args: string[]) => {
    const result = Bun.spawnSync([process.execPath, join(repository, 'node_modules', bin), ...args], {
      cwd: dir,
      env: { ...process.env, PATH: `${join(repository, 'node_modules/.bin')}${delimiter}${process.env.PATH ?? ''}`,
        SOURCE_DATE_EPOCH: EXAMPLE_SOURCE_DATE_EPOCH },
      stdout: 'pipe', stderr: 'pipe',
    });
    if (result.exitCode !== 0) throw new Error(`${args[0]} exited ${result.exitCode}\n${result.stdout}\n${result.stderr}`);
  };
  const parts = (...args: string[]) => produce('@rig-c/parts/bin/rig-parts.cjs', ...args);

  generateExampleParts(producer);
  write(['init', dir, '--no-install', '--owner-language', 'en', '--painting', join(producer, 'painting.png'),
    '--origin', 'Synthetic geometric painting.', '--projects-root', scratch]);
  // Init's fallback is for its first commit only. Give the disposable repository
  // an identity for the stage and output writers' own commits as well.
  for (const [key, value] of [['user.name', 'Synthetic example'], ['user.email', 'example@localhost']] as const) {
    const result = Bun.spawnSync(['git', 'config', '--local', key, value], { cwd: dir, stderr: 'pipe' });
    if (result.exitCode !== 0) throw new Error(`could not configure the synthetic project: ${result.stderr}`);
  }
  propose('parts', 'Build a standing idle character. Use core projection and keep the synthetic painted outlines.\n');
  decide('rig_type', 'character.idle', 'Build a standing idle character.');
  decide('assemble', { project: 'core' }, 'Use core projection and keep the synthetic painted outlines.');
  partsSteps.forEach((step, i) => plan(step, step, 'rig', i + 1));
  sign('interview');
  advance('plan-approved');
  sign('plan-approved');
  advance('parts');
  status(partsSteps, 'in-progress');
  copy(join(producer, 'config.json'), assembleConfig);
  copy(join(producer, 'layers'), layers);
  parts('assemble', '--source', painting, '--full', layers, '--config', assembleConfig, '--out', 'outputs/parts.next');
  parts('check-parts', '--parts', 'outputs/parts.next/rig', '--out', 'outputs/parts.next/check');
  status(partsSteps, 'done');
  // A fresh init has no current nodes; the current-parts stage moves are also missing (#1054).
  record('parts', ['--config', assembleConfig], true);
  parts('check-parts', '--parts', partsRoot, '--out', dirname(partsCheck));
  advance('parts-review', ['--parts-check', partsCheck, '--parts', partsRoot], true);
  write(['structure-snapshot', dir], ['structure-snapshot'], true);
  sign('parts-review', true);
  advance('rigging-interview');
  propose('rigging', 'Keep the painted view. Keep the torso rigid.\n');
  propose('motion', 'Give the body a four-second breathing loop.\n');
  decide('turn', { mode: 'fixed' }, 'Keep the painted view.');
  decide('meshes', {}, 'Keep the torso rigid.');
  rigSteps.forEach((step, i) => plan(step, step, 'rig', i + 3));
  sign('rigging-interview');
  advance('rigging');
  status(rigSteps, 'in-progress');
  const manifest = JSON.parse(readFileSync(join(dir, partsRoot, 'parts.json'), 'utf8')) as { parts: { name: string }[] };
  const assembly = JSON.parse(readFileSync(join(dir, assembleConfig), 'utf8')) as JsonObject;
  put(rigConfig, jsonBytes({ ...assembly, key: 'synthetic', requirements: 'interview-requirements.json',
    bones: [{ name: 'body', parent: 'root', at: [64, 64] }], meshes: {},
    regions: Object.fromEntries(manifest.parts.map(part => [part.name, 'body'])),
    motion: { duration: 4, tracks: [{ bone: 'body', prop: 'translatey', amp: EXAMPLE_BREATH_AMP, period: 4, phase: 0, base: 0 }] } }));
  copy(join(repository, 'templates/example-remesh/evidence/rig-check-requirements.json'), requirements);
  parts('rig', '--config', rigConfig, '--parts', partsRoot, '--out', 'outputs/rig.next');
  parts('check', '--rig', 'outputs/rig.next', '--parts', partsRoot, '--source', painting, '--requirements', requirements,
    '--out', 'outputs/rig.next/check', '--page-edges', 'free', '--pack-shape', 'polygon', '--no-extremes');
  record('rig', ['--config', rigConfig]);
  status(rigSteps, 'done');
  advance('rig-review');
  sign('rig-review');
  advance('post-interview');

  const plate = 'inputs/background.png';
  copy(join(dir, partsRoot, 'parts/background.png'), plate);
  write(['input', 'add', plate, dir, '--origin', 'Synthetic backdrop from Parts assemble.'], ['input', 'add'], true);
  const canvas = { width: 128, height: 128 };
  const plates = [{ name: 'backdrop', image: plate, at: [0, 0], opaque_backdrop: true }];
  const actor = { offset: [0, 0] };
  const order = ['backdrop', 'actor'];
  const composition = { canvas, plates, order, character: actor, idle_tracks: [] };
  const choices: Record<string, [JsonObject, JsonObject]> = {
    camera_depth: [{ camera: 'fixed', depth: false }, { camera: 'fixed', depth: true }],
    post_timing: [{ seconds: 4, loop: true }, { seconds: 8, loop: true }],
    post_composition: [{ compose: composition }, { compose: { ...composition, character: { offset: [4, 0] } } }],
  };
  for (const [id, [fragment, alternative]] of Object.entries(choices)) {
    const words = `Choose the proposed ${id} for the synthetic scene.`;
    const path = `evidence/interview/${id}.json`;
    const set = jsonBytes({ schema: OPTIONS_SPEC, id: `current-${id.replaceAll('_', '-')}`, question: id, stage: 'post-interview',
      drafted_by: 'agent', drafted_at: new Date(now).toISOString(), context: optionContext(project(), 'post-interview', now, dir),
      assembly: { rule: 'single' }, asks: [{ id, prompt: `Choose the synthetic ${id}.`, options: [
        { id: 'keep', kind: 'value', label: `Keep the proposed ${id}`, effect: 'Use the proposed value.', fragment,
          recommended: true, reason: 'Matches the synthetic rig.' },
        { id: 'alternative', kind: 'value', label: `Change the proposed ${id}`, effect: 'Use a different value.',
          fragment: alternative, recommended: false },
        { id: 'other', kind: 'other', label: 'Other', effect: 'Supply different words.', recommended: false },
        { id: 'auto', kind: 'auto', label: 'Delegate', effect: 'Ask the agent to decide.', recommended: false },
      ] }] });
    put(path, set);
    // The first per-question set starts the relay route; next initially proposes a direction plan instead.
    write(['interview-options', id, dir, '--file', path], ['interview-options', id], id === 'camera_depth');
    if (id === stopAfterOptions) return dir;
    write(['interview-answer', id, dir, '--set', path, '--sha256', sha256(Buffer.from(set)), '--pick', `${id}=keep`, ...relay,
      '--owner-chat', put('scratch/owner-words.txt', words), '--said-at', new Date(now).toISOString()], ['interview-answer', id]);
  }
  postSteps.forEach(([step, guide], i) => plan(step, guide, 'post', i + 7));
  sign('post-interview');
  advance('post');
  const postIds = postSteps.map(([step]) => step);
  status(postIds, 'in-progress');
  put('specs/motion/loop-seam.json', jsonBytes(seamBudget));
  produce('@rig-c/core/bin/rigc.cjs', 'render', '--candidate', 'outputs/rig/check/build', '--out', 'outputs/motion.next',
    '--animation', 'idle', '--fps', '1', '--max', '32', '--poser', 'core', ...seamFlags);
  record('motion', []);
  const characterBuild = 'derived/compose-character';
  copy(join(dir, partsRoot), characterBuild);
  for (const path of ['rig.json', 'motion.json', 'images']) copy(join(dir, 'outputs/rig', path), `${characterBuild}/rig/${path}`);
  copy(join(dir, 'outputs/rig/check/check.json'), `${characterBuild}/check/check.json`);
  put(scenePath, jsonBytes({ spec: 'spine-parts-scene/1', canvas,
    plates: plates.map(value => ({ ...value, image: `../../${value.image}`, provenance: 'generated' })),
    characters: [{ id: 'actor', build: `../../${characterBuild}`, ...actor }], order, animations: { idle: { duration: 4, tracks: [] } } }));
  write(['scene', 'write', dir, '--compose-scene', scenePath], ['scene', 'write'], true);
  const cite = (guide: string): JsonObject => {
    const answer = collectItems(project(), { collection: null }).find(item => item.id === guide)?.raw;
    if (!isObject(answer) || typeof answer.verbatim !== 'string') throw new Error(`${guide}: missing the recorded owner pick`);
    return { guide, asks: [guide], quote: answer.verbatim };
  };
  const intent = 'specs/direction/intent.json';
  put(intent, jsonBytes({ take: { duration: 4, loop: true }, citations: {
    camera: cite('camera_depth'), timing: cite('post_timing'), composition: cite('post_composition'),
  } }));
  write(['direction', 'write', dir, '--file', intent], ['direction', 'write'], true);
  parts('compose', '--scene', scenePath, '--out', 'outputs/direction.next', ...seamFlags);
  record('direction', ['--direction', 'specs/direction/direction.json']);
  status(postIds, 'done');
  advance('direction-review');
  sign('direction-review');
  advance('accepted');
  const final = checkProject(dir, undefined, { now });
  if (final.refusals.length || final.warnings.length) throw new Error(jsonBytes({ refusals: final.refusals, warnings: final.warnings } as unknown as Json));
  console.log('current example: accepted; 0 refusals, 0 warnings');
  return dir;
}

if (import.meta.main) {
  const { destination, check } = generatorArgs(import.meta.file, 'usage: generate-example-current.ts <fresh dir> [--check]');
  const tree = files(generateExampleCurrent(destination));
  if (check) {
    const retained = files(installedExample);
    for (const [path, bytes] of tree) if (!retained.get(path)?.equals(bytes)) throw new Error(`${path}: current example differs`);
    for (const path of retained.keys()) if (!tree.has(path)) throw new Error(`${path}: unexpected retained current example file`);
    console.log(`current example: ${tree.size} files reproduce byte for byte`);
  } else {
    rmSync(installedExample, { recursive: true, force: true });
    for (const [path, bytes] of tree) {
      const target = join(installedExample, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes);
    }
  }
}
