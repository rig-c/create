/** Register frozen bytes. Toolchain association and the not-after date are declarations. */
import { createHash } from 'node:crypto';
import { closeSync, linkSync, mkdirSync, mkdtempSync, openSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from './check-reads.ts';
import { acquireBoundJobWrite, beginJobProgress } from './job-writer.ts';
import { isRecordResult, pendingPublications } from './job-outbox.ts';
import { shellWord } from './job-acts.ts';
import { FIGURE_MASK_FILE, PAINTING_IN_RIG_FILE, partsFileReferences, readPartsManifest } from '@rig-c/parts/src/parts.ts';
import { BODY_YAW_DIAL_BONE } from '@rig-c/parts/src/turn.ts';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep, win32 } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { asArray, checkProject, collectItems, isObject, itemFor, type Ctx, type Finding } from './check.ts';
import { literalFile } from './choices.ts';
import { configInputReferences } from './config-inputs.ts';
import { assembleOnlyDraftPath, assertDraftHasRig } from './draft-layout.ts';
import { DRAFT_ID } from './draft-reuse.ts';
import { parseFeedbackAnswers, readProject } from './feedback.ts';
import { carryRigDraftVerdict } from './rig-draft-verdict.ts';
import { assertFigureMaskApproval } from './figure-mask.ts';
import { assertCorrectionApproval } from './correction-writers.ts';
import { OWNER_CHAT_FLAGS, readOwnerChat } from './owner-chat.ts';
import { Refusal, refuse, USAGE_EXIT } from './refusal.ts';
import { baselineOf, newFindings } from './refusal-baseline.ts';
import { prepareRigReviewPackage } from './review-package.ts';
import { checkRigReport, parseRigCheckReport, RIG_CHECK_REPORT_FILE, SOURCE_EXPOSURE_ID, type RigCheckTarget } from './rig-check-report.ts';
import { lockedPackage, type ToolchainKind } from './toolchain-lock.ts';
import { rigVersionDateFinding } from './rig-version-date.ts';
import { checkRegisteredRuns, FROZEN_RUN_SPECS, RUN_RECORD_SINCE, RunRecordError, validateRunRecord, type FrozenRunSpec } from './run-record.ts';
import { isScratchBindingPath } from './scratch-bindings.ts';
import { approvedStructureDelta, rigPartsApproval, structurePathIsIgnored } from './structure.ts';
import { stageOfStep } from './stages.ts';
import { checkVersionDeclarations, formatDeclarations } from './version-declarations.ts';
import { HEAD_TURN_SINCE } from './waypoints.ts';
import type { Json, JsonObject } from './templates.ts';

export const DEPTH_MAP_BINDING_SINCE = '2026-11-19T00:00:00Z';
const DEPTH_MAP_BINDING_SPEC = 'rig-parts-depth-map-binding/1';
const CHECK_MODEL_PATH = 'check/build/skeleton.model.json';

const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const absolute = (path: string): boolean => isAbsolute(path) || win32.isAbsolute(path);
const literal = (path: string): boolean => !!path && !absolute(path) && !path.includes('\\') && !path.includes(':') && path.split('/').every(p => p !== '' && p !== '.' && p !== '..');
const escapePointerToken = (token: string): string => token.replaceAll('~', '~0').replaceAll('/', '~1');
const insideOrEqual = (root: string, target: string): boolean => {
  const rel = relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};
const RESERVED_REGISTRATION_NAMES = new Set([
  'at-source.json',
  'compile-report.json',
  'config-source.json',
  'requirements-source.json',
  'config.json',
  'package-lock.json',
  'path-adapter.json',
  'citations.json',
  'depth-manifest.json',
  'depth-report.json',
  'depth-source-parts.json',
  'depth-map-bindings',
]);
function isValidAdaptedTarget(target: string): boolean {
  return literal(target)
    && !RESERVED_REGISTRATION_NAMES.has(target)
    && !/^rig(?:c)?-run-\d+\.json$/.test(target)
    && target !== 'out'
    && !target.startsWith('out/');
}
function fail(code: string, path: string, why: string): never {
  refuse(code, `${path}: ${why}; retain the cited frozen inputs and register a new rig version`);
}

/** A retry of a committed registration names that version and its publication, not the numbering rule (create#844). */
function refuseRegisteredVersion(dir: string, project: JsonObject, n: number): void {
  const version = asArray(project.versions).filter(isObject).find(row => row.n === n);
  if (!version) return;
  let publication: string;
  try {
    const pending = pendingPublications(dir).find(entry => !isRecordResult(entry.result)
      && entry.result.selector && 'version' in entry.result.selector && entry.result.selector.version === n);
    publication = pending
      ? `its publication is pending (JOB_PUBLISH_PENDING${pending.failure ? `: ${pending.failure.code}` : ''}); do not register it again: restore the bound host and run rig-create job reconcile`
      : 'no publication of it is pending; to register changed inputs, use a version number after all registered versions';
  } catch { publication = 'its publication state is unreadable; run rig-create check'; }
  const at = isObject(version.registration) && typeof version.registration.at === 'string' ? ` at ${version.registration.at}` : '';
  refuse('RIG_VERSION_ALREADY_REGISTERED', `versions[v${n}]: ${String(version.kind)} v${n} is already recorded${at}; ${publication}`);
}

function bytesAt(dir: string, binding: Json | undefined, output = false): Buffer {
  if (!isObject(binding) || typeof binding.path !== 'string' || !literal(binding.path)
    || typeof binding.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(binding.sha256)) throw Error('expected literal retained path and sha256');
  const file = literalFile(dir, binding.path);
  if (!output && structurePathIsIgnored(dir, binding.path)) throw Error('evidence is under an ignored root');
  const bytes = readFileSync(file);
  if (sha(bytes) !== binding.sha256) throw Error(`${binding.path} bytes changed`);
  return bytes;
}

const TOOLCHAIN_KINDS = 'npm-lock-v3 (package-lock.json) or bun-lock (bun.lock)';

function lockVersions(bytes: Buffer, found: string, declared?: ToolchainKind): { kind: ToolchainKind; versions: JsonObject } {
  const invalid = (reason: string): Error => Error(`found ${found}: ${reason}; supply ${TOOLCHAIN_KINDS}`);
  const text = bytes.toString();
  let raw: Json;
  let strictJson = false;
  try {
    raw = JSON.parse(text) as Json;
    strictJson = true;
  } catch {
    try { raw = Bun.JSONC.parse(text) as Json; }
    catch { throw invalid('unparseable lock'); }
  }
  if (!isObject(raw) || !isObject(raw.packages)) throw invalid('missing lock package entries');
  const kind = strictJson && raw.lockfileVersion === 3 ? 'npm-lock-v3'
    : (raw.lockfileVersion === 1 || raw.lockfileVersion === 2) && isObject(raw.workspaces) ? 'bun-lock'
    : undefined;
  if (!kind || (declared && kind !== declared)) throw invalid('lock format does not match a supported declaration');
  const versions: JsonObject = {};
  for (const name of ['@rig-c/parts', '@rig-c/core']) {
    const { version, integrity } = lockedPackage(raw, kind, name);
    if (typeof version !== 'string' || !version.trim()) throw invalid(`missing resolved version for ${name}`);
    if (kind === 'bun-lock'
      && (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(version)
        || typeof integrity !== 'string' || !/^sha(?:1|256|384|512)-[A-Za-z0-9+/]+={0,2}$/.test(integrity))) {
      throw invalid(`missing exact registry version or integrity for ${name}`);
    }
    versions[name] = version;
  }
  return { kind, versions };
}

function pointerTokens(pointer: Json | undefined): string[] {
  if (typeof pointer !== 'string' || !pointer.startsWith('/') || pointer.length < 2 || /~(?![01])/.test(pointer)) {
    throw Error('supply a nonempty RFC 6901 JSON pointer');
  }
  const raw = pointer.slice(1).split('/');
  if (raw.some(t => t === '')) throw Error('supply a nonempty RFC 6901 JSON pointer without empty segments');
  return raw.map(t => t.replaceAll('~1', '/').replaceAll('~0', '~'));
}

function pointerValue(raw: Json, pointer: Json | undefined): Json | undefined {
  let value: Json | undefined = raw;
  for (const key of pointerTokens(pointer)) {
    if (!isObject(value) && !Array.isArray(value)) return undefined;
    if (!Object.hasOwn(value, key)) return undefined;
    value = (value as JsonObject)[key];
  }
  return value;
}

function setPointerValue(raw: Json, pointer: string, next: string): void {
  const tokens = pointerTokens(pointer);
  let cur: Json = raw;
  for (let i = 0; i < tokens.length - 1; i++) {
    const key = tokens[i]!;
    if (Array.isArray(cur)) {
      if (!/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= cur.length) throw Error(`pointer ${pointer} not found`);
      cur = cur[Number(key)]!;
    } else if (isObject(cur) && Object.hasOwn(cur, key)) {
      cur = cur[key]!;
    } else throw Error(`pointer ${pointer} not found`);
  }
  const last = tokens.at(-1)!;
  if (Array.isArray(cur)) {
    if (!/^(?:0|[1-9]\d*)$/.test(last) || Number(last) >= cur.length || typeof cur[Number(last)] !== 'string') {
      throw Error(`pointer ${pointer} does not select a string`);
    }
    cur[Number(last)] = next;
  } else if (isObject(cur) && Object.hasOwn(cur, last) && typeof cur[last] === 'string') {
    cur[last] = next;
  } else throw Error(`pointer ${pointer} does not select a string`);
}

function utcDate(raw: Json | undefined): raw is string {
  return typeof raw === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|\+00:00)$/.test(raw)
    && rigVersionDateFinding({ kind: 'rig', at: raw }) === null
    && Number(raw.slice(11, 13)) < 24 && Number(raw.slice(14, 16)) < 60 && Number(raw.slice(17, 19)) < 60;
}

const versionDestinations = (n: number): [string, string, string] => [
  `outputs/v${n}`,
  `evidence/v${n}/registration`,
  `derived/review/v${n}`,
];

function destinationExists(dir: string, target: string, onInvalidPath: (target: string) => never): boolean {
  let current = dir;
  for (const part of target.split('/')) {
    current = join(current, part);
    if (existsSync(current) && (lstatSync(current).isSymbolicLink() || !lstatSync(current).isDirectory())) onInvalidPath(target);
  }
  return existsSync(join(dir, target));
}

/** Find a vacant registration number after the recorded versions using the writer's destination rules. */
export function nextRigRegistrationNumber(dir: string, start: number): number | undefined {
  const onInvalidPath = (target: string): never => fail('RIG_REGISTRATION_PATH_INVALID', target, 'destination must have real directory parents');
  try {
    for (let n = start; Number.isSafeInteger(n); n++) {
      const occupied = versionDestinations(n).filter(target => destinationExists(dir, target, onInvalidPath));
      if (occupied.length === 0) return n;
    }
  } catch { /* An invalid or unreadable destination prevents a safe suggestion. */ }
}

function treeBindings(dir: string, root: string): JsonObject[] {
  return readdirSync(join(dir, root)).sort().flatMap(name => {
    const path = `${root}/${name}`;
    const stat = lstatSync(join(dir, path));
    if (stat.isSymbolicLink()) throw Error(`${path}: symlinks are unsupported`);
    if (stat.isDirectory()) return treeBindings(dir, path);
    const bytes = readFileSync(literalFile(dir, path));
    return [{ path, sha256: sha(bytes), bytes: bytes.length }];
  });
}

interface NormalizedAdapterRow {
  kind: 'legacy-abs' | 'pointer';
  doc: 'config' | 'requirements';
  pointer: string;
  originalString: string;
  sourcePath?: string;
  adaptedString: string;
  raw: JsonObject;
}

function parsePathAdapter(raw: Json): NormalizedAdapterRow[] {
  if (!Array.isArray(raw)) throw Error('supply an array of path adapter mappings');
  const rows: NormalizedAdapterRow[] = [];
  const seenLegacyAt = new Set<string>();
  const seenPointers = new Set<string>();
  for (const entry of raw) {
    if (!isObject(entry)) throw Error('supply object path adapter mappings');
    let row: NormalizedAdapterRow;
    if (entry.doc === undefined && entry.pointer === undefined) {
      if (typeof entry.at !== 'string' || typeof entry.before !== 'string' || typeof entry.after !== 'string'
        || seenLegacyAt.has(entry.at)) {
        throw Error('supply distinct at/before/after mappings');
      }
      seenLegacyAt.add(entry.at);
      const validAt = entry.at.startsWith('.') && entry.at.length >= 2 && !entry.at.slice(1).split('.').some(p => !p);
      const parts = validAt ? entry.at.slice(1).split('.') : [];
      const pointer = validAt ? `/${parts.map(escapePointerToken).join('/')}` : '';
      const adaptedString = validAt ? `inputs/${parts.join('/')}` : '';
      row = { kind: 'legacy-abs', doc: 'config', pointer, originalString: entry.after, sourcePath: entry.before, adaptedString, raw: entry };
    } else if (Object.keys(entry).sort().join(',') === 'after,before,doc,pointer') {
      if ((entry.doc !== 'config' && entry.doc !== 'requirements')
        || typeof entry.pointer !== 'string'
        || typeof entry.before !== 'string' || !entry.before || absolute(entry.before)
        || typeof entry.after !== 'string' || !isValidAdaptedTarget(entry.after)) {
        throw Error('supply doc ("config"|"requirements"), RFC 6901 pointer, relative before and literal in-package after');
      }
      pointerTokens(entry.pointer);
      const pointerKey = `${entry.doc}:${entry.pointer}`;
      if (seenPointers.has(pointerKey)) throw Error(`duplicate path adapter target ${pointerKey}`);
      seenPointers.add(pointerKey);
      row = { kind: 'pointer', doc: entry.doc, pointer: entry.pointer, originalString: entry.before, adaptedString: entry.after, raw: entry };
    } else {
      throw Error('supply distinct at/before/after or doc/pointer/before/after mappings');
    }
    rows.push(row);
  }
  return rows;
}

interface AssetRefSpec {
  doc: 'config' | 'requirements';
  pointer: string;
  dotPath: string;
  value: string;
  kind: 'file' | 'dir' | 'file-or-dir';
  autoRelocate: boolean;
  pre394: boolean;
  declaredSha256?: string;
  set?: (next: string) => void;
}

function configAdapterMatches(config: JsonObject, ref: AssetRefSpec, before: string): boolean {
  return ref.value === before || /^assemble\.edited_parts\.receipts\.\d+\.file$/.test(ref.dotPath)
    && pointerValue(config, ref.pointer) === before;
}

function adaptConfigReference(config: JsonObject, refs: AssetRefSpec[], pointer: string, value: string): void {
  const ref = refs.find(entry => entry.pointer === pointer);
  // The producer setter also rebases shared directories and sibling receipt names.
  if (ref?.set) ref.set(value);
  else setPointerValue(config, pointer, value);
}

