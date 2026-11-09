/** Advisory intake: consume immutable producer bytes, never pixels or producer verifiers. */
import { renameSync, writeFileSync } from 'node:fs';
import { readFileSync } from './check-reads.ts';
import { dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual as equal } from 'node:util';
import { asArray, classify, isObject, type Finding, type Item } from './check.ts';
import { choiceAdoption, literalFile, optionFile, selection, sha256, validateChoice, validateContext, validateSet } from './choices.ts';
import { structurePathIsIgnored } from './structure.ts';
import { readProject } from './feedback.ts';
import { refuse } from './refusal.ts';
import type { Json, JsonObject } from './templates.ts';

export const INTAKE_SPEC = 'rig-create/intake@1';
export const PREFLIGHT_SPEC = 'rig-parts/head-crop-preflight/1';
export const INTAKE_QUESTION = 'intake_suitability';
export const INTAKE_NOTES = 'Colour-adjacent ground and ground enclosed between strands: known-not-predicted (two rounds of a model sweep on a pilot did not separate them). No threshold. Silhouette stepping, source-vs-final alpha classes, patchwork runs and versioned dark retention need post-assemble outputs and are excluded.';
const text = (v: Json | undefined): v is string => typeof v === 'string' && v.trim() !== '';
const clock = (v: Json | undefined): number => typeof v === 'string' ? Date.parse(v) : NaN;
const count = (v: Json | undefined): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
function invalid(why: string): never { throw Error(why); }

/** Optional item for the explicit choice writers only, never global approval readers. */
export function intakeItem(project: JsonObject): Item | undefined {
  const intake = isObject(project.intake) ? project.intake : null;
  const record = intake && isObject(intake.choice) ? intake.choice : null;
  if (!record) return undefined;
  return { id: INTAKE_QUESTION, kind: 'framing', path: 'intake.choice.answer', record, raw: record.answer ?? null, state: classify(record.answer, { collection: null }) };
}

export function intakeContext(project: JsonObject, at: number): JsonObject {
  const intake = isObject(project.intake) ? project.intake : {};
  const reports = asArray(intake.reports).filter(isObject).filter(r => clock(r.at) <= at);
  const entry = reports.at(-1);
  if (intake.spec !== INTAKE_SPEC || !entry || !isObject(entry.report)) invalid('intake.reports: record a preflight before showing the parts-stage ask');
  return { kind: 'intake', report_id: entry.id as Json, report: entry.report };
}

/** Validate the producer's report shape; do not rederive registration or count measurements. */
export function readIntakeReport(dir: string, binding: JsonObject): JsonObject {
  if (!text(binding.path) || typeof binding.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(binding.sha256)) invalid('report needs a retained path and raw sha256');
  const file = literalFile(dir, binding.path);
  if (structurePathIsIgnored(dir, binding.path)) invalid('report must survive a clone; retain it outside ignored roots');
  const bytes = readFileSync(file);
  if (sha256(bytes) !== binding.sha256) invalid('report sha256 differs from retained bytes');
  const raw: Json = JSON.parse(bytes.toString('utf8'));
  if (!isObject(raw) || raw.spec !== PREFLIGHT_SPEC || raw.drawn_alpha_above !== 8 || raw.pixel_grid !== 'full-run') invalid('expected rig-parts/head-crop-preflight/1, native alpha > 8 on the full-run grid');
  if (!Array.isArray(raw.head_box) || raw.head_box.length !== 4 || !raw.head_box.every(n => typeof n === 'number' && Number.isFinite(n)) || Number(raw.head_box[0]) >= Number(raw.head_box[2]) || Number(raw.head_box[1]) >= Number(raw.head_box[3])) invalid('invalid head_box');
  for (const key of ['source_canvas', 'run_canvas']) {
    const canvas = raw[key];
    if (!isObject(canvas) || !count(canvas.w) || !count(canvas.h) || !canvas.w || !canvas.h) invalid(`invalid ${key}`);
  }
  if (!isObject(raw.registration) || typeof raw.registration.scale_source_per_run !== 'number' || !Number.isFinite(raw.registration.scale_source_per_run) || raw.registration.scale_source_per_run <= 0 || !['pad_left','pad_top'].every(k => typeof (raw.registration as JsonObject)[k] === 'number' && Number.isFinite((raw.registration as JsonObject)[k]))) invalid('invalid registration');
  const tags = new Set<string>();
  if (!Array.isArray(raw.layers)) invalid('layers must be an array');
  for (const layer of raw.layers) {
    if (!isObject(layer) || !text(layer.tag) || tags.has(layer.tag) || !count(layer.drawn_px) || !count(layer.bottom_px) || !isObject(layer.sides) || !['top_px','left_px','right_px'].every(k => count((layer.sides as JsonObject)[k]))) invalid('invalid or duplicate layer counts');
    tags.add(layer.tag);
    if ([layer.bottom_px, ...Object.values(layer.sides)].some(n => typeof n !== 'number' || n > Number(layer.drawn_px))) invalid('edge count exceeds drawn samples');
  }
  for (const key of ['spec','head_box','source_canvas','run_canvas']) if (key in binding && !equal(binding[key], raw[key])) invalid(`report binding ${key} differs from producer bytes`);
  return raw;
}
export function intakeHit(report: JsonObject): boolean {
  return asArray(report.layers).filter(isObject).some(l => isObject(l.sides) && ['top_px','left_px','right_px'].some(k => Number((l.sides as JsonObject)[k]) > 0));
}
function warning(code: string, path: string, why: string, remedy: string): Finding { return { code, path, message: `${path}: ${why}; ${remedy}` }; }

