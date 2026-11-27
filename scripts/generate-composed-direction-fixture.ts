/** Seal authored inputs and run a fresh composed post through Parts, Core, Review and Create. */
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { encodePng } from '@rig-c/core/plate';
import type { JobOwnerHost } from '@rig-c/review/job-host';
import type { CheckReport } from '../src/check.ts';
import type { NextReport } from '../src/next.ts';
import type { Json, JsonObject } from '../src/templates.ts';

const repo = realpathSync(join(import.meta.dir, '..'));
const fixtures = {
  default: join(repo, 'templates/example-composed-direction'),
  clip: join(repo, 'templates/example-composed-clip'),
} as const;
export type ComposedVariant = keyof typeof fixtures;
const id = 'composed';
const owner = 'synthetic-owner';
const build = 'evidence/compose-character';
const scene = 'compose.scene.json';
const manifest = 'review-live-v2.json';
const jsonBytes = (value: unknown): Buffer => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

export function inputBytes(variant: ComposedVariant = 'default'): Map<string, Buffer> {
  const clip = variant === 'clip';
  const inputs = new Map<string, Buffer>();
  const json = (path: string, data: unknown): void => { inputs.set(path, jsonBytes(data)); };
  const size = 128;
  const painting = new Uint8Array(size * size * 4);
  const blocks = [
    { name: 'background', tag: 'author:background', x: 0, y: 0, w: 128, h: 128, rgb: [32, 48, 64] },
    { name: 'torso', tag: 'topwear', x: 40, y: 56, w: 48, h: 64, rgb: [64, 144, 192] },
    { name: 'lantern', tag: 'author:lantern', x: 96, y: 72, w: 16, h: 24, rgb: [240, 176, 64] },
    { name: 'face', tag: 'face', x: 44, y: 16, w: 40, h: 32, rgb: [224, 176, 144] },
    { name: 'eye_r', tag: 'eyewhite-r', x: 50, y: 28, w: 8, h: 8, rgb: [240, 240, 240] },
    { name: 'eye_l', tag: 'eyewhite-l', x: 70, y: 28, w: 8, h: 8, rgb: [240, 240, 240] },
  ];
  const layers = blocks.map(({ name, tag, x, y, w, h, rgb }) => {
    const rgba = new Uint8Array(w * h * 4);
    const colour = [...rgb, 255];
    for (let row = 0; row < h; row++) for (let col = 0; col < w; col++) {
      rgba.set(colour, (row * w + col) * 4);
      painting.set(colour, ((row + y) * size + col + x) * 4);
    }
    const filename = `${name}.png`;
    inputs.set(`source/layers/${filename}`, Buffer.from(encodePng(w, h, rgba)));
    return { name: tag, filename, left: x, top: y, right: x + w, bottom: y + h, depth_median: null };
  });
  inputs.set('source/painting.png', Buffer.from(encodePng(size, size, painting)));
  json('source/layers/layers.json', { width: size, height: size, layers });
  const seethrough = { resolution: size, steps: 1, seed: 0, offload: false };
  const assemble = { rig_scale: 1, plan: blocks.map(({ name, tag }) => [name, 'full', tag]) };
  json('source/config.json', { key: 'synthetic-interview-parts', seethrough, assemble });
  json('rig/config.json', { key: 'synthetic', seethrough, assemble, requirements: 'interview-requirements.json',
    bones: [{ name: 'body', parent: 'root', at: [64, 64] }, { name: 'body_yaw_dial', parent: 'root', at: [0, 0] }],
    meshes: { torso: { grid: 16, r: 16, segments: [['body', [64, 8], [64, 72]]] } },
    regions: Object.fromEntries(blocks.filter(block => block.name !== 'torso').map(block => [block.name, 'body'])),
    constraints: [{ name: 'body_turn', type: 'slider', bone: 'body_yaw_dial', animation: 'body_turn', property: 'rotate',
      local: true, loop: false, from: -12, max: 12, to: 0, scale: 0.125 }],
    motion: { duration: 4, tracks: [{ bone: 'body', prop: 'translatey', amp: 0.9, period: 4, phase: 0, base: 0 }],
      animations_from: 'animations.json' } });
  json('rig/animations.json', { spec: 'rigc-motion/1', animations: { body_turn: { duration: 3,
    tracks: [{ bone: 'body', property: 'rotate', keys: [{ t: 0, v: [-3] }, { t: 1.5, v: [0] }, { t: 3, v: [3] }] }] } } });
  const requirements = { spec: 'spine-parts-requirements/1', fps: 12, requirements: [] };
  json('rig/interview-requirements.json', { ...requirements, setup_painting: { required: true } });
  json('rig/rig-check-requirements.json', { ...requirements, setup_painting: { required: true, rgb_tolerance: 40,
    regions: [{ name: 'whole-painting', box: [0, 0, size, size], max_pixels: 0 }] } });

  inputs.set('plates/background.png', inputs.get('source/layers/background.png')!);
  const rgba = new Uint8Array(20 * 20 * 4);
  for (let y = 0; y < 20; y++) for (let x = 0; x < 20; x++) {
    if (Math.abs(x - 9.5) + Math.abs(y - 9.5) < 9) rgba.set([235, 167, 79, 255], (y * 20 + x) * 4);
  }
  inputs.set('plates/foreground.png', Buffer.from(encodePng(20, 20, rgba)));
  const take = { duration: 4, loop: true };
  const compose = {
    canvas: { width: clip ? 96 : size, height: size },
    plates: [{ name: 'backdrop', image: 'inputs/background.png', at: [0, 0], opaque_backdrop: true },
      { name: 'foreground', image: 'inputs/foreground.png', at: [14, 88] }],
    order: ['backdrop', 'actor', 'foreground'],
    character: { offset: clip ? [-16, 0] : [0, 0] },
    idle_tracks: [{ bone: 'foreground', property: 'translate', keys: [{ t: 0, v: [0, 0] }, { t: 2, v: [3, 0] }, { t: 4, v: [0, 0] }] }],
  };
  json('post-composition.json', { compose });
  json('scene.json', { spec: 'spine-parts-scene/1', canvas: compose.canvas,
    plates: compose.plates.map(plate => ({ ...plate, provenance: 'generated' })), order: compose.order,
    characters: [{ id: 'actor', build, ...compose.character, ...(clip ? { canvas_clip: true } : {}) }],
    animations: { idle: { duration: take.duration, tracks: compose.idle_tracks } } });
  json('direction-intent.json', { rig: { version: 1 }, take,
    guides: { camera: 'camera_depth', timing: 'post_timing', composition: 'post_composition' } });
  inputs.set('approval/plan.txt', Buffer.from('Approve the plan for this synthetic figure.\n'));
  inputs.set('approval/parts.txt', Buffer.from('Approve the synthetic parts.\n'));
  inputs.set('approval/rig.txt', Buffer.from('Approve the synthetic rig in its setup pose.\n'));
  return inputs;
}