function collectConfigAssetRefs(dir: string, config: JsonObject, strict = true): AssetRefSpec[] {
  const byPointer = new Map<string, AssetRefSpec>();
  const addRef = (spec: AssetRefSpec): void => {
    if (!byPointer.has(spec.pointer)) byPointer.set(spec.pointer, spec);
  };
  const assemble = isObject(config.assemble) ? config.assemble : undefined;
  const occluders = isObject(assemble) && Array.isArray(assemble.occluders) ? assemble.occluders : [];
  for (const ref of configInputReferences(dir, config)) {
    const dotPath = ref.at.replace(/\[(\d+)\]/g, '.$1');
    const pointer = `/${dotPath.split('.').map(escapePointerToken).join('/')}`;
    let declaredSha256: string | undefined;
    const occMatch = /^assemble\.occluders\.(\d+)\.image$/.exec(dotPath);
    if (occMatch) {
      const entry = occluders[Number(occMatch[1])];
      if (isObject(entry) && entry.sha256 !== undefined) {
        if (typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
          if (strict) throw Error(`config.${dotPath}: expected 64-character lowercase hex sha256`);
        } else {
          declaredSha256 = entry.sha256;
        }
      }
    }
    addRef({
      doc: 'config',
      pointer,
      dotPath,
      value: ref.value,
      ...(ref.set ? { set: ref.set } : {}),
      kind: dotPath.endsWith('.plate') ? 'dir' : 'file-or-dir',
      autoRelocate: absolute(ref.value) || !isValidAdaptedTarget(ref.value),
      pre394: true,
      ...(strict && declaredSha256 ? { declaredSha256 } : {}),
    });
  }
  if (isObject(assemble)) {
    if (Array.isArray(assemble.take)) {
      for (const [i, entry] of assemble.take.entries()) {
        if (!isObject(entry)) continue;
        if (typeof entry.run_dir === 'string' && entry.run_dir !== '') {
          addRef({ doc: 'config', pointer: `/assemble/take/${i}/run_dir`, dotPath: `assemble.take.${i}.run_dir`, value: entry.run_dir, kind: 'dir', autoRelocate: true, pre394: true });
        }
        if (typeof entry.st_input === 'string' && entry.st_input !== '') {
          addRef({ doc: 'config', pointer: `/assemble/take/${i}/st_input`, dotPath: `assemble.take.${i}.st_input`, value: entry.st_input, kind: 'file', autoRelocate: true, pre394: true });
        }
        if (isObject(entry.reference) && typeof entry.reference.painting === 'string' && entry.reference.painting !== '') {
          let declaredSha256: string | undefined;
          if (entry.reference.sha256 !== undefined) {
            if (typeof entry.reference.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.reference.sha256)) {
              if (strict) throw Error(`config.assemble.take.${i}.reference.sha256: expected 64-character lowercase hex sha256`);
            } else {
              declaredSha256 = entry.reference.sha256;
            }
          }
          addRef({
            doc: 'config',
            pointer: `/assemble/take/${i}/reference/painting`,
            dotPath: `assemble.take.${i}.reference.painting`,
            value: entry.reference.painting,
            kind: 'file',
            autoRelocate: true,
            pre394: false,
            ...(strict && declaredSha256 ? { declaredSha256 } : {}),
          });
        }
      }
    }
    if (isObject(assemble.editor_receipts) && Array.isArray(assemble.editor_receipts.receipts)) {
      for (const [i, entry] of assemble.editor_receipts.receipts.entries()) {
        if (!isObject(entry) || typeof entry.file !== 'string' || entry.file === '') continue;
        let declaredSha256: string | undefined;
        if (entry.sha256 !== undefined) {
          if (typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
            if (strict) throw Error(`config.assemble.editor_receipts.receipts.${i}.sha256: expected 64-character lowercase hex sha256`);
          } else {
            declaredSha256 = entry.sha256;
          }
        }
        addRef({
          doc: 'config',
          pointer: `/assemble/editor_receipts/receipts/${i}/file`,
          dotPath: `assemble.editor_receipts.receipts.${i}.file`,
          value: entry.file,
          kind: 'file',
          autoRelocate: true,
          pre394: true,
          ...(strict && declaredSha256 ? { declaredSha256 } : {}),
        });
      }
    }
    if (Array.isArray(assemble.cuts)) {
      for (const [i, entry] of assemble.cuts.entries()) {
        if (!isObject(entry)) continue;
        if (typeof entry.under === 'string' && entry.under !== '') {
          addRef({ doc: 'config', pointer: `/assemble/cuts/${i}/under`, dotPath: `assemble.cuts.${i}.under`, value: entry.under, kind: 'file', autoRelocate: true, pre394: false });
        } else if (isObject(entry.under) && typeof entry.under.plate === 'string' && entry.under.plate !== '') {
          addRef({ doc: 'config', pointer: `/assemble/cuts/${i}/under/plate`, dotPath: `assemble.cuts.${i}.under.plate`, value: entry.under.plate, kind: 'dir', autoRelocate: true, pre394: false });
        }
      }
    }
  }
  if (isObject(config.limbs)) {
    for (const [limbName, limb] of Object.entries(config.limbs)) {
      if (!isObject(limb) || !Array.isArray(limb.segments)) continue;
      for (const [i, seg] of limb.segments.entries()) {
        if (isObject(seg) && typeof seg.cap === 'string' && seg.cap !== '') {
          addRef({
            doc: 'config',
            pointer: `/limbs/${escapePointerToken(limbName)}/segments/${i}/cap`,
            dotPath: `limbs.${limbName}.segments.${i}.cap`,
            value: seg.cap,
            kind: 'file',
            autoRelocate: true,
            pre394: false,
          });
        }
      }
    }
  }
  if (isObject(config.depth)) {
    for (const run of ['full', 'head'] as const) {
      const block = config.depth[run];
      if (!isObject(block)) continue;
      if (isObject(block.atlas) && typeof block.atlas.image === 'string' && block.atlas.image !== '') {
        addRef({ doc: 'config', pointer: `/depth/${run}/atlas/image`, dotPath: `depth.${run}.atlas.image`, value: block.atlas.image, kind: 'file', autoRelocate: true, pre394: false });
      }
      if (isObject(block.layers)) {
        for (const [layer, spec] of Object.entries(block.layers)) {
          if (isObject(spec) && typeof spec.image === 'string' && spec.image !== '') {
            addRef({
              doc: 'config',
              pointer: `/depth/${run}/layers/${escapePointerToken(layer)}/image`,
              dotPath: `depth.${run}.layers.${layer}.image`,
              value: spec.image,
              kind: 'file',
              autoRelocate: true,
              pre394: false,
            });
          }
        }
      }
    }
  }
  const scanAbsolute = (value: Json, pointer: string, dotPath: string): void => {
    if (typeof value === 'string' && absolute(value)) {
      addRef({ doc: 'config', pointer, dotPath, value, kind: 'file-or-dir', autoRelocate: true, pre394: true });
      return;
    }
    if (Array.isArray(value)) value.forEach((v, i) => scanAbsolute(v, `${pointer}/${i}`, dotPath ? `${dotPath}.${i}` : String(i)));
    else if (isObject(value)) {
      for (const [k, v] of Object.entries(value)) {
        scanAbsolute(v, `${pointer}/${escapePointerToken(k)}`, dotPath ? `${dotPath}.${k}` : k);
      }
    }
  };
  scanAbsolute(config, '', '');
  return [...byPointer.values()];
}

function collectRequirementsAssetRefs(requirements: JsonObject, portableRequirementsPath: string, strict = true): AssetRefSpec[] {
  const refs: AssetRefSpec[] = [];
  const setup = isObject(requirements.setup_painting) ? requirements.setup_painting : {};
  const reqParent = dirname(portableRequirementsPath);
  for (const key of ['figure_mask', 'backdrop'] as const) {
    if (setup[key] === undefined) continue;
    const entry = setup[key];
    if (!isObject(entry) || typeof entry.path !== 'string' || !entry.path.trim()
      || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      if (!strict && key === 'backdrop') continue;
      throw Error(`requirements.setup_painting.${key} must declare a nonempty path and 64-character lowercase hex sha256`);
    }
    const candidateRel = requirementsAssetTarget(reqParent, entry.path);
    refs.push({
      doc: 'requirements',
      pointer: `/setup_painting/${key}/path`,
      dotPath: `setup_painting.${key}.path`,
      value: entry.path,
      kind: 'file',
      autoRelocate: key === 'backdrop' || absolute(entry.path) || !isValidAdaptedTarget(entry.path) || !isValidAdaptedTarget(candidateRel),
      pre394: key === 'figure_mask',
      declaredSha256: entry.sha256,
    });
  }
  return refs;
}

function requirementsAssetTarget(parent: string, path: string): string {
  return parent === '.' ? path : `${parent}/${path}`;
}

function mappedAssetPath(ref: AssetRefSpec, row?: NormalizedAdapterRow, parent = '.'): string {
  if (row) return row.adaptedString;
  if (!ref.autoRelocate) return ref.value;
  const fieldPath = ref.dotPath.split('.').join('/');
  return parent === '.' ? `inputs/${fieldPath}` : fieldPath;
}

function pointerAdapterRow(ref: AssetRefSpec, after: string): JsonObject {
  return { doc: ref.doc, pointer: ref.pointer, before: ref.value, after };
}

function absoluteConfigAdapter(config: JsonObject, ref: AssetRefSpec): NormalizedAdapterRow | undefined {
  // In the legacy grammar, before names the frozen file and after matches
  // the literal config value. Generation can infer a source only from that value.
  if (!isAbsolute(ref.value)) return undefined;
  const raw = { at: `.${ref.dotPath}`, before: ref.value, after: ref.value };
  const [row] = parsePathAdapter([raw]);
  return row?.pointer === ref.pointer && pointerValue(config, ref.pointer) === ref.value ? row : undefined;
}

function registrationReservedTargets(bunLock: boolean, runs: readonly FrozenRunSpec[]): Set<string> {
  const targets = new Set(RESERVED_REGISTRATION_NAMES);
  if (bunLock) targets.add('bun.lock');
  for (const spec of runs) targets.add(`${spec.replace('/', '-')}.json`);
  return targets;
}

/** A declared depth/turn config is the existing registration's depth input branch. */
function usesDepth(config: JsonObject): boolean {
  const turn = isObject(config.turn) ? config.turn : {};
  const body = isObject(turn.body) ? turn.body : {};
  return isObject(config.depth) || [turn.roles, body.roles].some(roles => isObject(roles) && Object.keys(roles).length > 0);
}

/** Reads only producer declarations and bytes, never producer measurements. */
function depthBindingFindings(dir: string, version: JsonObject, config: JsonObject, record: JsonObject | undefined, warnings: Finding[]): Finding[] {
  if (!usesDepth(config) && record?.depth === undefined) return [];
  const path = `versions[v${String(version.n)}].registration.depth`;
  const findings: Finding[] = [];
  const missing = (why: string): void => {
    const finding = { code: 'RIG_DEPTH_BINDING_MISSING', path, message: `${path}: ${why}; retain rig's depth_sheets.json and, for per-part maps, --depth-manifest and parts' depth-report.json when registering a new rig version` };
    (typeof version.at === 'string' && Date.parse(version.at) < Date.parse(HEAD_TURN_SINCE) ? warnings : findings).push(finding);
  };
  const depth = record?.depth;
  if (!isObject(depth)) { missing('no producer depth binding'); return findings; }
  if (!isObject(depth.sheets) || depth.route === 'per-part' && (!isObject(depth.manifest) || !isObject(depth.report))) {
    missing('incomplete producer depth binding'); return findings;
  }
  try {
    if (depth.route !== 'per-part' && depth.route !== 'per-layer') throw Error('expected per-part or per-layer route');
    if (depth.route === 'per-layer' && (depth.manifest !== undefined || depth.report !== undefined)) throw Error('per-part reports require the per-part route');
    const read = (binding: Json | undefined, spec: string, output = false, parts = true): JsonObject => {
      const inventory = asArray(output ? version.outputs : record?.files).filter(isObject);
      if (!isObject(binding) || !inventory.some(row => row.path === binding.path && row.sha256 === binding.sha256)) throw Error('depth file is absent from the retained inventory');
      const doc: Json = JSON.parse(bytesAt(dir, binding, output).toString('utf8'));
      if (!isObject(doc) || doc.spec !== spec || parts && !Array.isArray(doc.parts)) throw Error(`expected ${spec}${parts ? ' with parts[]' : ''}`);
      return doc;
    };
    const digest = (value: Json | undefined, field: string): string => {
      if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw Error(`${field}: expected producer SHA-256`);
      return value;
    };
    const namedRows = (value: Json | undefined, label: string): JsonObject[] => {
      if (!Array.isArray(value) || value.length === 0 || value.some(row => !isObject(row) || typeof row.part !== 'string' || !row.part)) throw Error(`${label}: expected nonempty named parts[]`);
      const rows = value as JsonObject[];
      if (new Set(rows.map(row => row.part)).size !== rows.length) throw Error(`${label}: duplicate part`);
      return rows;
    };
    const outputRoot = `outputs/v${String(version.n)}/out`;
    const outputs = asArray(version.outputs).filter(isObject);
    const outputBytes = (path: string): Buffer => {
      const binding = outputs.find(row => row.path === path);
      if (!binding) throw Error(`${path}: absent from retained outputs`);
      return bytesAt(dir, binding, true);
    };
    const parts: Json = JSON.parse(outputBytes(`${outputRoot}/parts.json`).toString('utf8'));
    if (!isObject(parts) || !Array.isArray(parts.parts)) throw Error('retained assembled parts.json has no parts[]');
    const mappedParts = parts.parts.filter(isObject);
    const sourceList = (raw: Json | undefined, label: string): JsonObject[] => {
      if (!Array.isArray(raw) || raw.length === 0 || raw.some(row => !isObject(row))) throw Error(`${label}: expected depth sources[]`);
      const rows = raw as JsonObject[];
      for (const row of rows) {
        digest(row.sha256, `${label}.sha256`);
        if (typeof row.from !== 'string' || !row.from || typeof row.image !== 'string' || !literal(row.image)
          || !Array.isArray(row.crop) || row.crop.length !== 4 || row.crop.some(v => typeof v !== 'number' || !Number.isFinite(v))) throw Error(`${label}: invalid declared depth source`);
      }
      return rows;
    };
    const sheets = namedRows(read(depth.sheets, 'rig-parts-depth-sheets/1', true).parts, 'rig sheets');
    for (const row of sheets) {
      const ref = row.depth;
      if (!isObject(ref) || typeof ref.image !== 'string' || !literal(ref.image) || ref.image.includes('/')
        || !['white', 'black'].includes(String(ref.near)) || typeof ref.zScale !== 'number' || !(ref.zScale > 0) || !Number.isFinite(ref.zScale)
        || !Array.isArray(row.size) || row.size.length !== 2 || row.size.some(v => typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1)) throw Error('invalid consumed sheet metadata');
      const sources = sourceList(ref.sources, 'rig sheet sources');
      // Rig may pad/crop a sheet. Its declared source provenance must still match
      // an assembled part; comparing the padded sheet hash to apply's would be wrong.
      if (!mappedParts.some(part => isObject(part.depth) && part.depth.near === ref.near && part.depth.zScale === ref.zScale
        && isDeepStrictEqual(sourceList(part.depth.sources, 'assembled sheet sources'), sources))) throw Error('rig sheet sources do not bind the retained assembled parts');
      outputBytes(`${outputRoot}/rig/images/${ref.image}`);
    }
    if (depth.route === 'per-part') {
      const manifest = read(depth.manifest, 'rig-parts-depth-inputs/1');
      const report = read(depth.report, 'rig-parts-depth-report/1');
      for (const field of ['partsSha256', 'recipeSha256'] as const) {
        if (digest(report[field], `report.${field}`) !== digest(manifest[field], `manifest.${field}`)) throw Error(`producer ${field} declarations disagree`);
      }
      digest(report.rigConfigSha256, 'report.rigConfigSha256');
      if (digest(report.manifestSha256, 'report.manifestSha256') !== (depth.manifest as JsonObject).sha256) throw Error('producer report does not bind the retained prepare manifest');
      if (depth.source_parts !== undefined) {
        const binding = depth.source_parts;
        const sourceSha256 = depth.source_parts_applied === true
          ? outputs.find(row => row.path === `${outputRoot}/parts.json`)?.sha256
          : manifest.partsSha256;
        if (!isObject(binding) || !asArray(record?.files).filter(isObject).some(f => f.path === binding.path && f.sha256 === binding.sha256)
          || digest(binding.sha256, 'source parts') !== sourceSha256) throw Error('prepare manifest does not bind the retained source parts');
        bytesAt(dir, binding);
      }
      const prepared = namedRows(manifest.parts, 'prepared parts');
      const applied = namedRows(report.parts, 'applied parts');
      let leftOut: string[] = [];
      if (report.selection !== undefined) {
        if (!isObject(report.selection) || !Array.isArray(report.selection.groups) || report.selection.groups.length === 0
          || report.selection.groups.some(g => typeof g !== 'string' || !g) || new Set(report.selection.groups).size !== report.selection.groups.length
          || !Array.isArray(report.selection.leftOut) || report.selection.leftOut.some(p => typeof p !== 'string' || !p)
          || new Set(report.selection.leftOut).size !== report.selection.leftOut.length) throw Error('invalid report selection');
        leftOut = report.selection.leftOut as string[];
        if (leftOut.some(part => applied.some(row => row.part === part) || mappedParts.some(p => p.name === part && p.depth !== undefined))) throw Error('left-out part cannot be applied or retain a depth sheet');
      }
      if (!isDeepStrictEqual(prepared.map(row => row.part).sort(), [...applied.map(row => row.part), ...leftOut].sort())) throw Error('prepare/apply part sets disagree');
      const bindings = depth.map_bindings === undefined ? [] : depth.map_bindings;
      if (!Array.isArray(bindings) || bindings.some(b => !isObject(b) || !applied.some(row => row.part === b.part))
        || new Set(bindings.map(b => (b as JsonObject).part)).size !== bindings.length) throw Error('expected unique map bindings for applied parts');
      for (const row of applied) {
        const input = prepared.find(p => p.part === row.part)!;
        const binding = bindings.find(b => isObject(b) && b.part === row.part);
        if (binding === undefined) {
          const bindingPath = `${path}.map_bindings[${String(row.part)}]`;
          const finding = { code: 'RIG_DEPTH_MAP_BINDING_MISSING', path: bindingPath,
            message: `${bindingPath}: no retained Parts map receipt (DEPTH_MAP_BINDING_ABSENT); re-infer changed prepared inputs, run rig-parts depth-bind immediately after inference, then register with --depth-manifest and --depth-map-binding <map.binding.json> for each map; reuse the existing map and receipt only when inputSha256 is unchanged, never bind an old map to new input` };
          const registeredAt = typeof record?.at === 'string' ? record.at : version.at;
          (typeof registeredAt === 'string' && Date.parse(registeredAt) < Date.parse(DEPTH_MAP_BINDING_SINCE) ? warnings : findings).push(finding);
        } else {
          if (!isObject(binding) || binding.spec !== DEPTH_MAP_BINDING_SPEC) throw Error('expected declared Parts map binding spec');
          const receipt = read(binding, DEPTH_MAP_BINDING_SPEC, false, false);
          if (!isDeepStrictEqual(Object.keys(receipt).sort(), ['inputSha256', 'mapSha256', 'part', 'spec'])
            || receipt.part !== row.part
            || digest(receipt.mapSha256, 'receipt.mapSha256') !== digest(row.mapSha256, 'report.mapSha256')
            || digest(receipt.inputSha256, 'receipt.inputSha256') !== digest(input.inputSha256, 'manifest.inputSha256')) throw Error('Parts map receipt disagrees with the applied map or prepared input');
        }
        const part = mappedParts.find(p => p.name === row.part);
        if (!part || !isObject(part.depth) || typeof part.name !== 'string' || !literal(part.name) || part.name.includes('/')
          || typeof part.depth.image !== 'string' || !literal(part.depth.image) || part.depth.image.includes('/')) throw Error('report part has no retained assembled depth declaration');
        const partDepth = part.depth;
        for (const field of ['sourceSha256', 'inputSha256'] as const) {
          if (digest(row[field], `report.${field}`) !== digest(input[field], `manifest.${field}`)) throw Error(`producer ${field} declarations disagree`);
        }
        if (digest(row.sourceSha256, 'report.sourceSha256') !== sha(outputBytes(`${outputRoot}/parts/${part.name}.png`))) throw Error('applied part art differs from the retained assembled part');
        if (digest(row.sheetSha256, 'report.sheetSha256') !== sha(outputBytes(`${outputRoot}/parts/${partDepth.image}`))) throw Error('applied sheet differs from the retained assembled sheet');
        const map = digest(row.mapSha256, 'report.mapSha256');
        const sources = sourceList(partDepth.sources, 'applied sheet sources');
        if (!sources.some(source => source.sha256 === map && source.from === part.from)) throw Error('applied map hash is absent from the assembled depth sources');
        if (row.near !== partDepth.near || row.zScale !== partDepth.zScale) throw Error('applied depth units disagree with the assembled declaration');
        if (!sheets.some(sheet => isObject(sheet.depth) && isDeepStrictEqual(sheet.depth.sources, sources)
          && sheet.depth.near === partDepth.near && sheet.depth.zScale === partDepth.zScale)) throw Error('rig consumed no sheet from the reported applied part');
      }
    }
  } catch (error) {
    findings.push({ code: 'RIG_DEPTH_BINDING_INVALID', path, message: `${path}: ${String(error)}; restore the exact producer files or register a new rig version` });
  }
  return findings;
}

