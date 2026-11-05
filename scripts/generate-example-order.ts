/** Reproduce the new-order example's declarations through public writers on synthetic dated input. */
import { setSystemTime } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { checkProject } from '../src/check.ts';
import { draftRigCommand } from '../src/drafts.ts';
import { signoffCommand } from '../src/signoff.ts';
import { STAGE_ORDER_SPEC, STAGE_VALUES } from '../src/stages.ts';
import { STRUCTURE_SCHEMA } from '../src/structure.ts';
import { readTemplate, type Json, type JsonObject } from '../src/templates.ts';
import { exampleDraftFiles, EXAMPLE_DRAFT } from '../tests/draft-fixture.ts';
import { partsPackage, EXAMPLE_VERDICT } from '../tests/parts-package.ts';
import { preparedExampleFiles } from '../tests/prepared-fixture.ts';
import { reviewExampleFiles } from '../tests/review-fixture.ts';
import { EXAMPLE_DIFF_REPORT } from '../tests/diff-fixture.ts';
const obj = (v: Json | undefined): JsonObject => v as JsonObject;
const arr = (v: Json | undefined): Json[] => v as Json[];

export function generateExampleOrder(dir: string): { project: JsonObject; files: Record<string, string> } {
  if (existsSync(dir)) throw new Error('example order needs a fresh scratch directory');
  mkdirSync(dir, { recursive: true });
  const original = readTemplate('legacy-example-project.json');
  let p = structuredClone(original);
  const save = (): void => writeFileSync(join(dir, 'project.json'), `${JSON.stringify(p, null, 2)}\n`);
  const reload = (): void => { p = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject; };
  const write = (path: string, bytes: string | Uint8Array): void => { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), bytes); };
  const files = exampleDraftFiles();
  for (const [path, bytes] of Object.entries({ ...preparedExampleFiles(), ...reviewExampleFiles(), ...partsPackage({ verdict: EXAMPLE_VERDICT }).files, ...files })) write(path, bytes);
  const words = join(dir, 'words.txt');
  const sign = (stage: string, at: string, flags: string[] = []): void => {
    setSystemTime(new Date(at)); writeFileSync(words, `Approve the synthetic ${stage} record.\n`);
    signoffCommand([stage, dir, '--by', 'user', '--verbatim-file', words, ...flags]); reload();
  };
  try {
    p.stage = 'plan-approved'; p.stage_values = [...STAGE_VALUES]; p.versions = [];
    const interview = obj(p.interview);
    interview.order = { spec: STAGE_ORDER_SPEC, adopted_at: '2026-11-10T14:20:00Z' };
    interview.question_set = String(obj(readTemplate('project.json').interview).question_set);
    p.signoffs = arr(original.signoffs).filter(s => obj(s).stage === 'interview');
    for (const w of arr(interview.waypoints).map(obj)) if (['bones', 'meshes', 'constraints', 'motion'].includes(String(w.id))) w.guide = null;
    for (const s of arr(obj(p.plan).steps).map(obj)) { s.status = 'pending'; if (s.id === 'assemble') s.rests_on = ['assemble']; }
    save(); sign('plan-approved', '2026-11-10T16:05:00Z');
    p.stage = 'parts';
    for (const s of arr(obj(p.plan).steps).map(obj)) if (['seethrough', 'assemble'].includes(String(s.id))) s.status = 'done';
    arr(p.signoffs).push(...arr(original.signoffs).filter(s => obj(s).stage === 'parts'));
    save(); setSystemTime(new Date('2026-11-11T10:00:00Z'));
    draftRigCommand(['example', dir, '--config', `${EXAMPLE_DRAFT}/config.json`, '--from', `${EXAMPLE_DRAFT}/out`, '--parts', `${EXAMPLE_DRAFT}/input`]); reload();
    const draft = obj(arr(p.drafts)[0]);
    files['evidence/structure-decisions.json'] = `${JSON.stringify({ schema: STRUCTURE_SCHEMA, draft_id: 'example', config: draft.config, entries: [] }, null, 2)}\n`;
    write('evidence/structure-decisions.json', files['evidence/structure-decisions.json'] as string);
    p.stage = 'parts-review'; save();
    sign('parts-review', '2026-11-11T10:20:00Z', ['--evidence', EXAMPLE_VERDICT, '--diff-report', EXAMPLE_DIFF_REPORT,
      '--component', 'p10-n3=in-painting:the synthetic painting deliberately differs here', '--component', 'p1000-n3=in-painting:the synthetic painting deliberately differs here',
      '--draft', 'example', '--structure-file', 'evidence/structure-decisions.json']);
    p.stage = 'rigging-interview'; obj(p.plan).rigging_drafted_at = '2026-11-11T11:05:00Z';
    for (const w of arr(obj(p.interview).waypoints).map(obj)) {
      if (!['bones', 'meshes', 'constraints', 'motion'].includes(String(w.id))) continue;
      const old = arr(obj(original.interview).waypoints).map(obj).find(x => x.id === w.id);
      const guide = structuredClone(obj(old?.guide));
      w.history = [...arr(w.history ?? []), structuredClone(guide)];
      guide.at = '2026-11-11T11:00:00Z'; guide.verbatim = `Synthetic ${String(w.id)} answer after viewing the approved parts and structure.`; w.guide = guide;
    }
    save(); sign('rigging-interview', '2026-11-11T11:10:00Z');
    sign('rigging-interview', '2026-11-12T10:30:00Z', ['--steps', 'bones,constraints']);
    // Retain the already writer-shaped synthetic execution/review history; new approvals are all writer-generated.
    arr(p.signoffs).push(...arr(original.signoffs).filter(s => !['interview', 'plan-approved', 'parts', 'parts-review'].includes(String(obj(s).stage))));
    p.stage = original.stage as Json; p.versions = original.versions as Json;
    for (const s of arr(obj(p.plan).steps).map(obj)) s.status = 'done';
    save();
    const checked = checkProject(dir);
    if (checked.refusals.length || checked.warnings.length) throw new Error(JSON.stringify({ refusals: checked.refusals, warnings: checked.warnings }));
    return { project: p, files };
  } finally { setSystemTime(); }
}

/** Replace selected top-level values in place; never reserialize unrelated template blocks. */
function replaceValue(text: string, key: string, value: Json): string {
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
  const [destination, flag] = process.argv.slice(2);
  if (!destination || (flag !== undefined && flag !== '--check')) throw new Error('usage: generate-example-order.ts <fresh dir> [--check]');
  const generated = generateExampleOrder(resolve(destination));
  const root = join(import.meta.dir, '../templates');
  let text = readFileSync(join(root, 'legacy-example-project.json'), 'utf8');
  for (const key of ['stage_values', 'interview', 'plan', 'signoffs', 'drafts']) text = replaceValue(text, key, generated.project[key] as Json);
  const outputs: Record<string, string> = { 'example-project.json': text };
  for (const [path, bytes] of Object.entries(generated.files)) {
    const rel = path.startsWith(EXAMPLE_DRAFT) ? `example-draft/${path.slice(EXAMPLE_DRAFT.length + 1)}` : `example-draft/${path}`;
    outputs[rel] = bytes;
  }
  for (const [path, bytes] of Object.entries(outputs)) {
    if (flag === '--check') { if (readFileSync(join(root, path), 'utf8') !== bytes) throw new Error(`${path}: generated order differs`); }
    else { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), bytes); }
  }
  console.log('new-order example and draft identities reproduce through the writers; 0 refusals, 0 warnings');
}