function files(root: string, prefix = ''): string[] {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap(entry => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return files(root, path);
    if (!entry.isFile()) throw Error(`${path}: expected a regular file`);
    return [path];
  }).sort();
}

function put(path: string, bytes: Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

/** Check the inventory and return the same bytes the producer will consume. */
export function checkInputFiles(root: string, variant: ComposedVariant = 'default'): Map<string, Buffer> {
  const expected = inputBytes(variant);
  const retained = new Map(files(root).map(path => [path, readFileSync(join(root, path))]));
  const differences = [...new Set([...expected.keys(), ...retained.keys()])].sort().flatMap(path => {
    const actual = retained.get(path);
    const generated = expected.get(path);
    if (generated === undefined) return [`extra ${path}`];
    if (actual === undefined) return [`missing ${path}`];
    return actual.equals(generated) ? [] : [`changed ${path}`];
  });
  if (differences.length) throw Error(`COMPOSED_INPUT_MISMATCH\n${differences.join('\n')}`);
  return retained;
}

function checkFixture(variant: ComposedVariant = 'default'): Map<string, Buffer> {
  const fixture = fixtures[variant];
  const expected = new Set(['README.md', 'inputs']);
  for (const entry of readdirSync(fixture, { withFileTypes: true })) {
    if (!expected.delete(entry.name) || (entry.name === 'inputs' ? !entry.isDirectory() : !entry.isFile())) {
      throw Error(`COMPOSED_INPUT_MISMATCH: unexpected fixture entry ${entry.name}`);
    }
  }
  if (expected.size) throw Error(`COMPOSED_INPUT_MISMATCH: missing fixture entries ${[...expected].join(', ')}`);
  return checkInputFiles(join(fixture, 'inputs'), variant);
}

function existingPath(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

function physicalPath(path: string): string {
  return existingPath(path) ? realpathSync(path) : join(physicalPath(dirname(path)), basename(path));
}

function insideRepo(path: string): boolean {
  const rel = relative(repo, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

function externalTarget(destination: string): string {
  const path = resolve(destination);
  const canonical = physicalPath(path);
  if (insideRepo(path) || insideRepo(canonical) || existingPath(path)) {
    throw Error('COMPOSED_OUTPUT_PATH: choose a fresh output directory outside the Create repository');
  }
  return canonical;
}

async function submit(host: JobOwnerHost, kind: 'parts-verdict' | 'review-verdict', words: string, {
  stage = 'rig-review', verdict = 'approved', picture,
}: { stage?: 'rig-review' | 'direction-review'; verdict?: 'approved' | 'changes-requested'; picture?: Buffer } = {}) {
  const { readHostActsAndAsks } = await import('../src/job-acts.ts');
  const { publication, generation } = host.session.status();
  if (!publication) throw Error('Review has no publication');
  const { publicationId, instanceKey, source: { sourceHash } } = publication;
  const { asks } = await readHostActsAndAsks(host);
  const matches = asks.filter(ask => ask.publicationId === publicationId && ask.subject.kind === kind && ask.status === 'pending');
  if (matches.length !== 1) throw Error(`Expected one ${kind} ask, found ${matches.length}`);
  const { askId } = matches[0]!;
  const pageId = crypto.randomUUID();
  const request = (route: string, body: object): Request =>
    new Request(`${host.origin}/jobs/${host.session.jobId}/ui/${route}`, {
      method: 'POST', headers: { origin: host.origin, 'X-Review-Capability': host.session.hostCredentials().ui,
        'content-type': 'application/json' }, body: JSON.stringify(body),
    });
  const displayed = await host.ports.ackDisplayed(host.session.jobId, request('displayed', { publicationId, pageId, sourceHash }));
  if (!displayed.ok) throw Error(`Review displayed: ${displayed.error.code}`);
  const value = kind === 'parts-verdict'
    ? { verdict: 'approved', issues: [], words }
    : { stage, verdict, words };
  const act = await host.ports.commitUIAct(host.session.jobId, request('acts', {
    publicationId, askId, pageId, displayedNonce: displayed.value.displayedNonce,
    expectedGeneration: generation, submissionId: crypto.randomUUID(), kind, value,
    ...(picture ? { capture: { png: `data:image/png;base64,${picture.toString('base64')}`,
      width: picture.readUInt32BE(16), height: picture.readUInt32BE(20),
      camera: 'fixed', framing: 'default', view: 'whole-rig', frame: 'setup', playing: false,
      binding: { publicationId, instanceKey, sourceHash, pageId, askId, drawGeneration: 1, playerGeneration: 0 } } } : {}),
  }));
  if (!act.ok) throw Error(`Review ${kind}: ${act.error.code}`);
  console.log(`Review ${kind}: ${act.value.schema} at ${act.value.at}`);
  return act.value;
}

async function generate(root: string, scratch: string, inputs: Map<string, Buffer>, reviseAfterBounce: boolean): Promise<string> {
  const [{ asArray, collectItems, isObject }, { main }, { applicableAsks, optionContext, OPTIONS_SPEC, sha256 },
    { agentCall, readHostActsAndAsks }, { openCreateJob, openDraftPublication }, { jobHostStateRoot }, { interviewStageOfGuide },
    { TURN_OPTIONS, TURN_QUESTION }, { EXAMPLE_ANCHOR, EXAMPLE_SOURCE_DATE_EPOCH }] = await Promise.all([
    import('../src/check.ts'), import('../src/cli.ts'), import('../src/choices.ts'), import('../src/job-acts.ts'),
    import('../src/job-host.ts'), import('../src/job-outbox.ts'), import('../src/stages.ts'), import('../src/waypoints.ts'), import('./example-time.ts'),
  ]);
  const source = join(scratch, 'source');
  const rigWorkspace = 'scratch/rig';
  const candidate = join(root, rigWorkspace);
  let now = EXAMPLE_ANCHOR;
  let host: JobOwnerHost | undefined;
  const bin = join(repo, 'node_modules/.bin');
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, SOURCE_DATE_EPOCH: EXAMPLE_SOURCE_DATE_EPOCH };
  const execute = async (tool: string, args: string[], cwd: string, at?: number) => {
    const entry = tool === 'rig-create' ? join(repo, 'tests/cli-at.ts') : join(bin, tool);
    const clock = at === undefined ? [] : [new Date(at).toISOString()];
    const child = Bun.spawn([process.execPath, entry, ...clock, ...args], {
      cwd, env, stdout: 'pipe', stderr: 'pipe', timeout: 120_000,
    });
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    console.log(`${tool} ${args.join(' ')} → ${exit}`);
    return { exit, stdout, stderr };
  };
  const requireSuccess = (result: Awaited<ReturnType<typeof execute>>): string => {
    if (result.exit !== 0) throw Error(result.stderr + result.stdout);
    if (result.stderr) console.log(result.stderr.trimEnd());
    return result.stdout;
  };
  const create = async (...args: string[]) => {
    const cwd = args[0] === 'init' ? scratch : root;
    ++now;
    if (host || args[0] === 'job') return execute('rig-create', args, cwd, now);
    const before = process.cwd();
    const stdoutWrite = process.stdout.write;
    const stderrWrite = process.stderr.write;
    let stdout = '';
    let stderr = '';
    try {
      process.chdir(cwd);
      process.stdout.write = ((chunk: string | Uint8Array) => { stdout += Buffer.from(chunk).toString(); return true; }) as typeof stdoutWrite;
      process.stderr.write = ((chunk: string | Uint8Array) => { stderr += Buffer.from(chunk).toString(); return true; }) as typeof stderrWrite;
      const exit = main(args, now);
      stdoutWrite.call(process.stdout, `rig-create ${args.join(' ')} → ${exit}\n`);
      return { exit, stdout, stderr };
    } finally {
      process.chdir(before);
      process.stdout.write = stdoutWrite;
      process.stderr.write = stderrWrite;
    }
  };
  const write = async (...args: string[]) => requireSuccess(await create(...args));
  const produce = async (cwd: string, tool: string, ...args: string[]) => requireSuccess(await execute(tool, args, cwd));
  const sign = (stage: string) => write('signoff', stage, '--by', owner, '--verbatim-file', 'evidence/approval.txt');
  const advance = (stage: string, ...args: string[]) => write('advance', stage, ...args);
  const project = (): JsonObject => JSON.parse(readFileSync(join(root, 'project.json'), 'utf8')) as JsonObject;
  const json = (path: string, value: unknown) => put(path, jsonBytes(value));
  const plan = async (phase: string, steps: ReadonlyArray<readonly [string, string]>, order: number) => {
    for (const [index, [step, guide]] of steps.entries()) await write('plan', 'add', step, '--by', 'agent', '--phase', phase,
      '--order', String(order + index), '--does', `Author the synthetic ${step}`, '--produces', `Synthetic ${step}`,
      '--rests-on', guide, '--bar', 'Match the recorded synthetic input.', '--checkpoint-proposed', 'false');
  };
  const done = async (steps: ReadonlyArray<readonly [string, string]>) => {
    for (const [step] of steps) {
      for (const status of ['in-progress', 'at-checkpoint', 'done']) await write('step-status', step, status, '--by', 'agent');
    }
  };
  const intent = JSON.parse(inputs.get('direction-intent.json')!.toString()) as {
    rig: { version: number }; take: { duration: number; loop: boolean }; guides: Record<string, string>;
  };
  const composition = JSON.parse(inputs.get('post-composition.json')!.toString()) as JsonObject;
  const choices = async (stage: string) => {
    const items = collectItems(project(), { collection: null }).filter(item => interviewStageOfGuide(item.id, item.kind === 'post', true) === stage);
    for (const item of items) {
      const before = project();
      const asks = applicableAsks(before, item, { asks: [] });
      const values: Record<string, Json> = {
        rig_type: 'character.idle', reference: 'none', camera_depth: { camera: 'fixed', depth: false },
        post_timing: { seconds: intent.take.duration, loop: intent.take.loop }, post_composition: composition,
      };
      const set: JsonObject = { schema: OPTIONS_SPEC, id: `composed-${item.id}`, question: item.id, stage,
        drafted_by: 'agent', drafted_at: new Date(now).toISOString(), context: optionContext(before, stage, now),
        assembly: { rule: item.kind === 'waypoint' ? 'merge' : 'single' },
        asks: asks.map((ask): JsonObject => {
          const fragment: Json = item.kind !== 'waypoint' ? values[item.id] ?? {} :
            ask === 'projection' ? { project: 'core' } : ask === 'ground' ? { ground: 'plain' } : { [ask]: `synthetic ${ask}` };
          return { id: ask, prompt: `Choose ${ask} for the synthetic figure.`, options: [
            { id: 'keep', kind: 'value', label: `Use the synthetic ${ask}`, effect: 'Use the declared values.', fragment,
              recommended: true, reason: 'Matches the synthetic inputs.' },
            { id: 'alternative', kind: 'value', label: `Change ${ask}`, effect: 'Use the other declared option.', fragment, recommended: false },
            { id: 'other', kind: 'other', label: 'Other', effect: 'Supply different words.', recommended: false },
            { id: 'auto', kind: 'auto', label: 'Delegate', effect: 'Ask the agent to decide.', recommended: false },
          ] };
        }) };
      if (item.id === 'turn') set.asks = [{ id: 'view', prompt: TURN_QUESTION,
        options: TURN_OPTIONS.map(option => ({ ...option, recommended: option.id === 'fixed',
          ...(option.id === 'fixed' ? { reason: 'Keep the synthetic painted view.' } : {}) })) as Json }];
      const path = `evidence/interview/${item.id}.json`;
      json(join(root, path), set);
      await write('interview-options', item.id, '--file', path);
      await write('interview-answer', item.id, '--set', path, '--sha256', sha256(readFileSync(join(root, path))), '--by', owner,
        ...asks.flatMap(ask => ['--pick', `${ask}=${item.id === 'turn' ? 'fixed' : 'keep'}`]));
    }
  };
  const cite = (guide: string): JsonObject => {
    const answer = collectItems(project(), { collection: null }).find(item => item.id === guide)?.raw;
    if (!isObject(answer) || typeof answer.verbatim !== 'string' || !Array.isArray(answer.asks)) throw Error(`Missing answer for ${guide}`);
    return { guide, quote: answer.verbatim, asks: answer.asks.filter(isObject).map(ask => ask.id!) };
  };
  const openPublication = async (target: { draft: string } | { kind: 'rig' | 'post'; version: number }) => {
    if (!host) throw Error('Review host did not start');
    const lines = 'draft' in target
      ? await openDraftPublication(root, host, ++now, target.draft)
      : await openDraftPublication(root, host, ++now, undefined, String(target.version));
    console.log(lines.join('\n'));
    const { publication } = host.session.status();
    const source = publication?.source;
    const selector = source && 'selector' in source ? source.selector : undefined;
    const matches = 'draft' in target
      ? selector?.kind === 'draft' && selector.id === target.draft
      : selector?.kind === target.kind && selector.version === target.version;
    if (!publication || !matches || source?.projectHash !== sha256(readFileSync(join(root, 'project.json')))) {
      throw Error(`Expected Review publication bound to the current project record for ${JSON.stringify(target)}`);
    }
    return publication;
  };
  const askHistoricalVerdict = async (stage: 'rig-review' | 'direction-review', version: number) => {
    if (!host || project().stage !== stage) throw Error(`Expected an open Review job at ${stage}`);
    const publication = await openPublication({ kind: stage === 'rig-review' ? 'rig' : 'post', version });
    const { generation, pending } = host.session.status();
    if (pending.some(ask => ask.publicationId === publication.publicationId && ask.status === 'pending')) {
      throw Error(`Expected an askless numbered publication at ${stage}`);
    }
    // Recreate a historical verdict ask through Review's package API in this fixture.
    const reply = await agentCall(host, {
      schema: 'rig-review/job-api@2', verb: 'ask', expectedGeneration: generation,
      publicationId: publication.publicationId, idempotencyKey: crypto.randomUUID(),
      subject: { kind: 'review-verdict', stage },
    });
    if (!reply.ok) throw Error(`Review historical ${stage} ask: ${JSON.stringify(reply.error)}`);
  };
  try {
    await write('init', root, '--no-install', '--owner-language', 'en');
    put(join(root, 'evidence/approval.txt'), inputs.get('approval/plan.txt')!);
    for (const [path, bytes] of inputs) {
      if (path.startsWith('source/')) put(join(scratch, path), bytes);
      if (path.startsWith('rig/')) put(join(candidate, path.slice('rig/'.length)), bytes);
    }
    await produce(source, 'rig-parts', 'assemble', '--source', 'painting.png', '--full', 'layers', '--config', 'config.json', '--out', 'assembled');
    const assembled = join(source, 'assembled/rig');
    const candidateInput = join(candidate, 'input');
    mkdirSync(candidateInput, { recursive: true });
    for (const path of ['parts.json', 'painting_in_rig.png', 'parts']) {
      cpSync(join(assembled, path), join(candidateInput, path), { recursive: true });
    }
    await produce(candidate, 'rig-parts', 'rig', '--config', 'config.json', '--parts', 'input', '--out', 'out');
    await produce(candidate, 'rigc', 'build', '--rig', 'out/rig.json', '--motion', 'out/motion.json', '--out', 'out/check/build',
      '--profile', 'rig-play', '--pack', '--page-edges', 'free', '--pack-shape', 'polygon');
    cpSync(join(source, 'painting.png'), join(root, 'inputs/painting.png'));
    await write('input', 'add', 'inputs/painting.png', '--painting', '--origin', 'Synthetic geometric painting.');
    await choices('interview');
    const partsSteps = [['seethrough', 'seethrough'], ['assemble', 'assemble']] as const;
    const rigSteps = [['bones', 'bones'], ['meshes', 'meshes'], ['constraints', 'constraints'], ['motion', 'motion']] as const;
    const postSteps = [['camera', 'camera_depth'], ['timing', 'post_timing'], ['composition', 'post_composition']] as const;
    await plan('rig', partsSteps, 1);
    await sign('interview');
    await advance('plan-approved');
    await sign('plan-approved');
    await advance('parts');
    await done(partsSteps);
    const draft = `derived/drafts/${id}`;
    mkdirSync(join(root, draft), { recursive: true });
    for (const path of ['config.json', 'animations.json', 'interview-requirements.json', 'input', 'out']) {
      cpSync(join(candidate, path), join(root, draft, path), { recursive: true });
    }
    cpSync(join(source, 'assembled/render/recomposite_rig.png'), join(root, draft, 'input/recomposite_rig.png'));
    await write('draft-rig', id, '--config', `${draft}/config.json`, '--from', `${draft}/out`, '--parts', `${draft}/input`);
    await produce(root, 'rig-parts', 'check-parts', '--parts', `${draft}/input`, '--out', 'scratch/parts-check');
    cpSync(join(root, 'scratch/parts-check/parts-check.json'), join(root, 'evidence/parts-check.json'));
    await write('structure-snapshot', '--draft', id);
    await produce(source, 'rig-parts', 'diff-components', '--stack', 'assembled/render/recomposite_rig.png', '--painting', 'painting.png',
      '--parts', 'assembled/rig/parts.json', '--floor', '2', '--threshold', '40', '--out', 'diff-components.json');
    cpSync(join(source, 'diff-components.json'), join(root, 'evidence/diff-components.json'));
    await advance('parts-review', '--parts-check', 'evidence/parts-check.json', '--parts', `${draft}/input`);
    const diff = JSON.parse(readFileSync(join(root, 'evidence/diff-components.json'), 'utf8')) as { components: { id: string }[] };
    await write('diff-classes', '--diff-report', 'evidence/diff-components.json', '--by', 'agent',
      ...diff.components.flatMap(component => ['--component', `${component.id}=in-painting:Part of the synthetic painting.`]));
    host = await openCreateJob(root, { id: owner, role: 'owner' }, now);
    await openPublication({ draft: id });
    const partsAct = await submit(host, 'parts-verdict', inputs.get('approval/parts.txt')!.toString());
    now = Math.max(now, Date.parse(partsAct.at));
    await write('parts-review', '--from-review', partsAct.actId);
    await write('job', 'close');
    host.stop();
    host = undefined;
    await advance('rigging-interview');
    await choices('rigging-interview');
    await plan('rig', rigSteps, 3);
    await sign('rigging-interview');
    await advance('rigging');
    await done(rigSteps);
    cpSync(join(source, 'painting.png'), join(candidate, 'painting.png'));
    mkdirSync(join(candidate, 'check'));
    cpSync(join(candidate, 'out'), join(candidate, 'check/out'), { recursive: true });
    now = Math.ceil(now / 1000) * 1000;
    env.SOURCE_DATE_EPOCH = String(now / 1000);
    await produce(candidate, 'rig-parts', 'check', '--rig', 'check/out', '--parts', 'input', '--source', 'painting.png',
      '--requirements', 'rig-check-requirements.json', '--out', 'check', '--no-extremes', '--keep-stills');
    await produce(candidate, 'rigc', 'render', '--candidate', 'check/build', '--out', 'idle', '--animation', 'idle', '--fps', '1', '--max', '32', '--poser', 'core');
    json(join(candidate, 'citations.json'), Object.fromEntries(['seethrough', 'assemble', 'bones', 'meshes', 'regions', 'constraints', 'motion']
      .map(section => [section, [{ entry: section, ...cite(section === 'regions' ? 'meshes' : section) }]])));
    const rigPath = (path: string) => `${rigWorkspace}/${path}`;
    cpSync(join(repo, 'bun.lock'), join(candidate, 'bun.lock'));
    await write('rig-version', 'adapter', '--config', rigPath('config.json'), '--out', rigPath('path-adapter.json'));
    await write('rig-version', '1', '--parts', rigPath('input'), '--rig', rigPath('check/out'), '--build', rigPath('check/build'),
      '--idle', rigPath('idle'), '--config', rigPath('config.json'), '--compile-report', rigPath('check/build-report.json'),
      '--path-adapter', rigPath('path-adapter.json'),
      '--toolchain-lock', rigPath('bun.lock'), '--check-report', rigPath('check/check.json'), '--run-record', rigPath('check/build/run.json'),
      '--at-source', rigPath('check/build/run.json'), '--at-pointer', '/finished_at', '--citations', rigPath('citations.json'), '--by', 'agent');
    await advance('rig-review');
    host = await openCreateJob(root, { id: owner, role: 'owner' }, now);
    await askHistoricalVerdict('rig-review', 1);
    const stillRoot = join(candidate, 'check/setup_still');
    const png = files(stillRoot).find(path => path.endsWith('/f0000.png'));
    if (!png) throw Error('Parts --keep-stills did not produce a setup PNG');
    const rigApproval = inputs.get('approval/rig.txt')!;
    const rigAct = await submit(host, 'review-verdict', rigApproval.toString(), { picture: readFileSync(join(stillRoot, png)) });
    now = Math.max(now, Date.parse(rigAct.at));
    await write('review', '1', '--from-review', rigAct.actId);
    // The historical ask on a view-only publication does not fold a signature.
    const rigApprovalPath = 'evidence/rig-approval.txt';
    put(join(root, rigApprovalPath), rigApproval);
    await write('signoff', 'rig-review', '--version', '1', '--by', owner, '--owner-chat', rigApprovalPath,
      '--said-at', rigAct.at, '--relayed-by', 'agent');
    await write('handoff', '--rig', '1');
    // Close the rig review before moving to post authoring.
    await write('job', 'close');
    host.stop();
    host = undefined;
    await advance('post-interview');
    await choices('post-interview');
    await plan('post', postSteps, 7);
    await sign('post-interview');
    await advance('post');
    await write('direction', '--adopt');
    for (const [path, bytes] of inputs) {
      if (!path.startsWith('plates/')) continue;
      const plate = `inputs/${basename(path)}`;
      put(join(root, plate), bytes);
      await write('input', 'add', plate, '--origin', 'Synthetic geometric plate.');
    }
    // Parts takes a build-shaped input. Copy its inputs beside the scene so
    // the registered rig output tree remains byte-for-byte sealed.
    const registered = join(root, 'outputs/v1/out');
    cpSync(registered, join(root, build), { recursive: true, filter: path => path !== join(registered, 'check') });
    put(join(root, build, 'check/check.json'), readFileSync(join(root, 'evidence/v1/registration/check.json')));
    env.SOURCE_DATE_EPOCH = EXAMPLE_SOURCE_DATE_EPOCH;
    const binding = (from: string, to: string) => ({ path: to, sha256: sha256(readFileSync(join(root, from))) });
    const preparePost = async (version: number, scenePath: string, output: string, directionPath: string): Promise<string[]> => {
      await produce(root, 'rig-parts', 'compose', '--scene', scenePath, '--out', output);
      const frozen = `outputs/v${version}/compose`;
      const binds = (path: string) => binding(`${output}/${path}`, `${frozen}/${path}`);
      json(join(root, directionPath), { schema: 'rig-create/direction@3', rig: intent.rig,
        compose: { scene: binding(scenePath, `evidence/compose-src/v${version}/scene.json`), out: frozen,
          report: binds('scene.json'), check: binds('check/check.json'), run: binds('compose-run.json') },
        model: binds('check/build/skeleton.model.json'), take: intent.take,
        citations: Object.fromEntries(Object.entries(intent.guides).map(([section, guide]) => [section, cite(guide)])) });
      return ['direction', 'write', String(version), '.', '--file', directionPath, '--rig', '1',
        '--compose-out', output, '--compose-scene', scenePath];
    };
    put(join(root, scene), inputs.get('scene.json')!);
    const firstPost = await preparePost(2, scene, 'scratch/compose', 'evidence/direction-input.json');
    await done(postSteps);
    console.log((await write(...firstPost)).trimEnd());
    await write('direction', 'check', '2');
    await advance('direction-review');
    const record = project();
    const checked = JSON.parse(await write('interview', '--check', '--json')) as CheckReport;
    const post = asArray(record.versions).filter(isObject).find(version => version.n === 2 && version.kind === 'post');
    if (record.stage !== 'direction-review' || checked.effective_stage !== 'direction-review' || !post
      || !Array.isArray(post.verdicts) || post.verdicts.length
      || asArray(record.signoffs).filter(isObject).some(signoff => signoff.stage === 'direction-review')
      || asArray(record.review_acts).filter(isObject).some(act => act.version === 2)) {
      throw Error('Expected live direction-review with neither a verdict nor a signoff on the new post');
    }
    if (checked.refusals.length || checked.warnings.length) throw Error(JSON.stringify(checked));
    host = await openCreateJob(root, { id: owner, role: 'owner' }, now);
    await askHistoricalVerdict('direction-review', 2);
    const { publication: published, pending } = host.session.status();
    const { acts } = await readHostActsAndAsks(host);
    const asks = pending.filter(ask => ask.publicationId === published?.publicationId && ask.status === 'pending');
    if (!published || !('selector' in published.source) || published.source.selector?.kind !== 'post' || published.source.selector.version !== 2
      || asks.length !== 1 || asks[0]!.subject.kind !== 'review-verdict' || asks[0]!.subject.stage !== 'direction-review'
      || acts.length !== 0) {
      throw Error('Expected exactly one pending direction verdict ask and no submitted acts');
    }
    console.log('direction-review: stored and effective; one fresh verdict ask, zero signoff asks, zero submitted acts');
    console.log('interview --check: 0 refusals, 0 warnings');
    if (reviseAfterBounce) {
      const verdict = await submit(host, 'review-verdict', 'Keep both plates still in the revised post.', {
        stage: 'direction-review', verdict: 'changes-requested',
      });
      now = Math.max(now, Date.parse(verdict.at));
      await write('review', '2', '--from-review', verdict.actId);
      await write('job', 'close');
      host.stop();
      host = undefined;

      // A signed step is replanned without an amendment (#981); probe it on a copy so this run's record is unchanged.
      const probeRoot = join(scratch, 'replan-signed');
      cpSync(root, probeRoot, { recursive: true });
      requireSuccess(await execute('rig-create', ['plan', 'revise', 'composition', '--by', 'agent', '--does', 'Change the signed composition.'], probeRoot, ++now));
      console.log('plan revise on a signed step: written without an amendment');

      const revised = structuredClone(composition);
      (revised.compose as JsonObject).idle_tracks = [];
      const previous = JSON.parse(readFileSync(join(root, 'evidence/interview/post_composition.json'), 'utf8')) as JsonObject;
      const previousAsk = asArray(previous.asks).filter(isObject)[0]!;
      const previousPick = asArray(previousAsk.options).filter(isObject).find(option => option.id === 'keep')!;
      const label = 'Keep both plates still';
      const setPath = 'evidence/interview/post_composition-002.json';
      json(join(root, setPath), {
        ...previous, id: 'composed-post_composition-002', drafted_at: new Date(now).toISOString(),
        context: optionContext(project(), 'post-interview', now, root),
        asks: [{ ...previousAsk, options: asArray(previousAsk.options).map(option => option === previousPick
          ? { ...previousPick, id: 'all-still', label, effect: 'Remove the plate motion tracks.', fragment: revised }
          : option) }],
      });
      const wordsPath = 'evidence/composition-revision.txt';
      put(join(root, wordsPath), Buffer.from(`${label}.\n`));
      const ownerChat = (path = wordsPath) => ['--by', owner, '--owner-chat', path, '--said-at', new Date(now).toISOString(), '--relayed-by', 'agent'];
      await write('interview-options', 'post_composition', '--file', setPath);
      const next = JSON.parse(await write('next', '--json')) as NextReport;
      if (next.stage !== 'direction-review' || next.effective_stage !== 'direction-review'
        || !next.moves.some(move => move.command?.includes('job open') && move.command.includes('--question post_composition'))
        || !next.moves.some(move => move.role === 'human' && move.command === null && move.act.includes('composed-post_composition-002'))
        || !next.moves.some(move => move.command?.startsWith('rig-create interview-answer post_composition ') && move.command.includes('--owner-chat'))
        || next.moves.some(move => move.command?.includes('direction write'))) {
        throw Error(`Expected next to request the revised composition pick before authoring: ${JSON.stringify(next)}`);
      }

      const otherRoot = join(scratch, 'wrong-stage');
      cpSync(root, otherRoot, { recursive: true });
      const otherPath = 'evidence/interview/reference-002.json';
      const reference = JSON.parse(readFileSync(join(root, 'evidence/interview/reference.json'), 'utf8')) as JsonObject;
      json(join(otherRoot, otherPath), { ...reference, id: 'composed-reference-002', drafted_at: new Date(now).toISOString(),
        context: optionContext(project(), 'interview', now) });
      requireSuccess(await execute('rig-create', ['interview-options', 'reference', '--file', otherPath], otherRoot, ++now));
      const wrongStage = await execute('rig-create', ['job', 'open', '--question', 'reference', '--reviewer', owner, '--role', 'owner'], otherRoot, ++now);
      if (wrongStage.exit !== 1 || !wrongStage.stderr.includes('JOB_RECORD_SUBJECT_INVALID')) {
        throw Error(`Expected the pending interview-stage reference to refuse at direction-review: ${wrongStage.stderr}`);
      }
      const pauseWords = 'evidence/pause.txt';
      put(join(otherRoot, pauseWords), Buffer.from('Pause this project.\n'));
      const pauseAuthority = ['--by', owner, '--verbatim-file', pauseWords];
      requireSuccess(await execute('rig-create', ['signoff', 'paused', ...pauseAuthority], otherRoot, ++now));
      requireSuccess(await execute('rig-create', ['pause', ...pauseAuthority], otherRoot, ++now));
      const pausedCheck = JSON.parse(requireSuccess(await execute('rig-create', ['interview', '--check', '--json'], otherRoot, ++now))) as typeof checked;
      const paused = await execute('rig-create', ['job', 'open', '--question', 'post_composition', '--reviewer', owner, '--role', 'owner'], otherRoot, ++now);
      if (pausedCheck.effective_stage !== 'direction-review' || paused.exit !== 1 || !paused.stderr.includes('JOB_RECORD_SUBJECT_INVALID')) {
        throw Error(`Expected direction-review picks to refuse while paused: ${paused.stderr}`);
      }

      host = await openCreateJob(root, { id: owner, role: 'owner' }, now);
      await write('job', 'open', '--question', 'post_composition', '--reviewer', owner, '--role', 'owner');
      await write('job', 'open', '--questions', '--reviewer', owner, '--role', 'owner');
      if ((await readHostActsAndAsks(host)).asks.length !== 0) {
        throw Error('Expected option-set publication to open no interview-picks asks');
      }
      await write('interview-answer', 'post_composition', '--set', setPath, '--sha256', sha256(readFileSync(join(root, setPath))),
        '--pick', 'post_composition=all-still', ...ownerChat());
      await write('job', 'close');
      host.stop();
      host = undefined;
      const stale = JSON.parse((await create('interview', '--check', '--json')).stdout) as typeof checked;
      if (!stale.refusals.some(finding => finding.code === 'SIGNOFF_ANSWERS_STALE'
        && finding.path.endsWith('.answer_hashes[post_composition]'))) throw Error(JSON.stringify(stale));
      await write('amend', 'post-interview', '--kind', 'interview-answer', '--target', 'post_composition', '--change', setPath, ...ownerChat());
      const awaitingPlan = JSON.parse((await create('interview', '--check', '--json')).stdout) as typeof checked;
      if (!awaitingPlan.refusals.some(finding => finding.code === 'PLAN_STEP_PREDATES_ANSWER'
        && finding.path === 'plan.steps[composition]')) throw Error('Expected PLAN_STEP_PREDATES_ANSWER until the composition step is replaced');

      const completed = asArray((project().plan as JsonObject).steps).filter(isObject).find(step => step.id === 'composition');
      if (!completed) throw Error('Expected a retained composition step after amendment');
      await write('plan', 'remove', 'composition', '--by', 'agent');
      await write('plan', 'add', 'composition', '--by', 'agent', '--phase', 'post', '--order', String(completed.order),
        '--does', 'Keep both plates still in the revised post.', '--produces', String(completed.produces), '--rests-on', 'post_composition',
        '--bar', String(completed.bar), '--checkpoint-proposed', String(completed.checkpoint_proposed));
      await write('signoff', 'post-interview', '--steps', 'composition', ...ownerChat());
      const replanned = JSON.parse(await write('interview', '--check', '--json')) as typeof checked;
      if (replanned.refusals.length !== 0) throw Error(JSON.stringify(replanned));

      const revisedScene = JSON.parse(inputs.get('scene.json')!.toString()) as JsonObject;
      ((revisedScene.animations as JsonObject).idle as JsonObject).tracks = [];
      const revisedScenePath = 'compose-v3.scene.json';
      json(join(root, revisedScenePath), revisedScene);
      const secondPost = await preparePost(3, revisedScenePath, 'scratch/compose-v3', 'evidence/direction-v3-input.json');
      const beforeReapproval = JSON.parse(await write('next', '--json')) as import('../src/next.ts').NextReport;
      if (beforeReapproval.refusals.length !== 0
        || !beforeReapproval.moves.some(move => move.role === 'human'
          && move.command?.startsWith('rig-create signoff post-interview ')
          && move.command.includes(' --steps camera,timing '))
        || beforeReapproval.moves.some(move => move.command?.startsWith('rig-create direction write '))) {
        throw Error(`Expected camera and timing reapproval before direction write: ${JSON.stringify(beforeReapproval)}`);
      }
      console.log('next: human signoff post-interview --steps camera,timing; direction write withheld');
      const beforeRetry = readFileSync(join(root, 'project.json'));
      const refused = await create(...secondPost, '--answers', '2:0');
      if (refused.exit !== 1 || !refused.stderr.includes('DIRECTION_CITATION: plan.steps[camera]')
        || !readFileSync(join(root, 'project.json')).equals(beforeRetry)) {
        throw Error(`Expected camera citation refusal and unchanged project.json: ${refused.stderr}`);
      }
      console.log(refused.stderr.trim());

      const otherStepsApproval = 'evidence/camera-timing-reapproval.txt';
      put(join(root, otherStepsApproval), Buffer.from('Approve the existing camera and timing for the revised post.\n'));
      await write('signoff', 'post-interview', '--steps', 'camera,timing', ...ownerChat(otherStepsApproval));
      const afterReapproval = JSON.parse(await write('next', '--json')) as typeof beforeReapproval;
      if (!afterReapproval.moves.some(move => move.command?.startsWith('rig-create direction write 3 ')
        && move.command.endsWith(' --answers 2:0'))) {
        throw Error(`Expected direction write after camera and timing reapproval: ${JSON.stringify(afterReapproval)}`);
      }
      console.log('next: direction write 3 offered with --answers 2:0 after reapproval');
      await done([['composition', 'post_composition']]);
      await write(...secondPost, '--answers', '2:0');
      await write('direction', 'check', '2');
      await write('direction', 'check', '3');
      const revisionCheck = JSON.parse(await write('interview', '--check', '--json')) as typeof checked;
      if (revisionCheck.effective_stage !== 'direction-review' || revisionCheck.refusals.length || revisionCheck.warnings.length) {
        throw Error(JSON.stringify(revisionCheck));
      }

      // The bounce leaves the stage at direction-review. A new verdict and
      // signature authorize the next forward advance, to accepted.
      host = await openCreateJob(root, { id: owner, role: 'owner' }, now);
      await askHistoricalVerdict('direction-review', 3);
      const verdictPublicationId = host.session.status().publication?.publicationId;
      const approvalWords = 'Approve the revised post with both plates still.';
      const approval = await submit(host, 'review-verdict', approvalWords, { stage: 'direction-review' });
      now = Math.max(now, Date.parse(approval.at));
      await write('review', '3', '--from-review', approval.actId);
      const approvalPath = 'evidence/direction-approval.txt';
      put(join(root, approvalPath), Buffer.from(approvalWords));
      await write('signoff', 'direction-review', '--by', owner, '--owner-chat', approvalPath,
        '--said-at', new Date(now).toISOString(), '--relayed-by', 'agent');
      await advance('accepted');
      const acceptedPublication = await openPublication({ kind: 'post', version: 3 });
      if (acceptedPublication.publicationId === verdictPublicationId
        || host.session.status().pending.some(ask => ask.publicationId === acceptedPublication.publicationId && ask.status === 'pending')) {
        throw Error('Expected the accepted v3 record on the published post, with no pending asks');
      }
      const finalCheck = JSON.parse(await write('interview', '--check', '--json')) as typeof checked;
      if (finalCheck.effective_stage !== 'accepted' || finalCheck.refusals.length || finalCheck.warnings.length) throw Error(JSON.stringify(finalCheck));
      console.log('accepted: revised post v3 published from the advanced record with 0 refusals and 0 warnings');
    }
    await write('job', 'close');
  } finally {
    host?.stop();
    if (existsSync(root)) rmSync(jobHostStateRoot(root), { recursive: true, force: true });
  }
  for (const path of ['.git', '.rig-create-review', 'scratch']) rmSync(join(root, path), { recursive: true, force: true });
  return sha256(readFileSync(join(root, reviseAfterBounce ? 'review-live-v3.json' : manifest)));
}

async function runProject(destination: string, variant: ComposedVariant = 'default', reviseAfterBounce = false): Promise<void> {
  const target = externalTarget(destination);
  const inputs = checkFixture(variant);
  const parent = dirname(target);
  mkdirSync(parent, { recursive: true });
  if (realpathSync(parent) !== parent) throw Error('COMPOSED_OUTPUT_PATH: output parent changed');
  mkdirSync(target);
  let scratch: string | undefined;
  let complete = false;
  try {
    scratch = mkdtempSync(join(parent, '.create-composed-direction-'));
    const digest = await generate(target, scratch, inputs, reviseAfterBounce);
    console.log(`Project ${target}\nManifest ${join(target, reviseAfterBounce ? 'review-live-v3.json' : manifest)}\nManifest SHA-256 ${digest}`);
    complete = true;
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    if (!complete) rmSync(target, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const raw = process.argv.slice(2);
  let variant: ComposedVariant = 'default';
  let reviseAfterBounce = false;
  let bad: string | undefined;
  const positional: string[] = [];
  for (const arg of raw) {
    if (arg === '--clip') {
      if (variant === 'clip') { bad ??= arg; break; }
      variant = 'clip';
    } else if (arg === '--revise-after-bounce') {
      if (reviseAfterBounce) { bad ??= arg; break; }
      reviseAfterBounce = true;
    } else positional.push(arg);
  }
  const [mode, ...extra] = positional;
  bad ??= !mode ? '(missing destination)' : mode.startsWith('-') && !['--check', '--write-inputs'].includes(mode) ? mode : extra[0];
  if (reviseAfterBounce && mode?.startsWith('-')) bad ??= '--revise-after-bounce';
  if (bad !== undefined) {
    const error = new Error(`${basename(import.meta.path)}: invalid argument ${JSON.stringify(bad)}.\n`
      + 'usage: generate-composed-direction-fixture.ts [--clip] (--check | --write-inputs | [--revise-after-bounce] <fresh directory outside the repository>)');
    error.name = 'GENERATOR_ARGS_INVALID';
    throw error;
  }
  const label = variant === 'clip' ? 'Clipped composed direction inputs' : 'Composed direction inputs';
  if (mode === '--check') console.log(`${label}: ${checkFixture(variant).size} files match byte for byte`);
  else if (mode === '--write-inputs') {
    const root = join(fixtures[variant], 'inputs');
    if (physicalPath(root) !== root) throw Error('COMPOSED_INPUT_MISMATCH: input directory resolves through a symlink');
    if (existsSync(root)) files(root);
    for (const [path, bytes] of inputBytes(variant)) put(join(root, path), bytes);
    console.log(`${label}: wrote ${checkFixture(variant).size} files`);
  } else await runProject(mode!, variant, reviseAfterBounce);
}