/** Only explicitly registered versions opt in. Older version contracts are unchanged. */
export function rigRegistrationFindings(dir: string, project: JsonObject, warnings: Finding[] = [], collection: JsonObject | null = null): Finding[] {
  const findings: Finding[] = depthPlanFindings(project, warnings, collection);
  turnExtraGroupFindings(dir, project, warnings, collection);
  turnMissingBodyGroupFindings(dir, project, warnings, collection);
  const allVersions = asArray(project.versions).filter(isObject);
  const registeredNumbers = new Set(allVersions.map(v => v.n).filter((n): n is number => typeof n === 'number' && Number.isSafeInteger(n)));
  for (const [index, version] of allVersions.entries()) {
    if (version.registration === undefined) {
      if (version.kind === 'rig' && version.pre_interview !== true && isObject(version.provenance)) {
        try {
          const config: Json = JSON.parse(bytesAt(dir, version.provenance.config).toString('utf8'));
          if (isObject(config)) findings.push(...depthBindingFindings(dir, version, config, undefined, warnings));
        } catch { /* Existing provenance checks own unreadable config evidence. */ }
      }
      continue;
    }
    const path = `versions[v${String(version.n)}]`;
    const add = (code: string, field: string, why: string): void => { findings.push({ code, path: `${path}.${field}`, message: `${path}.${field}: ${why}; restore the retained registration inputs or register a new rig version` }); };
    const record = version.registration;
    if (version.kind !== 'rig' || !isObject(record) || record.kind !== 'frozen-rig/1' || !utcDate(record.at)
      || !isObject(record.toolchain) || (record.toolchain.kind !== 'npm-lock-v3' && record.toolchain.kind !== 'bun-lock') || version.at_basis !== 'not-after') {
      add('RIG_REGISTRATION_INVALID', 'registration', `expected frozen-rig/1, a UTC registration date and ${TOOLCHAIN_KINDS} declaration`); continue;
    }
    const prevMax = Math.max(0, ...allVersions.slice(0, index).map(v => typeof v.n === 'number' && Number.isSafeInteger(v.n) ? v.n : 0));
    const versionN = typeof version.n === 'number' && Number.isSafeInteger(version.n) ? version.n : 0;
    if (versionN <= prevMax || allVersions.filter(v => v.n === versionN).length !== 1) {
      add('RIG_REGISTRATION_INVALID', 'registration', 'version number must strictly follow prior registered versions');
    } else {
      const expectedSkipped: number[] = [];
      for (let k = prevMax + 1; k < versionN; k++) expectedSkipped.push(k);
      if (expectedSkipped.length === 0) {
        if (record.skipped !== undefined) add('RIG_REGISTRATION_INVALID', 'registration.skipped', 'no version numbers were skipped before this version');
      } else if (!Array.isArray(record.skipped) || record.skipped.length !== expectedSkipped.length) {
        add('RIG_REGISTRATION_INVALID', 'registration.skipped', `expected skipped records for v${expectedSkipped.join(', v')}`);
      } else {
        for (const [i, raw] of record.skipped.entries()) {
          const k = expectedSkipped[i]!;
          const allowed = versionDestinations(k);
          if (!isObject(raw) || Object.keys(raw).length !== 2 || raw.n !== k || registeredNumbers.has(k)
            || !Array.isArray(raw.destinations) || !raw.destinations.length
            || raw.destinations.some(d => typeof d !== 'string' || !allowed.includes(d))
            || !isDeepStrictEqual(raw.destinations, allowed.filter(d => (raw.destinations as Json[]).includes(d)))) {
            add('RIG_REGISTRATION_INVALID', `registration.skipped[${i}]`, `expected unregistered v${k} occupying destinations`);
          }
        }
      }
    }
    // Versions registered before #981 may bind a parts approval; that recorded binding must still resolve.
    if (version.accepted_parts !== undefined && !rigPartsApproval(project, version)) {
      findings.push({ code: 'RIG_PARTS_APPROVAL_INVALID', path: `${path}.accepted_parts`, message: `${path}.accepted_parts: no unique bound parts approval was live at registration; restore its signoff and evidence` });
    }
    const runPaths = checkRegisteredRuns(dir, path, record, findings, warnings);
    try {
      const { versions } = lockVersions(bytesAt(dir, record.toolchain.source), record.toolchain.kind, record.toolchain.kind);
      if (!isDeepStrictEqual(versions, version.built_with)) add('RIG_TOOLCHAIN_MISMATCH', 'built_with', 'declared versions disagree with the retained toolchain lock');
    } catch (error) { add('RIG_TOOLCHAIN_LOCK_INVALID', 'registration.toolchain.source', `declared ${record.toolchain.kind}: ${String(error)}; retain ${TOOLCHAIN_KINDS}`); }
    try {
      const source = version.at_source;
      const raw = JSON.parse(bytesAt(dir, source).toString()) as Json;
      const at = pointerValue(raw, isObject(source) ? source.pointer : undefined);
      if (!utcDate(at) || at !== version.at) throw Error('the cited pointer must equal at and contain a valid UTC instant');
      if (Date.parse(at) > Date.parse(String(record.at))) throw Error('the cited not-after instant is later than registration');
    } catch (error) { add('RIG_AT_SOURCE_INVALID', 'at_source', String(error)); }
    let adapterRows: NormalizedAdapterRow[] | null = null;
    try { adapterRows = parsePathAdapter(JSON.parse(bytesAt(dir, record.path_adapter).toString())); }
    catch (error) { add('RIG_PATH_ADAPTER_INVALID', 'registration.path_adapter', String(error)); }
    try {
      const files = asArray(record.files);
      if (!files.length || files.some(f => !isObject(f))) throw Error('missing retained input inventory');
      for (const file of files) if (!isObject(file) || typeof file.path !== 'string' || !runPaths.has(file.path)) bytesAt(dir, file);
      const config = isObject(version.provenance) ? version.provenance.config : undefined;
      for (const binding of [record.toolchain.source, version.at_source, record.compile, record.config_source, record.path_adapter, config]) {
        if (!isObject(binding) || !files.some(f => isObject(f) && f.path === binding.path && f.sha256 === binding.sha256)) throw Error('a declared input is absent from the retained inventory');
        bytesAt(dir, binding);
      }
      const configSourceRaw = JSON.parse(bytesAt(dir, record.config_source).toString()) as Json;
      const portable = JSON.parse(bytesAt(dir, config).toString()) as Json;
      if (!isObject(configSourceRaw) || !isObject(portable)) throw Error('config-source and portable config must be JSON objects');
      findings.push(...depthBindingFindings(dir, version, configSourceRaw, record, warnings));
      checkPortable(portable, String((config as JsonObject).path));
      const evidenceRoot = dirname(String((config as JsonObject).path));
      const reqAdapters = (adapterRows ?? []).filter(r => r.doc === 'requirements');
      const hasPointerAdapters = (adapterRows ?? []).some(r => r.kind === 'pointer');
      const hasReqBindings = record.requirements_source !== undefined || record.requirements !== undefined || reqAdapters.length > 0;
      const adapterFormat = isObject(record.path_adapter) ? record.path_adapter.format : undefined;
      if (adapterFormat !== undefined && adapterFormat !== 'json-pointer/1') throw Error('unsupported registration.path_adapter.format');
      const isPointerAdaptedRecord = adapterFormat === 'json-pointer/1' || hasPointerAdapters || hasReqBindings;
      const sourceConfigRefs = collectConfigAssetRefs(dir, configSourceRaw, isPointerAdaptedRecord);
      if (adapterRows !== null) {
        const expectedConfig = replayConfigAdapter(dir, configSourceRaw, sourceConfigRefs, adapterRows, isPointerAdaptedRecord, why => {
          add('RIG_PATH_ADAPTER_INVALID', 'registration.path_adapter', why);
          throw Error(why);
        });
        if (!isDeepStrictEqual(expectedConfig, portable)) {
          throw Error('the retained runtime config differs from config-source outside declared path_adapter substitutions');
        }
      }
      const adaptedPointersForCheck = new Set(
        (adapterRows ?? []).filter(r => r.doc === 'config' && r.pointer).map(r => r.pointer),
      );
      for (const ref of collectConfigAssetRefs(dir, portable, isPointerAdaptedRecord)) {
        if (!isPointerAdaptedRecord && !ref.pre394 && !adaptedPointersForCheck.has(ref.pointer)) continue;
        if (!isValidAdaptedTarget(ref.value)) throw Error(`config.${ref.dotPath}: expected literal retained path`);
        const targetPath = `${evidenceRoot}/${ref.value}`;
        const fileBinding = files.find(f => isObject(f) && f.path === targetPath);
        const dirBinding = files.some(f => isObject(f) && typeof f.path === 'string' && f.path.startsWith(`${targetPath}/`));
        if (isPointerAdaptedRecord && ref.kind === 'dir' && isObject(fileBinding)) throw Error(`${targetPath} must be a retained directory`);
        if (ref.kind === 'file' || ref.declaredSha256 !== undefined) {
          if (!isObject(fileBinding)) throw Error(`${targetPath} is absent from the retained inventory`);
          const bytes = bytesAt(dir, fileBinding);
          if (ref.declaredSha256 !== undefined && sha(bytes) !== ref.declaredSha256) {
            throw Error(`${targetPath} sha256 differs from config.${ref.dotPath} declaration`);
          }
        } else if (ref.kind === 'file-or-dir' && !isObject(fileBinding) && !dirBinding) {
          throw Error(`${targetPath} is absent from the retained inventory`);
        }
      }
      if (typeof portable.requirements !== 'string') {
        if (hasReqBindings) throw Error('requirements bindings or adapter entries present without config.requirements');
      } else {
        const runtimeReqPath = `${evidenceRoot}/${portable.requirements}`;
        const runtimeReqInFiles = files.find(f => isObject(f) && f.path === runtimeReqPath);
        if (!isObject(runtimeReqInFiles)) throw Error(`${runtimeReqPath} is absent from the retained inventory`);
        const runtimeReqObj = JSON.parse(bytesAt(dir, runtimeReqInFiles).toString()) as Json;
        if (!isObject(runtimeReqObj)) throw Error('retained requirements must be a JSON object');
        if (isPointerAdaptedRecord) checkPortable(runtimeReqObj, runtimeReqPath, true);
        if (isPointerAdaptedRecord) {
          if (!isObject(record.requirements_source) || !isObject(record.requirements)) {
            throw Error('both requirements_source and requirements bindings are required when requirements are adapted');
          }
          for (const binding of [record.requirements_source, record.requirements]) {
            if (!files.some(f => isObject(f) && f.path === binding.path && f.sha256 === binding.sha256)) {
              throw Error('declared requirements input is absent from the retained inventory');
            }
            bytesAt(dir, binding);
          }
          if (record.requirements.path !== runtimeReqPath) throw Error('registration.requirements.path disagrees with config.requirements');
          if (record.requirements_source.source_path !== undefined
            && (typeof record.requirements_source.source_path !== 'string' || !literal(record.requirements_source.source_path))) {
            throw Error('invalid registration.requirements_source.source_path');
          }
          const reqSourceObj = JSON.parse(bytesAt(dir, record.requirements_source).toString()) as Json;
          if (!isObject(reqSourceObj)) throw Error('requirements-source must be a JSON object');
          const sourceReqRefs = collectRequirementsAssetRefs(reqSourceObj, portable.requirements, true);
          if (adapterRows !== null) {
            const expectedReq = structuredClone(reqSourceObj);
            for (const row of reqAdapters) {
              const ref = sourceReqRefs.find(r => r.pointer === row.pointer);
              if (!ref || pointerValue(reqSourceObj, row.pointer) !== row.originalString) {
                add('RIG_PATH_ADAPTER_INVALID', 'registration.path_adapter', `requirements ${row.pointer}: adapter does not match requirements-source`);
                throw Error(`requirements ${row.pointer}: adapter does not match requirements-source`);
              }
              setPointerValue(expectedReq, row.pointer, row.adaptedString);
            }
            if (!isDeepStrictEqual(expectedReq, runtimeReqObj)) {
              throw Error('the retained runtime requirements differs from requirements-source outside declared path_adapter substitutions');
            }
          }
        }
        const reqParent = dirname(portable.requirements);
        for (const ref of collectRequirementsAssetRefs(runtimeReqObj, portable.requirements, isPointerAdaptedRecord)) {
          if (!isPointerAdaptedRecord && !ref.pre394) continue;
          const relInEvidence = posix.normalize(requirementsAssetTarget(reqParent, ref.value));
          if (absolute(ref.value) || (isPointerAdaptedRecord && !isValidAdaptedTarget(ref.value)) || !isValidAdaptedTarget(relInEvidence)) {
            throw Error(`requirements.${ref.dotPath}: expected literal retained path`);
          }
          const assetTargetPath = `${evidenceRoot}/${relInEvidence}`;
          const assetBinding = files.find(f => isObject(f) && f.path === assetTargetPath);
          if (!isObject(assetBinding)) throw Error(`${assetTargetPath} is absent from the retained inventory`);
          const assetBytes = bytesAt(dir, assetBinding);
          if (ref.declaredSha256 !== undefined && sha(assetBytes) !== ref.declaredSha256) {
            throw Error(`${assetTargetPath} sha256 differs from requirements.${ref.dotPath} declaration`);
          }
        }
      }
      if (!isObject(record.idle) || record.idle.path !== `outputs/v${String(version.n)}/idle/frames.json`) throw Error('idle manifest must be in the version output');
      const manifest = JSON.parse(bytesAt(dir, record.idle, true).toString()) as Json;
      if (!isObject(manifest) || manifest.spec !== 'rigc-frames/1' || !Array.isArray(manifest.sets)
        || !manifest.sets.some(set => isObject(set) && set.animation === 'idle' && typeof set.fps === 'number' && set.fps > 0)) throw Error('idle requires the producer rigc-frames/1 manifest and an idle set');
      if (!asArray(version.outputs).length) throw Error('empty output inventory');
      for (const output of asArray(version.outputs)) {
        if (!isObject(output) || typeof output.path !== 'string' || !literal(output.path) || !output.path.startsWith(`outputs/v${String(version.n)}/`)
          || typeof output.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(output.sha256)) throw Error('invalid frozen output binding');
        const bytes = readFileSync(literalFile(dir, output.path));
        if (sha(bytes) !== output.sha256 || bytes.length !== output.bytes) throw Error(`${output.path} changed`);
      }
      const actual = treeBindings(dir, `outputs/v${String(version.n)}`).sort((a, b) => String(a.path).localeCompare(String(b.path), 'en'));
      const expected = [...asArray(version.outputs)].sort((a, b) => String(isObject(a) ? a.path : '').localeCompare(String(isObject(b) ? b.path : ''), 'en'));
      if (!isDeepStrictEqual(actual, expected)) throw Error('the frozen output tree differs from its complete inventory');
      if (!isObject(record.copied) || record.copied.files !== actual.length || record.copied.bytes !== actual.reduce((sum, f) => sum + Number(f.bytes), 0)) throw Error('copied totals disagree with the frozen output inventory');
      for (const [path, spec] of [['rig/rig.json', 'rigc-rig/1'], ['rig/motion.json', 'rigc-motion/1'], [CHECK_MODEL_PATH, 'rigc-compiled/3']]) {
        const document = JSON.parse(readFileSync(literalFile(dir, `outputs/v${String(version.n)}/out/${path}`), 'utf8')) as Json;
        if (!isObject(document) || document.spec !== spec) throw Error(`${path}: expected producer spec ${spec}`);
      }
      const frozenModel = actual.find(f => f.path === `outputs/v${String(version.n)}/out/${CHECK_MODEL_PATH}`);
      findings.push(...checkRigReport(record, `${path}.registration.check_report`, `${versionDestinations(versionN)[1]}/${RIG_CHECK_REPORT_FILE}`,
        frozenModel?.sha256, binding => bytesAt(dir, binding), warnings));
      const idleRoot = isObject(record.idle) ? dirname(String(record.idle.path)) : '';
      for (const set of manifest.sets.filter(isObject)) {
        if (set.animation !== 'idle') continue;
        if (typeof set.dir !== 'string' || !literal(set.dir) || !Number.isSafeInteger(set.written) || Number(set.written) < 1) throw Error('invalid idle set directory or written count');
        const frames = asArray(version.outputs).filter(f => isObject(f) && typeof f.path === 'string'
          && dirname(f.path) === `${idleRoot}/${set.dir}` && /^f\d+\.png$/.test(f.path.split('/').at(-1)!));
        if (frames.length !== set.written) throw Error('idle frame inventory differs from the producer written count');
      }
      const compile = JSON.parse(bytesAt(dir, record.compile).toString()) as Json;
      if (!isObject(compile) || compile.spec !== 'build-report/1' || compile.command !== 'build' || !Array.isArray(compile.gates)
        || compile.gates.length === 0 || compile.gates.some(g => !isObject(g) || !Array.isArray(g.failures) || g.failures.length > 0)) throw Error('retain the successful producer build-report/1');
    } catch (error) { add('RIG_REGISTRATION_FILE_INVALID', 'registration.files', String(error)); }
  }
  return findings;
}

