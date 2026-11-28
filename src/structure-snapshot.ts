/**
 * The parts-review structure-decisions snapshot, written from current.parts
 * or an explicitly named draft. It copies every `meshes.<part>` declaration
 * of the bound producer config. The writer measures and derives no mesh.
 */
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { asArray, isObject, type Finding } from './check.ts';
import { readProject } from './feedback.ts';
import { IGNORED_DIRS } from './init.ts';
import { partsStructureSnapshot } from './job-acts.ts';
import { refuse, Refusal, USAGE_EXIT } from './refusal.ts';
import { currentPartsStructureSnapshot, hasCurrentParts, readCurrentPartsContext, retainedJson, STRUCTURE_SCHEMA, structurePathIsIgnored, validateStructureSnapshot } from './structure.ts';
import type { Json, JsonObject } from './templates.ts';

export const STRUCTURE_SNAPSHOT_HELP = `structure-snapshot:
  [<project dir>] [--draft <id>] [--out <path>]
  Write ${STRUCTURE_SCHEMA} from current.parts or the explicit recorded draft <id>:
  one entry per meshes.<part> of its producer config, or entries:[] without meshes.
  For --draft, prepare this evidence before publishing for the parts verdict.
  --out defaults to evidence/structure/current-parts/<record sha256>.json for
  current.parts, or the evidence/structure-<encoded draft>.json path Review asks read.
  Writes only --out; an existing --out with the same bytes is left as it is.
  Parts verdict ingestion retains this snapshot with the folded stage signature.`;

const pointer = (part: string): string => `/meshes/${part.replaceAll('~', '~0').replaceAll('/', '~1')}`;

export function isStructureSnapshotOutForDraft(draft: string, out: string): boolean {
  const stem = `evidence/structure-${encodeURIComponent(draft)}`;
  if (out === `${stem}.json`) return true;
  if (!out.startsWith(`${stem}-`) || !out.endsWith('.json')) return false;
  return /^[1-9]\d*$/.test(out.slice(stem.length + 1, -'.json'.length));
}

/** Where --out may be written, refusing before any byte is: a literal path under the project, outside ignored roots. */
function outTarget(dir: string, out: string): string {
  const at = `structure-snapshot --out ${out}`;
  const segments = out.split('/');
  if (isAbsolute(out) || out.includes('\\') || segments.some(s => s === '' || s === '.' || s === '..')) {
    refuse('STRUCTURE_SNAPSHOT_OUT_INVALID', `${at}: expected a literal project-relative POSIX path; name a file under the project, for example evidence/structure-<id>.json`);
  }
  const root = realpathSync(dir);
  // The longest existing prefix: it carries the links the write would follow.
  let existing = '';
  for (const segment of segments) {
    const next = existing === '' ? segment : `${existing}/${segment}`;
    try { lstatSync(join(dir, next)); } catch { break; }
    existing = next;
  }
  if (existing !== '') {
    let real: string;
    try { real = realpathSync(join(dir, existing)); } catch { refuse('STRUCTURE_SNAPSHOT_OUT_INVALID', `${at}: ${existing} is a link that leads nowhere; name a file under the project`); }
    const rel = relative(root, real);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) refuse('STRUCTURE_SNAPSHOT_OUT_INVALID', `${at}: ${existing} leads out of the project; name a file under the project`);
    if (existing !== out && !lstatSync(real).isDirectory()) refuse('STRUCTURE_SNAPSHOT_OUT_INVALID', `${at}: ${existing} is not a folder; name a file under a folder of the project`);
  }
  const ignored: readonly string[] = [...IGNORED_DIRS, 'node_modules', '.git'];
  if (ignored.includes(segments[0] as string) || (existing !== '' && structurePathIsIgnored(dir, existing))) {
    refuse('STRUCTURE_SNAPSHOT_OUT_IGNORED', `${at}: the snapshot must survive a clone, and ${out} is under an ignored root; write it outside ignored roots, for example evidence/`);
  }
  const file = resolve(dir, out);
  if (existing === out && !lstatSync(file).isFile()) refuse('STRUCTURE_SNAPSHOT_OUT_INVALID', `${at}: ${out} exists and is not a regular file; name a new file or remove that entry`);
  return file;
}

function writeCurrentSnapshot(file: string, out: string, snapshot: JsonObject, count: number): { stdout: string; exit: number } {
  const bytes = `${JSON.stringify(snapshot, null, 2)}\n`;
  mkdirSync(dirname(file), { recursive: true });
  try {
    writeFileSync(file, bytes, { flag: 'wx' });
  } catch (error) {
    if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (readFileSync(file).equals(Buffer.from(bytes))) return { stdout: `structure-snapshot: ${out} already holds this snapshot of current.parts; unchanged`, exit: 0 };
    refuse('STRUCTURE_SNAPSHOT_OUT_EXISTS', `structure-snapshot --out ${out}: the file holds different bytes; a retained snapshot is never overwritten, so name a new file`);
  }
  return { stdout: `structure-snapshot: wrote ${out} for current.parts with ${count} ${count === 1 ? 'entry' : 'entries'}`, exit: 0 };
}

