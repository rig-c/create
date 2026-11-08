/** Register frozen bytes. Toolchain association and the not-after date are declarations. */
import { createHash } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { asArray, checkProject, isObject, type Finding } from './check.ts';
import { literalFile } from './choices.ts';
import { configInputReferences } from './config-inputs.ts';
import { readProject } from './feedback.ts';
import { Refusal, refuse, USAGE_EXIT } from './refusal.ts';
import { collectReopens, reopenTime } from './reopen.ts';
import { prepareRigReviewPackage } from './review-package.ts';
import { rigVersionDateFinding } from './rig-version-date.ts';
import { checkRegisteredRuns, RUN_RECORD_SINCE, RunRecordError, validateRunRecord, type RunSpec } from './run-record.ts';
import { structurePathIsIgnored } from './structure.ts';
import type { Json, JsonObject } from './templates.ts';

const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const absolute = (path: string): boolean => isAbsolute(path) || win32.isAbsolute(path);
const literal = (path: string): boolean => !!path && !absolute(path) && !path.includes('\\') && !path.includes(':') && path.split('/').every(p => p !== '' && p !== '.' && p !== '..');
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

function pointerValue(raw: Json, pointer: Json | undefined): Json | undefined {
  if (typeof pointer !== 'string' || !pointer.startsWith('/') || /~(?![01])/.test(pointer)) throw Error('supply a nonempty RFC 6901 JSON pointer');
  let value: Json | undefined = raw;
  for (const token of pointer.slice(1).split('/')) {
    const key = token.replaceAll('~1', '/').replaceAll('~0', '~');
    if (!isObject(value) && !Array.isArray(value)) return undefined;
    if (!Object.hasOwn(value, key)) return undefined;
    value = (value as JsonObject)[key];
  }
  return value;
}

function utcDate(raw: Json | undefined): raw is string {
  return typeof raw === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|\+00:00)$/.test(raw)
    && rigVersionDateFinding({ kind: 'rig', at: raw }) === null
    && Number(raw.slice(11, 13)) < 24 && Number(raw.slice(14, 16)) < 60 && Number(raw.slice(17, 19)) < 60;
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

function pathAdapter(raw: Json): JsonObject[] {
  if (!Array.isArray(raw) || raw.some(v => !isObject(v) || typeof v.at !== 'string' || typeof v.before !== 'string' || typeof v.after !== 'string')
    || new Set(raw.filter(isObject).map(v => v.at)).size !== raw.length) throw Error('supply distinct at/before/after mappings');
  return raw as JsonObject[];
}

