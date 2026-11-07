import { generatorArgs } from './generator-args.ts';
import { writeExampleReopened } from './generate-example-reopened.ts';
import { exampleTime, retimeExample } from './example-time.ts';
import { generateExampleDraft } from './generate-example-draft.ts';
import { generateExampleParts } from './generate-example-parts.ts';
import { correctionCommand } from '../src/correction-writers.ts';
/** Reproduce the new-order example's declarations through public writers on synthetic dated input. */
import { writeExampleChoices } from './example-choices.ts';
import { sha256, CHOICE_ORDER_SPEC } from '../src/choices.ts';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { checkProject } from '../src/check.ts';
import { draftRigCommand } from '../src/drafts.ts';
import { reviewPackageCommand } from '../src/review-package.ts';
import { advanceCommand, stepStatusCommand } from '../src/progress-writers.ts';
import { signoffCommand } from '../src/signoff.ts';
import { STAGES, STAGE_VALUES } from '../src/stages.ts';
import { stepHash } from '../src/step-hash.ts';
import { STRUCTURE_SCHEMA } from '../src/structure.ts';
import { readTemplate, type Json, type JsonObject } from '../src/templates.ts';
import { exampleDraftFiles, EXAMPLE_DRAFT } from '../tests/draft-fixture.ts';
import { partsPackage, EXAMPLE_VERDICT } from '../tests/parts-package.ts';
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
      advanceCommand([next, dir, '--by', 'user', '--verbatim-file', words], clock.now); reload();
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
  const interview = obj(p.interview);
  interview.order = { spec: CHOICE_ORDER_SPEC, adopted_at: exampleTime('2026-11-10T14:00:00Z'), choices_adopted_at: exampleTime('2026-11-10T14:00:00Z') };
  const source = readFileSync(join(dir,'inputs/preparation-source.svg'));
  p.inputs = [{path:'inputs/preparation-source.svg',sha256:sha256(source),bytes:source.length,origin:'synthetic source painting'}];
  interview.question_set = String(obj(readTemplate('project.json').interview).question_set);
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
  const draft = obj(arr(p.drafts)[0]);
  files['evidence/structure-decisions.json'] = `${JSON.stringify({ schema: STRUCTURE_SCHEMA, draft_id: 'example', config: draft.config, entries: [] }, null, 2)}\n`;
  write('evidence/structure-decisions.json', files['evidence/structure-decisions.json'] as string);
  advanceCommand(['parts-review', dir, '--by', 'user', '--verbatim-file', words], clock.now); reload();
  sign('parts-review', '2026-11-11T10:20:00Z', ['--evidence', EXAMPLE_VERDICT, '--diff-report', EXAMPLE_DIFF_REPORT,
    '--component', 'p10-n3=in-painting:the synthetic painting deliberately differs here', '--component', 'p1000-n3=in-painting:the synthetic painting deliberately differs here',
    '--draft', 'example', '--structure-file', 'evidence/structure-decisions.json']);
  obj(p.plan).rigging_drafted_at = exampleTime('2026-11-11T11:05:00Z');
  for (const w of arr(obj(p.interview).waypoints).map(obj)) {
    if (!['bones', 'meshes', 'constraints', 'motion'].includes(String(w.id))) continue;
    const old = arr(obj(original.interview).waypoints).map(obj).find(x => x.id === w.id);
    const guide = structuredClone(obj(old?.guide));
    w.history = [...arr(w.history ?? []), structuredClone(guide)];
    guide.at = exampleTime('2026-11-11T11:00:00Z'); guide.verbatim = `Synthetic ${String(w.id)} answer after viewing the approved parts and structure.`; w.guide = guide;
  }
  save(); Object.assign(files,writeExampleChoices(dir,'rigging-interview',clock)); reload();
  advanceCommand(['rigging-interview', dir, '--by', 'user', '--verbatim-file', words], clock.now); reload();
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
  advanceCommand(['rig-review', dir, '--by', 'user', '--verbatim-file', words], clock.now); reload();
  sign('rig-review', '2026-11-13T09:15:00Z', ['--version', '2']);
  p.versions = original.versions as Json;
  obj(p.interview).post = structuredClone(obj(original.interview).post as Json);
  for (const s of arr(obj(p.plan).steps).map(obj)) s.status = s.phase === 'post' ? 'pending' : 'done';
  save(); Object.assign(files,writeExampleChoices(dir,'post-interview',clock)); reload();
  advanceCommand(['post-interview', dir, '--by', 'user', '--verbatim-file', words], clock.now); reload();
  save(); sign('post-interview', '2026-11-13T10:30:00Z');
  p.versions = original.versions as Json; save();
  clock.now = Date.parse(exampleTime('2026-11-15T11:00:00Z'));
  finish('post');
  advanceCommand(['direction-review', dir, '--by', 'user', '--verbatim-file', words], clock.now); reload();
  sign('direction-review', '2026-11-15T11:00:00Z', ['--version', '4']);
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
  for (const key of ['stage_values', 'interview', 'plan', 'signoffs', 'drafts', 'inputs', 'versions', 'advances']) text = replaceValue(text, key, generated.project[key] as Json);
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
  writeExampleReopened(join(resolve(destination), 'reopened'), check);
  console.log('new-order example and draft identities reproduce through the writers; 0 refusals, 0 warnings');
}
