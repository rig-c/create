import { partsReviewCommand } from '../src/parts-review.ts';
import { inputCommand } from '../src/inputs.ts';
import { directionCommand } from '../src/direction-writers.ts';
import { DIRECTION_SCENE_SPEC } from '../src/direction.ts';
import { sceneCommand } from '../src/scene-writers.ts';
import { currentScene, sceneReference } from '../src/scene.ts';
import { splitCaptions } from '../src/split-captions.ts';
import { generatorArgs } from './generator-args.ts';
import { writeExampleReopened } from './generate-example-reopened.ts';
import { exampleTime, retimeExample } from './example-time.ts';
import { generateExampleDraft } from './generate-example-draft.ts';
import { checkExampleParts, generateExampleParts } from './generate-example-parts.ts';
import { correctionCommand } from '../src/correction-writers.ts';
/** Reproduce the new-order example's declarations through public writers on synthetic dated input. */
import { writeExampleChoices } from './example-choices.ts';
import { writeExampleLedger } from './example-ledger.ts';
import { sha256, CHOICE_ORDER_SPEC } from '../src/choices.ts';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { checkProject } from '../src/check.ts';
import { diffClassesCommand } from '../src/diff-classes.ts';
import { draftRigCommand } from '../src/drafts.ts';
import { reviewPackageCommand } from '../src/review-package.ts';
import { advanceCommand, stepStatusCommand } from '../src/progress-writers.ts';
import { signoffCommand } from '../src/signoff.ts';
import { STAGES, STAGE_VALUES } from '../src/stages.ts';
import { stepHash } from '../src/step-hash.ts';
import { structureSnapshotCommand } from '../src/structure-snapshot.ts';
import { readTemplate, type Json, type JsonObject } from '../src/templates.ts';
import { exampleDraftFiles, EXAMPLE_DRAFT, EXAMPLE_PARTS_CHECK } from '../tests/draft-fixture.ts';
import { partsPackage, EXAMPLE_PARTS_DIR, EXAMPLE_VERDICT } from '../tests/parts-package.ts';
import { preparedExampleFiles } from '../tests/prepared-fixture.ts';
import { reviewExampleFiles } from '../tests/review-fixture.ts';
import { EXAMPLE_DIFF_REPORT } from '../tests/diff-fixture.ts';
const obj = (v: Json | undefined): JsonObject => v as JsonObject;
const arr = (v: Json | undefined): Json[] => v as Json[];

