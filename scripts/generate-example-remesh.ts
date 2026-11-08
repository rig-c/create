/** A five-version synthetic lifecycle with a producer-made torso mesh, reopened to parts-review. */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { main } from '../src/cli.ts';
import { asArray, checkProject, collectItems, isObject } from '../src/check.ts';
import { applicableAsks, optionContext, OPTIONS_SPEC, sha256 } from '../src/choices.ts';
import { DIRECTION_SCENE_SPEC } from '../src/direction.ts';
import { currentScene, sceneReference } from '../src/scene.ts';
import { interviewStageOfGuide } from '../src/stages.ts';
import type { Json, JsonObject } from '../src/templates.ts';
import { partsPackage } from '../tests/parts-package.ts';
import { EXAMPLE_ANCHOR } from './example-time.ts';
import { generatorArgs } from './generator-args.ts';
import { generateExampleMeshDraft } from './generate-example-draft.ts';
import { checkExampleParts, generateExampleParts } from './generate-example-parts.ts';

export const REMESH_PARTS_REVIEW_LAPSES: readonly [string, string][] = [
  ['REOPEN_SIGNOFF_LAPSED', 'signoffs[3]'],
  ['REOPEN_SIGNOFF_LAPSED', 'signoffs[4]'],
  ['REOPEN_SIGNOFF_LAPSED', 'signoffs[5]'],
  ['REOPEN_SIGNOFF_LAPSED', 'signoffs[6]'],
  ['REOPEN_SIGNOFF_LAPSED', 'signoffs[7]'],
  ['REOPEN_VERDICT_LAPSED', 'versions[v3].verdicts[0]'],
  ['REOPEN_VERDICT_LAPSED', 'versions[v5].verdicts[0]'],
];

export function remeshFiles(dir: string, prefix = ''): Record<string, Buffer> {
  const files: Record<string, Buffer> = {};
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === '.git') continue;
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(files, remeshFiles(join(dir, entry.name), name));
    else files[name] = readFileSync(join(dir, entry.name));
  }
  return files;
}