export function intakeWarnings(dir: string, project: JsonObject): Finding[] {
  if (project.intake === undefined) return [];
  const warnings: Finding[] = [];
  const addInvalid = (path: string, e: unknown) => warnings.push(warning('INTAKE_REPORT_INVALID',path,String(e),'restore the original producer report bytes first, then append a corrected entry with intake-report'));
  const intake = project.intake;
  if (!isObject(intake) || intake.spec !== INTAKE_SPEC || !Array.isArray(intake.reports) || !intake.reports.length) {
    addInvalid('intake','expected rig-create/intake@1 with nonempty reports'); return warnings;
  }
  const ids = new Set<string>();
  let active: JsonObject | undefined;
  for (const [i, entry] of intake.reports.entries()) {
    const path = `intake.reports[${i}]`;
    try {
      if (!isObject(entry) || !text(entry.id) || ids.has(entry.id) || !text(entry.by) || !Number.isFinite(clock(entry.at)) || !text(entry.parts_version) || !isObject(entry.report)) invalid('invalid report identity, clock, declared parts version or binding');
      if (entry.supersedes !== undefined && (!text(entry.supersedes) || !ids.has(entry.supersedes))) invalid('supersedes must name an earlier retained entry');
      ids.add(entry.id);
      if (!['spec','head_box','source_canvas','run_canvas'].every(k => k in (entry.report as JsonObject))) invalid('report binding must retain spec, head_box and both canvases');
      const raw = readIntakeReport(dir, entry.report);
      if (!equal(entry.measurement,raw) || entry.prediction !== (intakeHit(raw) ? 'hit' : 'no-hit')) invalid('copied report fields or prediction differ from retained report');
      if (i === intake.reports.length-1) active = entry;
    } catch (e) { addInvalid(path,e); }
  }
  if (active?.prediction === 'hit') {
    const raw = active.measurement as JsonObject;
    const counts = asArray(raw.layers).filter(isObject).map(l => `${String(l.tag)} ${JSON.stringify(l.sides)} (bottom ${String(l.bottom_px)})`).join('; ');
    warnings.push(warning('INTAKE_HEAD_CROP_RISK','intake.reports',`advisory native alpha > 8 before ghost cleanup: ${counts}`,'show the report-bound parts-stage intake_suitability choice; no approval is refused'));
  }
  const item = intakeItem(project);
  let pending = true;
  if (item) {
    try {
      if (item.record.pending_options !== undefined) {
        const {set} = optionFile(dir,item.record.pending_options); validateSet(project,item,set); validateContext(dir,project,set,clock(set.drafted_at));
      }
      if (item.raw !== null) {
        if (!isObject(item.raw) || item.raw.basis === 'inherited') invalid('intake choice must be a local per-ask record');
        validateChoice(dir,project,item,item.raw);
        const {set} = optionFile(dir,(item.raw.choice as JsonObject).set);
        const chosen = selection(set,item.raw.choice as JsonObject);
        const context = set.context as JsonObject;
        pending = !active || context.report_id !== active.id || chosen.pending.length > 0 || (chosen.autos.length > 0 && !(isObject(item.raw.agent_decision) && 'value' in item.raw.agent_decision));
      }
      if (!Array.isArray(item.record.history)) invalid('intake choice history must be an array');
      for (const answer of item.record.history) {
        if (!isObject(answer)) invalid('invalid choice history');
        validateChoice(dir,project,item,answer);
      }
    } catch (e) { pending = true; warnings.push(warning('INTAKE_CHOICE_INVALID','intake.choice',String(e),'retain and re-show report-bound options with the interview choice writers')); }
  } else if (intake.choice !== undefined) warnings.push(warning('INTAKE_CHOICE_INVALID','intake.choice','invalid optional choice record','record a new report before showing options'));
  if (project.stage === 'parts' && active?.prediction === 'hit' && pending) warnings.push(warning('INTAKE_CHOICE_PENDING','intake.choice','HIT report has no resolved choice bound to it',`${choiceAdoption(project) === null ? 'adopt choices with interview-options --adopt first, then ' : ''}show intake_suitability in parts and record the person’s explicit pick, Other or delegation; advisory only`));
  return warnings;
}

