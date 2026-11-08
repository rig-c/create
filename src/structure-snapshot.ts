/**
 * The parts-review structure-decisions snapshot, written from the bound draft
 * (rig-c/create#229). The parts verdict names no per-declaration approval: an
 * approved verdict approves the reviewed draft, so the snapshot carries every
 * `meshes.<part>` declaration of that draft's config, copied exactly. The
 * writer measures and derives no mesh.
 */
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { asArray, isObject, type Finding } from './check.ts';
import { readProject } from './feedback.ts';
import { IGNORED_DIRS } from './init.ts';
import { checkPartsVerdict, partsVerdictDraftFinding, partsVerdictEvidence } from './parts-verdict.ts';
import { refuse, USAGE_EXIT } from './refusal.ts';
import { retainedJson, STRUCTURE_SCHEMA, structurePathIsIgnored, validateStructureSnapshot } from './structure.ts';
import type { Json, JsonObject } from './templates.ts';

export const STRUCTURE_SNAPSHOT_HELP = `structure-snapshot:
  [<project dir>] --draft <id> --verdict <path> --out <path>
  Write ${STRUCTURE_SCHEMA} from the recorded draft <id>: one entry per
  meshes.<part> of its config, copied exactly, or entries:[] without meshes.
  --verdict is the approved parts verdict file, read as parts-review reads it.
  --out is project-relative and outside ignored roots, for example evidence/.
  Writes only --out; an existing --out with the same bytes is left as it is.
  Pass the same --draft and --out to signoff parts-review --structure-file.`;

const pointer = (part: string): string => `/meshes/${part.replaceAll('~', '~0').replaceAll('/', '~1')}`;

/** Where --out may be written, refusing before any byte is: a literal path under the project, outside ignored roots. */
function outTarget(dir: string, out: string): string {
  const at = `structure-snapshot --out ${out}`;
  const segments = out.split('/');
  if (isAbsolute(out) || out.includes('\\') || segments.some(s => s === '' || s === '.' || s === '..')) {
    refuse('STRUCTURE_SNAPSHOT_OUT_INVALID', `${at}: expected a literal project-relative POSIX path; name a file under the project, for example evidence/structure-decisions.json`);
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

export function structureSnapshotCommand(args: string[]): { stdout: string; exit: number } {
  const opts: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (['--draft', '--verdict', '--out'].includes(arg)) {
      const value = args[++i];
      if (arg in opts || value === undefined || value === '' || value.startsWith('--')) refuse('STRUCTURE_SNAPSHOT_USAGE', `structure-snapshot: ${arg} needs one non-empty value; ${STRUCTURE_SNAPSHOT_HELP}`, USAGE_EXIT);
      opts[arg] = value;
    } else if (arg.startsWith('-')) refuse('STRUCTURE_SNAPSHOT_USAGE', `structure-snapshot: unsupported ${arg}; ${STRUCTURE_SNAPSHOT_HELP}`, USAGE_EXIT);
    else positional.push(arg);
  }
  const draftId = opts['--draft'];
  const verdict = opts['--verdict'];
  const out = opts['--out'];
  if (positional.length > 1 || draftId === undefined || verdict === undefined || out === undefined) refuse('STRUCTURE_SNAPSHOT_USAGE', `structure-snapshot: needs --draft, --verdict and --out and at most one project folder; ${STRUCTURE_SNAPSHOT_HELP}`, USAGE_EXIT);
  const dir = resolve(positional[0] ?? process.cwd());
  const { project } = readProject(dir);
  const file = outTarget(dir, out);

  const index = asArray(project.drafts).findIndex(d => isObject(d) && d.id === draftId);
  const draft = asArray(project.drafts)[index];
  if (!isObject(draft)) refuse('STRUCTURE_SNAPSHOT_DRAFT_UNKNOWN', `drafts[${draftId}]: no recorded draft has this id; record the reviewed draft with draft-rig, then name its id with --draft`);
  let config: JsonObject;
  try { config = retainedJson(dir, draft.config); } catch (error) {
    refuse('STRUCTURE_SNAPSHOT_CONFIG_CHANGED', `drafts[${index}].config: ${error instanceof Error ? error.message : String(error)}; the snapshot copies the config the draft recorded, so restore those bytes, or record the changed config as a new draft with draft-rig and review it`);
  }

  // The verdict is read by the parts-review sign-off's own reader; only an approved one gives a snapshot.
  const refusals: Finding[] = [];
  const evidence = partsVerdictEvidence(dir, verdict);
  checkPartsVerdict(dir, { evidence }, 'structure-snapshot', refusals);
  if (refusals[0] !== undefined) refuse(refusals[0].code, refusals[0].message);
  // ...and it reviews this draft's parts (rig-c/create#236).
  const bound = partsVerdictDraftFinding(dir, project, evidence, draftId, `structure-snapshot --draft ${draftId}`);
  if (bound !== null) refuse(bound.code, bound.message);

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
