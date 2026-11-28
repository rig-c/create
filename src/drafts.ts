/** Draft identity is create-owned inventory, never producer provenance or a measurement. */
import { latestPartsVerdictStatus } from './parts-verdict-record.ts';
import { ConfigInputsUnavailable, configInputReferences, DIRECTORY_INPUT_RECEIPT, DRAFT_CONFIG_INPUTS_SINCE, draftUnboundInputs, receiptSpec, resolveConfigInput } from './config-inputs.ts';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from './check-reads.ts';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { asArray, isObject, type Finding } from './check.ts';
import { diffStackCandidates } from './diff-map.ts';
import { checkDraftReuse, DRAFT_ID as idPattern } from './draft-reuse.ts';
import { assembleOnlyVersionFinding, isAssembleOnlyDraft } from './draft-layout.ts';
import { RunRecordError, validateRunRecord } from './run-record.ts';
import { checkUnrecordedPartRepaints } from './corrections.ts';
import { EDITED_PART_INPUTS_SINCE, editedPartInputFindings } from './edited-part-inputs.ts';
import type { Json, JsonObject } from './templates.ts';

export const DRAFT_STACK_BINDING_SINCE = '2026-11-19T00:00:00Z';

const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const hex = (v: Json | undefined): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const inside = (root: string, path: string): boolean => { const rel = relative(root, path); return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };

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
    const configPath = String(raw.config.path);
    try {
      if (!draftFileUnavailable(dir, configPath, root)) {
        const config = JSON.parse(readFileSync(fileAt(dir, configPath, root), 'utf8'));
        for (const ref of configInputReferences(dir, config)) {
          const named = relative(resolve(dir), resolve(dir, configPath, '..', ref.value)).split(sep).join('/');
          // Receipt-file omissions use their own dated contract, including when a newer loader declares them.
          if (editedInputs.has(named) || (ref.at.startsWith('assemble.edited_parts.') && [...editedInputs].some(file => named === file || named.endsWith(`/${file}`)))) continue;
          // A directory input (an occluder plate) is bound by its receipt and names the directory it stands for.
          const binds = (input: string): boolean => asArray(raw.config_inputs).some(f => binding(f) && (f.directory === undefined ? f.path === input : f.directory === input));
          if (binds(named)) continue;
          if (unbound === 'refused') {
            try {
              if (binds(resolveConfigInput(dir, configPath, ref).path)) continue;
            } catch (error) {
              add('DRAFT_RIG_FILE', path, error instanceof Error ? error.message : String(error));
              continue;
            }
          }
          if (unbound === 'unrecorded') { unrecorded(`config.${ref.at} names ${named}`); continue; }
          const finding = { code: 'DRAFT_RIG_FILE', path, message: `${path}.config_inputs: missing config.${ref.at} input ${named}; preserve the old draft and record a new draft with draft-rig` };
          (unbound === 'legacy' ? warnings : refusals).push(finding);
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