function checkPortable(value: Json, document: string, requirementsDocument = false, location: string[] = []): void {
  if (typeof value === 'string' && absolute(value)) {
    const field = `${document}#/${location.map(escapePointerToken).join('/')}`;
    const provenancePointer = requirementsDocument
      && location.at(-2) === 'x-source' && location.at(-1) === 'json_pointer';
    if (!provenancePointer) throw Error(`${field}: contains an unresolved absolute path`);
    // Parts leaves x-* metadata opaque, without declaring a target document to resolve.
    if (!value.startsWith('/') || /~(?![01])/.test(value)) throw Error(`${field}: expected an RFC 6901 JSON pointer with valid escapes`);
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => checkPortable(entry, document, requirementsDocument, [...location, String(index)]));
  } else if (isObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      checkPortable(entry, document, requirementsDocument, [...location, key]);
    }
  }
}

function replayConfigAdapter(
  dir: string, config: JsonObject, refs: AssetRefSpec[], adapterRows: NormalizedAdapterRow[],
  pointerFormat: boolean, invalid: (why: string) => never,
): JsonObject {
  const expectedConfig = structuredClone(config);
  const expectedConfigRefs = collectConfigAssetRefs(dir, expectedConfig, pointerFormat);
  const adaptedConfigPointers = new Set<string>();
  for (const row of adapterRows.filter(r => r.doc === 'config')) {
    if (row.kind === 'legacy-abs') {
      const currentVal = row.pointer ? pointerValue(config, row.pointer) : undefined;
      if (row.pointer && typeof currentVal === 'string' && absolute(currentVal) && currentVal === row.originalString) {
        if (!row.sourcePath || !absolute(row.sourcePath) || !isValidAdaptedTarget(row.adaptedString)) {
          invalid(`config ${row.pointer}: invalid legacy adapter`);
        }
        setPointerValue(expectedConfig, row.pointer, row.adaptedString);
        adaptedConfigPointers.add(row.pointer);
      }
      continue;
    }
    const ref = refs.find(r => r.pointer === row.pointer);
    if (!ref || !configAdapterMatches(config, ref, row.originalString)) {
      invalid(`config ${row.pointer}: adapter does not match config-source`);
    }
    adaptedConfigPointers.add(row.pointer);
    adaptConfigReference(expectedConfig, expectedConfigRefs, row.pointer, row.adaptedString);
  }
  if (!pointerFormat) {
    for (const ref of refs) {
      if (adaptedConfigPointers.has(ref.pointer)) continue;
      if (/^assemble\.take\.\d+\.(?:run_dir|st_input)$|^assemble\.editor_receipts\.receipts\.\d+\.file$/.test(ref.dotPath)
        && !absolute(ref.value)) {
        setPointerValue(expectedConfig, ref.pointer, mappedAssetPath(ref));
      }
    }
  }
  return expectedConfig;
}

interface RegistrationAssetIO {
  checkSourceAncestors: (path: string, label: string, allowedRoot?: string) => void;
  sourceBytes: (path: string) => Buffer;
  copyTree: (source: string, target: string) => void;
  retain: (target: string, bytes: Buffer) => JsonObject;
}

interface SourceFile { source: string; bytes: Buffer }

/** An optional snapshot of the original assembly, using the draft's recorded parts path. */
function plateAssemblySources(dir: string, project: JsonObject, partsDir: string, versionOut: string): Map<string, SourceFile> | undefined {
  const parts = asArray(project.drafts).filter(isObject).flatMap(draft => {
    if (typeof draft.id !== 'string' || !DRAFT_ID.test(draft.id) || !isObject(draft.parts)) return [];
    const path = draft.parts.path;
    return typeof path === 'string' && literal(path) && path.startsWith(`derived/drafts/${draft.id}/`)
      && path.endsWith('/rig') && resolve(dir, path) === partsDir ? [draft.parts] : [];
  });
  if (parts.length !== 1) return;
  const draftParts = parts[0]!;
  const manifestPath = `${String(draftParts.path)}/parts.json`;
  const manifestBinding = asArray(draftParts.files).filter(isObject).find(file => file.path === manifestPath);
  if (manifestBinding === undefined) return;
  const assembly = posix.dirname(String(draftParts.path));
  const read = (path: string): SourceFile => {
    const source = literalFile(dir, `${assembly}/${path}`);
    return { source, bytes: readFileSync(source) };
  };
  try {
    const receipt = read('run.json');
    const { spec, record } = validateRunRecord(receipt.bytes, `${assembly}/run.json`, { allowAssembleInputs: true });
    if (spec !== 'rig-run/1' || record.command !== 'assemble') return;
    const snapshot = new Map([['run.json', receipt]]);
    const usedPaths = new Set(['run.json']);
    for (const output of asArray(record.outputs).filter(isObject)) {
      const path = String(output.path);
      const portablePath = path.normalize('NFC').toLowerCase();
      if (!literal(path) || usedPaths.has(portablePath)) return;
      const file = read(path);
      if (sha(file.bytes) !== output.sha256) return;
      usedPaths.add(portablePath);
      snapshot.set(path, file);
    }
    const manifest = readPartsManifest(join(versionOut, 'parts.json'));
    if (manifest.scene?.figure_mask !== FIGURE_MASK_FILE) return;
    const paths = ['parts.json', FIGURE_MASK_FILE];
    if (manifest.painting_in_rig !== undefined) paths.push(PAINTING_IN_RIG_FILE);
    const boundManifest = snapshot.get('rig/parts.json');
    if (boundManifest === undefined || sha(boundManifest.bytes) !== manifestBinding.sha256) return;
    for (const path of paths) {
      if (!snapshot.get(`rig/${path}`)?.bytes.equals(readFileSync(join(versionOut, path)))) return;
    }
    return snapshot;
  } catch {
    // Missing, unreadable or malformed optional producer evidence cannot supply a plate source.
    return;
  }
}

function registrationSourceReader(dir: string, requestedDir: string, recordSource?: (file: SourceFile) => void) {
  const systemRoots = [resolve(tmpdir()), '/tmp', '/var', dirname(resolve(requestedDir)), dirname(dir)];
  const isSystemAncestor = (candidate: string): boolean =>
    systemRoots.some(root => root === candidate || root.startsWith(`${candidate}${sep}`));
  const checkSourceAncestors = (absolutePath: string, label: string, allowedRoot?: string): void => {
    let current = absolutePath;
    while (dirname(current) !== current && (current === absolutePath || !isSystemAncestor(current))) {
      if (existsSync(current) && lstatSync(current).isSymbolicLink()) fail('RIG_REGISTRATION_PATH_INVALID', label, 'source symlinks are unsupported');
      if (allowedRoot && current === allowedRoot) break;
      current = dirname(current);
    }
  };
  const sourceBytes = (path: string): Buffer => {
    const source = resolve(dir, path);
    const stat = lstatSync(source);
    if (stat.isSymbolicLink()) fail('RIG_REGISTRATION_PATH_INVALID', path, 'source symlinks are unsupported');
    checkSourceAncestors(source, path);
    if (!stat.isFile()) fail('RIG_REGISTRATION_FILE_INVALID', path, 'expected a regular source file');
    const bytes = readFileSync(source);
    recordSource?.({ source, bytes });
    return bytes;
  };
  return { checkSourceAncestors, sourceBytes };
}

// Walk the lexical spelling before resolving system temp aliases or input symlinks.
function canonicalSourcePath(path: string): string {
  let parent = path;
  while (!existsSync(parent)) parent = dirname(parent);
  return resolve(realpathSync(parent), relative(parent, path));
}

function walkSourceTree(
  path: string, target: string,
  directory: (path: string, target: string, names: string[]) => void,
  file: (path: string, target: string) => void,
): void {
  if (lstatSync(path).isDirectory()) {
    const names = readdirSync(path).sort();
    directory(path, target, names);
    for (const name of names) walkSourceTree(join(path, name), `${target}/${name}`, directory, file);
  } else {
    file(path, target);
  }
}