function buildMeshRigCandidate(
  dir: string,
  parts: Record<string, Uint8Array>,
  amp: number,
  epochSeconds: string,
): Record<string, Buffer> {
  mkdirSync(dir, { recursive: true });
  for (const [path, bytes] of Object.entries(parts)) {
    const file = join(dir, 'input', path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, bytes);
  }
  const manifest = JSON.parse(Buffer.from(parts['parts.json']!).toString('utf8')) as {
    parts: { name: string; from: string }[];
  };
  const config = {
    key: 'synthetic',
    requirements: 'interview-requirements.json',
    assemble: {
      rig_scale: 1,
      plan: manifest.parts.map(part => [
        part.name,
        part.from.slice(0, part.from.indexOf(':')),
        part.from.slice(part.from.indexOf(':') + 1),
      ]),
    },
    bones: [{ name: 'body', parent: 'root', at: [64, 64] }],
    meshes: { torso: { grid: 16, r: 16, segments: [['body', [64, 8], [64, 72]]] } },
    regions: Object.fromEntries(manifest.parts.filter(part => part.name !== 'torso').map(part => [part.name, 'body'])),
    motion: { duration: 4, tracks: [{ bone: 'body', prop: 'translatey', amp, period: 4, phase: 0, base: 0 }] },
  };
  writeFileSync(join(dir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
  writeFileSync(
    join(dir, 'interview-requirements.json'),
    `${JSON.stringify({ spec: 'spine-parts-requirements/1', fps: 12, requirements: [], setup_painting: { required: true } }, null, 2)}\n`,
  );
  const env = { ...process.env, SOURCE_DATE_EPOCH: epochSeconds };
  const rigResult = Bun.spawnSync(
    [process.execPath, join(import.meta.dir, '../node_modules/@rig-c/parts/bin/rig-parts.cjs'),
      'rig', '--config', 'config.json', '--parts', 'input', '--out', 'out'],
    { cwd: dir, env, stdout: 'pipe', stderr: 'pipe', timeout: 600_000 },
  );
  if (rigResult.exitCode !== 0) throw new Error(`rig exit ${rigResult.exitCode}\n${rigResult.stdout}\n${rigResult.stderr}`);
  const buildResult = Bun.spawnSync(
    [process.execPath, join(import.meta.dir, '../node_modules/@rig-c/core/bin/rigc.cjs'),
      'build', '--rig', 'out/rig.json', '--motion', 'out/motion.json', '--out', 'out/check/build',
      '--profile', 'rig-play', '--pack', '--page-edges', 'free', '--pack-shape', 'polygon'],
    { cwd: dir, env, stdout: 'pipe', stderr: 'pipe', timeout: 600_000 },
  );
  if (buildResult.exitCode !== 0) throw new Error(`rigc build exit ${buildResult.exitCode}\n${buildResult.stdout}\n${buildResult.stderr}`);
  return {
    'config.json': readFileSync(join(dir, 'config.json')),
    'interview-requirements.json': readFileSync(join(dir, 'interview-requirements.json')),
    ...remeshFiles(join(dir, 'out'), 'out'),
  };
}

export function generateExampleRemesh(destination: string): Record<string, Buffer> {
  const scratch = resolve(destination);
  if (existsSync(scratch)) throw new Error('remesh generation needs a fresh directory');
  mkdirSync(scratch, { recursive: true });
  const dir = join(scratch, 'project');
  const originalCwd = process.cwd();
  let clock = EXAMPLE_ANCHOR;
  let now = clock;
  const tick = (): void => { now = clock; clock += 1000; };
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
    try { exit = main(args, now); } finally { process.stdout.write = stdout; process.stderr.write = stderr; }
    if (exit !== 0) throw new Error(`${args.join(' ')}: exit ${exit}\n${output}`);
    if (outputPath) write(outputPath, output);
  };
  const advance = (value: string, flags: string[] = []): void =>
    writer(['advance', value, '--by', 'user', '--verbatim-file', 'evidence/approval.txt', ...flags]);
  const sign = (name: string, flags: string[] = []): void =>
    writer(['signoff', name, '--by', 'user', '--verbatim-file', 'evidence/approval.txt', ...flags]);
  const addPlanStep = (id: string, phase: 'rig' | 'post', order: number, restsOn: string, checkpointProposed: boolean): void => {
    writer([
      'plan',
      'add',
      id,
      '--by',
      'agent',
      '--phase',
      phase,
      '--order',
      String(order),
      '--does',
      `Execute synthetic ${id}`,
      '--produces',
      `Synthetic ${id} output`,
      '--rests-on',
      restsOn,
      '--bar',
      'The synthetic output matches its declared input.',
      '--checkpoint-proposed',
      String(checkpointProposed),
    ]);
  };
  const runSteps = (ids: string[], checkpointStage?: { stage: string; step: string }): void => {
    for (const id of ids) {
      writer(['step-status', id, 'in-progress', '--by', 'agent']);
      writer(['step-status', id, 'at-checkpoint', '--by', 'agent']);
      if (checkpointStage && checkpointStage.step === id) {
        sign(checkpointStage.stage, ['--checkpoint', id]);
      }
      writer(['step-status', id, 'done', '--by', 'agent']);
    }
  };
  const choices = (phase: string): void => {
    const items = collectItems(load(), { collection: null }).filter(
      item => interviewStageOfGuide(item.id, item.kind === 'post', true) === phase,
    );
    for (const item of items) {
      tick();
      const project = load();
      const asks = applicableAsks(project, item, { asks: [] });
      const values: Record<string, Json> = {
        rig_type: 'character.idle',
        reference: 'none',
        camera_depth: { camera: 'push_in', depth: false },
        post_timing: { duration: 4, loop: false },
        post_composition: { framing: 'whole synthetic plate' },
      };
      const value = values[item.id] ?? {};
      const set: JsonObject = {
        schema: OPTIONS_SPEC,
        id: `remesh-${item.id}`,
        question: item.id,
        stage: phase,
        drafted_by: 'agent',
        drafted_at: new Date(now).toISOString(),
        context: optionContext(project, phase, now),
        assembly: { rule: item.kind === 'waypoint' ? 'merge' : 'single' },
        asks: asks.map((ask): JsonObject => ({
          id: ask,
          prompt: `Choose ${ask} for the synthetic plate.`,
          options: [
            {
              id: 'keep',
              kind: 'value',
              label: `Use the synthetic ${ask}`,
              effect: 'Keep the declared geometric example.',
              fragment: item.kind !== 'waypoint'
                ? value
                : ask === 'projection'
                  ? { project: 'core' }
                  : ask === 'ground'
                    ? { ground: 'plain' }
                    : { [ask]: `synthetic ${ask}` },
              recommended: true,
              reason: 'Matches the synthetic geometric inputs.',
            },
            {
              id: 'alternative',
              kind: 'value',
              label: `Change ${ask}`,
              effect: 'Use the alternate synthetic choice.',
              fragment: item.kind === 'waypoint' ? { [ask]: `alternate ${ask}` } : value,
              recommended: false,
            },
            { id: 'other', kind: 'other', label: 'Other', effect: 'Supply different words.', recommended: false },
            { id: 'auto', kind: 'auto', label: 'Delegate', effect: 'Ask the agent to decide.', recommended: false },
          ],
        })),
      };
      const path = `evidence/interview/${item.id}.json`;
      json(path, set);
      writer(['interview-options', item.id, '--file', path]);
      writer([
        'interview-answer',
        item.id,
        '--set',
        path,
        '--sha256',
        String(binding(path).sha256),
        '--by',
        'user',
        ...asks.flatMap(ask => ['--pick', `${ask}=keep`]),
      ]);
    }
  };
  try {
    tick();
    process.chdir(scratch);
    writer(['init', 'project', '--no-install']);
    process.chdir(dir);
    write('evidence/approval.txt', 'Approve this synthetic geometric example.\n');
    write('evidence/reopen.txt', 'Reopen the synthetic parts for remeshing.\n');
    const input = generateExampleParts(join(scratch, 'parts-producer'));
    write('inputs/painting.png', readFileSync(join(scratch, 'parts-producer/painting.png')));
    write('evidence/split-config.json', readFileSync(join(scratch, 'parts-producer/config.json')));
    writer(['input', 'add', 'inputs/painting.png', '--origin', 'synthetic, generated by generateExampleParts']);
    const manifest = JSON.parse(input['parts.json']!.toString()) as { parts: { name: string }[] };
    {
      const project = load();
      (project.split as JsonObject).parts = manifest.parts.map(part => ({
        name: part.name,
        label: 'rigid',
        note: 'Synthetic geometric block.',
      }));
      json('project.json', project);
    }
    choices('interview');
    addPlanStep('seethrough', 'rig', 1, 'seethrough', false);
    addPlanStep('assemble', 'rig', 2, 'assemble', true);
    sign('interview');
    advance('plan-approved');
    sign('plan-approved');
    advance('parts');
    runSteps(['seethrough', 'assemble'], { stage: 'parts', step: 'assemble' });

    const draft = generateExampleMeshDraft(join(scratch, 'draft-producer'), input);
    const draftRoot = 'derived/drafts/remesh';
    for (const [path, bytes] of Object.entries(input)) write(`${draftRoot}/input/${path}`, bytes);
    for (const [path, bytes] of Object.entries(draft)) write(`${draftRoot}/${path}`, bytes);
    write(`${draftRoot}/input/recomposite_rig.png`, readFileSync(join(scratch, 'parts-producer/assembled/render/recomposite_rig.png')));
    writer(['draft-rig', 'remesh', '--config', `${draftRoot}/config.json`, '--from', `${draftRoot}/out`, '--parts', `${draftRoot}/input`]);

    const partsDir = `${draftRoot}/input`;
    const partsCheck = checkExampleParts(join(dir, partsDir), join(scratch, 'parts-check-producer'));
    write('evidence/parts-check.json', partsCheck);
    const verdict = partsPackage({
      input,
      partsDir,
      verdict: 'evidence/parts-review.json',
      edit: v => { v.updatedAt = new Date(now).toISOString(); },
    });
    write('evidence/parts-review.json', verdict.files['evidence/parts-review.json']!);
    writer(['parts-review', '--draft', 'remesh', '--from-review-cli', '--by', 'user', '--', partsDir, '--verdict', 'evidence/parts-review.json']);
    writer(['structure-snapshot', '--draft', 'remesh', '--out', 'evidence/structure.json']);
    const diff = Bun.spawnSync(
      [process.execPath, join(import.meta.dir, '../node_modules/@rig-c/parts/bin/rig-parts.cjs'),
        'diff-components', '--stack', 'assembled/render/recomposite_rig.png', '--painting', 'painting.png', '--parts', 'assembled/rig/parts.json',
        '--floor', '2', '--threshold', '40', '--out', 'diff-components.json'],
      { cwd: join(scratch, 'parts-producer'), env: { ...process.env, SOURCE_DATE_EPOCH: String(Math.trunc(now / 1000)) }, stdout: 'pipe', stderr: 'pipe', timeout: 600_000 },
    );
    if (diff.exitCode !== 0) throw new Error(`diff-components exit ${diff.exitCode}: ${diff.stderr}`);
    const reportBytes = readFileSync(join(scratch, 'parts-producer/diff-components.json'));
    write('evidence/diff-components.json', reportBytes);
    const diffReport = JSON.parse(reportBytes.toString()) as { components: { id: string }[] };
    advance('parts-review', ['--parts-check', 'evidence/parts-check.json', '--parts', partsDir]);
    sign('parts-review', [
      '--draft',
      'remesh',
      '--structure-file',
      'evidence/structure.json',
      '--diff-report',
      'evidence/diff-components.json',
      ...diffReport.components.flatMap(c => ['--component', `${c.id}=in-painting:the generated synthetic painting contains this component`]),
    ]);

    advance('rigging-interview');
    choices('rigging-interview');
    for (const [index, id] of ['bones', 'meshes', 'constraints', 'motion'].entries()) {
      addPlanStep(id, 'rig', index + 3, id, false);
    }
    sign('rigging-interview');
    advance('rigging');
    runSteps(['bones', 'meshes', 'constraints', 'motion']);
    writer(['interview', '--check', '--json']);

    write('evidence/setup.png', readFileSync(join(scratch, 'parts-producer/assembled/render/recomposite_rig.png')));
    const sections: JsonObject = {};
    for (const name of ['assemble', 'bones', 'meshes', 'regions', 'motion']) {
      const guide = name === 'regions' ? 'meshes' : name;
      const item = collectItems(load(), { collection: null }).find(i => i.id === guide)!;
      const answer = item.raw as JsonObject;
      sections[name] = [{ entry: name, guide, quote: answer.verbatim as string, asks: asArray(answer.asks).filter(isObject).map(ask => ask.id) }];
    }
    const builtWith = Object.fromEntries(
      ['@rig-c/parts', '@rig-c/core'].map(name => [
        name,
        JSON.parse(readFileSync(join(import.meta.dir, '../node_modules', name, 'package.json'), 'utf8')).version as string,
      ]),
    );

    for (const [index, amp] of [0.4, 0.5, 0.6].entries()) {
      const n = index + 1;
      tick();
      const buildEpoch = String(Math.trunc(now / 1000));
      const built = buildMeshRigCandidate(join(scratch, `rig-producer-v${n}`), input, amp, buildEpoch);
      for (const [path, bytes] of Object.entries(input)) {
        write(`outputs/v${n}/out/${path}`, bytes);
      }
      for (const [path, bytes] of Object.entries(built)) {
        if (!path.startsWith('out/')) write(`evidence/v${n}/${path}`, bytes);
        else {
          const suffix = path.slice(4);
          write(`outputs/v${n}/out/${suffix.startsWith('check/') ? suffix : `rig/${suffix}`}`, bytes);
        }
      }
      const modelRelPath = `outputs/v${n}/out/check/build/skeleton.model.json`;
      const version: JsonObject = {
        n,
        kind: 'rig',
        rig_version: null,
        at: new Date(now).toISOString(),
        built_by: 'agent',
        built_with: builtWith,
        changed: `Build synthetic mesh rig candidate v${n} (amp=${amp}).`,
        outputs: [{ ...binding(modelRelPath), bytes: built['out/check/build/skeleton.model.json']!.length }],
        evidence: [{ kind: 'still', ...binding('evidence/setup.png'), camera: 'fixed', frame: 'setup' }],
        verdicts: [],
        answers_feedback: [],
        review_origin: null,
        provenance: { config: binding(`evidence/v${n}/config.json`), sections },
      };
      const project = load();
      project.versions = [...asArray(project.versions), version];
      json('project.json', project);
      writer(['review-package', String(n), '--config', `evidence/v${n}/config.json`, '--from', `outputs/v${n}/out`]);
    }

    advance('rig-review');
    writer(['review', '3', '--verdict', 'accepted', '--by', 'user', '--review', 'rig-review', '--verbatim-file', 'evidence/approval.txt', '--source', 'synthetic example']);
    sign('rig-review', ['--version', '3']);

    advance('post-interview');
    choices('post-interview');
    addPlanStep('camera', 'post', 7, 'camera_depth', false);
    addPlanStep('timing', 'post', 8, 'post_timing', false);
    addPlanStep('composition', 'post', 9, 'post_composition', false);
    sign('post-interview');
    advance('post');
    runSteps(['camera', 'timing', 'composition']);
    writer(['direction', '--adopt']);

    const cite = (id: string): JsonObject => {
      const answer = collectItems(load(), { collection: null }).find(i => i.id === id)!.raw as JsonObject;
      return { guide: id, asks: [id], quote: answer.verbatim as string };
    };
    write('inputs/background.png', input['parts/background.png']!);
    writer(['input', 'add', 'inputs/background.png', '--origin', 'synthetic background plate, generated by generateExampleParts']);
    json('evidence/scene-citations.json', { background: cite('post_composition') });
    writer(['scene', 'write', '--rig', '3', '--background', 'inputs/background.png', '--citations-file', 'evidence/scene-citations.json', '--by', 'user']);

    for (const [n, endInset] of [[4, 2], [5, 4]] as const) {
      const directionPath = `evidence/direction-input-v${n}.json`;
      const width = 128 - endInset * 2;
      json(directionPath, {
        schema: DIRECTION_SCENE_SPEC,
        scene: sceneReference(currentScene(load())!),
        rig: { version: 3, model: binding('derived/review/v3/out/check/build/skeleton.model.json') },
        take: { duration: 4, loop: false },
        camera: {
          space: 'rig-world-y-up',
          keys: [
            { time: 0, box: { x: -64, y: 0, width: 128, height: 128 }, easing: 'linear' },
            { time: 4, box: { x: -64 + endInset, y: endInset, width, height: width }, easing: 'hold' },
          ],
        },
        timing: { keys: [{ time: 0, source_time: 0, easing: 'linear' }, { time: 4, source_time: 4, easing: 'hold' }] },
        citations: { camera: cite('camera_depth'), timing: cite('post_timing') },
      });
      writer(['direction', 'write', String(n), '--file', directionPath, '--rig', '3']);
      writer(['direction', 'check', String(n), '--json']);
    }

    advance('direction-review');
    writer(['review', '5', '--verdict', 'accepted', '--by', 'user', '--review', 'direction-review', '--verbatim-file', 'evidence/approval.txt', '--source', 'synthetic example']);
    sign('direction-review', ['--version', '5']);
    advance('accepted');
    writer(['interview', '--check', '--json']);
    writer(['split-captions', '--config', 'evidence/split-config.json'], 'evidence/captions.json');

    const beforeReopen = checkProject(dir, undefined, { now });
    if (beforeReopen.refusals.length > 0 || beforeReopen.warnings.length > 0) {
      throw new Error(`expected 0 refusals and 0 warnings before reopen, got: ${JSON.stringify({ refusals: beforeReopen.refusals, warnings: beforeReopen.warnings })}`);
    }

    writer(['reopen', 'parts-review', '--by', 'user', '--verbatim-file', 'evidence/reopen.txt']);
    const afterReopen = checkProject(dir, undefined, { now });
    if (afterReopen.refusals.length > 0) {
      throw new Error(`expected 0 refusals after reopen, got: ${JSON.stringify(afterReopen.refusals)}`);
    }
    const actualLapses = afterReopen.warnings.map(f => [f.code, f.path]);
    if (JSON.stringify(actualLapses) !== JSON.stringify(REMESH_PARTS_REVIEW_LAPSES)) {
      throw new Error(`unexpected warnings after reopen: ${JSON.stringify(actualLapses)}`);
    }
    return remeshFiles(dir);
  } finally {
    process.chdir(originalCwd);
  }
}

if (import.meta.main) {
  const { destination, check } = generatorArgs(import.meta.file, 'usage: generate-example-remesh.ts <fresh dir> [--check]');
  const files = generateExampleRemesh(destination);
  const root = join(import.meta.dir, '../templates/example-remesh');
  if (check) {
    const committed = remeshFiles(root);
    if (JSON.stringify(Object.keys(committed)) !== JSON.stringify(Object.keys(files))) {
      throw new Error('remesh file inventory differs');
    }
    for (const [path, bytes] of Object.entries(files)) {
      if (!committed[path]!.equals(bytes)) throw new Error(`${path}: remesh differs`);
    }
    console.log('example remesh reproduces byte for byte through writers and producers');
  } else {
    for (const [path, bytes] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), bytes);
    }
    console.log('example remesh generated');
  }
}