export function generateExampleOrder(dir: string): { project: JsonObject; files: Record<string, string | Uint8Array> } {
  if (existsSync(dir)) throw new Error('example order needs a fresh scratch directory');
  mkdirSync(dir, { recursive: true });
  const original = retimeExample(readTemplate('legacy-example-project.json'));
  for (const signoff of arr(original.signoffs).map(obj)) {
    if (!signoff.step_hashes) continue;
    for (const id of Object.keys(obj(signoff.step_hashes))) {
      const step = arr(obj(original.plan).steps).map(obj).find(step => step.id === id)!;
      obj(signoff.step_hashes)[id] = stepHash(step);
    }
  }
  let p = structuredClone(original);
  const save = (): void => writeFileSync(join(dir, 'project.json'), `${JSON.stringify(p, null, 2)}\n`);
  const reload = (): void => { p = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject; };
  const write = (path: string, bytes: string | Uint8Array): void => { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), bytes); };
  const input = generateExampleParts(join(dir, 'producer'));
  const files = { ...exampleDraftFiles(input, generateExampleDraft(join(dir, 'draft-producer'), input)), ...partsPackage({ verdict: EXAMPLE_VERDICT, input, edit: verdict => { verdict.updatedAt = exampleTime('2026-11-11T10:15:00Z'); } }).files };
  const builtWith = Object.fromEntries(['@rig-c/parts', '@rig-c/core'].map(name => {
    const installed = JSON.parse(readFileSync(join(import.meta.dir, '../node_modules', name, 'package.json'), 'utf8')) as { version: string };
    return [name, installed.version];
  }));
  // Carry the diff-report stack at the draft recorder's candidate position.
  files[`${EXAMPLE_DRAFT}/input/recomposite_rig.png`] = files[`${EXAMPLE_PARTS_DIR}/recomposite_rig.png`]!;
  for (const [path, bytes] of Object.entries({ ...preparedExampleFiles(), ...reviewExampleFiles(), ...files })) write(path, bytes);
  for (const raw of arr(original.versions)) {
    const version = obj(raw);
    version.built_with = { ...builtWith };
    if (version.kind === 'rig') {
      const path = `evidence/v${String(version.n)}/interview-config.json`;
      const requirements = `evidence/v${String(version.n)}/interview-requirements.json`;
      files[path] = files[`${EXAMPLE_DRAFT}/config.json`]!;
      files[requirements] = files[`${EXAMPLE_DRAFT}/interview-requirements.json`]!;
      write(path,files[path] as string); write(requirements,files[requirements] as string);
      // Package the same producer population retained by the labelled draft.
      const reviewConfig = `evidence/v${String(version.n)}/review-config.json`;
      files[reviewConfig] = files[path]!; write(reviewConfig, files[path]!);
      const build = `outputs/v${String(version.n)}/out`;
      rmSync(join(dir, build), { recursive: true });
      for (const [file, bytes] of Object.entries(input)) { files[`${build}/${file}`] = bytes; write(`${build}/${file}`, bytes); }
      for (const [file, bytes] of Object.entries(files).filter(([file]) => file.startsWith(`${EXAMPLE_DRAFT}/out/`))) {
        const suffix = file.slice(`${EXAMPLE_DRAFT}/out/`.length);
        const dest = `${build}/${suffix.startsWith('check/') ? suffix : `rig/${suffix}`}`;
        files[dest] = bytes; write(dest, bytes);
      }
      const provenance = obj(version.provenance);
      provenance.config = {path,sha256:sha256(Buffer.from(files[path] as string))};
    } else {
      for (const entries of Object.values(obj(obj(version.provenance).sections))) for (const entry of arr(entries).map(obj)) entry.asks = [entry.guide as Json];
    }
  }
  const words = join(dir, 'words.txt');
  // Every writer runs at clock.now, the declared example instant of its act.
  const clock = { now: Number.NaN };
  const sign = (stage: string, at: string, flags: string[] = []): void => {
    clock.now = Date.parse(exampleTime(at)); writeFileSync(words, ['interview', 'post-interview', 'rig-review', 'direction-review'].includes(stage)
      ? String(arr(original.signoffs).map(obj).find(s => s.stage === stage)!.verbatim)
      : `Approve the synthetic ${stage} record.\n`);
    signoffCommand([stage, dir, '--by', 'user', '--verbatim-file', words, ...flags], clock.now); reload();
    if (p.stage === stage && !['parts-review', 'rig-review'].includes(stage)) {
      const next = STAGES[STAGES.findIndex(s => s.id === stage) + 1]!.id;
      advanceCommand([next, dir], clock.now); reload();
    }
  };
  const finish = (phase: string, ids?: string[]): void => {
    const steps = arr(obj(p.plan).steps).map(obj).filter(step => step.phase === phase && (ids === undefined || ids.includes(String(step.id))));
    for (const step of steps) for (const status of ['in-progress', 'at-checkpoint', 'done']) {
      stepStatusCommand([String(step.id), status, dir, '--by', 'agent'], clock.now); reload();
    }
  };
  p.stage = 'plan-approved'; p.stage_values = [...STAGE_VALUES]; p.versions = [];
  save(); clock.now = Date.parse(exampleTime('2026-11-05T00:00:00Z')); correctionCommand(['--adopt', dir], clock.now); reload();
  const painting = readFileSync(join(dir, 'producer/painting.png'));
  files['inputs/painting.png'] = painting;
  write('inputs/painting.png', painting);
  p.inputs = []; save();
  inputCommand(['add', 'inputs/preparation-source.svg', dir, '--origin', 'synthetic source painting'], clock.now);
  inputCommand(['add', 'inputs/painting.png', dir, '--origin', 'synthetic painting generated by generateExampleParts'], clock.now);
  reload();
  for (const raw of arr(p.derived).map(obj)) {
    for (const source of arr(raw.inputs ?? []).map(obj)) if (source.path === 'inputs/painting.png') source.sha256 = sha256(painting);
  }
  const interview = obj(p.interview);
  interview.order = { spec: CHOICE_ORDER_SPEC, adopted_at: exampleTime('2026-11-10T14:00:00Z'), choices_adopted_at: exampleTime('2026-11-10T14:00:00Z') };
  interview.question_set = String(obj(readTemplate('project.json').interview).question_set);
  interview.turn_question = obj(readTemplate('project.json').interview).turn_question!;
  const turn = arr(obj(readTemplate('project.json').interview).waypoints).map(obj).find(w => w.id === 'turn')!;
  arr(interview.waypoints).splice(arr(interview.waypoints).findIndex(w => obj(w).id === 'motion'), 0, turn);
  for (const item of arr(obj(interview.post).items).map(obj)) if (item.id === 'camera_depth') {
    item.config = [];
    item.text = 'Is the view fixed, or does it move along a camera-box path such as a push-in?';
  }
  for (const item of arr(obj(interview.post).items).map(obj)) item.guide = null;
  p.signoffs = [];
  for (const w of arr(interview.waypoints).map(obj)) if (['bones', 'meshes', 'constraints', 'motion'].includes(String(w.id))) w.guide = null;
  for (const s of arr(obj(p.plan).steps).map(obj)) { s.status = 'pending'; if (s.id === 'assemble') s.rests_on = ['assemble']; }
  p.stage = 'interview'; save(); Object.assign(files,writeExampleChoices(dir,'interview',clock)); reload(); sign('interview', '2026-11-10T14:20:00Z'); sign('plan-approved', '2026-11-10T16:05:00Z');
  p.stage = 'parts';
  arr(p.signoffs).push(...arr(original.signoffs).filter(s => obj(s).stage === 'parts'));
  save(); clock.now = Date.parse(String(arr(original.signoffs).map(obj).find(s => s.stage === 'parts')!.at));
  finish('rig', ['seethrough', 'assemble']);
  clock.now = Date.parse(exampleTime('2026-11-11T10:00:00Z'));
  draftRigCommand(['example', dir, '--config', `${EXAMPLE_DRAFT}/config.json`, '--from', `${EXAMPLE_DRAFT}/out`, '--parts', `${EXAMPLE_DRAFT}/input`], clock.now); reload();
  // The structure snapshot is the writer's: every meshes declaration of the draft the approved verdict covers.
  const receipt = JSON.parse(partsReviewCommand([dir, '--draft', 'example', '--from-review-cli', '--by', 'user', '--json', '--', EXAMPLE_PARTS_DIR,
    '--verdict', EXAMPLE_VERDICT], clock.now).stdout) as JsonObject;
  reload();
  const responsePath = String(obj(receipt.evidence).path);
  files[responsePath] = readFileSync(join(dir, responsePath));
  structureSnapshotCommand([dir, '--draft', 'example', '--out', 'evidence/structure-decisions.json']);
  files['evidence/structure-decisions.json'] = readFileSync(join(dir, 'evidence/structure-decisions.json'));
  // The producer's parts-stage check on the retained assembled root, bound by the advance.
  files[EXAMPLE_PARTS_CHECK] = checkExampleParts(join(dir, `${EXAMPLE_DRAFT}/input`), join(dir, 'parts-check-producer'));
  write(EXAMPLE_PARTS_CHECK, files[EXAMPLE_PARTS_CHECK]!);
  advanceCommand(['parts-review', dir, '--parts-check', EXAMPLE_PARTS_CHECK, '--parts', `${EXAMPLE_DRAFT}/input`], clock.now); reload();
  clock.now = Date.parse(exampleTime('2026-11-11T10:20:00Z'));
  diffClassesCommand([dir, '--diff-report', EXAMPLE_DIFF_REPORT,
    '--component', 'p10-n3=in-painting:the synthetic painting deliberately differs here', '--component', 'p1000-n3=in-painting:the synthetic painting deliberately differs here',
    '--by', 'agent'], clock.now); reload();
  sign('parts-review', '2026-11-11T10:20:00Z', ['--draft', 'example', '--structure-file', 'evidence/structure-decisions.json']);
  obj(p.plan).rigging_drafted_at = exampleTime('2026-11-11T11:05:00Z');
  for (const w of arr(obj(p.interview).waypoints).map(obj)) {
    if (!['bones', 'meshes', 'constraints', 'motion'].includes(String(w.id))) continue;
    const old = arr(obj(original.interview).waypoints).map(obj).find(x => x.id === w.id);
    const guide = structuredClone(obj(old?.guide));
    w.history = [...arr(w.history ?? []), structuredClone(guide)];
    guide.at = exampleTime('2026-11-11T11:00:00Z'); guide.verbatim = `Synthetic ${String(w.id)} answer after viewing the approved parts and structure.`; w.guide = guide;
  }
  save(); Object.assign(files,writeExampleChoices(dir,'rigging-interview',clock)); reload();
  advanceCommand(['rigging-interview', dir], clock.now); reload();
  sign('rigging-interview', '2026-11-11T11:10:00Z');
  sign('rigging-interview', '2026-11-12T10:30:00Z', ['--steps', 'bones,constraints']);
  // Retain the already writer-shaped synthetic execution/review history; new approvals are all writer-generated.
  arr(p.signoffs).push(...arr(original.signoffs).filter(s => obj(s).stage === 'rigging'));
  p.versions = original.versions as Json;
  // Original sparse controls are separate from the signed build packages.
  for (const version of arr(p.versions).map(obj).filter(v => v.kind === 'rig')) {
    const n = String(version.n);
    const packageRoot = `derived/review/v${n}`;
    // The generator materialised the independent controls above. Remove only
    // this fresh scratch copy before publishing the signed population.
    rmSync(join(dir, packageRoot), { recursive: true });
    save();
    const record = JSON.parse(reviewPackageCommand([n, dir, '--config', `evidence/v${n}/review-config.json`, '--from', `outputs/v${n}/out`, '--json']).stdout) as JsonObject;
    version.review_package = record;
    for (const entry of arr(record.files).map(obj)) {
      const path = `${packageRoot}/${String(entry.path)}`;
      files[path] = readFileSync(join(dir, path));
    }
  }
  p.stage = 'rigging';
  p.versions = arr(original.versions).filter(v => obj(v).kind === 'rig');
  save(); clock.now = Date.parse(String(arr(original.signoffs).map(obj).filter(s => s.stage === 'rigging').at(-1)!.at));
  finish('rig', ['bones', 'meshes', 'constraints', 'motion']);
  advanceCommand(['rig-review', dir], clock.now); reload();
  sign('rig-review', '2026-11-13T09:15:00Z', ['--version', '2']);
  p.versions = arr(original.versions).filter(v => obj(v).kind === 'rig');
  obj(p.interview).post = structuredClone(obj(original.interview).post as Json);
  for (const s of arr(obj(p.plan).steps).map(obj)) s.status = s.phase === 'post' ? 'pending' : 'done';
  save(); Object.assign(files,writeExampleChoices(dir,'post-interview',clock)); reload();
  advanceCommand(['post-interview', dir], clock.now); reload();
  save(); sign('post-interview', '2026-11-13T10:30:00Z');
  // The plate bytes are producer-generated and registered through input add.
  const background = 'evidence/scene-background.png';
  files[background] = input['parts/background.png']!; write(background, files[background]!);
  save(); inputCommand(['add', background, dir, '--origin', 'synthetic producer background plate'], clock.now); reload();
  const cite = (id: string): JsonObject => {
    const item = arr(obj(obj(p.interview).post).items).map(obj).find(item => item.id === id)!;
    return { guide: id, asks: [id], quote: obj(item.guide).verbatim! };
  };
  const citationsPath = 'evidence/scene-citations.json';
  files[citationsPath] = `${JSON.stringify({ background: cite('post_composition') }, null, 2)}\n`; write(citationsPath, files[citationsPath]!);
  save();
  sceneCommand(['write', '--rig', '2', '--background', background, '--citations-file', citationsPath, dir], clock.now); reload();
  const historicalPost = structuredClone(arr(original.versions).map(obj).find(version => version.kind === 'post')!);
  historicalPost.verdicts = [];
  p.versions = [...arr(p.versions), historicalPost];
  clock.now = Date.parse(String(historicalPost.at)); save();
  directionCommand(['--adopt', dir], clock.now); reload();
  const scene = currentScene(p)!;
  files[String(scene.path)] = readFileSync(join(dir, String(scene.path)));
  const model = `derived/review/v2/out/check/build/skeleton.model.json`;
  for (const originalPost of arr(original.versions).map(obj).filter(version => version.kind === 'post' && version.n !== historicalPost.n)) {
    const n = Number(originalPost.n);
    const doc: JsonObject = { schema: DIRECTION_SCENE_SPEC, scene: sceneReference(scene), rig: { version: 2, model: { path: model, sha256: sha256(readFileSync(join(dir, model))) } },
      take: { duration: 8, loop: true }, camera: { space: 'rig-world-y-up', keys: [{ time: 0, box: { x: n === 3 ? -64 : -60, y: 0, width: n === 3 ? 128 : 120, height: n === 3 ? 128 : 120 }, easing: 'linear' }] },
      timing: { keys: [{ time: 0, source_time: 0, easing: 'linear' }, { time: 8, source_time: 8, easing: 'hold' }] },
      citations: { camera: cite('camera_depth'), timing: cite('post_timing') } };
    const path = `evidence/direction-input-v${n}.json`;
    files[path] = `${JSON.stringify(doc, null, 2)}\n`; write(path, files[path]!);
    clock.now = Date.parse(String(originalPost.at));
    directionCommand(['write', String(n), dir, '--file', path, '--rig', '2'], clock.now); reload();
    files[`evidence/direction/v${n}.json`] = readFileSync(join(dir, `evidence/direction/v${n}.json`));
    save();
  }
  for (const originalPost of arr(original.versions).map(obj).filter(version => version.kind === 'post')) {
    const version = arr(p.versions).map(obj).find(version => version.n === originalPost.n)!;
    for (const key of ['changed', 'evidence', 'verdicts', 'answers_feedback', 'review_origin']) if (originalPost[key] !== undefined) version[key] = originalPost[key]!;
  }
  save();
  clock.now = Date.parse(exampleTime('2026-11-15T11:00:00Z'));
  finish('post');
  advanceCommand(['direction-review', dir], clock.now); reload();
  sign('direction-review', '2026-11-15T11:00:00Z', ['--version', '4']);
  // The owner fix the v1 bounce asked for goes into the fix ledger, and a later draft is recorded with a passing report.
  Object.assign(files, writeExampleLedger(dir, files, clock)); reload();
  p.stage = original.stage as Json; save();
  const checked = checkProject(dir, undefined, { now: clock.now });
  if (checked.refusals.length || checked.warnings.length) throw new Error(JSON.stringify({ refusals: checked.refusals, warnings: checked.warnings }));
  return { project: p, files };
}

