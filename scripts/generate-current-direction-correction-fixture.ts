import { generatorArgs } from './generator-args.ts';
/** Reproduce a synthetic current-path direction correction through the public writers. */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { CHOICE_SPEC, OPTIONS_SPEC } from '../src/choices.ts';
import { correctionCommand } from '../src/correction-writers.ts';
import { COMPOSE_CHECK_PATH, COMPOSE_RUN_PATH, CURRENT_DIRECTION_PATH } from '../src/current-direction.ts';
import { CURRENT_RIG_MODEL, outputSetHash, sha256, treeFiles } from '../src/current.ts';
import { directionCommand } from '../src/direction-writers.ts';
import { inputCommand } from '../src/inputs.ts';
import { ownerLanguageCommand } from '../src/owner-language-writer.ts';
import { recordCommand } from '../src/record.ts';
import { sceneCommand } from '../src/scene-writers.ts';
import { signoffCommand } from '../src/signoff.ts';
import { sorted } from '../src/step-hash.ts';
import { readTemplate, type JsonObject } from '../src/templates.ts';

const SYNTHETIC_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zb1sAAAAASUVORK5CYII=',
  'base64',
);
const CAMERA_WORDS = 'Hold the centered rectangle. Keep the upper margin clear.';
const TIMING_WORDS = 'Four-second seamless loop.';
const PLATE_WORDS = 'Place the backdrop behind the actor.';

function put(dir: string, path: string, value: JsonObject | string | Buffer): { path: string; sha256: string } {
  const bytes = typeof value === 'string' || Buffer.isBuffer(value) ? value : `${JSON.stringify(value, null, 2)}\n`;
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), bytes);
  return { path, sha256: sha256(typeof bytes === 'string' ? Buffer.from(bytes) : bytes) };
}

function stageComposeOutput(
  dir: string,
  partsScene: string,
  composeStage: string,
  directionFrom: string,
  backdropSha256: string,
  revision: number,
): void {
  const model: JsonObject = {
    spec: 'rigc-compiled/3',
    stage: { x: -32, y: 0, width: 64, height: 48 },
    animations: [{ name: 'idle', duration: 4 }],
    pages: [],
    synthetic_revision: revision,
  };
  const modelBinding = put(dir, `${directionFrom}/check/build/skeleton.model.json`, model);
  put(dir, `${directionFrom}/${COMPOSE_CHECK_PATH}`, {
    spec: 'rig-parts-check/1',
    PASS: true,
    gate_spine_html_green: true,
    build: { model_sha256: modelBinding.sha256 },
  });
  put(dir, `${directionFrom}/scene.json`, {
    spec: 'spine-parts-scene-report/1',
    scene: partsScene,
    canvas: { width: 64, height: 48 },
    characters: [{ id: 'actor', build: `../../${composeStage}`, offset: [0, 0], scale: 1, rig_size: [64, 48], shift: [0, 0] }],
    plates: [{ name: 'backdrop', image: '../../inputs/backdrop.png', at: [0, 0], opaque_backdrop: true, sha256: backdropSha256 }],
  });
  put(dir, `${directionFrom}/${COMPOSE_RUN_PATH}`, {
    spec: 'rig-compose-run/1',
    scene: { path: partsScene, sha256: sha256(readFileSync(join(dir, partsScene))) },
    characters: [{
      id: 'actor',
      build: `../../${composeStage}`,
      files: treeFiles(dir, composeStage).map(({ path, sha256: digest }) => ({
        path: path.slice(composeStage.length + 1),
        sha256: digest,
      })),
    }],
    plate: null,
    plates: [{ name: 'backdrop', path: '../../inputs/backdrop.png', sha256: backdropSha256 }],
  });
}