export const INTAKE_HELP = `intake-report [<dir>] --id <id> --report <retained relative path> --sha256 <raw sha> --parts-version <declared version> --by <agent> [--supersedes <id>]
  Record a parts head-crop preflight without running a producer. Offers optional intake_suitability in parts.
intake [<dir>]
  Show advisory counts and choice state; never refuse approval. This cannot save the first full run.`;
export function intakeReportCommand(args: string[], now: number): string {
  const opts: Record<string,string> = {}; const positional: string[] = [];
  for (let i=0;i<args.length;i++) {
    const arg = args[i] as string;
    if (!arg.startsWith('-')) { positional.push(arg); continue; }
    if (!['--id','--report','--sha256','--parts-version','--by','--supersedes'].includes(arg) || opts[arg] !== undefined || !args[i+1] || args[i+1]?.startsWith('--')) refuse('INTAKE_REPORT_INVALID',`intake.reports: invalid writer arguments; ${INTAKE_HELP}`);
    opts[arg] = args[++i] as string;
  }
  if (positional.length > 1 || !['--id','--report','--sha256','--parts-version','--by'].every(k => opts[k]?.trim())) refuse('INTAKE_REPORT_INVALID',`intake.reports: missing writer arguments; ${INTAKE_HELP}`);
  const dir = resolve(positional[0] ?? process.cwd()); const {file,project} = readProject(dir);
  const next = structuredClone(project);
  try {
    if (project.stage !== 'parts') invalid('offer intake only in the parts stage at report time');
    if (next.intake !== undefined && intakeWarnings(dir,next).some(w => w.code === 'INTAKE_REPORT_INVALID')) invalid('restore existing retained intake reports before appending');
    if (next.intake === undefined) next.intake = {spec:INTAKE_SPEC,reports:[],choice:{id:INTAKE_QUESTION,answer:null,history:[]}};
    const intake = next.intake as JsonObject; const reports = intake.reports as Json[];
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(opts['--id'] as string) || reports.some(r => isObject(r) && r.id === opts['--id'])) invalid('use a new report id');
    const binding: JsonObject = {path:opts['--report'] as string,sha256:opts['--sha256'] as string};
    const measurement = readIntakeReport(dir,binding);
    for (const k of ['spec','head_box','source_canvas','run_canvas']) binding[k] = measurement[k] as Json;
    reports.push({id:opts['--id'] as string,report:binding,parts_version:opts['--parts-version'] as string,measurement,prediction:intakeHit(measurement)?'hit':'no-hit',by:opts['--by'] as string,at:new Date(now).toISOString(),...(opts['--supersedes']?{supersedes:opts['--supersedes']}:{})});
    const errors = intakeWarnings(dir,next).filter(w => w.code === 'INTAKE_REPORT_INVALID');
    if (errors.length) invalid(errors[0]?.message ?? 'invalid report');
    const tmp = join(dirname(file),`.intake-${crypto.randomUUID()}.tmp`);
    writeFileSync(tmp,`${JSON.stringify(next,null,2)}\n`,{flag:'wx'}); renameSync(tmp,file);
    return intakeCommand([dir]);
  } catch (e) { refuse('INTAKE_REPORT_INVALID',`intake.reports: ${String(e)}; retain correct report bytes and retry intake-report`); }
}
export function intakeCommand(args: string[]): string {
  if (args.length > 1 || args.some(a => a.startsWith('-'))) refuse('INTAKE_REPORT_INVALID',`intake: expected a project folder; ${INTAKE_HELP}`);
  const dir = resolve(args[0] ?? process.cwd()); const {project} = readProject(dir);
  const intake = isObject(project.intake) ? project.intake : null;
  return JSON.stringify({advisory:true,notes:INTAKE_NOTES,intake:intake ?? 'not-measured',warnings:intakeWarnings(dir,project)},null,2);
}
