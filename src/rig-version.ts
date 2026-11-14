/** Register frozen bytes. Toolchain association and the not-after date are declarations. */
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from './check-reads.ts';
import { acquireBoundJobWrite, prepareVersionIntent, publishCommittedVersion } from './job-writer.ts';
import { cancelUncommittedIntent, type PendingPublication } from './job-outbox.ts';
import { partsFileReferences } from '@rig-c/parts/src/parts.ts';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, posix, relative, resolve, sep, win32 } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { asArray, checkProject, collectItems, isObject, type Finding } from './check.ts';
import { literalFile } from './choices.ts';
import { configInputReferences } from './config-inputs.ts';
import { parseFeedbackAnswers, readProject } from './feedback.ts';
import { Refusal, refuse, USAGE_EXIT } from './refusal.ts';
import { baselineOf, newFindings } from './refusal-baseline.ts';
import { collectReopens, reopenTime } from './reopen.ts';
import { prepareRigReviewPackage } from './review-package.ts';
import { rigVersionDateFinding } from './rig-version-date.ts';
import { checkRegisteredRuns, RUN_RECORD_SINCE, RunRecordError, validateRunRecord, type RunSpec } from './run-record.ts';
import { approvedStructureDelta, latestPartsApproval, structurePathIsIgnored } from './structure.ts';
import { stageOfStep } from './stages.ts';
import { HEAD_TURN_SINCE } from './waypoints.ts';
import type { Json, JsonObject } from './templates.ts';

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

function bytesAt(dir: string, binding: Json | undefined, output = false): Buffer {
  if (!isObject(binding) || typeof binding.path !== 'string' || !literal(binding.path)
    || typeof binding.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(binding.sha256)) throw Error('expected literal retained path and sha256');
  const file = literalFile(dir, binding.path);
  if (!output && structurePathIsIgnored(dir, binding.path)) throw Error('evidence is under an ignored root');
  const bytes = readFileSync(file);
  if (sha(bytes) !== binding.sha256) throw Error(`${binding.path} bytes changed`);
  return bytes;
}