/** Replace selected top-level values in place; never reserialize unrelated template blocks. */
export function replaceValue(text: string, key: string, value: Json): string {
  const marker = `  "${key}": `; const start = text.indexOf(marker);
  const formatted = key === 'signoffs' && Array.isArray(value) ? `[\n    ${value.map(v => JSON.stringify(v)).join(',\n    ')}\n  ]` : JSON.stringify(value, null, 2).replaceAll('\n', '\n  ');
  if (start < 0) return text.replace(/\n}\n$/, `,\n${marker}${formatted}\n}\n`);
  const from = start + marker.length; let depth = 0; let quoted = false; let escape = false; let end = from;
  for (; end < text.length; end++) {
    const c = text[end];
    if (quoted) { if (escape) escape = false; else if (c === '\\') escape = true; else if (c === '"') quoted = false; continue; }
    if (c === '"') quoted = true;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') { if (depth === 0) break; depth--; }
    else if ((c === ',' || c === '\n') && depth === 0) break;
  }
  return text.slice(0, from) + formatted + text.slice(end);
}

if (import.meta.main) {
  const { destination, check } = generatorArgs(import.meta.file, 'usage: generate-example-order.ts <fresh dir> [--check]');
  const generated = generateExampleOrder(resolve(destination));
  const root = join(import.meta.dir, '../templates');
  let text = readFileSync(join(root, 'legacy-example-project.json'), 'utf8');
  for (const key of ['stage_values', 'interview', 'plan', 'signoffs', 'diff_map', 'drafts', 'inputs', 'derived', 'versions', 'review_acts', 'advances', 'scenes', 'direction_contract', 'fix_ledger']) text = replaceValue(text, key, generated.project[key] as Json);
  text = text.replace(/("proposed_at":\s*)"([^"]+)"/, (_match, prefix: string, at: string) => `${prefix}${JSON.stringify(exampleTime(at))}`);
  text = text.replace('  "schema": "rig-create/project@0",', '  "schema": "rig-create/project@0",' + `\n  "corrections_contract": ${JSON.stringify(generated.project.corrections_contract)},\n  "corrections": [],`);
  const outputs: Record<string, string | Uint8Array> = { 'example-project.json': text };
  for (const [path, bytes] of Object.entries(generated.files)) {
    const rel = path.startsWith('evidence/interview/') ? `example-interview-options/${path.slice('evidence/interview/'.length)}` : path.startsWith(EXAMPLE_DRAFT) ? `example-draft/${path.slice(EXAMPLE_DRAFT.length + 1)}` : `example-draft/${path}`;
    outputs[rel] = bytes;
  }
  for (const [path, bytes] of Object.entries(outputs)) {
    if (check) { if (!readFileSync(join(root, path)).equals(Buffer.from(bytes))) throw new Error(`${path}: generated order differs`); }
    else { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), bytes); }
  }
  if (!check) {
    const receipts = join(root, 'example-draft/evidence/review-reads');
    const expected = new Set(Object.keys(outputs).filter(path => path.startsWith('example-draft/evidence/review-reads/')).map(path => path.slice('example-draft/evidence/review-reads/'.length)));
    if (existsSync(receipts)) for (const name of readdirSync(receipts)) if (!expected.has(name)) rmSync(join(receipts, name));
  }
  const captions = `${JSON.stringify(splitCaptions(join(root, 'example-project.json'), join(root, 'example-split/config.json')), null, 2)}\n`;
  const captionsFile = join(root, 'example-split/captions.json');
  if (check) { if (readFileSync(captionsFile, 'utf8') !== captions) throw new Error('example captions differ'); }
  else writeFileSync(captionsFile, captions);
  writeExampleReopened(join(resolve(destination), 'reopened'), check);
  console.log('new-order example and draft identities reproduce through the writers; 0 refusals, 0 warnings');
}