/** Only explicitly registered versions opt in. Older version contracts are unchanged. */
export function rigRegistrationFindings(dir: string, project: JsonObject, warnings: Finding[] = []): Finding[] {
  const findings: Finding[] = [];
  for (const version of asArray(project.versions).filter(isObject)) {
    if (version.registration === undefined) continue;
    const path = `versions[v${String(version.n)}]`;
    const add = (code: string, field: string, why: string): void => { findings.push({ code, path: `${path}.${field}`, message: `${path}.${field}: ${why}; restore the retained registration inputs or register a new rig version` }); };
    const record = version.registration;
    if (version.kind !== 'rig' || !isObject(record) || record.kind !== 'frozen-rig/1' || !utcDate(record.at)
      || !isObject(record.toolchain) || record.toolchain.kind !== 'npm-lock-v3' || version.at_basis !== 'not-after') {
      add('RIG_REGISTRATION_INVALID', 'registration', 'expected frozen-rig/1, a UTC registration date and npm-lock-v3 declaration'); continue;
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
    try { pathAdapter(JSON.parse(bytesAt(dir, record.path_adapter).toString())); }
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
      const portable = JSON.parse(bytesAt(dir, config).toString()) as Json;
      const checkPortable = (value: Json): void => {
        if (typeof value === 'string' && absolute(value)) throw Error('the retained config contains an unresolved absolute path');
        if (Array.isArray(value)) value.forEach(checkPortable);
        else if (isObject(value)) Object.values(value).forEach(checkPortable);
      };
      checkPortable(portable);
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
  --at-source <dated JSON file> --at-pointer </pointer> --by <registrant> [--run-record <run.json>]... [--citations <sections JSON>] [--json]
  Copy and hash frozen producer outputs. Retain an explicitly declared npm lock, producer run records and UTC not-after date.
  Idle requires rigc render's frames.json. No build, acceptance or stage advance runs.
  Source arguments resolve against the project directory; external frozen sources are permitted.`;

interface SourceFile { source: string; bytes: Buffer }

export function rigVersionCommand(args: string[], now: number): { stdout: string; exit: number } {
  const positional: string[] = [];
  const options: Record<string, string> = {};
  const runRecords: string[] = [];
  const flags = ['--parts', '--rig', '--build', '--idle', '--config', '--path-adapter', '--compile-report', '--toolchain-lock', '--at-source', '--at-pointer', '--by', '--citations'];
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') json = true;
    else if (arg === '--run-record') {
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
  if (!Number.isSafeInteger(n) || n < 1 || positional.length > 2 || flags.filter(f => f !== '--citations').some(f => !options[f])) refuse('RIG_REGISTRATION_USAGE', RIG_VERSION_HELP, USAGE_EXIT);
  const dir = realpathSync(resolve(positional[1] ?? process.cwd()));
  const { file, project } = readProject(dir);
  const original = readFileSync(file);
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
  try {
    if (project.schema !== 'rig-create/project@0') fail('SCHEMA_UNKNOWN', 'schema', 'rig-version reads rig-create/project@0');
    if (!Array.isArray(project.versions) || asArray(project.versions).some(v => !isObject(v) || typeof v.n !== 'number')) fail('RIG_REGISTRATION_INVALID', 'versions', 'restore the version list');
    if (n !== Math.max(0, ...project.versions.filter(isObject).map(v => Number(v.n))) + 1) fail('RIG_REGISTRATION_INVALID', 'versions', 'use the next version number');
    // Refuse missing public idle provenance before copying any project input.
    const idleSource = resolve(dir, options['--idle']!);
    if (!existsSync(join(idleSource, 'frames.json'))) fail('RIG_IDLE_MANIFEST_MISSING', `versions[v${n}].registration.idle`, 'supply rigc render output with frames.json');
    for (const target of [out, evidence, pkg]) {
      let current = dir;
      for (const part of target.split('/')) {
        current = join(current, part);
        if (existsSync(current) && (lstatSync(current).isSymbolicLink() || !lstatSync(current).isDirectory())) fail('RIG_REGISTRATION_PATH_INVALID', target, 'destination must have real directory parents');
      }
      if (existsSync(join(dir, target))) fail('RIG_REGISTRATION_EXISTS', target, 'preserve the existing destination');
    }
    const sourceBytes = (path: string): Buffer => {
      const absolutePath = resolve(dir, path);
      // Check every ancestor, including external frozen source trees.
      let current = absolutePath;
      while (dirname(current) !== current) {
        if (lstatSync(current).isSymbolicLink()) fail('RIG_REGISTRATION_PATH_INVALID', path, 'source symlinks are unsupported');
        current = dirname(current);
      }
      if (!lstatSync(absolutePath).isFile()) fail('RIG_REGISTRATION_FILE_INVALID', path, 'expected a regular source file');
      const bytes = readFileSync(absolutePath);
      sources.push({ source: absolutePath, bytes });
      return bytes;
    };
    const retain = (target: string, bytes: Buffer, outputs = false): JsonObject => {
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
    const baseline = checkProject(dir, project, { now }).refusals;
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
    const adapterBinding = input('--path-adapter', 'path-adapter.json');
    let adapter: JsonObject[];
    try { adapter = pathAdapter(JSON.parse(bytesAt(dir, adapterBinding).toString())); }
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
        mkdirSync(join(dir, target), { recursive: true });
        for (const name of names) copyTree(join(path, name), `${target}/${name}`, outputs);
      } else {
        retain(target, sourceBytes(path), outputs);
        copiedSources.set(target, path);
      }
    };
    const configDir = dirname(resolve(dir, options['--config']!));
    const relocate = (value: Json, path: string): Json => {
      const runtimeInput = /^assemble\.take\.\d+\.(?:run_dir|st_input)$|^assemble\.editor_receipts\.receipts\.\d+\.file$/.test(path);
      if (typeof value === 'string' && (absolute(value) || runtimeInput)) {
        let source = resolve(configDir, value);
        if (absolute(value)) {
          const mapping = adapter.find(v => v.at === `.${path}` && v.after === value);
          if (!mapping || typeof mapping.before !== 'string' || !absolute(mapping.before)) return fail('RIG_RUNTIME_PATH_UNRESOLVED', `config.${path}`, 'absolute input has no exact recorded adapter');
          source = mapping.before;
        }
        const target = `inputs/${path.split('.').join('/')}`;
        copyTree(source, `${evidence}/${target}`, false);
        return target;
      }
      if (Array.isArray(value)) return value.map((v, i) => relocate(v, path ? `${path}.${i}` : String(i)));
      if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, relocate(v, path ? `${path}.${k}` : k)]));
      return value;
    };
    const portable = relocate(config, '') as JsonObject;
    for (const ref of configInputReferences(dir, portable)) {
      if (!literal(ref.value)) fail('RIG_REGISTRATION_PATH_INVALID', `config.${ref.at}`, 'named inputs must be contained relative paths');
      const target = `${evidence}/${ref.value}`;
      if (!copiedSources.has(target)) copyTree(resolve(configDir, ref.value), target, false);
    }
    if (typeof portable.requirements === 'string') {
      const target = `${evidence}/${portable.requirements}`;
      const requirements = JSON.parse(readFileSync(join(dir, target), 'utf8')) as Json;
      const setup = isObject(requirements) && isObject(requirements.setup_painting) ? requirements.setup_painting : {};
      if (isObject(setup.figure_mask) && typeof setup.figure_mask.path === 'string') {
        const path = setup.figure_mask.path;
        const mask = resolve(dir, dirname(target), path);
        const name = relative(join(dir, evidence), mask);
        if (absolute(path) || !name || name === '..' || name.startsWith(`..${sep}`)) fail('RIG_RUNTIME_PATH_UNRESOLVED', target, 'figure mask must resolve inside the retained config directory');
        copyTree(resolve(dirname(copiedSources.get(target)!), path), relative(dir, mask).split(sep).join('/'), false);
      }
    }
    const configBinding = retain(`${evidence}/config.json`, Buffer.from(`${JSON.stringify(portable, null, 2)}\n`));
    const compile = input('--compile-report', 'compile-report.json');
    const partsDir = resolve(dir, options['--parts']!);
    copyTree(join(partsDir, 'parts.json'), `${out}/out/parts.json`, true);
    copyTree(join(partsDir, 'parts'), `${out}/out/parts`, true);
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
    const version: JsonObject = { n, kind: 'rig', rig_version: null, at, at_basis: 'not-after', at_source: atSource,
      built_by: options['--by']!, built_with: versions, outputs: outputFiles, evidence: [], verdicts: [], answers_feedback: [], review_origin: null,
      changed: 'Registered frozen producer outputs', provenance: { config: configBinding, sections },
      registration: { kind: 'frozen-rig/1', at: registrationAt, toolchain: { kind: 'npm-lock-v3', source: toolchain },
        ...(runs.length ? { runs } : {}),
        files: retained, config_source: configSource, path_adapter: adapterBinding, idle, compile,
        copied: { files: outputFiles.length, bytes: outputFiles.reduce((total, f) => total + Number(f.bytes), 0) } } };
    const candidate = { ...project, versions: [...project.versions, version] };
    const problem = rigRegistrationFindings(dir, candidate)[0];
    if (problem) refuse(problem.code, problem.message);
    created.push(join(dir, pkg));
    prepareRigReviewPackage([String(n), dir, '--config', String(configBinding.path), '--from', `${out}/out`], candidate);
    // The record must pass the same check as every other writer's before it is renamed into place.
    const counts = new Map<string, number>();
    for (const f of baseline) counts.set(`${f.code}:${f.path}`, (counts.get(`${f.code}:${f.path}`) ?? 0) + 1);
    for (const f of checkProject(dir, candidate, { now }).refusals) {
      const key = `${f.code}:${f.path}`;
      const left = counts.get(key) ?? 0;
      if (!left) refuse(f.code, f.message);
      counts.set(key, left - 1);
    }
    for (const [path, names] of sourceDirectories) if (!isDeepStrictEqual(readdirSync(path).sort(), names)) fail('RIG_REGISTRATION_SOURCE_CHANGED', path, 'source directory changed during registration');
    for (const source of sources) if (!readFileSync(source.source).equals(source.bytes)) fail('RIG_REGISTRATION_SOURCE_CHANGED', source.source, 'source changed during registration');
    if (!readFileSync(file).equals(original)) fail('RIG_REGISTRATION_SOURCE_CHANGED', 'project.json', 'record changed during registration');
    const pending = join(dir, evidence, 'project.pending');
    writeFileSync(pending, `${JSON.stringify(candidate, null, 2)}\n`);
    renameSync(pending, file);
    created.length = 0;
    return { stdout: json ? JSON.stringify(version, null, 2) : `rig-version: v${n} registered; ${String((version.review_package as JsonObject).open)}`, exit: 0 };
  } catch (error) {
    if (error instanceof Refusal) throw error;
    return fail('RIG_REGISTRATION_FILE_INVALID', `versions[v${n}].registration`, error instanceof Error ? error.message : String(error));
  } finally {
    for (const path of created.reverse()) rmSync(path, { recursive: true, force: true });
    closeSync(descriptor);
    rmSync(lock);
  }
}