function lockVersions(raw: Json): JsonObject {
  if (!isObject(raw) || raw.lockfileVersion !== 3 || !isObject(raw.packages)) throw Error('supply an npm lockfileVersion 3 package-lock.json');
  const versions: JsonObject = {};
  for (const name of ['@rig-c/parts', '@rig-c/core']) {
    const pkg = raw.packages[`node_modules/${name}`];
    if (!isObject(pkg) || typeof pkg.version !== 'string' || !pkg.version.trim()) throw Error(`missing packages[node_modules/${name}].version`);
    versions[name] = pkg.version;
  }
  return versions;
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
    const candidateRel = reqParent === '.' ? entry.path : `${reqParent}/${entry.path}`;
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
    const read = (binding: Json | undefined, spec: string, output = false): JsonObject => {
      const inventory = asArray(output ? version.outputs : record?.files).filter(isObject);
      if (!isObject(binding) || !inventory.some(row => row.path === binding.path && row.sha256 === binding.sha256)) throw Error('depth file is absent from the retained inventory');
      const doc: Json = JSON.parse(bytesAt(dir, binding, output).toString('utf8'));
      if (!isObject(doc) || doc.spec !== spec || !Array.isArray(doc.parts)) throw Error(`expected ${spec} with parts[]`);
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
        if (!isObject(binding) || !asArray(record?.files).filter(isObject).some(f => f.path === binding.path && f.sha256 === binding.sha256)
          || digest(binding.sha256, 'source parts') !== manifest.partsSha256) throw Error('prepare manifest does not bind the retained source parts');
        bytesAt(dir, binding);
      }
      const prepared = namedRows(manifest.parts, 'prepared parts');
      const applied = namedRows(report.parts, 'applied parts');
      if (!isDeepStrictEqual(prepared.map(row => row.part).sort(), applied.map(row => row.part).sort())) throw Error('prepare/apply part sets disagree');
      for (const row of applied) {
        const input = prepared.find(p => p.part === row.part)!;
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
      || !isObject(record.toolchain) || record.toolchain.kind !== 'npm-lock-v3' || version.at_basis !== 'not-after') {
      add('RIG_REGISTRATION_INVALID', 'registration', 'expected frozen-rig/1, a UTC registration date and npm-lock-v3 declaration'); continue;
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
    const runPaths = checkRegisteredRuns(dir, path, record, findings, warnings);
    try {
      const versions = lockVersions(JSON.parse(bytesAt(dir, record.toolchain.source).toString()));
      if (!isDeepStrictEqual(versions, version.built_with)) add('RIG_TOOLCHAIN_MISMATCH', 'built_with', 'declared versions disagree with the retained npm lock');
    } catch (error) { add('RIG_TOOLCHAIN_LOCK_INVALID', 'registration.toolchain.source', String(error)); }
    try {
      const source = version.at_source;
      const raw = JSON.parse(bytesAt(dir, source).toString()) as Json;
      const at = pointerValue(raw, isObject(source) ? source.pointer : undefined);
      if (!utcDate(at) || at !== version.at) throw Error('the cited pointer must equal at and contain a valid UTC instant');
      if (Date.parse(at) > Date.parse(String(record.at))) throw Error('the cited not-after instant is later than registration');
      // Later reopens preserve the historical registration, judged at its own event time.
      const reopens = collectReopens(project, []).filter(r => r.at <= Date.parse(String(record.at)));
      if (Date.parse(at) <= reopenTime(reopens, 'rig-review')) add('RIG_BUILD_BEFORE_REOPEN', 'at_source', 'the cited build bound does not follow the reopen covering rig-review at registration');
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
      const checkPortable = (value: Json, document: string, requirementsDocument = false, location: string[] = []): void => {
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
      };
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
        const expectedConfig = structuredClone(configSourceRaw);
        const adaptedConfigPointers = new Set<string>();
        for (const row of adapterRows.filter(r => r.doc === 'config')) {
          if (row.kind === 'legacy-abs') {
            const currentVal = row.pointer ? pointerValue(configSourceRaw, row.pointer) : undefined;
            if (row.pointer && typeof currentVal === 'string' && absolute(currentVal) && currentVal === row.originalString) {
              if (!row.sourcePath || !absolute(row.sourcePath) || !isValidAdaptedTarget(row.adaptedString)) {
                add('RIG_PATH_ADAPTER_INVALID', 'registration.path_adapter', `config ${row.pointer}: invalid legacy adapter`);
                throw Error(`config ${row.pointer}: invalid legacy adapter`);
              }
              setPointerValue(expectedConfig, row.pointer, row.adaptedString);
              adaptedConfigPointers.add(row.pointer);
            }
            continue;
          }
          const ref = sourceConfigRefs.find(r => r.pointer === row.pointer);
          if (!ref || pointerValue(configSourceRaw, row.pointer) !== row.originalString) {
            add('RIG_PATH_ADAPTER_INVALID', 'registration.path_adapter', `config ${row.pointer}: adapter does not match config-source`);
            throw Error(`config ${row.pointer}: adapter does not match config-source`);
          }
          adaptedConfigPointers.add(row.pointer);
          setPointerValue(expectedConfig, row.pointer, row.adaptedString);
        }
        if (!isPointerAdaptedRecord) {
          for (const ref of sourceConfigRefs) {
            if (adaptedConfigPointers.has(ref.pointer)) continue;
            if (/^assemble\.take\.\d+\.(?:run_dir|st_input)$|^assemble\.editor_receipts\.receipts\.\d+\.file$/.test(ref.dotPath)
              && !absolute(ref.value)) {
              setPointerValue(expectedConfig, ref.pointer, `inputs/${ref.dotPath.split('.').join('/')}`);
            }
          }
        }
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
          const relInEvidence = posix.normalize(reqParent === '.' ? ref.value : `${reqParent}/${ref.value}`);
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
      for (const [path, spec] of [['rig/rig.json', 'rigc-rig/1'], ['rig/motion.json', 'rigc-motion/1'], ['check/build/skeleton.model.json', 'rigc-compiled/3']]) {
        const document = JSON.parse(readFileSync(literalFile(dir, `outputs/v${String(version.n)}/out/${path}`), 'utf8')) as Json;
        if (!isObject(document) || document.spec !== spec) throw Error(`${path}: expected producer spec ${spec}`);
      }
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

export const RIG_VERSION_HELP = `rig-version <n> [<dir>] --parts <dir> --rig <dir> --build <dir> --idle <render dir>
  --config <file> --path-adapter <file> --compile-report <file> --toolchain-lock <package-lock.json>
  --at-source <dated JSON file> --at-pointer </pointer> --by <registrant> [--run-record <run.json>]... [--citations <sections JSON>] [--depth-manifest <prepare manifest>] [--json]
  Copy and hash frozen producer outputs. Retain an explicitly declared npm lock, producer run records and UTC not-after date.
  Idle requires rigc render's frames.json. No build, acceptance or stage advance runs.
  Repeat --answers <version>:<verdict> to answer earlier human bounced feedback.
  Source arguments resolve against the project directory; external frozen sources are permitted.`;

interface SourceFile { source: string; bytes: Buffer }

export function rigVersionCommand(args: string[], now: number): { stdout: string; exit: number } {
  const positional: string[] = [];
  const options: Record<string, string> = {};
  const runRecords: string[] = [];
  const answerValues: string[] = [];
  const flags = ['--parts', '--rig', '--build', '--idle', '--config', '--path-adapter', '--compile-report', '--toolchain-lock', '--at-source', '--at-pointer', '--by', '--citations', '--depth-manifest'];
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') json = true;
    else if (arg === '--answers') {
      const value = args[++i];
      if (!value || value.startsWith('--')) fail('RIG_REGISTRATION_USAGE', 'versions', '--answers needs version:verdict');
      answerValues.push(value);
    } else if (arg === '--run-record') {
      const value = args[++i];
      if (!value || value.startsWith('--')) fail('RIG_REGISTRATION_USAGE', 'versions', '--run-record needs one value');
      runRecords.push(value);
    } else if (flags.includes(arg)) {
      const value = args[++i];
      if (!value || value.startsWith('--') || options[arg] !== undefined) fail('RIG_REGISTRATION_USAGE', 'versions', `${arg} needs one value`);
      options[arg] = value;
    } else if (arg.startsWith('-')) refuse('UNKNOWN_OPTION', `rig-version does not take ${arg}`, USAGE_EXIT);
    else positional.push(arg);
  }
  const n = Number(positional[0]?.replace(/^v/, ''));
  if (!Number.isSafeInteger(n) || n < 1 || positional.length > 2 || flags.filter(f => f !== '--citations' && f !== '--depth-manifest').some(f => !options[f])) refuse('RIG_REGISTRATION_USAGE', RIG_VERSION_HELP, USAGE_EXIT);
  const dir = realpathSync(resolve(positional[1] ?? process.cwd()));
  let { file, project } = readProject(dir);
  let original = readFileSync(file);
  const lock = `${file}.rig-version.lock`;
  let descriptor: number;
  try { descriptor = openSync(lock, 'wx'); } catch { return fail('RIG_REGISTRATION_BUSY', 'versions', 'another registration holds the lock'); }
  const out = `outputs/v${n}`;
  const evidence = `evidence/v${n}/registration`;
  const pkg = `derived/review/v${n}`;
  const created: string[] = [];
  const sources: SourceFile[] = [];
  const sourceDirectories = new Map<string, string[]>();
  const outputFiles: JsonObject[] = [];
  let releasePublication = () => {};
  let publicationIntent: PendingPublication | null = null;
  try {
    releasePublication = acquireBoundJobWrite(dir);
    ({ file, project } = readProject(dir));
    original = readFileSync(file);
    if (project.schema !== 'rig-create/project@0') fail('SCHEMA_UNKNOWN', 'schema', 'rig-version reads rig-create/project@0');
    if (!Array.isArray(project.versions) || asArray(project.versions).some(v => !isObject(v) || typeof v.n !== 'number')) fail('RIG_REGISTRATION_INVALID', 'versions', 'restore the version list');
    const registeredNumbers = new Set(project.versions.map(v => (v as JsonObject).n as number));
    const maxRegistered = Math.max(0, ...registeredNumbers);
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
    const systemRoots = [resolve(tmpdir()), '/tmp', '/var', dirname(resolve(positional[1] ?? process.cwd())), dirname(dir)];
    const isSystemAncestor = (candidate: string): boolean =>
      systemRoots.some(root => root === candidate || root.startsWith(`${candidate}${sep}`));
    const sourceBytes = (path: string): Buffer => {
      const absolutePath = resolve(dir, path);
      // Check every ancestor inside the source tree, excluding system ancestors above it.
      let current = absolutePath;
      while (dirname(current) !== current && (current === absolutePath || !isSystemAncestor(current))) {
        if (lstatSync(current).isSymbolicLink()) fail('RIG_REGISTRATION_PATH_INVALID', path, 'source symlinks are unsupported');
        current = dirname(current);
      }
      if (!lstatSync(absolutePath).isFile()) fail('RIG_REGISTRATION_FILE_INVALID', path, 'expected a regular source file');
      const bytes = readFileSync(absolutePath);
      sources.push({ source: absolutePath, bytes });
      return bytes;
    };
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
    let versions: JsonObject;
    try { versions = lockVersions(JSON.parse(sourceBytes(options['--toolchain-lock']!).toString())); }
    catch (error) { if (error instanceof Refusal) throw error; return fail('RIG_TOOLCHAIN_LOCK_INVALID', `versions[v${n}].built_with`, String(error)); }
    const registrationAt = new Date(now).toISOString();
    const validatedRuns: { path: string; spec: RunSpec }[] = [];
    const seenSpecs = new Set<RunSpec>();
    for (const [i, recordPath] of runRecords.entries()) {
      const entryPath = `versions[v${n}].registration.runs[${i}]`;
      try {
        const { spec } = validateRunRecord(sourceBytes(recordPath), entryPath);
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
      return fail('RUN_RECORD_REQUIRED', `versions[v${n}].registration.runs`, 'version registered from the npm lock alone; retain producer run.json records with --run-record');
    }
    // Pre-existing refusals stay the project's; the candidate may not add a new one.
    const baseline = baselineOf(checkProject(dir, project, { now }));
    created.push(join(dir, evidence), join(dir, out));
    mkdirSync(join(dir, evidence), { recursive: true });
    const toolchain = input('--toolchain-lock', 'package-lock.json');
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
    const config = JSON.parse(bytesAt(dir, configSource).toString()) as Json;
    if (!isObject(config)) fail('RIG_REGISTRATION_FILE_INVALID', 'config', 'expected a JSON object');
    const copiedSources = new Map<string, string>();
    const copyTree = (source: string, target: string, outputs: boolean): void => {
      const path = resolve(dir, source);
      const info = lstatSync(path);
      if (info.isDirectory()) {
        if (info.isSymbolicLink()) fail('RIG_REGISTRATION_PATH_INVALID', source, 'source symlinks are unsupported');
        const names = readdirSync(path).sort();
        sourceDirectories.set(path, names);
        destinationExists(dir, target, invalidDestination);
        mkdirSync(join(dir, target), { recursive: true });
        for (const name of names) copyTree(join(path, name), `${target}/${name}`, outputs);
      } else {
        retain(target, sourceBytes(path), outputs);
        copiedSources.set(target, path);
      }
    };
    const checkSourceAncestors = (absolutePath: string, label: string, allowedRoot?: string): void => {
      let current = absolutePath;
      while (dirname(current) !== current && (current === absolutePath || !isSystemAncestor(current))) {
        if (existsSync(current) && lstatSync(current).isSymbolicLink()) fail('RIG_REGISTRATION_PATH_INVALID', label, 'source symlinks are unsupported');
        if (allowedRoot && current === allowedRoot) break;
        current = dirname(current);
      }
    };
    // Walk the lexical spelling before resolving system temp aliases or input symlinks.
    const canonicalSourcePath = (path: string): string => {
      let parent = path;
      while (!existsSync(parent)) parent = dirname(parent);
      return resolve(realpathSync(parent), relative(parent, path));
    };
    const configDir = dirname(realpathSync(resolve(dir, options['--config']!)));
    let configRefs: AssetRefSpec[];
    try { configRefs = collectConfigAssetRefs(dir, config); }
    catch (error) { if (error instanceof Refusal) throw error; return fail('RIG_REGISTRATION_FILE_INVALID', 'config', String(error)); }
    for (const row of callerAdapter.filter(r => r.kind === 'pointer' && r.doc === 'config')) {
      const ref = configRefs.find(r => r.pointer === row.pointer);
      if (!ref || ref.value !== row.originalString) {
        return fail('RIG_PATH_ADAPTER_INVALID', `versions[v${n}].registration.path_adapter`, `config ${row.pointer}: adapter does not match config-source`);
      }
    }
    const configUsesPointers = callerAdapter.some(row => row.kind === 'pointer')
      || configRefs.some(ref => !absolute(ref.value) && ref.autoRelocate);
    const configAllowedRoot = configUsesPointers || insideOrEqual(dir, configDir) ? dir : configDir;
    const portable = structuredClone(config);
    const effectiveAdapter: JsonObject[] = callerAdapter.map(r => r.raw);
    const reservedTargets = new Set<string>(RESERVED_REGISTRATION_NAMES);
    for (const { spec } of validatedRuns) reservedTargets.add(`${spec.replace('/', '-')}.json`);
    const conflictsWithReserved = (candidate: string): boolean => {
      for (const existing of reservedTargets) {
        if (existing === candidate || existing.startsWith(`${candidate}/`) || candidate.startsWith(`${existing}/`)) return true;
      }
      return false;
    };
    let reqSourcePath: string | undefined;
    let portableReqRel: string | undefined;
    for (const ref of configRefs) {
      const callerRow = callerAdapter.find(r => r.doc === 'config' && r.pointer === ref.pointer && (r.kind === 'pointer' || absolute(ref.value) && r.originalString === ref.value));
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
      let adaptedValue: string;
      if (callerRow) {
        adaptedValue = callerRow.adaptedString;
      } else if (ref.autoRelocate) {
        adaptedValue = `inputs/${ref.dotPath.split('.').join('/')}`;
        effectiveAdapter.push({ doc: 'config', pointer: ref.pointer, before: ref.value, after: adaptedValue });
      } else {
        adaptedValue = ref.value;
      }
      if (!isValidAdaptedTarget(adaptedValue) || conflictsWithReserved(adaptedValue)) {
        return fail('RIG_REGISTRATION_PATH_INVALID', `${evidence}/${adaptedValue}`, 'two distinct inputs collide or target is invalid');
      }
      if (adaptedValue !== ref.value) setPointerValue(portable, ref.pointer, adaptedValue);
      if (ref.pointer === '/requirements') {
        reqSourcePath = sourcePath;
        portableReqRel = adaptedValue;
      } else {
        copyTree(sourcePath, `${evidence}/${adaptedValue}`, false);
      }
    }
    let requirementsSourceBinding: JsonObject | undefined;
    let requirementsRuntimeBinding: JsonObject | undefined;
    if (typeof config.requirements !== 'string') {
      if (callerAdapter.some(r => r.doc === 'requirements')) {
        return fail('RIG_PATH_ADAPTER_INVALID', `versions[v${n}].registration.path_adapter`, 'requirements adapter supplied without config.requirements');
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
          return fail('RIG_PATH_ADAPTER_INVALID', `versions[v${n}].registration.path_adapter`, `requirements ${row.pointer}: adapter does not match requirements-source`);
        }
      }
      const portableReq = structuredClone(originalReq);
      const reqDir = dirname(reqSourcePath);
      const reqUsesPointers = effectiveAdapter.some(row => row.pointer !== undefined)
        || reqRefs.some(ref => ref.autoRelocate);
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
        let adaptedValue: string;
        if (callerRow) {
          adaptedValue = callerRow.adaptedString;
        } else if (ref.autoRelocate) {
          adaptedValue = reqParent === '.' ? `inputs/${ref.dotPath.split('.').join('/')}` : `${ref.dotPath.split('.').join('/')}`;
          effectiveAdapter.push({ doc: 'requirements', pointer: ref.pointer, before: ref.value, after: adaptedValue });
        } else {
          adaptedValue = ref.value;
        }
        const relInEvidence = reqParent === '.' ? adaptedValue : `${reqParent}/${adaptedValue}`;
        if (!isValidAdaptedTarget(adaptedValue) || !isValidAdaptedTarget(relInEvidence) || conflictsWithReserved(relInEvidence)) {
          return fail('RIG_REGISTRATION_PATH_INVALID', `${evidence}/${relInEvidence}`, 'two distinct inputs collide or target is invalid');
        }
        retain(`${evidence}/${relInEvidence}`, assetBytes, false);
        copiedSources.set(`${evidence}/${relInEvidence}`, assetSource);
        if (adaptedValue !== ref.value) setPointerValue(portableReq, ref.pointer, adaptedValue);
      }
      if (effectiveAdapter.some(row => row.pointer !== undefined)) {
        const reqSourceRel = insideOrEqual(dir, reqSourcePath) ? relative(dir, reqSourcePath).split(sep).join('/') : undefined;
        requirementsSourceBinding = {
          ...retain(`${evidence}/requirements-source.json`, reqOriginalBytes),
          ...(reqSourceRel && literal(reqSourceRel) ? { source_path: reqSourceRel } : {}),
        };
        const runtimeReqBytes = isDeepStrictEqual(originalReq, portableReq)
          ? reqOriginalBytes : Buffer.from(`${JSON.stringify(portableReq, null, 2)}\n`);
        requirementsRuntimeBinding = retain(`${evidence}/${portableReqRel}`, runtimeReqBytes);
      } else {
        retain(`${evidence}/${portableReqRel}`, reqOriginalBytes);
      }
      copiedSources.set(`${evidence}/${portableReqRel}`, reqSourcePath);
    }
    const pointerAdapted = effectiveAdapter.some(row => row.pointer !== undefined);
    const adapterBinding = retain(
      `${evidence}/path-adapter.json`,
      effectiveAdapter.length === callerAdapter.length ? rawAdapterBytes : Buffer.from(`${JSON.stringify(effectiveAdapter, null, 2)}\n`),
    );
    const configBinding = retain(`${evidence}/config.json`, Buffer.from(`${JSON.stringify(portable, null, 2)}\n`));
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
      const approval = latestPartsApproval(project, Date.parse(String(at)));
      const draft = asArray(project.drafts).filter(isObject).find(d => d.id === approval?.draft_id);
      if (perPart && approval && isObject(draft?.parts) && typeof draft.parts.path === 'string') {
        const originalParts = resolve(dir, draft.parts.path, 'parts.json');
        if (!existsSync(originalParts)) fail('RIG_DEPTH_BINDING_MISSING', `versions[v${n}].registration.depth.source_parts`, 'restore the accepted assembled parts manifest before registering the depth-enriched version');
        depthBinding.source_parts = retain(`${evidence}/depth-source-parts.json`, sourceBytes(originalParts));
      }
      if (existsSync(sourceSheets)) depthBinding.sheets = { path: relative(dir, sheets).split(sep).join('/'), sha256: sha(sourceBytes(sourceSheets)) };
      if (options['--depth-manifest']) depthBinding.manifest = input('--depth-manifest', 'depth-manifest.json');
      if (existsSync(depthReport)) depthBinding.report = retain(`${evidence}/depth-report.json`, sourceBytes(depthReport));
    }
    const partReferences = partsFileReferences(partsDir);
    for (const reference of partReferences) {
      const target = `${out}/out/${reference.path}`;
      if (!copiedSources.has(target)) copyTree(join(partsDir, reference.path), target, true);
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
    let sections: Json = {};
    if (options['--citations']) {
      const binding = input('--citations', 'citations.json');
      retained.push(binding);
      sections = JSON.parse(bytesAt(dir, binding).toString()) as Json;
      if (!isObject(sections)) fail('RIG_REGISTRATION_FILE_INVALID', 'provenance.sections', 'citations must be a section map');
    }
    const structureChanges = approvedStructureDelta(dir, project, Date.parse(String(at)), portable);
    const version: JsonObject = { n, kind: 'rig', rig_version: null, at, at_basis: 'not-after', at_source: atSource,
      built_by: options['--by']!, built_with: versions, outputs: outputFiles, evidence: [], verdicts: [], answers_feedback: answersFeedback, review_origin: null,
      changed: 'Registered frozen producer outputs', provenance: { config: configBinding, sections, ...(structureChanges.length ? { structure_delta: structureChanges } : {}) },
      registration: { kind: 'frozen-rig/1', at: registrationAt, toolchain: { kind: 'npm-lock-v3', source: toolchain },
        ...(runs.length ? { runs } : {}),
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
    prepareRigReviewPackage([String(n), dir, '--config', String(configBinding.path), '--from', `${out}/out`], candidate, partReferences.map(reference => reference.path));
    // The record must pass the same check as every other writer's before it is renamed into place.
    const fresh = newFindings(baseline, checkProject(dir, candidate, { now }).refusals)[0];
    if (fresh) refuse(fresh.code, fresh.message);
    for (const entry of skipped) {
      const currentDestinations = versionDestinations(entry.n).filter(target => destinationExists(dir, target, invalidDestination));
      if (!isDeepStrictEqual(currentDestinations, entry.destinations)) fail('RIG_REGISTRATION_SOURCE_CHANGED', `versions[v${n}].registration.skipped`, `v${entry.n} occupying destinations changed during registration`);
    }
    for (const [path, names] of sourceDirectories) if (!isDeepStrictEqual(readdirSync(path).sort(), names)) fail('RIG_REGISTRATION_SOURCE_CHANGED', path, 'source directory changed during registration');
    for (const source of sources) if (!readFileSync(source.source).equals(source.bytes)) fail('RIG_REGISTRATION_SOURCE_CHANGED', source.source, 'source changed during registration');
    if (!readFileSync(file).equals(original)) fail('RIG_REGISTRATION_SOURCE_CHANGED', 'project.json', 'record changed during registration');
    const pending = join(dir, evidence, 'project.pending');
    const recordBytes = Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`);
    publicationIntent = prepareVersionIntent(dir, recordBytes, n);
    writeFileSync(pending, recordBytes);
    renameSync(pending, file);
    created.length = 0;
    publishCommittedVersion(dir, n);
    return { stdout: json ? JSON.stringify(version, null, 2) : `rig-version: v${n} registered; ${String((version.review_package as JsonObject).open)}`, exit: 0 };
  } catch (error) {
    if (error instanceof Refusal) throw error;
    return fail('RIG_REGISTRATION_FILE_INVALID', `versions[v${n}].registration`, error instanceof Error ? error.message : String(error));
  } finally {
    cancelUncommittedIntent(dir, publicationIntent);
    for (const path of created.reverse()) rmSync(path, { recursive: true, force: true });
    closeSync(descriptor);
    rmSync(lock);
    releasePublication();
  }
}

/** The optional plan step consumes approved parts before the ordinary rig step. */
export function depthPlanMoves(project: JsonObject, collection: JsonObject | null = null): { role: 'agent'; field: string; awaits: string; command: null; act: string }[] {
  const { answer, mode } = depthAnswer(project, collection);
  if (mode !== 'depth') return [];
  const answerAt = typeof answer.at === 'string' ? Date.parse(answer.at) : -Infinity;
  const rig = asArray(project.versions).filter(isObject).find(v => v.kind === 'rig' && typeof v.at === 'string' && Date.parse(v.at) >= answerAt && isObject(v.registration) && isObject(v.registration.depth));
  if (rig) return [];
  const steps = ["Record the chosen depth route and reason in the turn plan step text. Default per-part sequence: rig-parts depth-prepare --parts <accepted assembled parts> --config <depth recipe> --out <inference directory>",
    "Run the supplied depth model on each prepared image; retain raw rig-parts-map/1 maps (face normals, scalar depth for other parts).",
    "rig-parts depth-apply --parts <accepted assembled parts> --manifest <inference/manifest.json> --config <depth recipe> --rig-config <config.json> --out <mapped directory>; then rig-parts rig --parts <mapped directory> --config <mapped/config.json> --out <rig directory>. Register with rig-version --parts <mapped directory> --rig <rig directory> --config <mapped/config.json> --depth-manifest <inference/manifest.json>."];
  return steps.map((act, i) => ({ role: 'agent', field: `plan.steps[turn].moves[${i}]`, awaits: 'versions[].registration.depth', command: null, act }));
}

function depthAnswer(project: JsonObject, collection: JsonObject | null = null): { answer: JsonObject; mode: Json | undefined } {
  const item = collectItems(project, { collection }).find(item => item.id === 'turn');
  const answer = item?.state.state === 'user' || item?.state.state === 'delegated' ? item.state.answer : {};
  const decision = answer.delegated === true && isObject(answer.agent_decision) ? answer.agent_decision.value : answer.value;
  return { answer, mode: isObject(decision) ? decision.mode : undefined };
}

/** The optional depth step is drafted before its rigging-interview approval, just like the other rig steps. */
export function depthPlanFindings(project: JsonObject, warnings: Finding[], collection: JsonObject | null = null): Finding[] {
  const { answer, mode } = depthAnswer(project, collection);
  if (mode !== 'depth') return [];
  const answerAt = typeof answer.at === 'string' ? Date.parse(answer.at) : NaN;
  const approved = asArray(project.signoffs).filter(isObject).some(s => s.stage === 'rigging-interview' && (s.checkpoint ?? null) === null && Date.parse(String(s.at)) >= answerAt);
  if (!approved && !['rigging', 'rig-review', 'post-interview', 'post', 'direction-review', 'accepted'].includes(String(project.stage))) return [];
  const plan = isObject(project.plan) ? project.plan : {};
  const steps = asArray(plan.steps).filter(isObject);
  const depth = steps.find(s => s.id === 'turn' && s.phase === 'rig' && asArray(s.rests_on).includes('turn'));
  if (depth && steps.filter(s => s !== depth && s.phase === 'rig' && stageOfStep('rig', String(s.id)) === 'rigging').every(s => Number(depth.order) < Number(s.order))) return [];
  const path = 'plan.steps[turn]';
  const finding = { code: 'RIG_DEPTH_PLAN_MISSING', path, message: `${path}: a depth turn needs a rig-phase depth step resting on turn, ordered before the rig steps; draft it with plan add turn and approve it at rigging-interview before running rig` };
  if (answerAt < Date.parse(HEAD_TURN_SINCE)) { warnings.push(finding); return []; }
  return [finding];
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