/** Resolve, verify and lay out the same assets for generation and registration. */
function mapRegistrationAssets(
  dir: string, configPath: string, config: JsonObject, evidence: string, adapterLabel: string,
  reservedTargets: ReadonlySet<string>, io: RegistrationAssetIO, callerAdapter?: NormalizedAdapterRow[],
) {
  const generate = callerAdapter === undefined;
  callerAdapter ??= [];
  const { checkSourceAncestors, sourceBytes, copyTree, retain } = io;
  const configDir = dirname(realpathSync(resolve(dir, configPath)));
  let configRefs: AssetRefSpec[];
  try { configRefs = collectConfigAssetRefs(dir, config); }
  catch (error) { if (error instanceof Refusal) throw error; return fail('RIG_REGISTRATION_FILE_INVALID', 'config', String(error)); }
  for (const row of callerAdapter.filter(r => r.kind === 'pointer' && r.doc === 'config')) {
    const ref = configRefs.find(r => r.pointer === row.pointer);
    if (!ref || !configAdapterMatches(config, ref, row.originalString)) {
      return fail('RIG_PATH_ADAPTER_INVALID', adapterLabel, `config ${row.pointer}: adapter does not match config-source`);
    }
  }
  const configUsesPointers = callerAdapter.some(row => row.kind === 'pointer')
    || configRefs.some(ref => !absolute(ref.value) && (generate || ref.autoRelocate));
  const configAllowedRoot = configUsesPointers || insideOrEqual(dir, configDir) ? dir : configDir;
  const portable = structuredClone(config);
  const portableRefs = collectConfigAssetRefs(dir, portable);
  const effectiveAdapter: JsonObject[] = callerAdapter.map(r => r.raw);
  const conflictsWithReserved = (candidate: string): boolean => {
    for (const existing of reservedTargets) {
      if (existing === candidate || existing.startsWith(`${candidate}/`) || candidate.startsWith(`${existing}/`)) return true;
    }
    return false;
  };
  let reqSourcePath: string | undefined;
  let portableReqRel: string | undefined;
  for (const ref of configRefs) {
    const callerRow = generate && absolute(ref.value)
      ? absoluteConfigAdapter(config, ref)
      : callerAdapter.find(r => r.doc === 'config' && r.pointer === ref.pointer && (r.kind === 'pointer' || absolute(ref.value) && r.originalString === ref.value));
    let sourcePath: string;
    if (absolute(ref.value)) {
      if (!callerRow || callerRow.kind !== 'legacy-abs' || !callerRow.pointer || !callerRow.sourcePath || !absolute(callerRow.sourcePath) || !isValidAdaptedTarget(callerRow.adaptedString)) {
        return fail('RIG_RUNTIME_PATH_UNRESOLVED', `config.${ref.dotPath}`, 'absolute input has no exact recorded adapter');
      }
      sourcePath = resolve(dir, callerRow.sourcePath);
    } else {
      sourcePath = resolve(configDir, ref.value);
    }
    checkSourceAncestors(sourcePath, `config.${ref.dotPath}`, !absolute(ref.value) ? configAllowedRoot : undefined);
    sourcePath = canonicalSourcePath(sourcePath);
    if (!absolute(ref.value) && !insideOrEqual(configAllowedRoot, sourcePath)) {
      return fail('RIG_REGISTRATION_PATH_INVALID', `config.${ref.dotPath}`, 'relative input escapes the project');
    }
    if (!existsSync(sourcePath)) {
      return fail('RIG_REGISTRATION_FILE_INVALID', `config.${ref.dotPath}`, 'referenced source asset is missing');
    }
    const stat = lstatSync(sourcePath);
    if (stat.isSymbolicLink()) return fail('RIG_REGISTRATION_PATH_INVALID', `config.${ref.dotPath}`, 'source symlinks are unsupported');
    if (ref.kind === 'dir' && !stat.isDirectory()) return fail('RIG_REGISTRATION_FILE_INVALID', `config.${ref.dotPath}`, 'expected a source directory');
    if (ref.kind === 'file' && !stat.isFile()) return fail('RIG_REGISTRATION_FILE_INVALID', `config.${ref.dotPath}`, 'expected a regular source file');
    if (ref.declaredSha256 !== undefined) {
      const bytes = sourceBytes(sourcePath);
      if (sha(bytes) !== ref.declaredSha256) {
        return fail('RIG_REGISTRATION_FILE_INVALID', `config.${ref.dotPath}`, 'source bytes differ from declared sha256');
      }
    }
    const adaptedValue = mappedAssetPath(ref, callerRow);
    const addRow = generate || (!callerRow && ref.autoRelocate);
    if (addRow) {
      effectiveAdapter.push(callerRow?.raw ?? pointerAdapterRow(ref, adaptedValue));
    }
    if (!isValidAdaptedTarget(adaptedValue) || conflictsWithReserved(adaptedValue)) {
      return fail('RIG_REGISTRATION_PATH_INVALID', `${evidence}/${adaptedValue}`, 'two distinct inputs collide or target is invalid');
    }
    // A pointer row also runs the producer setter for equal paths. Edited
    // receipts can still need rebasing after a sibling changed their shared dir.
    if (adaptedValue !== ref.value || callerRow?.kind === 'pointer' || (addRow && !callerRow)) {
      adaptConfigReference(portable, portableRefs, ref.pointer, adaptedValue);
    }
    if (ref.pointer === '/requirements') {
      reqSourcePath = sourcePath;
      portableReqRel = adaptedValue;
    } else {
      copyTree(sourcePath, `${evidence}/${adaptedValue}`);
    }
  }
  let runtimeRequirements: JsonObject | undefined;
  let requirementsSourceBinding: JsonObject | undefined;
  let requirementsRuntimeBinding: JsonObject | undefined;
  if (typeof config.requirements !== 'string') {
    if (callerAdapter.some(r => r.doc === 'requirements')) {
      return fail('RIG_PATH_ADAPTER_INVALID', adapterLabel, 'requirements adapter supplied without config.requirements');
    }
  } else if (reqSourcePath && portableReqRel) {
    const reqOriginalBytes = sourceBytes(reqSourcePath);
    let originalReq: Json;
    try { originalReq = JSON.parse(reqOriginalBytes.toString('utf8')); }
    catch (error) { return fail('RIG_REGISTRATION_FILE_INVALID', 'requirements', String(error)); }
    if (!isObject(originalReq)) return fail('RIG_REGISTRATION_FILE_INVALID', 'requirements', 'expected a JSON object');
    let reqRefs: AssetRefSpec[];
    try { reqRefs = collectRequirementsAssetRefs(originalReq, portableReqRel); }
    catch (error) { return fail('RIG_REGISTRATION_FILE_INVALID', 'requirements', String(error)); }
    for (const row of callerAdapter.filter(r => r.doc === 'requirements')) {
      const ref = reqRefs.find(r => r.pointer === row.pointer);
      if (!ref || ref.value !== row.originalString) {
        return fail('RIG_PATH_ADAPTER_INVALID', adapterLabel, `requirements ${row.pointer}: adapter does not match requirements-source`);
      }
    }
    const portableReq = structuredClone(originalReq);
    const reqDir = dirname(reqSourcePath);
    const reqUsesPointers = effectiveAdapter.some(row => row.pointer !== undefined)
      || reqRefs.some(ref => generate || ref.autoRelocate);
    const reqAllowedRoot = reqUsesPointers || insideOrEqual(dir, reqDir) ? dir : configDir;
    const reqParent = dirname(portableReqRel);
    for (const ref of reqRefs) {
      const callerRow = callerAdapter.find(r => r.doc === 'requirements' && r.pointer === ref.pointer);
      if (absolute(ref.value)) {
        return fail('RIG_RUNTIME_PATH_UNRESOLVED', `requirements.${ref.dotPath}`, 'requirements setup_painting path must be relative');
      }
      const lexicalSource = resolve(reqDir, ref.value);
      checkSourceAncestors(lexicalSource, `requirements.${ref.dotPath}`, reqAllowedRoot);
      const assetSource = canonicalSourcePath(lexicalSource);
      if (!insideOrEqual(reqAllowedRoot, assetSource)) {
        return fail('RIG_REGISTRATION_PATH_INVALID', `requirements.${ref.dotPath}`, 'relative input escapes the project');
      }
      if (!existsSync(assetSource)) {
        return fail('RIG_REGISTRATION_FILE_INVALID', `requirements.${ref.dotPath}`, 'referenced source asset is missing');
      }
      const assetBytes = sourceBytes(assetSource);
      if (ref.declaredSha256 !== undefined && sha(assetBytes) !== ref.declaredSha256) {
        return fail('RIG_REGISTRATION_FILE_INVALID', `requirements.${ref.dotPath}`, 'source bytes differ from declared sha256');
      }
      const adaptedValue = mappedAssetPath(ref, callerRow, reqParent);
      if (generate || !callerRow && ref.autoRelocate) effectiveAdapter.push(pointerAdapterRow(ref, adaptedValue));
      const relInEvidence = requirementsAssetTarget(reqParent, adaptedValue);
      if (!isValidAdaptedTarget(adaptedValue) || !isValidAdaptedTarget(relInEvidence) || conflictsWithReserved(relInEvidence)) {
        return fail('RIG_REGISTRATION_PATH_INVALID', `${evidence}/${relInEvidence}`, 'two distinct inputs collide or target is invalid');
      }
      retain(`${evidence}/${relInEvidence}`, assetBytes);
      if (adaptedValue !== ref.value) setPointerValue(portableReq, ref.pointer, adaptedValue);
    }
    runtimeRequirements = portableReq;
    if (effectiveAdapter.some(row => row.pointer !== undefined)) {
      const reqSourceRel = insideOrEqual(dir, reqSourcePath) ? relative(dir, reqSourcePath).split(sep).join('/') : undefined;
      requirementsSourceBinding = {
        ...retain(`${evidence}/requirements-source.json`, reqOriginalBytes),
        ...(reqSourceRel && literal(reqSourceRel) && !isScratchBindingPath(reqSourceRel) ? { source_path: reqSourceRel } : {}),
      };
      const runtimeReqBytes = isDeepStrictEqual(originalReq, portableReq)
        ? reqOriginalBytes : Buffer.from(`${JSON.stringify(portableReq, null, 2)}\n`);
      requirementsRuntimeBinding = retain(`${evidence}/${portableReqRel}`, runtimeReqBytes);
    } else {
      retain(`${evidence}/${portableReqRel}`, reqOriginalBytes);
    }
  }
  return { portable, effectiveAdapter, runtimeRequirements, requirementsSourceBinding, requirementsRuntimeBinding, reqSourcePath, portableReqRel };
}

const RIG_VERSION_ADAPTER_USAGE = 'rig-version adapter [<dir>] --config <file> --out <file>';
export const RIG_VERSION_INPUTS = '--parts <dir> --rig <dir> --build <dir> --idle <dir> --config <file> --path-adapter <file> --compile-report <file> --check-report <check.json> --toolchain-lock <file> --run-record <run.json> --at-source <file> --at-pointer <pointer> --by <agent>';
export const NO_DRAFT_VERDICT = '--no-draft-verdict';

export function rigRegistrationCommand(args: readonly string[]): string {
  return ['rig-create', 'rig-version', ...args].map(shellWord).join(' ');
}

export const RIG_VERSION_HELP = `rig-version <n> [<dir>] --parts <dir> --rig <dir> --build <dir> --idle <render dir>
  --config <file> --path-adapter <file> --compile-report <file> --toolchain-lock <bun.lock|package-lock.json>
  --at-source <dated JSON file> --at-pointer </pointer> --by <registrant> [--run-record <run.json>]... [--citations <sections JSON>] [--depth-manifest <prepare manifest>] [--depth-map-binding <map.binding.json>]... [--json]
  [--check-report <check.json>] [${NO_DRAFT_VERDICT}]
  Copy and hash frozen producer outputs. Retain an explicitly declared toolchain lock, producer run records and UTC not-after date.
  For --build check/build from rig-parts check, --compile-report is check/build-report.json beside it (Parts 2.47.0 and later).
  Accept specific failed bars or unmet requirement lines from --check-report with repeatable --accept-check-bar <id> or --accept-check-line <name>,
  and a failed SOURCE_EXPOSURE line with --accept-check-exposure.
  Acceptance requires --check-accepted-by <owner> --owner-chat <words file> --said-at <ISO date> --relayed-by <operator>.
  Idle requires rigc render's frames.json. No build, acceptance or stage advance runs.
  Use ${NO_DRAFT_VERDICT} to register without carrying an accepted draft verdict.
  Repeat --answers <version>:<verdict> to answer earlier human bounced feedback.
  Source arguments resolve against the project directory; external frozen sources are permitted.

rig-version <n> [<dir>] --preflight --config <file> [--citations <sections JSON>] [--at-source <file> --at-pointer </pointer>] [--json]
  Name every declaration registration reads from the config, its requirements and the citations, in one run. Writes nothing; other flags are ignored.

${RIG_VERSION_ADAPTER_USAGE}
  Write and print the path adapter JSON for the frozen config and its requirements.`;

function generatePathAdapter(dir: string, requestedDir: string, configPath: string): JsonObject[] {
  const { checkSourceAncestors, sourceBytes } = registrationSourceReader(dir, requestedDir);
  const config = JSON.parse(sourceBytes(configPath).toString()) as Json;
  if (!isObject(config)) fail('RIG_REGISTRATION_FILE_INVALID', configPath, 'expected a JSON object');

  // Dry-run the copier into an in-memory inventory. No project destination is
  // created before all source and target conflicts have been checked.
  const entries = new Map<string, Buffer | null>();
  const directory = (target: string): void => {
    for (let path = target; path !== '.'; path = dirname(path)) {
      if (entries.get(path)) fail('RIG_REGISTRATION_PATH_INVALID', path, 'destination must have real directory parents');
      entries.set(path, null);
    }
  };
  const retain = (target: string, bytes: Buffer): JsonObject => {
    if (!literal(target)) fail('RIG_REGISTRATION_PATH_INVALID', target, 'expected a literal retained path');
    directory(dirname(target));
    const prior = entries.get(target);
    if (prior === null) fail('RIG_REGISTRATION_PATH_INVALID', target, 'retained file target must be a regular file');
    if (prior && !prior.equals(bytes)) fail('RIG_REGISTRATION_PATH_INVALID', target, 'two distinct inputs collide');
    entries.set(target, bytes);
    return { path: target, sha256: sha(bytes), bytes: bytes.length };
  };
  const evidence = 'registration';
  const { portable, effectiveAdapter, runtimeRequirements } = mapRegistrationAssets(
    dir, configPath, config, evidence, configPath, registrationReservedTargets(true, FROZEN_RUN_SPECS), {
      checkSourceAncestors, sourceBytes, retain,
      copyTree: (source, target) => walkSourceTree(source, target, (_, path) => directory(path),
        (path, destination) => retain(destination, sourceBytes(path))),
    },
  );
  const rows = parsePathAdapter(effectiveAdapter);
  const pointerFormat = rows.some(row => row.kind === 'pointer');
  const refs = collectConfigAssetRefs(dir, config, pointerFormat);
  const expected = replayConfigAdapter(dir, config, refs, rows, pointerFormat, why =>
    fail('RIG_PATH_ADAPTER_INVALID', configPath, why));
  if (!isDeepStrictEqual(expected, portable)) {
    fail('RIG_PATH_ADAPTER_INVALID', configPath, 'generated adapter does not replay the copier substitutions');
  }
  checkPortable(portable, configPath);
  if (typeof portable.requirements === 'string' && !runtimeRequirements) {
    fail('RIG_REGISTRATION_FILE_INVALID', 'config.requirements', 'expected a referenced requirements document');
  }
  if (pointerFormat && runtimeRequirements) checkPortable(runtimeRequirements, 'requirements', true);
  for (const ref of collectConfigAssetRefs(dir, portable, pointerFormat)) {
    const target = `${evidence}/${ref.value}`;
    const file = entries.get(target);
    const hasFiles = ref.kind === 'file-or-dir' && !file
      && [...entries].some(([path, bytes]) => bytes !== null && path.startsWith(`${target}/`));
    if (ref.kind === 'dir' ? !entries.has(target) || file !== null : !file && !hasFiles) {
      fail('RIG_REGISTRATION_FILE_INVALID', `config.${ref.dotPath}`, 'adapted path does not name a retained asset');
    }
  }
  return effectiveAdapter;
}