export function structureSnapshotCommand(args: string[]): { stdout: string; exit: number } {
  if (args.some(arg => arg === '--verdict' || arg.startsWith('--verdict='))) refuse('PARTS_VERDICT_FILE_ROUTE_REMOVED', 'project.json.drafts: --verdict was removed; numbered parts verdicts are read-only — record current.parts with rig-create record parts --from <producer out> --config <rig config>, run rig-create structure-snapshot, and relay any owner chat signoff with rig-create signoff parts-review --by <owner> --owner-chat <words file> --said-at <ISO date> --relayed-by <operator>', USAGE_EXIT);
  const opts: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (['--draft', '--out'].includes(arg)) {
      const value = args[++i];
      if (arg in opts || value === undefined || value === '' || value.startsWith('--')) refuse('STRUCTURE_SNAPSHOT_USAGE', `structure-snapshot: ${arg} needs one non-empty value; ${STRUCTURE_SNAPSHOT_HELP}`, USAGE_EXIT);
      opts[arg] = value;
    } else if (arg.startsWith('-')) refuse('STRUCTURE_SNAPSHOT_USAGE', `structure-snapshot: unsupported ${arg}; ${STRUCTURE_SNAPSHOT_HELP}`, USAGE_EXIT);
    else positional.push(arg);
  }
  const draftId = opts['--draft'];
  const requestedOut = opts['--out'];
  const usage = (): never => refuse('STRUCTURE_SNAPSHOT_USAGE', `structure-snapshot: needs current.parts or --draft and at most one project folder; ${STRUCTURE_SNAPSHOT_HELP}`, USAGE_EXIT);
  if (positional.length > 1) usage();
  const dir = resolve(positional[0] ?? process.cwd());
  let project: JsonObject;
  try { ({ project } = readProject(dir)); }
  catch (error) {
    if (draftId === undefined && error instanceof Refusal) usage();
    throw error;
  }
  if (draftId === undefined) {
    if (!hasCurrentParts(project)) usage();
    const parts = readCurrentPartsContext(dir, project);
    const out = requestedOut ?? `evidence/structure/current-parts/${parts.target.record_sha256}.json`;
    const file = outTarget(dir, out);
    const snapshot = currentPartsStructureSnapshot(parts);
    return writeCurrentSnapshot(file, out, snapshot, asArray(snapshot.entries).length);
  }
  const index = asArray(project.drafts).findIndex(d => isObject(d) && d.id === draftId);
  const draft = asArray(project.drafts)[index];
  const expectedOut = partsStructureSnapshot(dir, project, draftId).path;
  const out = requestedOut ?? expectedOut;
  const file = outTarget(dir, out);
  if (!isObject(draft)) refuse('STRUCTURE_SNAPSHOT_DRAFT_UNKNOWN', `drafts[${draftId}]: no recorded draft has this id; drafts[] is read-only — name an existing recorded draft id with --draft, or snapshot current.parts without --draft after rig-create record parts --from <dir> --config <file>`);
  if (requestedOut !== undefined && !isStructureSnapshotOutForDraft(draftId, requestedOut)) {
    refuse('STRUCTURE_SNAPSHOT_OUT_UNREAD', `structure-snapshot --out ${requestedOut}: parts-verdict publication reads only evidence/structure-${encodeURIComponent(draftId)}.json (or -<n>.json) for draft ${draftId}; omit --out or use --out ${expectedOut}`);
  }
  let config: JsonObject;
  try { config = retainedJson(dir, draft.config); } catch (error) {
    refuse('STRUCTURE_SNAPSHOT_CONFIG_CHANGED', `drafts[${index}].config: ${error instanceof Error ? error.message : String(error)}; drafts[] is read-only and the snapshot copies the config the draft recorded, so restore those bytes, or record changed parts on the current path with rig-create record parts --from <dir> --config <file>`);
  }

  const meshes = config.meshes;
  if (meshes !== undefined && !isObject(meshes)) refuse('STRUCTURE_DECISIONS_INVALID', `drafts[${index}].config meshes: expected an object of part declarations; review the labelled draft, retain its exact structure decisions, and sign again`);
  const entries: Json[] = Object.entries(meshes ?? {}).map(([part, value]) => ({ path: pointer(part), value: structuredClone(value) }));
  const snapshot: JsonObject = { schema: STRUCTURE_SCHEMA, draft_id: draftId, config: structuredClone(draft.config) as Json, entries };
  const errors: Finding[] = [];
  validateStructureSnapshot(dir, project, draftId, snapshot, out, errors);
  if (errors[0] !== undefined) refuse(errors[0].code, errors[0].message);

  const bytes = `${JSON.stringify(snapshot, null, 2)}\n`;
  let present: Buffer | undefined;
  try { present = readFileSync(file); } catch { present = undefined; }
  if (present !== undefined) {
    if (present.equals(Buffer.from(bytes))) return { stdout: `structure-snapshot: ${out} already holds this snapshot of draft ${draftId}; unchanged`, exit: 0 };
    refuse('STRUCTURE_SNAPSHOT_OUT_EXISTS', `structure-snapshot --out ${out}: the file holds different bytes; a retained snapshot is never overwritten, so name a new file`);
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, bytes);
  return { stdout: `structure-snapshot: wrote ${out} for draft ${draftId} with ${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}`, exit: 0 };
}