export function generateCurrentDirectionCorrectionFixture(dir: string): Record<string, Buffer> {
  if (existsSync(dir)) throw Error('generation requires a fresh directory');
  mkdirSync(dir, { recursive: true });
  put(dir, '.gitignore', '/outputs/*\n!/outputs/parts/\n');

  const rigModel: JsonObject = {
    spec: 'rigc-compiled/3',
    stage: { x: -32, y: 0, width: 64, height: 48 },
    animations: [{ name: 'idle' }],
    pages: [],
  };
  const rigModelBinding = put(dir, CURRENT_RIG_MODEL, rigModel);
  put(dir, 'outputs/rig/check/build/skeleton.json', '{}');
  put(dir, 'outputs/rig/check/build/skeleton.atlas', 'synthetic atlas\n');
  const rigRun = put(dir, 'outputs/rig/run.json', '{}');
  const rigReport = put(dir, 'outputs/rig/check/check.json', { spec: 'rig-parts-check/1', PASS: true });
  put(dir, 'outputs/rig/rig.json', { synthetic: 'current rig' });
  put(dir, 'outputs/rig/motion.json', { synthetic: 'current motion' });
  put(dir, 'outputs/rig/images/body.png', SYNTHETIC_PNG);
  const rigFiles = treeFiles(dir, 'outputs/rig');
  const rigNode: JsonObject = {
    at: '2026-11-26T08:00:00.000Z',
    built_by: 'agent',
    built_with: {},
    files: rigFiles,
    files_sha256: outputSetHash(rigFiles),
    built_from: [],
    run: rigRun,
    report: rigReport,
    rebuild: { recorded: false, note: 'synthetic rig producer' },
  };

  const backdrop = put(dir, 'inputs/backdrop.png', SYNTHETIC_PNG);
  const composeValue: JsonObject = {
    canvas: { width: 64, height: 48 },
    plates: [{ name: 'backdrop', image: 'inputs/backdrop.png', at: [0, 0], opaque_backdrop: true }],
    order: ['backdrop', 'actor'],
    character: { offset: [0, 0], scale: 1 },
    idle_tracks: [],
  };
  const shown = { label: PLATE_WORDS, effect: 'Use the recorded backdrop placement.' };
  const optionSet: JsonObject = {
    schema: OPTIONS_SPEC,
    id: 'synthetic-post-composition',
    question: 'post_composition',
    stage: 'post-interview',
    drafted_by: 'agent',
    drafted_at: '2026-11-26T08:10:00.000Z',
    context: {
      kind: 'current-rig',
      signoff_at: '2026-11-26T08:05:00.000Z',
      target: {
        subject: 'current.rig',
        record_sha256: sha256(JSON.stringify(sorted(rigNode))),
        files_sha256: rigNode.files_sha256,
      },
      config: put(dir, 'specs/rig/config.json', {}),
      run: rigRun,
    },
    assembly: { rule: 'single' },
    asks: [{
      id: 'post_composition',
      prompt: 'Choose composition',
      options: [
        { id: 'keep', kind: 'value', ...shown, fragment: { compose: composeValue }, recommended: true, reason: 'Synthetic layout' },
        { id: 'alternative', kind: 'value', ...shown, fragment: { compose: composeValue }, recommended: false },
        { id: 'other', kind: 'other', ...shown, recommended: false },
        { id: 'auto', kind: 'auto', ...shown, recommended: false },
      ],
    }],
  };
  const setBinding = put(dir, 'evidence/post-composition-options.json', optionSet);

  const template = readTemplate('project.json');
  const project: JsonObject = {
    schema: template.schema as string,
    name: 'synthetic-current-direction-correction',
    stage: 'direction-review',
    stage_values: template.stage_values as string[],
    inputs: [],
    interview: {
      held: true,
      post: {
        held: true,
        items: [
          {
            id: 'camera_depth',
            config: [],
            text: 'Synthetic camera question',
            guide: {
              delegated: false,
              by: 'user',
              at: '2026-11-26T08:15:00.000Z',
              verbatim: CAMERA_WORDS,
              value: { camera: 'fixed', depth: false },
              asks: [{ id: 'camera_depth', state: 'user' }],
            },
          },
          {
            id: 'post_timing',
            config: [],
            text: 'Synthetic timing question',
            guide: {
              delegated: false,
              by: 'user',
              at: '2026-11-26T08:15:00.000Z',
              verbatim: TIMING_WORDS,
              value: { seconds: 4, loop: true },
              asks: [{ id: 'post_timing', state: 'user' }],
            },
          },
          {
            id: 'post_composition',
            config: [],
            text: 'Synthetic composition question',
            guide: {
              delegated: false,
              by: 'user',
              at: '2026-11-26T08:15:00.000Z',
              verbatim: `${shown.label}\n${shown.effect}`,
              value: { compose: composeValue },
              asks: [{ id: 'post_composition', state: 'user' }],
              choice: { spec: CHOICE_SPEC, set: setBinding, picks: [{ ask: 'post_composition', option_id: 'keep', shown }] },
            },
          },
        ],
      },
    },
    plan: {
      steps: ['camera', 'timing'].map((id, index) => ({
        id,
        phase: 'post',
        order: index + 1,
        does: 'Author current direction',
        produces: CURRENT_DIRECTION_PATH,
        rests_on: [id === 'camera' ? 'camera_depth' : 'post_timing'],
        bar: 'current direction check passes',
        checkpoint_proposed: false,
        checkpoint: { delegated: false, by: 'user', at: '2026-11-26T08:15:00.000Z', verbatim: 'No checkpoint', value: false },
      })),
    },
    signoffs: [{
      stage: 'rig-review',
      checkpoint: null,
      by: 'owner',
      at: '2026-11-26T08:05:00.000Z',
      verbatim: 'Approve synthetic current rig.',
      source: 'owner chat, relayed',
      said_at: '2026-11-26T08:04:00Z',
      relayed_by: 'operator',
      target: (optionSet.context as JsonObject).target!,
    }],
    versions: [],
    current: { rig: rigNode },
  };
  put(dir, 'project.json', project);

  ownerLanguageCommand(['set', 'en', dir]);
  inputCommand(['add', backdrop.path, dir, '--origin', 'synthetic backdrop'], Date.parse('2026-11-26T08:17:00Z'));
  put(dir, 'evidence/post-approval.txt', 'Approve the post camera and timing steps.\n');
  signoffCommand(['post-interview', dir, '--by', 'user', '--steps', 'camera,timing', '--verbatim-file', join(dir, 'evidence/post-approval.txt')], Date.parse('2026-11-26T08:20:00Z'));

  put(dir, 'outputs/motion.next/frames.json', {
    spec: 'rigc-frames/1',
    sets: [{ dir: 'idle@1fps', animation: 'idle', fps: 1, sampled: 2, written: 2, stride: 1 }],
  });
  put(dir, 'outputs/motion.next/idle@1fps/f0000.png', SYNTHETIC_PNG);
  recordCommand(['motion', dir, '--from', 'outputs/motion.next'], Date.parse('2026-11-26T08:25:00Z'));

  const composeStage = 'derived/compose-input';
  for (const rel of ['check/check.json', 'rig/rig.json', 'rig/motion.json', 'rig/images/body.png']) {
    const src = `outputs/rig/${rel.replace(/^rig\//, '')}`;
    mkdirSync(dirname(join(dir, composeStage, rel)), { recursive: true });
    cpSync(join(dir, src), join(dir, composeStage, rel));
  }
  put(dir, `${composeStage}/parts.json`, {});

  const partsScene = 'specs/direction/compose-scene.json';
  put(dir, partsScene, {
    spec: 'spine-parts-scene/1',
    canvas: { width: 64, height: 48 },
    plates: [{ name: 'backdrop', image: '../../inputs/backdrop.png', at: [0, 0], opaque_backdrop: true, provenance: 'generated' }],
    characters: [{ id: 'actor', build: `../../${composeStage}`, offset: [0, 0], scale: 1 }],
    order: ['backdrop', 'actor'],
    animations: { idle: { duration: 4, tracks: [] } },
  });
  sceneCommand(['write', dir, '--compose-scene', partsScene], Date.parse('2026-11-26T08:30:00Z'));

  const baseCitations = {
    timing: { guide: 'post_timing', asks: ['post_timing'], quote: TIMING_WORDS },
    composition: { guide: 'post_composition', asks: ['post_composition'], quote: PLATE_WORDS },
  };
  put(dir, 'evidence/intent-initial.json', {
    take: { duration: 4, loop: true },
    citations: { ...baseCitations, camera: { guide: 'camera_depth', asks: ['camera_depth'], quote: 'Hold the centered rectangle.' } },
  });
  directionCommand(['write', dir, '--file', 'evidence/intent-initial.json'], Date.parse('2026-11-26T08:35:00Z'));
  stageComposeOutput(dir, partsScene, composeStage, 'outputs/direction.next', rigModelBinding.sha256 === '' ? '' : backdrop.sha256, 1);
  recordCommand(['direction', dir, '--from', 'outputs/direction.next', '--direction', CURRENT_DIRECTION_PATH], Date.parse('2026-11-26T08:40:00Z'));

  correctionCommand(['--adopt', dir], Date.parse('2026-11-26T08:45:00Z'));
  put(dir, 'words.txt', 'Keep the upper margin clear in the direction spec.\n');
  put(dir, 'reasoning.txt', 'Updated the direction spec citation and recomposed current.direction.\n');
  correctionCommand([
    'record', dir, '--id', 'frame', '--path', 'described', '--stage', 'direction-review',
    '--by', 'user', '--verbatim-file', join(dir, 'words.txt'),
  ], Date.parse('2026-11-26T08:50:00Z'));

  put(dir, 'evidence/intent-revised.json', {
    take: { duration: 4, loop: true },
    citations: { ...baseCitations, camera: { guide: 'camera_depth', asks: ['camera_depth'], quote: 'Keep the upper margin clear.' } },
  });
  directionCommand(['write', dir, '--file', 'evidence/intent-revised.json'], Date.parse('2026-11-26T08:55:00Z'));
  stageComposeOutput(dir, partsScene, composeStage, 'outputs/direction.next', backdrop.sha256, 2);
  recordCommand(['direction', dir, '--from', 'outputs/direction.next', '--direction', CURRENT_DIRECTION_PATH], Date.parse('2026-11-26T09:00:00Z'));

  correctionCommand([
    'resolve', 'frame', dir, '--by', 'agent', '--reasoning-file', join(dir, 'reasoning.txt'),
  ], Date.parse('2026-11-26T09:05:00Z'));

  const result: Record<string, Buffer> = {};
  const collect = (current: string, prefix = ''): void => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const key = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) collect(join(current, entry.name), key);
      else result[key] = readFileSync(join(current, entry.name));
    }
  };
  collect(dir);
  return result;
}

if (import.meta.main) {
  const { destination, check } = generatorArgs(
    import.meta.file,
    'usage: generate-current-direction-correction-fixture.ts <fresh directory> [--check]',
  );
  const files = generateCurrentDirectionCorrectionFixture(resolve(destination));
  const root = join(import.meta.dir, '../tests/fixtures/correction-current-direction');
  for (const [path, bytes] of Object.entries(files)) {
    const file = join(root, path);
    if (check) {
      if (!existsSync(file) || !readFileSync(file).equals(bytes)) throw Error(`${path}: current-direction correction fixture differs`);
    } else {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, bytes);
    }
  }
  if (check) {
    const walk = (current: string, prefix = ''): void => {
      if (!existsSync(current)) throw Error('checked current-direction correction fixture directory is missing');
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const key = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(join(current, entry.name), key);
        else if (!(key in files)) throw Error(`${key}: unexpected file in current-direction correction fixture`);
      }
    };
    walk(root);
  }
  console.log('current-direction correction reproduces through writers; checked fixture is synthetic shape-only');
}
