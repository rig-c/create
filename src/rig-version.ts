/** Read and verify retained frozen-rig/1 registrations, depth bindings, and turn rules. */
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from './check-reads.ts';
import { BODY_YAW_DIAL_BONE } from '@rig-c/parts/src/turn.ts';
import { dirname, isAbsolute, join, posix, win32 } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { asArray, collectItems, isObject, itemFor, type Ctx, type Finding } from './check.ts';
import { literalFile } from './choices.ts';
import { configInputReferences } from './config-inputs.ts';
import { refuse } from './refusal.ts';
import { checkRigReport, RIG_CHECK_REPORT_FILE } from './rig-check-report.ts';
import { lockedPackage, type ToolchainKind } from './toolchain-lock.ts';
import { rigVersionDateFinding } from './rig-version-date.ts';
import { checkRegisteredRuns } from './run-record.ts';
import { rigPartsApproval, structurePathIsIgnored } from './structure.ts';
import { stageOfStep } from './stages.ts';
import { HEAD_TURN_SINCE } from './waypoints.ts';
import type { Json, JsonObject } from './templates.ts';

export const DEPTH_MAP_BINDING_SINCE = '2026-11-19T00:00:00Z';
const DEPTH_MAP_BINDING_SPEC = 'rig-parts-depth-map-binding/1';
const CHECK_MODEL_PATH = 'check/build/skeleton.model.json';

const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const absolute = (path: string): boolean => isAbsolute(path) || win32.isAbsolute(path);
const literal = (path: string): boolean => !!path && !absolute(path) && !path.includes('\\') && !path.includes(':') && path.split('/').every(p => p !== '' && p !== '.' && p !== '..');
const escapePointerToken = (token: string): string => token.replaceAll('~', '~0').replaceAll('/', '~1');
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
