import { assemblyChangeDetail, assemblyConfigChanges } from '@rig-c/parts/assembly-reading';
import { readPartsManifest } from '@rig-c/parts/src/parts.ts';
import { latestPartsVerdictStatus } from './parts-verdict-record.ts';
import { randomUUID } from 'node:crypto';
import { acquireBoundJobWrite, prepareDraftIntent, publishCommittedVersion, takePublishedLines } from './job-writer.ts';
import { cancelUncommittedIntent, readWriterBinding, type PendingPublication } from './job-outbox.ts';
/** Draft identity is create-owned inventory, never producer provenance or a measurement. */
import { ConfigInputsUnavailable, configInputBindings, configInputReferences, DIRECTORY_INPUT_RECEIPT, DRAFT_CONFIG_INPUTS_SINCE, draftUnboundInputs, inputsUndeclaredByInstall, receiptSpec, releaseAfter } from './config-inputs.ts';
import { createHash } from 'node:crypto';
import { closeSync, fsyncSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from './check-reads.ts';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { asArray, isObject, type Finding } from './check.ts';
import { readProject } from './feedback.ts';
import { diffStackCandidates } from './diff-map.ts';
import { checkDraftReuse, DRAFT_ID as idPattern, prepareDraftReuse, retainDraftReuseRecord } from './draft-reuse.ts';
import { ASSEMBLE_ONLY, assembleOnlyVersionFinding, draftRigRequired, isAssembleOnlyDraft } from './draft-layout.ts';
import { locateParts } from './parts-sections.ts';
import { Refusal, refuse, USAGE_EXIT } from './refusal.ts';
import { RunRecordError, validateRunRecord } from './run-record.ts';
import { newRefusals } from './refusal-baseline.ts';
import { readVerbatim } from './record-input.ts';
import { checkUnrecordedPartRepaints } from './corrections.ts';
import { checkFixLedger, draftLedgerFields } from './fix-ledger.ts';
import { EDITED_PART_INPUTS_SINCE, editedPartInputFindings } from './edited-part-inputs.ts';
import type { Json, JsonObject } from './templates.ts';

export const DRAFT_STACK_BINDING_SINCE = '2026-11-19T00:00:00Z';

const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const hex = (v: Json | undefined): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const inside = (root: string, path: string): boolean => { const rel = relative(root, path); return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };
const pathOf = (dir: string, path: string): string => relative(realpathSync(dir), realpathSync(path)).split(sep).join('/');

function fileAt(dir: string, path: string, root: string): string {
  if (isAbsolute(path) || path.split('/').some(p => p === '..' || p === '.' || p === '')) throw new Error(`${path}: expected a project-relative literal path`);
  if (!inside(realpathSync(dir), realpathSync(resolve(dir, root)))) throw new Error(`${root}: draft root escapes the project`);
  const file = resolve(dir, path);
  if (!inside(resolve(dir, root), file) || !inside(realpathSync(resolve(dir, root)), realpathSync(file))) throw new Error(`${path}: outside ${root}`);
  if (!lstatSync(file).isFile()) throw new Error(`${path}: expected a regular file`);
  return file;
}

function inventory(dir: string, path: string, root: string): JsonObject[] {
  const absolute = resolve(dir, path);
  if (!inside(resolve(dir, root), absolute) && absolute !== resolve(dir, root)) throw new Error(`${path}: outside ${root}`);
  if (!inside(realpathSync(resolve(dir, root)), realpathSync(absolute)) && realpathSync(absolute) !== realpathSync(resolve(dir, root))) throw new Error(`${path}: escapes ${root}`);
  if (!lstatSync(absolute).isDirectory()) throw new Error(`${path}: expected a directory without symlinks`);
  const files: JsonObject[] = [];
  for (const name of readdirSync(absolute).sort()) {
    const entry = join(path, name).split(sep).join('/');
    const info = lstatSync(resolve(dir, entry));
    if (info.isDirectory()) files.push(...inventory(dir, entry, root));
    else files.push({ path: entry, sha256: sha(readFileSync(fileAt(dir, entry, root))) });
  }
  return files;
}

/** The raster parts.json itself declares under painting_in_rig, read from the producer's record and never inferred. */
function declaredPainting(dir: string, path: string, root: string, files: JsonObject[]): string | null {
  if (!files.some(f => f.path === `${path}/parts.json`)) return null;
  let manifest: Json;
  try { manifest = JSON.parse(readFileSync(fileAt(dir, `${path}/parts.json`, root), 'utf8')) as Json; } catch { return null; }
  const painting = isObject(manifest) ? manifest.painting_in_rig : undefined;
  return isObject(painting) && typeof painting.path === 'string' ? `${path}/${painting.path}` : null;
}

/** parts.json, parts/* and the declared painting; an undeclared or missing file is not carried. */
function partsInventory(dir: string, path: string, root: string): { files: JsonObject[]; painting: string | null } {
  const all = inventory(dir, path, root);
  const painting = declaredPainting(dir, path, root, all);
  return { files: all.filter(f => f.path === `${path}/parts.json` || String(f.path).startsWith(`${path}/parts/`) || f.path === painting), painting };
}

function binding(v: Json | undefined): v is JsonObject {
  return isObject(v) && typeof v.path === 'string' && hex(v.sha256);
}

function hasPartsInventory(files: Json[], from: string, requireImages = false): boolean {
  return files.some(f => binding(f) && f.path === `${from}/parts.json`)
    && files.some(f => binding(f) && String(f.path).startsWith(`${from}/parts/`)
      && (!requireImages || String(f.path).endsWith('.png')));
}

function isBuildInventory(files: Json[], from: string): boolean {
  return hasPartsInventory(files, from)
    && files.some(f => binding(f) && f.path === `${from}/rig/rig.json`);
}

const rigArtifact = (path: string): boolean => /\/(rig|motion|mesh_report|skeleton\.model)\.json$/.test(path);

function assemblePartsPath(files: JsonObject[], from: string): string | undefined {
  if (files.some(f => rigArtifact(String(f.path)))) return undefined;
  const candidates = [from, `${from}/rig`].filter(path => hasPartsInventory(files, path, true));
  return candidates.length === 1 ? candidates[0] : undefined;
}

function assembleStamps(files: JsonObject[], parts: string): JsonObject[] {
  const paths = [`${parts}/run.json`];
  if (parts.endsWith('/rig')) paths.push(`${parts.slice(0, -'/rig'.length)}/run.json`);
  return files.filter(f => paths.includes(String(f.path)));
}

/** parts' rig-run/1 stamp sits beside the rig.json it names: `<out>/run.json` of `rig --out`, which is `<root>/rig/run.json` in a build root. */
const stampBeside = (rigJson: string): string => rigJson.replace(/rig\.json$/, 'run.json');

/** The producer a rig-run/1 stamp names, read from its record and never recomputed; any other spec is not parts' rig stamp. */
function stampProducer(bytes: Buffer, path: string, assembleOnly: boolean): JsonObject {
  const { spec, record } = validateRunRecord(bytes, path, { allowAssembleInputs: assembleOnly });
  if (spec !== 'rig-run/1') throw new RunRecordError('RUN_RECORD_SPEC_UNKNOWN', `${path}.spec`, `expected the rig-run/1 stamp parts writes ${assembleOnly ? 'at the assemble output root' : 'beside rig.json'}, found ${spec}`);
  if (assembleOnly && record.command !== 'assemble') throw new RunRecordError('RUN_RECORD_MALFORMED', `${path}.command`, 'expected assemble for an assemble-only draft');
  const pkg = record.package as JsonObject;
  return { name: pkg.name as string, version: pkg.version as string };
}

/** Every name on the way must be a real directory, and the last a non-symlink; returns whether a name is absent. */
function absentAlong(dir: string, path: string): boolean {
  const names = path.split('/');
  let current = realpathSync(dir);
  for (const [i, name] of names.entries()) {
    current = join(current, name);
    let info;
    try { info = lstatSync(current); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
      throw error;
    }
    if (info.isSymbolicLink() || (i < names.length - 1 && !info.isDirectory())) throw new Error(`${path}: draft path traverses a symlink or non-directory`);
  }
  return false;
}

/** Absence may be regenerable; symlinks, escaped paths and present wrong kinds are never absence. */
export function draftFileUnavailable(dir: string, path: string, root: string): boolean {
  if (isAbsolute(path) || path.split('/').some(p => p === '..' || p === '.' || p === '')) throw new Error(`${path}: expected a literal project-relative draft path`);
  const target = resolve(dir, path);
  if (target !== resolve(dir, root) && !inside(resolve(dir, root), target)) throw new Error(`${path}: outside ${root}`);
  return absentAlong(dir, path);
}

/** A config-named input binds wherever it sits inside the project; one under the draft root is a draft artifact. */
const projectInput = (dir: string, path: string, root: string): boolean => !inside(resolve(dir, root), resolve(dir, path));

/**
 * Availability of a `config_inputs` binding. Under the draft root it is a regenerable draft artifact;
 * elsewhere in the project it is a project input, never regenerable, so its absence throws.
 */
export function draftInputUnavailable(dir: string, path: string, root: string): boolean {
  if (!projectInput(dir, path, root)) return draftFileUnavailable(dir, path, root);
  inputAt(dir, path);
  return false;
}

/** A project input outside the draft root: a literal path to a regular file inside the project, also after symlinks. */
function inputAt(dir: string, path: string): string {
  if (isAbsolute(path) || path.split('/').some(p => p === '..' || p === '.' || p === '')) throw new Error(`${path}: expected a project-relative literal path`);
  const file = resolve(dir, path);
  if (!inside(resolve(dir), file)) throw new Error(`${path}: outside the project`);
  if (absentAlong(dir, path)) throw new Error(`${path}: config-named project input is missing`);
  if (!inside(realpathSync(dir), realpathSync(file))) throw new Error(`${path}: outside the project`);
  if (!lstatSync(file).isFile()) throw new Error(`${path}: expected a regular file`);
  return file;
}

/** The bytes a draft binding names: its own artifacts under the draft root, config-named inputs anywhere in the project. */
const bindingAt = (dir: string, path: string, root: string, input: boolean): string => input && projectInput(dir, path, root) ? inputAt(dir, path) : fileAt(dir, path, root);

export function checkDrafts(dir: string, project: JsonObject, refusals: Finding[], warnings: Finding[] = []): void {
  const add = (code: string, path: string, why: string): void => { refusals.push({ code, path, message: `${path}: ${why}; retain a labelled draft with its original config, parts and files` }); };
  if (project.drafts !== undefined && !Array.isArray(project.drafts)) { add('DRAFT_RIG_MALFORMED', 'drafts', 'expected a list'); return; }
  const ids = new Set<string>();
  for (const [index, raw] of asArray(project.drafts).entries()) {
    const path = `drafts[${index}]`;
    if (!isObject(raw) || typeof raw.id !== 'string' || !idPattern.test(raw.id) || ids.has(raw.id) || raw.kind !== 'draft-rig'
      || typeof raw.at !== 'string' || !Number.isFinite(Date.parse(raw.at)) || !isObject(raw.producer)
      || typeof raw.producer.name !== 'string' || !raw.producer.name || typeof raw.producer.version !== 'string' || !raw.producer.version
      || !binding(raw.config) || !isObject(raw.parts) || typeof raw.parts.path !== 'string'
      || !Array.isArray(raw.parts.files) || !Array.isArray(raw.files)) { add('DRAFT_RIG_MALFORMED', path, 'invalid or duplicate draft identity'); continue; }
    ids.add(raw.id);
    const root = `derived/drafts/${raw.id}`;
    const parts = raw.parts;
    const assembleOnly = isAssembleOnlyDraft(raw);
    if (raw.layout !== undefined && !assembleOnly) { add('DRAFT_RIG_MALFORMED', `${path}.layout`, 'unknown draft layout'); continue; }
    const all = [raw.config, ...asArray(parts.files), ...asArray(raw.files), ...asArray(raw.config_inputs)];
    const inputs = new Set(asArray(raw.config_inputs));
    const manifestPath = `${String(parts.path)}/parts.json`;
    if (raw.config_inputs !== undefined && (!Array.isArray(raw.config_inputs) || raw.config_inputs.some(f => !binding(f)))) { add('DRAFT_RIG_MALFORMED', path, 'config_inputs must bind paths and sha256 hashes'); continue; }
    if (asArray(raw.config_inputs).some(f => isObject(f) && f.directory !== undefined && (typeof f.directory !== 'string' || f.path !== `${f.directory}/${DIRECTORY_INPUT_RECEIPT}` || typeof f.spec !== 'string' || !f.spec))) { add('DRAFT_RIG_MALFORMED', path, `a config_inputs directory binding must bind <directory>/${DIRECTORY_INPUT_RECEIPT} and its receipt spec`); continue; }
    if (raw.files.length === 0 || asArray(parts.files).length === 0 || all.some(f => !binding(f))
      || !asArray(parts.files).some(f => binding(f) && f.path === manifestPath)) { add('DRAFT_RIG_MALFORMED', path, 'file inventories must bind config, parts.json and output'); continue; }
    const files = raw.files.filter(binding);
    const rigs = files.filter(f => String(f.path).endsWith('/rig.json'));
    const rigPath = String(rigs[0]?.path);
    const partFiles = asArray(parts.files).filter(binding);
    const stamps = assembleOnly ? assembleStamps(files, String(parts.path)) : [];
    if (assembleOnly) {
      const outputHashes = new Map(files.map(f => [f.path, f.sha256]));
      if (stamps.length > 1 || files.some(f => rigArtifact(String(f.path)))
        || !hasPartsInventory(partFiles, String(parts.path), true)
        || partFiles.some(f => outputHashes.get(f.path) !== f.sha256)) {
        add('DRAFT_RIG_MALFORMED', path, 'assemble-only must bind its parts.json and parts images in its output with no rig output and at most one assemble run stamp'); continue;
      }
    } else if (rigs.length !== 1 || !['motion.json', 'mesh_report.json'].every(name => files.some(f => f.path === rigPath.replace(/rig\.json$/, name)))) {
      add('DRAFT_RIG_MALFORMED', path, 'expected one complete rig output layout'); continue;
    }
    const buildSuffix = '/rig/rig.json';
    const build = rigPath.endsWith(buildSuffix) && isBuildInventory(files, rigPath.slice(0, -buildSuffix.length));
    if (!build && raw.reuse === undefined) {
      const candidates = diffStackCandidates(resolve(dir, manifestPath)).map(file => relative(dir, file).split(sep).join('/'));
      if (!files.some(f => candidates.includes(String(f.path)))) {
        const field = `${path}.files`;
        const findings = !assembleOnly && Date.parse(raw.at) < Date.parse(DRAFT_STACK_BINDING_SINCE) ? warnings : refusals;
        const command = assembleOnly ? 'draft-rig' : 'draft-rig --parts';
        findings.push({ code: 'DRAFT_RIG_STACK_UNBOUND', path: field, message: `${field}: no sha256 binding for ${candidates.join(' or ')}; preserve this record and register a new draft with ${command} and the retained recomposite` });
      }
    }
    const unavailable = new Set<string>();
    for (const entry of all) {
      if (!binding(entry)) continue;
      const file = String(entry.path);
      try {
        const input = inputs.has(entry);
        if (input ? draftInputUnavailable(dir, file, root) : draftFileUnavailable(dir, file, root)) { unavailable.add(file); continue; }
        const bytes = readFileSync(bindingAt(dir, file, root, input));
        if (sha(bytes) !== entry.sha256) throw new Error(`${file} changed`);
        // A directory input's receipt is read, not re-verified: its declared spec must be the one recorded.
        if (input && entry.directory !== undefined && receiptSpec(bytes) !== entry.spec) throw new Error(`${file} declares spec ${JSON.stringify(receiptSpec(bytes))}, not the recorded ${JSON.stringify(entry.spec)}`);
      } catch (error) { add('DRAFT_RIG_FILE', path, error instanceof Error ? error.message : String(error)); }
    }
    const stampBinding = assembleOnly ? stamps[0] : files.find(f => f.path === stampBeside(rigPath));
    const stamp = assembleOnly ? String(stampBinding?.path ?? 'the assemble output root') : stampBeside(rigPath);
    const rebuild = assembleOnly ? 'rig-parts assemble' : 'parts rig';
    const recorded = `${raw.producer.name}@${raw.producer.version}`;
    let stampedProducer: JsonObject | undefined;
    if (stampBinding === undefined) {
      if (raw.reuse === undefined) warnings.push({ code: 'DRAFT_PRODUCER_ASSUMED', path: `${path}.producer`, message: `${path}.producer: no rig-run/1 run.json is bound at ${stamp}, so ${recorded} is the installed package assumed when the draft was recorded, not read from its run; record a new draft with draft-rig --reuse <reviewed-draft-id> [--reuse-record <previous-record-sha256>] for exact reviewed parts, or rebuild the draft with ${rebuild} and record it under a new id; the old record is kept` });
    } else if (!unavailable.has(stamp)) {
      try {
        const bytes = readFileSync(fileAt(dir, stamp, root));
        if (sha(bytes) === stampBinding.sha256) {
          stampedProducer = stampProducer(bytes, stamp, assembleOnly);
          if (raw.reuse === undefined && (stampedProducer.name !== raw.producer.name || stampedProducer.version !== raw.producer.version)) {
            warnings.push({ code: 'DRAFT_PRODUCER_MISMATCH', path: `${path}.producer`, message: `${path}.producer: records ${recorded} but its bound ${stamp} names ${String(stampedProducer.name)}@${String(stampedProducer.version)}; record the draft again with draft-rig under a new id; the old record is kept` });
          }
        }
      } catch (error) {
        if (error instanceof RunRecordError) (!assembleOnly && raw.reuse === undefined ? warnings : refusals).push({ code: error.code, path: `${path}.producer`, message: `${path}.producer: ${error.path}: ${error.why}; restore its valid run.json or rebuild the draft with ${rebuild} and record it under a new id` });
        // Unreadable, escaping or changed bytes are DRAFT_RIG_FILE above; the producer is not read from them.
      }
    }
    let editedInputs = new Set<string>();
    const manifestBinding = asArray(parts.files).find(f => binding(f) && f.path === manifestPath) as JsonObject;
    let manifestBytes: Buffer | undefined;
    try {
      if (!draftFileUnavailable(dir, manifestPath, root)) {
        const bytes = readFileSync(fileAt(dir, manifestPath, root));
        manifestBytes = bytes;
        // Changed producer bytes already refuse above; do not interpret their provenance.
        if (sha(bytes) === manifestBinding.sha256) {
          const manifest: Json = JSON.parse(bytes.toString('utf8'));
          if (isObject(manifest)) {
            if (manifest.assembly_config === undefined && latestPartsVerdictStatus(project, raw.id) === 'approved') {
              const manifestField = `${path}.parts.files`;
              warnings.push({ code: 'DRAFT_ASSEMBLY_CONFIG_UNRECORDED', path: manifestField,
                message: `${manifestField}: ${manifestPath} has no assembly_config; retain the accepted draft and use a new assemble output for future review` });
            }
            const result = editedPartInputFindings(dir, raw, manifest, path);
            editedInputs = result.paths;
            (Date.parse(raw.at) < Date.parse(EDITED_PART_INPUTS_SINCE) ? warnings : refusals).push(...result.findings);
          }
        }
      }
    } catch (error) { add('DRAFT_RIG_FILE', path, error instanceof Error ? error.message : String(error)); }
    const unbound = draftUnboundInputs(raw);
    const unrecorded = (why: string): void => { warnings.push({ code: 'DRAFT_CONFIG_INPUTS_UNRECORDED', path: `${path}.config_inputs`, message: `${path}.config_inputs: ${why}; the draft was recorded before ${DRAFT_CONFIG_INPUTS_SINCE} with no config_inputs key, so the parts install that recorded it could not declare its config-named inputs; the record is kept; record a new draft with draft-rig under a new id to bind them` }); };
    try {
      if (!draftFileUnavailable(dir, String(raw.config.path), root)) {
        const config = JSON.parse(readFileSync(fileAt(dir, String(raw.config.path), root), 'utf8'));
        for (const ref of configInputReferences(dir, config)) {
          const named = relative(resolve(dir), resolve(dir, String(raw.config.path), '..', ref.value)).split(sep).join('/');
          // Receipt-file omissions use their own dated contract, including when a newer loader declares them.
          if (editedInputs.has(named) || (ref.at.startsWith('assemble.edited_parts.') && [...editedInputs].some(file => named === file || named.endsWith(`/${file}`)))) continue;
          // A directory input (an occluder plate) is bound by its receipt and names the directory it stands for.
          if (!asArray(raw.config_inputs).some(f => binding(f) && (f.directory === undefined ? f.path === named : f.directory === named))) {
            if (unbound === 'unrecorded') { unrecorded(`config.${ref.at} names ${named}`); continue; }
            const finding = { code: 'DRAFT_RIG_FILE', path, message: `${path}.config_inputs: missing config.${ref.at} input ${named}; preserve the old draft and record a new draft with draft-rig` };
            (unbound === 'legacy' ? warnings : refusals).push(finding);
          }
        }
      }
    } catch (error) {
      if (error instanceof ConfigInputsUnavailable && unbound === 'legacy') warnings.push({ code: 'DRAFT_RIG_FILE', path, message: `${path}: ${error.message}` });
      else if (error instanceof ConfigInputsUnavailable && unbound === 'unrecorded') unrecorded(error.message);
      else add('DRAFT_RIG_FILE', path, error instanceof Error ? error.message : String(error));
    }
    let actualParts: JsonObject[] | undefined;
    try {
      if (!draftFileUnavailable(dir, String(parts.path), root)) {
        const expected = new Map(asArray(parts.files).filter(binding).map(f => [String(f.path), f.sha256]));
        const { files, painting } = partsInventory(dir, String(parts.path), root);
        actualParts = files;
        for (const actual of files) {
          if (painting !== null && actual.path === painting && !expected.has(painting)) {
            warnings.push({ code: 'DRAFT_DECLARED_FILE_UNBOUND', path: `${path}.parts.files`, message: `${path}.parts.files: parts.json declares ${painting} under painting_in_rig but the draft does not bind it; rebuild the draft and record it again with draft-rig` });
            continue;
          }
          if (expected.get(String(actual.path)) !== actual.sha256) throw new Error(`parts inventory changed at ${String(actual.path)}`);
        }
      }
    } catch (error) { add('DRAFT_RIG_FILE', path, error instanceof Error ? error.message : String(error)); }
    if (raw.reuse !== undefined) {
      const finding = checkDraftReuse(dir, project, raw, index, actualParts, manifestBytes, stampedProducer);
      if (finding !== undefined) refusals.push(finding);
    }
    if (unavailable.size > 0) warnings.push({ code: 'DRAFT_RIG_UNAVAILABLE', path, message: `${path}: regenerable draft artifacts are unavailable (${[...unavailable].join(', ')}); restore the recorded bytes before inspecting or rebuilding this draft` });
  }
  checkUnrecordedPartRepaints(dir, project, refusals, warnings);
}

/** Check declared identity/paths, including real paths; identical model bytes alone prove nothing. */
export function draftVersionFindings(dir: string, project: JsonObject): Finding[] {
  const out: Finding[] = [];
  const reserved = resolve(realpathSync(dir), 'derived/drafts');
  const declared = new Set(asArray(project.drafts).filter(isObject).flatMap(d => [d.config, ...asArray(d.files), ...(isObject(d.parts) ? asArray(d.parts.files) : [])])
    .filter(binding).map(f => String(f.path)));
  const visit = (value: Json, key = ''): boolean => {
    if (typeof value === 'string' && ['path', 'source_dir', 'from'].includes(key)) {
      const absolute = resolve(dir, value);
      if (declared.has(value) || absolute === reserved || inside(reserved, absolute)) return true;
      try { const real = realpathSync(absolute); if (real === reserved || inside(reserved, real)) return true; } catch { /* Other readers report missing files. */ }
    }
    if (Array.isArray(value)) return value.some(v => visit(v));
    return isObject(value) && Object.entries(value).some(([k, v]) => visit(v, k));
  };
  for (const [i, raw] of asArray(project.versions).entries()) {
    if (!isObject(raw)) continue;
    const path = `versions[${i}]`;
    const assemble = assembleOnlyVersionFinding(dir, project, raw, path);
    if (assemble !== undefined) {
      out.push(assemble);
      continue;
    }
    if (raw.kind === 'draft-rig' || raw.draft === true || raw.draft_id !== undefined || visit(raw)) {
      out.push({ code: 'DRAFT_RIG_AS_VERSION', path, message: `${path}: a draft cannot be reviewed, packaged or handed off as a production version; build a separately authorised production rig` });
    }
  }
  return out;
}

export const DRAFT_RIG_HELP = `draft-rig:
  <id> [<dir>] --config <path> --from <output dir> [--parts <dir>] [--reuse <draft id> [--reuse-record <sha256>]] [--ledger-report <file>] [--known-regression <row id>=<reason file>]... [--json]
  Record existing labelled draft artifacts under derived/drafts/<id>/; run no producer.
  A bound draft updates the open Review page when its owner ask is ready.
  Prepare any missing evidence, then show the draft with job open --draft <id>.
  With --json on a bound project, the record carries publication { status: published|deferred, lines }.
  Standalone rig output requires --parts. Build and assemble output roots supply their own parts.
  An assemble output root with parts and no rig records layout assemble-only for parts-review.
  Config/output association is declared, not measured reproducibility or producer provenance.
  --reuse binds a reviewed draft's exact parts inventory and inherits its recorded producer.
  --reuse-record selects the prior project.json named by a restart sha256 and retains a snapshot under evidence/draft-reuse/.
  --ledger-report binds the project's own fix-ledger check report (rig-create/fix-ledger-report@1) by sha256;
  a row the previous draft passed that does not pass here is refused unless named by --known-regression.`;

export function draftRigCommand(args: string[], now: number): { stdout: string; exit: number } {
  const opts: Record<string, string> = {};
  const positional: string[] = [];
  const known: [string, string][] = [];
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === '--json') json = true;
    else if (arg === '--known-regression') {
      const value = args[++i];
      const split = value === undefined ? -1 : value.indexOf('=');
      const row = split > 0 ? value!.slice(0, split) : '';
      if (!idPattern.test(row) || split === value!.length - 1 || known.some(([id]) => id === row)) refuse('DRAFT_RIG_USAGE', 'drafts: --known-regression needs <row id>=<reason file>, once per row; see draft-rig help', USAGE_EXIT);
      known.push([row, value!.slice(split + 1)]);
    } else if (['--config', '--from', '--parts', '--reuse', '--reuse-record', '--ledger-report'].includes(arg)) {
      const value = args[++i];
      if (!value || value.startsWith('--') || opts[arg] !== undefined) refuse('DRAFT_RIG_USAGE', `drafts: ${arg} requires one value; see draft-rig help`, USAGE_EXIT);
      opts[arg] = value;
    } else if (arg.startsWith('-')) refuse('DRAFT_RIG_USAGE', `drafts: unsupported ${arg}; see draft-rig help`, USAGE_EXIT);
    else positional.push(arg);
  }
  const id = positional[0];
  if (!id || !idPattern.test(id) || positional.length > 2 || !opts['--config'] || !opts['--from']) refuse('DRAFT_RIG_USAGE', DRAFT_RIG_HELP, USAGE_EXIT);
  const reuseId = opts['--reuse'];
  const reuseRecord = opts['--reuse-record'];
  if ((reuseId !== undefined && !idPattern.test(reuseId)) || (reuseRecord !== undefined && reuseId === undefined)) {
    refuse('DRAFT_RIG_USAGE', 'drafts: use --reuse <draft id> with optional --reuse-record <sha256>; see draft-rig help', USAGE_EXIT);
  }
  if (known.length && !opts['--ledger-report']) refuse('DRAFT_RIG_USAGE', 'drafts: --known-regression names rows of a --ledger-report; supply the report', USAGE_EXIT);
  const reasons: [string, string][] = known.map(([row, file]) => {
    const reason = readVerbatim(file).trim();
    if (!reason) refuse('DRAFT_RIG_USAGE', `drafts: the --known-regression reason file for ${row} is empty; say why the regression is accepted`, USAGE_EXIT);
    return [row, reason];
  });
  const dir = resolve(positional[1] ?? process.cwd());
  const release = acquireBoundJobWrite(dir);
  let intent: PendingPublication | null = null;
  const temporary = join(dir, `.draft-rig-record-${randomUUID()}.tmp`);
  try {
    const { file } = readProject(dir);
    const original = readFileSync(file);
    const project = JSON.parse(original.toString('utf8')) as JsonObject;
    const before = structuredClone(project);
    const root = `derived/drafts/${id}`;
    let record: JsonObject;
    let sourceSnapshot: Buffer | undefined;
    try {
      const from = opts['--from'];
      const output = inventory(dir, from, root);
      const build = isBuildInventory(output, from);
      const standalone = output.some(f => f.path === `${from}/rig.json`);
      const assembled = !build && !standalone ? assemblePartsPath(output, from) : undefined;
      const assembleOnly = assembled !== undefined;
      if (build === standalone && !assembleOnly) throw new Error('ambiguous or missing assemble/build/standalone output layout');
      if (standalone && !opts['--parts']) throw new Error('standalone rig output needs --parts');
      if (assembleOnly && opts['--parts'] !== undefined && opts['--parts'] !== assembled) throw new Error('assemble-only output needs its own parts inventory; omit --parts or name the parts.json directory inside --from');
      const parts = opts['--parts'] ?? assembled ?? from;
      if (assembleOnly && opts['--ledger-report'] !== undefined) {
        const finding = draftRigRequired(`drafts[${id}].ledger_report`, id);
        refuse(finding.code, finding.message);
      }
      const partsFiles = partsInventory(dir, parts, root).files;
      const candidates = diffStackCandidates(resolve(dir, parts, 'parts.json'));
      const present = candidates.filter(file => existsSync(file));
      if (present.length > 1 || (present.length === 0 && reuseId === undefined)) refuse('DRAFT_RIG_STACK', `drafts[${id}].parts.path: ${parts}/parts.json has ${present.length === 0 ? 'no stack candidate' : 'ambiguous stack candidates'} (${candidates.map(file => relative(dir, file)).join(', ')}); re-run rig-parts build into the draft output, or keep assemble's render/ beside rig/`);
      if (present[0] !== undefined) {
        const stackPath = relative(dir, present[0]).split(sep).join('/');
        const stack = fileAt(dir, stackPath, root);
        if ((standalone || assembleOnly) && !output.some(f => f.path === stackPath)) {
          output.push({ path: stackPath, sha256: sha(readFileSync(stack)) });
        }
      }
      const rigPrefix = build ? `${from}/rig` : from;
      if (!assembleOnly) {
        for (const name of ['rig.json', 'motion.json', 'mesh_report.json']) if (!output.some(f => f.path === `${rigPrefix}/${name}`)) throw new Error(`${name}: missing rig output`);
      }
      const configFile = fileAt(dir, opts['--config'], root);
      const config = JSON.parse(readFileSync(configFile, 'utf8')) as Json;
      if (!isObject(config)) throw new Error('config must be an object');
      const manifestFile = fileAt(dir, `${parts}/parts.json`, root);
      const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as Json;
      if (isObject(manifest) && Object.hasOwn(manifest, 'assembly_config')) {
        const changes = assemblyConfigChanges(configFile, readPartsManifest(manifestFile));
        if (changes.length > 0) {
          refuse('ASSEMBLY_CONFIG_STALE', `drafts[${id}].config: ${assemblyChangeDetail(changes)} as the second assemble before draft-rig`);
        }
      }
      const installed = locateParts(dir);
      if (installed === null) throw new Error('install @rig-c/parts before recording a draft');
      const pkgFile = join(installed, 'package.json');
      const pkg = JSON.parse(readFileSync(pkgFile, 'utf8')) as { name: string; version: string };
      const stamps = assembleOnly ? assembleStamps(output, parts) : [];
      if (stamps.length > 1) throw new Error('ambiguous assemble run stamps');
      const stamp = assembleOnly ? stamps[0]?.path : stampBeside(`${rigPrefix}/rig.json`);
      const partSet = { path: parts, files: partsFiles };
      const reused = reuseId === undefined ? undefined : prepareDraftReuse(dir, project, { id, parts: partSet }, reuseId, reuseRecord,
        partsFiles.some(file => file.path === `${parts}/parts.json`) ? readFileSync(fileAt(dir, `${parts}/parts.json`, root)) : undefined);
      sourceSnapshot = reused?.snapshot;
      let producer: JsonObject = reused?.producer ?? { name: pkg.name, version: pkg.version };
      const hasStamp = typeof stamp === 'string' && output.some(f => f.path === stamp);
      if (hasStamp) {
        try {
          const local = stampProducer(readFileSync(fileAt(dir, stamp, root)), stamp, assembleOnly);
          if (reused !== undefined && (local.name !== producer.name || local.version !== producer.version)) {
            refuse('DRAFT_REUSE_PRODUCER', `drafts[${id}].reuse: ${stamp} names ${String(local.name)}@${String(local.version)}, which differs from the reviewed source producer ${String(producer.name)}@${String(producer.version)}; use matching artifacts or run rig-parts build and record a normal draft`);
          }
          producer = local;
        } catch (error) {
          if (error instanceof RunRecordError) refuse(error.code, `drafts[${id}]: ${error.path}: ${error.why}; re-run ${assembleOnly ? 'rig-parts assemble' : 'parts rig'} into the draft output so it writes run.json with its outputs, then record the draft`);
          throw error;
        }
      }
      // A producer newer than the install may declare inputs the install cannot.
      if (releaseAfter(String(producer.version), pkg.version)) {
        const undeclared = inputsUndeclaredByInstall(dir, config);
        const origin = hasStamp ? stamp : `reviewed draft ${reuseId}`;
        if (undeclared.refs.length) refuse('DRAFT_PARTS_INSTALL_BEHIND', `drafts[${id}].config_inputs: the project's @rig-c/parts ${undeclared.version} cannot declare config-named inputs (${undeclared.refs.map(ref => `config.${ref.at}`).join(', ')}) that its producer @rig-c/parts ${String(producer.version)}, read from ${origin}, declares; install @rig-c/parts ${String(producer.version)} in the project, then record the draft again`);
      }
      // Named inputs bind wherever they sit inside the project; checkDrafts below reads them as check does.
      const configInputs = configInputBindings(dir, opts['--config']);
      record = { id, kind: 'draft-rig', ...(assembleOnly ? { layout: ASSEMBLE_ONLY } : {}), at: new Date(now).toISOString(), producer, config: { path: pathOf(dir, configFile), sha256: sha(readFileSync(configFile)) }, parts: partSet, files: output,
        ...(configInputs.length ? { config_inputs: configInputs } : {}), ...(reused === undefined ? {} : { reuse: reused.reuse }) };
    } catch (error) {
      if (error instanceof Refusal) throw error;
      refuse('DRAFT_RIG_MALFORMED', `drafts[${id}]: ${error instanceof Error ? error.message : String(error)}; retain an unambiguous labelled output and its --parts inputs`);
    }
    if (project.drafts !== undefined && !Array.isArray(project.drafts)) refuse('DRAFT_RIG_MALFORMED', 'drafts: expected a list; restore the original record');
    project.drafts = [...asArray(project.drafts), record];
    if (opts['--ledger-report']) Object.assign(record, draftLedgerFields(dir, project, asArray(project.drafts).length - 1, opts['--ledger-report'], reasons, now));
    if (sourceSnapshot !== undefined) retainDraftReuseRecord(dir, sourceSnapshot);
    const errors: Finding[] = [];
    checkDrafts(dir, project, errors);
    const ledger: Finding[] = [];
    checkFixLedger(dir, project, ledger, [], now);
    const index = asArray(project.drafts).length - 1;
    const first = errors[0] ?? ledger.find(f => f.path === `drafts[${index}]` || f.path.startsWith(`drafts[${index}].`)) ?? newRefusals(dir, before, project, { now })[0];
    if (first !== undefined) refuse(first.code, first.message);
    const bytes = Buffer.from(`${JSON.stringify(project, null, 2)}\n`);
    if (!readFileSync(file).equals(original)) refuse('DRAFT_RIG_FILE', 'project.json: draft source changed during registration; retry with frozen inputs');
    const publication = prepareDraftIntent(dir, bytes, id);
    intent = publication.intent;
    const fd = openSync(temporary, 'wx');
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, file);
    const directory = openSync(dir, 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
    if (intent) publishCommittedVersion(dir, id);
    if (json) {
      // A bound project reports whether the open page was updated or the update was deferred; the record itself is unchanged.
      const notice = !readWriterBinding(dir) ? undefined
        : publication.deferred ? { status: 'deferred', lines: [publication.deferred] }
        : { status: 'published', lines: takePublishedLines() };
      return { stdout: JSON.stringify(notice ? { ...record, publication: notice } : record, null, 2), exit: 0 };
    }
    const lines = [`draft-rig: recorded ${id}; no production version created`];
    if (publication.deferred) lines.push(publication.deferred);
    return { stdout: lines.join('\n'), exit: 0 };
  } finally { cancelUncommittedIntent(dir, intent); rmSync(temporary, { force: true }); release(); }
}