function writePathAdapter(out: string, json: string): void {
  const parent = dirname(out);
  mkdirSync(parent, { recursive: true });
  const scratch = mkdtempSync(join(parent, '.rig-version-adapter-'));
  try {
    const pending = join(scratch, 'adapter.json');
    const bytes = Buffer.from(`${json}\n`);
    writeFileSync(pending, bytes);
    try {
      // A concurrent writer or an existing input must never be overwritten.
      linkSync(pending, out);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (!lstatSync(out).isFile() || !readFileSync(out).equals(bytes)) {
        refuse('RIG_PATH_ADAPTER_OUT_INVALID', `${out}: output already exists with different contents or is not a regular file. Choose a fresh --out path`);
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function rigVersionAdapterCommand(args: string[]): { stdout: string; exit: number } {
  const positional: string[] = [];
  const options: Record<string, string> = {};
  const usage = (): never => refuse('RIG_REGISTRATION_USAGE', RIG_VERSION_ADAPTER_USAGE, USAGE_EXIT);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--config' || arg === '--out') {
      const value = args[++i];
      if (!value || value.startsWith('--') || options[arg] !== undefined) return usage();
      options[arg] = value;
    } else if (arg.startsWith('-')) return usage();
    else positional.push(arg);
  }
  const config = options['--config'];
  const out = options['--out'];
  if (positional.length > 1 || !config || !out) return usage();

  let dir: string;
  let json: string;
  try {
    const requestedDir = positional[0] ?? process.cwd();
    dir = realpathSync(resolve(requestedDir));
    json = JSON.stringify(generatePathAdapter(dir, requestedDir, config), null, 2);
  } catch (error) {
    if (error instanceof Refusal) throw error;
    return fail('RIG_REGISTRATION_FILE_INVALID', config, String(error));
  }
  try {
    writePathAdapter(resolve(dir, out), json);
  } catch (error) {
    if (error instanceof Refusal) throw error;
    return refuse('RIG_PATH_ADAPTER_OUT_INVALID', `${out}: ${String(error)}. Choose a writable --out path`);
  }
  return { stdout: json, exit: 0 };
}

/** The frozen config as registration reads it; the preflight refuses an unreadable one with the same code and remedy. */
function registrationConfig(bytes: Buffer, n: number): JsonObject {
  let config: Json;
  try { config = JSON.parse(bytes.toString()) as Json; }
  catch (error) { return fail('RIG_REGISTRATION_FILE_INVALID', `versions[v${n}].registration`, error instanceof Error ? error.message : String(error)); }
  if (!isObject(config)) fail('RIG_REGISTRATION_FILE_INVALID', 'config', 'expected a JSON object');
  return config;
}

function citationMap(sections: Json): JsonObject {
  if (!isObject(sections)) fail('RIG_REGISTRATION_FILE_INVALID', 'provenance.sections', 'citations must be a section map');
  return sections;
}

/**
 * `rig-version <n> --preflight --config <file>`: every declaration the
 * registration's record check reads from this config, in one run (create#750).
 * It reads the config and its requirements in place and writes nothing.
 */
function rigVersionPreflight(n: number, requestedDir: string, options: Record<string, string>, json: boolean, now: number): { stdout: string; exit: number } {
  const dir = realpathSync(resolve(requestedDir));
  const { project } = readProject(dir);
  if (project.schema !== 'rig-create/project@0') fail('SCHEMA_UNKNOWN', 'schema', 'rig-version reads rig-create/project@0');
  const configFile = resolve(dir, options['--config']!);
  const configPath = relative(dir, configFile).split(sep).join('/');
  if (!literal(configPath) || !existsSync(configFile) || !lstatSync(configFile).isFile()) {
    refuse('RIG_PREFLIGHT_CONFIG_OUTSIDE', `${options['--config']!}: the preflight reads the config and its requirements in place, so the config must be a file under the project; copy the frozen config and its requirements under the project and pass that path`);
  }
  let sections: JsonObject = {};
  if (options['--citations']) {
    let raw: Json;
    try { raw = JSON.parse(readFileSync(resolve(dir, options['--citations'])).toString()) as Json; }
    catch (error) { return fail('RIG_REGISTRATION_FILE_INVALID', 'provenance.sections', `--citations: ${String(error)}`); }
    sections = citationMap(raw);
  }
  let at = new Date(now).toISOString();
  if (options['--at-source'] && options['--at-pointer']) {
    let cited: Json | undefined;
    try { cited = pointerValue(JSON.parse(readFileSync(resolve(dir, options['--at-source'])).toString()) as Json, options['--at-pointer']); }
    catch (error) { return fail('RIG_AT_SOURCE_INVALID', `versions[v${n}].at_source`, String(error)); }
    if (!utcDate(cited)) fail('RIG_AT_SOURCE_INVALID', `versions[v${n}].at_source`, 'the cited pointer needs a valid UTC timestamp');
    at = cited;
  }
  const configBytes = readFileSync(configFile);
  const unreadable: Finding[] = [];
  try { registrationConfig(configBytes, n); }
  catch (error) {
    if (!(error instanceof Refusal)) throw error;
    // Held at the config, so every declaration read from it is unread, never carried.
    unreadable.push({ code: error.code, path: `versions[v${n}].provenance.config`, message: error.message });
  }
  const version: JsonObject = { n, kind: 'rig', at, provenance: { config: { path: configPath, sha256: sha(configBytes) }, sections } };
  const report = checkVersionDeclarations(dir, project, version, unreadable);
  const exit = report.refusals.length ? 1 : 0;
  return { stdout: json ? JSON.stringify({ preflight: true, config: configPath, ...report }, null, 2) : formatDeclarations(report, configPath).join('\n'), exit };
}

export function rigVersionCommand(args: string[], now: number): { stdout: string; exit: number } {
  if (args[0] === 'adapter') return rigVersionAdapterCommand(args.slice(1));
  const positional: string[] = [];
  const options: Record<string, string> = {};
  const runRecords: string[] = [];
  const depthMapBindings: string[] = [];
  const answerValues: string[] = [];
  const checkTargets: RigCheckTarget[] = [];
  const requiredFlags = ['--parts', '--rig', '--build', '--idle', '--config', '--path-adapter', '--compile-report', '--toolchain-lock', '--at-source', '--at-pointer', '--by'];
  const checkAuthorityFlags = ['--check-accepted-by', ...OWNER_CHAT_FLAGS];
  const flags = [...requiredFlags, '--citations', '--depth-manifest', '--check-report', ...checkAuthorityFlags];
  let json = false;
  let preflight = false;
  let carryDraftVerdict = true;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') json = true;
    else if (arg === '--preflight') preflight = true;
    else if (arg === NO_DRAFT_VERDICT) carryDraftVerdict = false;
    else if (arg === '--answers') {
      const value = args[++i];
      if (!value || value.startsWith('--')) fail('RIG_REGISTRATION_USAGE', 'versions', '--answers needs version:verdict');
      answerValues.push(value);
    } else if (arg === '--depth-map-binding') {
      const value = args[++i];
      if (!value || value.startsWith('--')) fail('RIG_REGISTRATION_USAGE', 'versions', '--depth-map-binding needs one receipt file');
      depthMapBindings.push(value);
    } else if (arg === '--run-record') {
      const value = args[++i];
      if (!value || value.startsWith('--')) fail('RIG_REGISTRATION_USAGE', 'versions', '--run-record needs one value');
      runRecords.push(value);
    } else if (arg === '--accept-check-exposure') {
      checkTargets.push({ kind: 'exposure', id: SOURCE_EXPOSURE_ID });
    } else if (arg === '--accept-check-bar' || arg === '--accept-check-line') {
      const value = args[++i];
      if (!value?.trim() || value.startsWith('--')) fail('RIG_REGISTRATION_USAGE', 'versions', `${arg} needs one exact report key`);
      checkTargets.push({ kind: arg === '--accept-check-bar' ? 'bar' : 'line', id: value });
    } else if (flags.includes(arg)) {
      const value = args[++i];
      if (!value || value.startsWith('--') || options[arg] !== undefined) fail('RIG_REGISTRATION_USAGE', 'versions', `${arg} needs one value`);
      options[arg] = value;
    } else if (arg.startsWith('-')) refuse('UNKNOWN_OPTION', `rig-version does not take ${arg}`, USAGE_EXIT);
    else positional.push(arg);
  }
  const n = Number(positional[0]?.replace(/^v/, ''));
  if (preflight && Number.isSafeInteger(n) && n >= 1 && positional.length <= 2 && options['--config']) {
    return rigVersionPreflight(n, positional[1] ?? process.cwd(), options, json, now);
  }
  if (!Number.isSafeInteger(n) || n < 1 || positional.length > 2 || requiredFlags.some(f => !options[f])) refuse('RIG_REGISTRATION_USAGE', RIG_VERSION_HELP, USAGE_EXIT);
  if (depthMapBindings.length && !options['--depth-manifest']) fail('RIG_REGISTRATION_USAGE', 'versions', '--depth-map-binding requires --depth-manifest');
  const dir = realpathSync(resolve(positional[1] ?? process.cwd()));
  const checkPath = `versions[v${n}].registration.check_report`;
  let checkAcceptance: JsonObject | undefined;
  if (checkTargets.length) {
    if (!options['--check-report']) fail('RIG_CHECK_ACCEPTANCE_INVALID', checkPath, 'acceptance requires an explicit --check-report');
    const words = options['--owner-chat'];
    const chatOptions = words && words !== '-' ? { ...options, '--owner-chat': resolve(dir, words) } : options;
    checkAcceptance = readOwnerChat(chatOptions, options['--check-accepted-by'] ?? '', now, checkPath);
    if (!checkAcceptance) refuse('OWNER_CHAT_REQUIRED', `${checkPath}: relay the owner's exact words with --check-accepted-by --owner-chat --said-at --relayed-by`);
  } else if (checkAuthorityFlags.some(flag => options[flag] !== undefined)) {
    fail('RIG_CHECK_ACCEPTANCE_INVALID', checkPath, 'owner chat requires --accept-check-bar or --accept-check-line with an exact report key, or --accept-check-exposure');
  }
  let { file, project } = readProject(dir);
  let original = readFileSync(file);
  const lock = `${file}.rig-version.lock`;
  let descriptor: number;
  try { descriptor = openSync(lock, 'wx'); } catch { return fail('RIG_REGISTRATION_BUSY', 'versions', 'another registration holds the lock'); }
  const out = `outputs/v${n}`;
  const evidence = `evidence/v${n}/registration`;
  const pkg = `derived/review/v${n}`;
  const created: string[] = [];
  const createdParents: string[] = [];
  const sources: SourceFile[] = [];
  const sourceDirectories = new Map<string, string[]>();
  const outputFiles: JsonObject[] = [];
  let releasePublication = () => {};
  let progress: ReturnType<typeof beginJobProgress>;
  try {
    // Before the job gate: a retry while v<n>'s publication is pending names v<n>, not the gate.
    refuseRegisteredVersion(dir, project, n);
    releasePublication = acquireBoundJobWrite(dir);
    // The first milestone waits for the job gate: a refused write leaves the project untouched.
    progress = beginJobProgress(dir, 'build', 'Starting rig registration');
    ({ file, project } = readProject(dir));
    original = readFileSync(file);
    if (project.schema !== 'rig-create/project@0') fail('SCHEMA_UNKNOWN', 'schema', 'rig-version reads rig-create/project@0');
    for (const flag of ['--rig', '--build', '--idle']) {
      assertDraftHasRig(assembleOnlyDraftPath(dir, project, options[flag]), `versions[v${n}].registration ${flag}`);
    }
    if (!Array.isArray(project.versions) || asArray(project.versions).some(v => !isObject(v) || typeof v.n !== 'number')) fail('RIG_REGISTRATION_INVALID', 'versions', 'restore the version list');
    const registeredNumbers = new Set(project.versions.map(v => (v as JsonObject).n as number));
    const maxRegistered = Math.max(0, ...registeredNumbers);
    refuseRegisteredVersion(dir, project, n);
    if (n <= maxRegistered || registeredNumbers.has(n)) fail('RIG_REGISTRATION_INVALID', 'versions', 'use a version number after all registered versions');
    const answersFeedback = parseFeedbackAnswers(project, n, answerValues);
    // Refuse missing public idle provenance before copying any project input.
    const idleSource = resolve(dir, options['--idle']!);
    if (!existsSync(join(idleSource, 'frames.json'))) fail('RIG_IDLE_MANIFEST_MISSING', `versions[v${n}].registration.idle`, 'supply rigc render output with frames.json');
    const invalidDestination = (target: string): never => fail('RIG_REGISTRATION_PATH_INVALID', target, 'destination must have real directory parents');
    for (const target of [out, evidence, pkg]) {
      if (destinationExists(dir, target, invalidDestination)) fail('RIG_REGISTRATION_EXISTS', target, 'preserve the existing destination');
    }
    const skipped: { n: number; destinations: string[] }[] = [];
    for (let k = maxRegistered + 1; k < n; k++) {
      if (registeredNumbers.has(k)) fail('RIG_REGISTRATION_INVALID', 'versions', `v${k} is already registered`);
      const destinations = versionDestinations(k).filter(target => destinationExists(dir, target, invalidDestination));
      if (!destinations.length) fail('RIG_REGISTRATION_INVALID', 'versions', `v${k} has no existing unregistered destination to skip`);
      skipped.push({ n: k, destinations });
    }
    const { checkSourceAncestors, sourceBytes } = registrationSourceReader(dir, positional[1] ?? process.cwd(), source => sources.push(source));
    const retain = (target: string, bytes: Buffer, outputs = false): JsonObject => {
      destinationExists(dir, dirname(target), invalidDestination);
      if (existsSync(join(dir, target)) && !lstatSync(join(dir, target)).isFile()) fail('RIG_REGISTRATION_PATH_INVALID', target, 'retained file target must be a regular file');
      mkdirSync(dirname(join(dir, target)), { recursive: true });
      if (existsSync(join(dir, target)) && !readFileSync(join(dir, target)).equals(bytes)) fail('RIG_REGISTRATION_PATH_INVALID', target, 'two distinct inputs collide');
      writeFileSync(join(dir, target), bytes);
      if (!readFileSync(join(dir, target)).equals(bytes)) fail('RIG_REGISTRATION_SOURCE_CHANGED', target, 'copy verification failed');
      const binding = { path: target, sha256: sha(bytes), bytes: bytes.length };
      if (outputs) outputFiles.push(binding);
      return binding;
    };
    const input = (flagOrPath: string, name: string): JsonObject => retain(`${evidence}/${name}`, sourceBytes(options[flagOrPath] ?? flagOrPath));
    // Validate the toolchain lock and run records before creating retained directories.
    const lockPath = options['--toolchain-lock']!;
    let lockBytes: Buffer;
    let lock: ReturnType<typeof lockVersions>;
    try {
      lockBytes = sourceBytes(lockPath);
      lock = lockVersions(lockBytes, basename(lockPath));
    } catch (error) {
      if (error instanceof Refusal) throw error;
      const reason = (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? `found no lock at ${lockPath}; supply ${TOOLCHAIN_KINDS}`
        : String(error);
      return fail('RIG_TOOLCHAIN_LOCK_INVALID', `versions[v${n}].built_with`, reason);
    }
    const { kind: toolchainKind, versions } = lock;
    const registrationAt = new Date(now).toISOString();
    const approvalBasis = { registration: { at: registrationAt } };
    const validatedRuns: { path: string; spec: FrozenRunSpec }[] = [];
    const seenSpecs = new Set<FrozenRunSpec>();
    for (const [i, recordPath] of runRecords.entries()) {
      const entryPath = `versions[v${n}].registration.runs[${i}]`;
      try {
        const { spec } = validateRunRecord(sourceBytes(recordPath), entryPath, { specs: FROZEN_RUN_SPECS }) as { spec: FrozenRunSpec };
        if (seenSpecs.has(spec)) throw new RunRecordError('RUN_RECORD_MALFORMED', `${entryPath}.spec`, `duplicate run record for spec ${spec}; supply at most one --run-record per spec`);
        seenSpecs.add(spec);
        validatedRuns.push({ path: recordPath, spec });
      } catch (error) {
        if (error instanceof Refusal) throw error;
        if (error instanceof RunRecordError) refuse(error.code, error.message);
        return fail('RUN_RECORD_MALFORMED', entryPath, String(error));
      }
    }
    if (validatedRuns.length === 0 && Date.parse(registrationAt) >= Date.parse(RUN_RECORD_SINCE)) {
      return fail('RUN_RECORD_REQUIRED', `versions[v${n}].registration.runs`, 'version registered from the toolchain lock alone; retain producer run.json records with --run-record');
    }
    // Pre-existing refusals stay the project's; the candidate may not add a new one.
    const asRead = checkProject(dir, project, { now });
    const baseline = baselineOf(asRead);
    // Remember only absent parents; never remove a pre-existing evidence tree.
    for (const target of [evidence, out, pkg]) {
      let parent = dirname(join(dir, target));
      while (parent !== dir && !existsSync(parent)) {
        if (!createdParents.includes(parent)) createdParents.push(parent);
        parent = dirname(parent);
      }
    }
    created.push(join(dir, evidence), join(dir, out));
    mkdirSync(join(dir, evidence), { recursive: true });
    const toolchain = retain(`${evidence}/${toolchainKind === 'bun-lock' ? 'bun.lock' : 'package-lock.json'}`, lockBytes);
    const runs = validatedRuns.map(({ path, spec }) => ({
      spec,
      source: input(path, `${spec.replace('/', '-')}.json`),
    }));
    let atSource: JsonObject;
    let at: Json | undefined;
    try {
      atSource = { ...input('--at-source', 'at-source.json'), pointer: options['--at-pointer']! };
      at = pointerValue(JSON.parse(bytesAt(dir, atSource).toString()), atSource.pointer);
    } catch (error) { if (error instanceof Refusal) throw error; return fail('RIG_AT_SOURCE_INVALID', `versions[v${n}].at_source`, String(error)); }
    if (!utcDate(at)) fail('RIG_AT_SOURCE_INVALID', `versions[v${n}].at_source`, 'the cited pointer needs a valid UTC timestamp');
    const rawAdapterBytes = sourceBytes(options['--path-adapter']!);
    let callerAdapter: NormalizedAdapterRow[];
    try { callerAdapter = parsePathAdapter(JSON.parse(rawAdapterBytes.toString())); }
    catch (error) { return fail('RIG_PATH_ADAPTER_INVALID', `versions[v${n}].registration.path_adapter`, String(error)); }
    const configSource = input('--config', 'config-source.json');
    const config = registrationConfig(bytesAt(dir, configSource), n);
    const copiedSources = new Map<string, string>();
    const copyTree = (source: string, target: string, outputs: boolean): void => {
      walkSourceTree(resolve(dir, source), target, (path, destination, names) => {
        sourceDirectories.set(path, names);
        destinationExists(dir, destination, invalidDestination);
        mkdirSync(join(dir, destination), { recursive: true });
      }, (path, destination) => {
        retain(destination, sourceBytes(path), outputs);
        copiedSources.set(destination, path);
      });
    };
    const {
      portable, effectiveAdapter, requirementsSourceBinding, requirementsRuntimeBinding, reqSourcePath, portableReqRel,
    } = mapRegistrationAssets(dir, options['--config']!, config, evidence, `versions[v${n}].registration.path_adapter`,
      registrationReservedTargets(toolchainKind === 'bun-lock', validatedRuns.map(({ spec }) => spec)), {
        checkSourceAncestors, sourceBytes, retain,
        copyTree: (source, target) => copyTree(source, target, false),
      }, callerAdapter);
    const pointerAdapted = effectiveAdapter.some(row => row.pointer !== undefined);
    const adapterBinding = retain(
      `${evidence}/path-adapter.json`,
      effectiveAdapter.length === callerAdapter.length ? rawAdapterBytes : Buffer.from(`${JSON.stringify(effectiveAdapter, null, 2)}\n`),
    );
    const configBinding = retain(`${evidence}/config.json`, Buffer.from(`${JSON.stringify(portable, null, 2)}\n`));
    const configInputSources = new Map(copiedSources);
    if (portableReqRel && reqSourcePath) {
      configInputSources.set(requirementsSourceBinding ? String(requirementsSourceBinding.path) : `${evidence}/${portableReqRel}`, reqSourcePath);
    }
    const compile = input('--compile-report', 'compile-report.json');
    const partsDir = resolve(dir, options['--parts']!);
    copyTree(join(partsDir, 'parts.json'), `${out}/out/parts.json`, true);
    copyTree(join(partsDir, 'parts'), `${out}/out/parts`, true);
    // Keep the producer's complete depth reports in this same frozen registration.
    // The config.depth image references above still use the ordinary path adapter.
    let depthBinding: JsonObject | undefined;
    const depthReport = join(partsDir, 'depth-report.json');
    if (usesDepth(config) || options['--depth-manifest'] || existsSync(depthReport)) {
      const perPart = options['--depth-manifest'] !== undefined || existsSync(depthReport) || !isObject(config.depth);
      const sheets = join(dir, out, 'out/rig/depth_sheets.json');
      // Rig files are copied below; bind the exact frozen source now.
      const sourceSheets = resolve(dir, options['--rig']!, 'depth_sheets.json');
      depthBinding = { route: perPart ? 'per-part' : 'per-layer' };
      const approval = rigPartsApproval(project, { ...approvalBasis, at });
      const draft = asArray(project.drafts).filter(isObject).find(d => d.id === approval?.draft_id);
      if (perPart && approval && isObject(draft?.parts) && typeof draft.parts.path === 'string') {
        const originalParts = resolve(dir, draft.parts.path, 'parts.json');
        if (!existsSync(originalParts)) fail('RIG_DEPTH_BINDING_MISSING', `versions[v${n}].registration.depth.source_parts`, 'restore the accepted assembled parts manifest before registering the depth-enriched version');
        depthBinding.source_parts = retain(`${evidence}/depth-source-parts.json`, sourceBytes(originalParts));
        if (resolve(dir, draft.parts.path) === partsDir && existsSync(depthReport)) depthBinding.source_parts_applied = true;
      }
      if (existsSync(sourceSheets)) depthBinding.sheets = { path: relative(dir, sheets).split(sep).join('/'), sha256: sha(sourceBytes(sourceSheets)) };
      if (options['--depth-manifest']) depthBinding.manifest = input('--depth-manifest', 'depth-manifest.json');
      if (existsSync(depthReport)) depthBinding.report = retain(`${evidence}/depth-report.json`, sourceBytes(depthReport));
      if (depthMapBindings.length) depthBinding.map_bindings = depthMapBindings.map((value, i) => {
        const source = resolve(dir, value);
        const path = `versions[v${n}].registration.depth.map_bindings[${i}]`;
        if (!existsSync(source) || !lstatSync(source).isFile()) fail('RIG_DEPTH_BINDING_INVALID', path, 'supply a regular Parts map binding receipt, never a symlink');
        const bytes = sourceBytes(source);
        let receipt: Json;
        try { receipt = JSON.parse(bytes.toString('utf8')) as Json; }
        catch { return fail('RIG_DEPTH_BINDING_INVALID', path, 'restore the exact Parts map binding JSON'); }
        if (!isObject(receipt) || receipt.spec !== DEPTH_MAP_BINDING_SPEC || typeof receipt.part !== 'string') fail('RIG_DEPTH_BINDING_INVALID', path, `retain a ${DEPTH_MAP_BINDING_SPEC} receipt`);
        return { ...retain(`${evidence}/depth-map-bindings/${i}.json`, bytes), spec: DEPTH_MAP_BINDING_SPEC, part: receipt.part };
      });
    }
    const partReferences = partsFileReferences(partsDir);
    for (const reference of partReferences) {
      const target = `${out}/out/${reference.path}`;
      if (!copiedSources.has(target)) copyTree(join(partsDir, reference.path), target, true);
    }
    const plateAssembly = plateAssemblySources(dir, project, partsDir, join(dir, out, 'out'));
    for (const [path, file] of plateAssembly ?? []) {
      retain(`${out}/plate-assemble/${path}`, file.bytes, true);
      sources.push(file);
    }
    copyTree(options['--rig']!, `${out}/out/rig`, true);
    copyTree(options['--build']!, `${out}/out/check/build`, true);
    copyTree(idleSource, `${out}/idle`, true);
    const idleBytes = readFileSync(join(dir, out, 'idle/frames.json'));
    const idle = { path: `${out}/idle/frames.json`, sha256: sha(idleBytes) };
    const retained: JsonObject[] = [];
    const inventory = (root: string): void => {
      for (const name of readdirSync(join(dir, root)).sort()) {
        const path = `${root}/${name}`;
        if (lstatSync(join(dir, path)).isDirectory()) inventory(path);
        else retained.push({ path, sha256: sha(readFileSync(join(dir, path))) });
      }
    };
    inventory(evidence);
    // A producer verdict is registration metadata, not a runtime package input.
    let checkReport: JsonObject | undefined;
    if (options['--check-report']) {
      const target = `${evidence}/${RIG_CHECK_REPORT_FILE}`;
      if (existsSync(join(dir, target))) fail('RIG_REGISTRATION_PATH_INVALID', target, 'check report collides with a retained runtime input');
      const bytes = sourceBytes(options['--check-report']);
      let report: JsonObject;
      try { report = parseRigCheckReport(bytes); }
      catch (error) { return fail('RIG_CHECK_REPORT_INVALID', checkPath, String(error)); }
      checkReport = { ...retain(target, bytes), spec: report.spec ?? null,
        ...(checkAcceptance ? { acceptances: checkTargets.map(target => ({ ...target, ...checkAcceptance })) } : {}) };
    }
    let sections: Json = {};
    if (options['--citations']) {
      const binding = input('--citations', 'citations.json');
      retained.push(binding);
      sections = citationMap(JSON.parse(bytesAt(dir, binding).toString()) as Json);
    }
    const structureChanges = approvedStructureDelta(dir, project, { ...approvalBasis, at }, portable);
    const version: JsonObject = { n, kind: 'rig', rig_version: null, at, at_basis: 'not-after', at_source: atSource,
      built_by: options['--by']!, built_with: versions, outputs: outputFiles, evidence: [], verdicts: [], answers_feedback: answersFeedback, review_origin: null,
      changed: 'Registered frozen producer outputs', provenance: { config: configBinding, sections, ...(structureChanges.length ? { structure_delta: structureChanges } : {}) },
      registration: { kind: 'frozen-rig/1', at: registrationAt, toolchain: { kind: toolchainKind, source: toolchain },
        ...(runs.length ? { runs } : {}),
        ...(checkReport ? { check_report: checkReport } : {}),
        ...(depthBinding ? { depth: depthBinding } : {}),
        ...(skipped.length ? { skipped } : {}),
        files: retained, config_source: configSource,
        ...(requirementsSourceBinding ? { requirements_source: requirementsSourceBinding } : {}),
        ...(requirementsRuntimeBinding ? { requirements: requirementsRuntimeBinding } : {}),
        path_adapter: { ...adapterBinding, ...(pointerAdapted ? { format: 'json-pointer/1' } : {}) }, idle, compile,
        copied: { files: outputFiles.length, bytes: outputFiles.reduce((total, f) => total + Number(f.bytes), 0) } } };
    const candidate = { ...project, versions: [...project.versions, version] };
    const depthProblem = depthBindingFindings(dir, { ...version, at: new Date(now).toISOString() }, config, version.registration as JsonObject, [])[0];
    if (depthProblem) refuse(depthProblem.code, depthProblem.message);
    const problem = rigRegistrationFindings(dir, candidate)[0];
    if (problem) refuse(problem.code, problem.message);
    created.push(join(dir, pkg));
    progress?.('Preparing and checking the retained rig package', { i: 1, n: 2 });
    prepareRigReviewPackage([String(n), dir, '--config', String(configBinding.path), '--from', `${out}/out`], candidate, partReferences.map(reference => reference.path));
    if (carryDraftVerdict && asRead.effective_stage === 'rigging') {
      const carried = carryRigDraftVerdict(dir, project, version, resolve(dir, options['--config']!), configInputSources, now);
      if (carried) {
        assertFigureMaskApproval(dir, candidate, n);
        try {
          assertCorrectionApproval(dir, candidate, 'rig-review', now);
        } catch (error) {
          if (!(error instanceof Refusal) || error.code !== 'CORRECTION_PENDING') throw error;
          const retryArgs = positional.length === 1 ? [...args, dir] : args;
          const plain = rigRegistrationCommand([...retryArgs, NO_DRAFT_VERDICT]);
          refuse(error.code, `${error.message}; to register without carrying the draft verdict, run ${plain}`, error.exitCode);
        }
        version.verdicts = [carried.verdict];
        if (carried.evidence) version.evidence = [carried.evidence];
      }
    }
    // The record must pass the same check as every other writer's before it is renamed into place.
    // Every new finding is named in one refusal (create#750); the first keeps the code, so a single finding reads as before.
    const [fresh, ...more] = newFindings(baseline, checkProject(dir, candidate, { now }).refusals);
    if (fresh) refuse(fresh.code, [fresh.message, ...more.map(f => `${f.code}: ${f.message}`)].join('\n  '));
    for (const entry of skipped) {
      const currentDestinations = versionDestinations(entry.n).filter(target => destinationExists(dir, target, invalidDestination));
      if (!isDeepStrictEqual(currentDestinations, entry.destinations)) fail('RIG_REGISTRATION_SOURCE_CHANGED', `versions[v${n}].registration.skipped`, `v${entry.n} occupying destinations changed during registration`);
    }
    for (const [path, names] of sourceDirectories) if (!isDeepStrictEqual(readdirSync(path).sort(), names)) fail('RIG_REGISTRATION_SOURCE_CHANGED', path, 'source directory changed during registration');
    for (const source of sources) if (!readFileSync(source.source).equals(source.bytes)) fail('RIG_REGISTRATION_SOURCE_CHANGED', source.source, 'source changed during registration');
    if (!readFileSync(file).equals(original)) fail('RIG_REGISTRATION_SOURCE_CHANGED', 'project.json', 'record changed during registration');
    const pending = join(dir, evidence, 'project.pending');
    const recordBytes = Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`);
    writeFileSync(pending, recordBytes);
    renameSync(pending, file);
    created.length = 0;
    progress?.('Rig version committed without publishing', { i: 2, n: 2 });
    return { stdout: json ? JSON.stringify(version, null, 2) : `rig-version: v${n} committed without publishing; ${String((version.review_package as JsonObject).open)}`, exit: 0 };
  } catch (error) {
    if (error instanceof Refusal) throw error;
    return fail('RIG_REGISTRATION_FILE_INVALID', `versions[v${n}].registration`, error instanceof Error ? error.message : String(error));
  } finally {
    for (const path of created.reverse()) rmSync(path, { recursive: true, force: true });
    for (const path of createdParents.sort((a, b) => b.length - a.length)) {
      if (existsSync(path) && readdirSync(path).length === 0) rmdirSync(path);
    }
    closeSync(descriptor);
    rmSync(lock);
    releasePublication();
  }
}

/** The optional plan step consumes approved parts before the ordinary rig step. */
export function depthPlanMoves(project: JsonObject, collection: JsonObject | null = null): { role: 'agent'; field: string; awaits: string; command: null; act: string }[] {
  const { answer, mode, body } = depthAnswer(project, collection);
  if (mode !== 'depth') return [];
  const answerAt = typeof answer.at === 'string' ? Date.parse(answer.at) : -Infinity;
  const rig = asArray(project.versions).filter(isObject).find(v => v.kind === 'rig' && typeof v.at === 'string' && Date.parse(v.at) >= answerAt && isObject(v.registration) && isObject(v.registration.depth));
  if (rig) return [];
  const groupNote = body
    ? 'keep turn.body in the working config and apply both head and body groups'
    : 'when the depth recipe also has a body group, pass --groups head and remove turn.body from the working config, because Parts refuses DEPTH_GROUP_LEFT_OUT otherwise';
  const steps = ["Record the chosen depth route and reason in the turn plan step text. Default per-part sequence: rig-parts depth-prepare --parts <accepted assembled parts> --config <depth recipe> --out <inference directory>",
    "Run the supplied depth model on each prepared image; retain raw rig-parts-map/1 maps (face normals, scalar depth for other parts). Immediately after each inference run rig-parts depth-bind --map <numeric-map.json> --input <prepared.png> --part <name>. Reuse a map and its existing receipt only when the prepared inputSha256 is unchanged. If input changes, re-infer and bind a new map filename; never bind an old map to a freshly prepared input or overwrite a receipt.",
    `rig-parts depth-apply --parts <accepted assembled parts> --manifest <inference/manifest.json> --config <depth recipe> --rig-config <config.json> --out <mapped directory> (${groupNote}); then rig-parts rig --parts <mapped directory> --config <mapped/config.json> --out <rig directory>. Register with rig-version --parts <mapped directory> --rig <rig directory> --config <mapped/config.json> --depth-manifest <inference/manifest.json> and repeat --depth-map-binding <map.binding.json> for each applied map.`];
  return steps.map((act, i) => ({ role: 'agent', field: `plan.steps[turn].moves[${i}]`, awaits: 'versions[].registration.depth', command: null, act }));
}

function depthAnswer(project: JsonObject, collection: JsonObject | null = null): { answer: JsonObject; mode: Json | undefined; body: boolean } {
  const item = collectItems(project, { collection }).find(item => item.id === 'turn');
  const answer = item?.state.state === 'user' || item?.state.state === 'delegated' ? item.state.answer : {};
  const decision = answer.delegated === true && isObject(answer.agent_decision) ? answer.agent_decision.value : answer.value;
  return {
    answer,
    mode: isObject(decision) ? decision.mode : undefined,
    body: isObject(decision) && decision.mode === 'depth' && decision.body === true,
  };
}

/** Records dated from this day refuse an invalid turn `body`; earlier records WARN (#1000, #1003). */
export const TURN_BODY_SINCE = '2026-11-25T00:00:00Z';

/** Invalid `body` findings on one `turn` answer, each with the `at` of the record that carries it. */
export function turnBodyFindings(answer: JsonObject, itemPath: string): { finding: Finding; at: Json | undefined }[] {
  const candidates: { value: Json | undefined; path: string; at: Json | undefined }[] = [];
  if ('value' in answer) candidates.push({ value: answer.value, path: `${itemPath}.value`, at: answer.at });
  if (isObject(answer.agent_decision) && 'value' in answer.agent_decision) {
    candidates.push({ value: answer.agent_decision.value, path: `${itemPath}.agent_decision.value`, at: answer.agent_decision.at });
  }
  asArray(answer.additions).forEach((add, i) => {
    if (isObject(add) && 'value' in add) candidates.push({ value: add.value, path: `${itemPath}.additions[${i}].value`, at: 'at' in add ? add.at : answer.at });
  });
  const findings: { finding: Finding; at: Json | undefined }[] = [];
  for (const { value, path, at } of candidates) {
    if (!isObject(value) || !('body' in value)) continue;
    if (value.body === true && value.mode === 'depth') continue;
    const bodyPath = `${path}.body`;
    findings.push({ at, finding: {
      code: 'TURN_BODY_VALUE_INVALID',
      path: bodyPath,
      message: `${bodyPath}: turn value accepts body only as true together with mode "depth" (got body ${JSON.stringify(value.body ?? null)} with mode ${JSON.stringify(value.mode ?? null)}); record { "mode": "depth", "body": true } for head and body, { "mode": "depth" } for head-only, or { "mode": "fixed" } for a fixed view`,
    } });
  }
  return findings;
}

/** Writers refuse an invalid turn `body` they are about to record, whatever the clock: a new write is always current. */
export function assertTurnBody(itemId: string, answer: JsonObject, itemPath: string): void {
  if (itemId !== 'turn') return;
  const first = turnBodyFindings(answer, itemPath)[0];
  if (first) refuse(first.finding.code, first.finding.message);
}

/**
 * Validate `body` on the `turn` guide value, delegated decision, and additions: only `body: true` with `mode: "depth"` is valid.
 * Each value is dated by its own record (`at` of the answer, the agent decision, or the addition, falling back to the answer's).
 * From TURN_BODY_SINCE, or with no readable date, the finding refuses; earlier records WARN with the same code.
 */
export function checkTurnValue(ctx: Ctx): void {
  const item = itemFor(ctx, 'turn');
  if (item === undefined) return;
  const answer = item.state.state === 'user' || item.state.state === 'delegated'
    ? item.state.answer
    : isObject(item.raw) ? item.raw : null;
  if (answer === null) return;
  for (const { finding, at } of turnBodyFindings(answer, item.path)) {
    const time = typeof at === 'string' ? Date.parse(at) : NaN;
    if (Number.isFinite(time) && time < Date.parse(TURN_BODY_SINCE)) {
      ctx.warnings.push({ ...finding, message: `${finding.message}; record dated ${String(at)} predates ${TURN_BODY_SINCE}, so preserve it and record a valid turn value with the next answer or decision` });
    } else ctx.refusals.push(finding);
  }
}

/** The optional depth step is drafted before its rigging-interview approval, just like the other rig steps. */
export function depthPlanFindings(project: JsonObject, warnings: Finding[], collection: JsonObject | null = null): Finding[] {
  const { answer, mode } = depthAnswer(project, collection);
  if (mode !== 'depth') return [];
  const answerAt = typeof answer.at === 'string' ? Date.parse(answer.at) : NaN;
  const approved = asArray(project.signoffs).filter(isObject).some(s => s.stage === 'rigging-interview' && (s.checkpoint ?? null) === null && Date.parse(String(s.at)) >= answerAt);
  if (!approved && !['rigging-interview', 'rigging', 'rig-review', 'post-interview', 'post', 'direction-review', 'accepted'].includes(String(project.stage))) return [];
  const plan = isObject(project.plan) ? project.plan : {};
  const steps = asArray(plan.steps).filter(isObject);
  const depth = steps.find(s => s.id === 'turn' && s.phase === 'rig' && asArray(s.rests_on).includes('turn'));
  if (depth && steps.filter(s => s !== depth && s.phase === 'rig' && stageOfStep('rig', String(s.id)) === 'rigging').every(s => Number(depth.order) < Number(s.order))) return [];
  const path = 'plan.steps[turn]';
  const remedy = steps.some(step => step.id === 'turn')
    ? `plan revise turn --order <before the first rigging step>${depth ? '' : ' --phase rig --rests-on turn'}`
    : 'plan add turn --phase rig --rests-on turn --order <before the first rigging step>';
  const finding = { code: 'RIG_DEPTH_PLAN_MISSING', path, message: `${path}: a depth turn needs a rig-phase depth step resting on turn, ordered before the rig steps; use ${remedy} and approve it at rigging-interview before running rig` };
  if (answerAt < Date.parse(HEAD_TURN_SINCE)) { warnings.push(finding); return []; }
  return [finding];
}

/**
 * On a head-only depth answer (`{ mode: "depth" }` without `body: true`), when a recipe prepared with a body group
 * applies only the head group (`depth-apply --groups head`) without `config.turn.body`, the report's `selection.leftOut`
 * records the left-out body parts while `recipeSha256` and `manifestSha256` stay unchanged. When a registered rig still
 * declares `config.turn.body`, Create reads the registered config's declaration and names the dial (#563, #792, #1000).
 */
export function turnExtraGroup(dir: string, project: JsonObject, collection: JsonObject | null = null): { version: number; dial: string; recorded: boolean } | null {
  const { mode, body } = depthAnswer(project, collection);
  if (mode !== 'depth' || body) return null;
  const rig = asArray(project.versions).filter(isObject).filter(v => v.kind === 'rig' && isObject(v.registration)).at(-1);
  if (rig === undefined || typeof rig.n !== 'number') return null;
  const record = rig.registration as JsonObject;
  let config: Json;
  try { config = JSON.parse(bytesAt(dir, record.config_source).toString('utf8')); }
  catch { return null; } // Registration checks own unreadable config evidence.
  const turn = isObject(config) && isObject(config.turn) ? config.turn : {};
  const turnBody = isObject(turn.body) ? turn.body : {};
  const bodyRoles = isObject(turnBody.roles) ? Object.keys(turnBody.roles) : [];
  if (bodyRoles.length === 0) return null;
  const dial = typeof turnBody.slider === 'string' && turnBody.slider !== '' ? turnBody.slider : BODY_YAW_DIAL_BONE;
  const plan = isObject(project.plan) ? project.plan : {};
  const step = asArray(plan.steps).filter(isObject).find(s => s.id === 'turn');
  const noteRecorded = asArray(step?.status_history).some(e => isObject(e) && typeof e.note === 'string' && e.note.includes(dial));
  let reportCleared = false;
  try {
    const depth = record.depth;
    const reportBinding = isObject(depth) && isObject(depth.report) ? depth.report : undefined;
    if (reportBinding && asArray(record.files).filter(isObject).some(f => f.path === reportBinding.path && f.sha256 === reportBinding.sha256)) {
      const report: Json = JSON.parse(bytesAt(dir, reportBinding).toString('utf8'));
      const leftOut = isObject(report) && report.spec === 'rig-parts-depth-report/1' && isObject(report.selection) && Array.isArray(report.selection.leftOut)
        ? report.selection.leftOut.filter((p): p is string => typeof p === 'string' && p !== '')
        : [];
      reportCleared = bodyRoles.every(role => leftOut.includes(role));
    }
  } catch { /* Registration checks own unreadable depth report evidence. */ }
  return { version: rig.n, dial, recorded: noteRecorded || reportCleared };
}

/** `next` names the unused dial while the turn step can still carry a note. */
export function turnExtraGroupMoves(dir: string, project: JsonObject, collection: JsonObject | null = null): { role: 'agent'; field: string; awaits: string; command: null; act: string }[] {
  const extra = turnExtraGroup(dir, project, collection);
  const plan = isObject(project.plan) ? project.plan : {};
  const step = asArray(plan.steps).filter(isObject).find(s => s.id === 'turn');
  if (extra === null || extra.recorded || step === undefined || step.status === 'done') return [];
  const field = 'plan.steps[turn].status_history[].note';
  return [{ role: 'agent', field, awaits: field, command: null,
    act: `RIG_TURN_EXTRA_GROUP: the head-only answer leaves dial ${extra.dial} of rig v${extra.version} unused; either remove turn.body from the working config and re-run rig-parts depth-apply --parts <accepted assembled parts> --manifest <inference/manifest.json> --config <depth recipe> --rig-config <config.json> --out <mapped directory> --groups head (Parts refuses DEPTH_GROUP_LEFT_OUT if turn.body remains) and register a new rig version, or keep the depth recipe and record it with the turn step's next status move: rig-create step-status turn <next status> <project dir> --by agent --note-file <file naming ${extra.dial} as unused>` }];
}

function turnExtraGroupFindings(dir: string, project: JsonObject, warnings: Finding[], collection: JsonObject | null): void {
  const extra = turnExtraGroup(dir, project, collection);
  if (extra === null || extra.recorded) return;
  const path = 'plan.steps[turn]';
  warnings.push({ code: 'RIG_TURN_EXTRA_GROUP', path, message: `${path}: the head-only answer omits body: true, but rig v${extra.version}'s registered config.turn.body also turns a body group on dial ${extra.dial}; remove turn.body from the working config and re-run rig-parts depth-apply ... --groups head (Parts refuses DEPTH_GROUP_LEFT_OUT otherwise) so depth-report.json records selection.leftOut for the body group, or keep the depth recipe and name ${extra.dial} as unused in a turn step note: rig-create step-status turn <next status> --by <operator> --note-file <file naming ${extra.dial}>` });
}

/** Reverse of `turnExtraGroup`: the answer asks for head and body, while the registered rig declares no `turn.body` roles (#1000). */
export function turnMissingBodyGroup(dir: string, project: JsonObject, collection: JsonObject | null = null): { version: number } | null {
  const { mode, body } = depthAnswer(project, collection);
  if (mode !== 'depth' || !body) return null;
  const rig = asArray(project.versions).filter(isObject).filter(v => v.kind === 'rig' && isObject(v.registration)).at(-1);
  if (rig === undefined || typeof rig.n !== 'number') return null;
  const record = rig.registration as JsonObject;
  let config: Json;
  try { config = JSON.parse(bytesAt(dir, record.config_source).toString('utf8')); }
  catch { return null; } // Registration checks own unreadable config evidence.
  const turn = isObject(config) && isObject(config.turn) ? config.turn : {};
  const turnBody = isObject(turn.body) ? turn.body : {};
  const bodyRoles = isObject(turnBody.roles) ? Object.keys(turnBody.roles) : [];
  if (bodyRoles.length > 0) return null;
  return { version: rig.n };
}

function turnMissingBodyGroupFindings(dir: string, project: JsonObject, warnings: Finding[], collection: JsonObject | null): void {
  const missing = turnMissingBodyGroup(dir, project, collection);
  if (missing === null) return;
  const path = `versions[v${missing.version}].registration.config_source`;
  warnings.push({
    code: 'RIG_TURN_BODY_MISSING',
    path,
    message: `${path}: the turn answer asks for head and body (body: true), but rig v${missing.version}'s registered config.turn.body declares no body roles; add turn.body to the working config, re-run rig-parts depth-apply with the body group and rig-parts rig, and register a new rig version, or record a head-only turn answer`,
  });
}

/** Depth-apply may enrich only depth declarations; accepted art/geometry/measurements stay identical. */
export function registeredDepthPartsMatch(dir: string, version: JsonObject, acceptedSha256: string, packagedSha256: string): boolean {
  try {
    const record = version.registration;
    if (!isObject(record) || !isObject(record.depth) || record.depth.route !== 'per-part' || !isObject(record.depth.source_parts)
      || record.depth.source_parts.sha256 !== acceptedSha256) return false;
    const binding = asArray(version.outputs).filter(isObject).find(f => f.path === `outputs/v${String(version.n)}/out/parts.json` && f.sha256 === packagedSha256);
    if (!binding) return false;
    const config: Json = JSON.parse(bytesAt(dir, record.config_source).toString('utf8'));
    if (!isObject(config) || depthBindingFindings(dir, version, config, record, []).length > 0) return false;
    const withoutDepth = (bytes: Buffer): JsonObject => {
      const doc: Json = JSON.parse(bytes.toString('utf8'));
      if (!isObject(doc) || !Array.isArray(doc.parts) || doc.parts.some(p => !isObject(p))) throw Error('invalid parts manifest');
      for (const part of doc.parts as JsonObject[]) delete part.depth;
      return doc;
    };
    return isDeepStrictEqual(withoutDepth(bytesAt(dir, record.depth.source_parts)), withoutDepth(bytesAt(dir, binding, true)));
  } catch { return false; }
}
