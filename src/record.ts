/**
 * `record rig`: write `current.rig` and install the producer's output by rename (docs/CURRENT-DATA.md §1.3).
 * create reads the producer's run records and check report and never re-derives them (AGENTS.md invariant 1).
 * Every refusal comes before the first rename, so a refused write leaves project.json and outputs/rig/ byte-identical.
 */
import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, renameSync, rmSync } from 'node:fs';
import { isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { existsSync, lstatSync, readFileSync, realpathSync } from './check-reads.ts';
import { checkProject, isObject, PROJECT_SCHEMA } from './check.ts';
import { literalFile } from './choices.ts';
import { builtFromNameAllowed, currentShapeFindings, outputRoot, outputSetHash, RUN_RECORD_NAME, sha256, treeFiles } from './current.ts';
import { readProject } from './feedback.ts';
import { acquireBoundJobWrite } from './job-writer.ts';
import type { CommandResult } from './interview.ts';
import { writeRecord } from './record-input.ts';
import { Refusal, refuse, USAGE_EXIT } from './refusal.ts';
import { baselineOf, newFindings } from './refusal-baseline.ts';
import { parseRigCheckReport, RIG_CHECK_REPORT_FILE } from './rig-check-report.ts';
import { RunRecordError, validateRunRecord } from './run-record.ts';
import type { JsonObject } from './templates.ts';

export const RECORD_HELP = `record:
  rig-create record rig [<dir>] --from <producer out> --config <rig config> [--by <who>] [--json]
                 record the producer's rig output as current.rig and rename it into outputs/rig/ (the old tree is deleted
                 after). <producer out> is a folder inside the project, normally outputs/rig.next, holding the parts rig
                 output with run.json (rig-run/1), check/check.json (rig-parts-check/1) and check/build/ with its run.json
                 (rigc-run/1). --config must be the config the run names by sha256. --by defaults to agent.`;

const CHECK_DIR = 'check';
const BUILD_DIR = `${CHECK_DIR}/build`;
const MODEL_FILE = `${BUILD_DIR}/skeleton.model.json`;
const REBUILD_NOTE = 'The rig check and idle render arguments are not recorded: no producer report records its arguments yet.';

const usage = (why: string): never => refuse('RECORD_USAGE', `record: ${why}; ${RECORD_HELP.split('\n')[1]!.trim()}`, USAGE_EXIT);

/** A path named on the command line as a project-relative literal path inside the project, with no symlink on the way. */
function projectPath(dir: string, arg: string, flag: string, code: string): string {
  const rel = relative(dir, resolve(dir, arg)).split(sep).join('/');
  if (!rel || isAbsolute(rel) || rel.split('/').some(part => part === '..' || part === '' || part === '.')) {
    refuse(code, `record rig ${flag} ${arg}: name a path inside the project`);
  }
  return rel;
}

function runAt(dir: string, from: string, rel: string, spec: 'rig-run/1' | 'rigc-run/1', files: Map<string, string>): JsonObject {
  const path = `${from}/${rel}`;
  let bytes: Buffer;
  try { bytes = readFileSync(literalFile(dir, path)); }
  catch { return refuse('RECORD_RUN_INVALID', `${path}: the producer run record is missing; re-run the producer into ${from} so it writes ${rel}`); }
  let record: JsonObject;
  try {
    const validated = validateRunRecord(bytes, path);
    if (validated.spec !== spec) throw new RunRecordError('RUN_RECORD_SPEC_UNKNOWN', `${path}.spec`, `expected ${spec}`);
    record = validated.record;
  } catch (error) {
    const why = error instanceof RunRecordError ? `${error.code} ${error.path}: ${error.why}` : String(error);
    return refuse('RECORD_RUN_INVALID', `${path}: ${why}; re-run the producer into ${from} and record again`);
  }
  if (spec === 'rig-run/1' && record.command !== 'rig') refuse('RECORD_RUN_INVALID', `${path}.command: expected rig, got ${JSON.stringify(record.command)}`);
  const base = posix.dirname(rel);
  for (const out of record.outputs as JsonObject[]) {
    const inside = posix.normalize(posix.join(base, String(out.path)));
    if (files.get(`${outputRoot('rig')}/${inside}`) !== out.sha256) {
      refuse('RECORD_RUN_INVALID', `${path}: output ${String(out.path)} is missing from ${from} or differs from the run's sha256; re-run the producer into ${from} and record again`);
    }
  }
  return record;
}

export function recordCommand(args: string[], now: number): CommandResult {
  const [kind, ...rest] = args;
  if (kind !== 'rig') usage(`${JSON.stringify(kind ?? null)} is not a kind this release records; it records rig`);
  const positional: string[] = [];
  const options: Record<string, string> = {};
  let json = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === '--json' && !json) json = true;
    else if (['--from', '--config', '--by'].includes(arg) && options[arg] === undefined) {
      const value = rest[++i];
      if (value === undefined || value.startsWith('--') || !value.trim()) usage(`${arg} needs one value`);
      options[arg] = value!;
    } else if (arg.startsWith('-')) usage(`unexpected or repeated option ${arg}`);
    else positional.push(arg);
  }
  if (positional.length > 1 || !options['--from'] || !options['--config']) usage('pass --from and --config, and at most one project folder');
  const dir = resolve(positional[0] ?? process.cwd());
  const root = outputRoot('rig');
  const from = projectPath(dir, options['--from']!, '--from', 'RECORD_FROM_INVALID');
  const config = projectPath(dir, options['--config']!, '--config', 'RECORD_CONFIG_MISMATCH');
  if (from !== root && (from.startsWith(`${root}/`) || root.startsWith(`${from}/`))) {
    refuse('RECORD_FROM_INVALID', `record rig --from ${from}: name a folder beside ${root}/, normally ${root}.next, or ${root} itself`);
  }
  if (config === from || config.startsWith(`${from}/`) || config.startsWith(`${root}/`)) {
    refuse('RECORD_CONFIG_MISMATCH', `record rig --config ${config}: the config is a source, not part of the output; keep it under specs/rig/`);
  }
  const { file } = readProject(dir);
  const lock = `${file}.record.lock`;
  let descriptor: number;
  try { descriptor = openSync(lock, 'wx'); } catch { return refuse('RECORD_BUSY', `${lock}: another record writer holds the project lock; let it finish and retry`); }
  let release = () => {};
  try {
    release = acquireBoundJobWrite(dir, { kind: 'record-only' });
    const original = readFileSync(file);
    const project = JSON.parse(original.toString('utf8')) as JsonObject;
    if (project.schema !== PROJECT_SCHEMA) refuse('SCHEMA_UNKNOWN', `project.json.schema: record rig reads ${PROJECT_SCHEMA}`);

    // The producer's tree, read in place: every regular file, recorded at its path after the rename.
    let fromIsDir = false;
    try { fromIsDir = realpathSync(join(dir, from)) === join(realpathSync(dir), from) && lstatSync(join(dir, from)).isDirectory(); } catch { fromIsDir = false; }
    if (!fromIsDir) refuse('RECORD_FROM_INVALID', `record rig --from ${from}: expected a real folder inside the project, with no symlink on the way`);
    let files: { path: string; sha256: string; bytes: number }[];
    try { files = treeFiles(dir, from, root); }
    catch (error) { return refuse('RECORD_FROM_INVALID', `record rig --from ${from}: ${error instanceof Error ? error.message : String(error)}; keep only regular files in the producer output`); }
    const byPath = new Map(files.map(f => [f.path, f.sha256]));

    const run = runAt(dir, from, RUN_RECORD_NAME, 'rig-run/1', byPath);
    const build = runAt(dir, from, `${BUILD_DIR}/${RUN_RECORD_NAME}`, 'rigc-run/1', byPath);

    let configBytes: Buffer;
    try { configBytes = readFileSync(literalFile(dir, config)); }
    catch { return refuse('RECORD_CONFIG_MISMATCH', `record rig --config ${config}: expected a regular file inside the project`); }
    const configRun = run.config as JsonObject;
    if (sha256(configBytes) !== configRun.sha256) {
      refuse('RECORD_CONFIG_MISMATCH', `record rig --config ${config}: its sha256 ${sha256(configBytes)} differs from the config ${String(configRun.sha256)} that ${from}/${RUN_RECORD_NAME} names; pass the config the rig was built from`);
    }
    const builtFrom: { path: string; sha256: string }[] = [{ path: config, sha256: sha256(configBytes) }];
    for (const input of build.inputs as JsonObject[]) {
      const resolved = posix.normalize(posix.join(from, BUILD_DIR, String(input.path)));
      if (resolved === from || resolved.startsWith(`${from}/`)) continue; // the build's own rig and motion: this output's files, checked above by the run's inventory
      const where = `${from}/${BUILD_DIR}/${RUN_RECORD_NAME} input ${String(input.role)} ${String(input.path)}`;
      if (resolved.startsWith('..') || posix.isAbsolute(resolved)) refuse('RECORD_INPUT_CHANGED', `${where}: resolves outside the project; build from inputs inside the project`);
      if (!builtFromNameAllowed(resolved)) refuse('RECORD_BUILT_FROM_INVALID', `${where}: a run record is provenance and never a built_from input; name the product file the build read`);
      let bytes: Buffer | undefined;
      try { bytes = readFileSync(literalFile(dir, resolved)); } catch { bytes = undefined; }
      if (bytes === undefined || sha256(bytes) !== input.sha256) refuse('RECORD_INPUT_CHANGED', `${where}: ${resolved} is missing or now differs from the sha256 the build read; rebuild from the current input and record again`);
      if (!builtFrom.some(entry => entry.path === resolved)) builtFrom.push({ path: resolved, sha256: String(input.sha256) });
    }

    const reportPath = `${from}/${CHECK_DIR}/${RIG_CHECK_REPORT_FILE}`;
    let report: JsonObject;
    try { report = parseRigCheckReport(readFileSync(literalFile(dir, reportPath))); }
    catch (error) { return refuse('RECORD_REPORT_INVALID', `${reportPath}: ${error instanceof Error ? error.message : String(error)}; run rig-parts check with --out ${from}/${CHECK_DIR} and record again`); }
    const model = byPath.get(`${root}/${MODEL_FILE}`);
    if (report.spec !== 'rig-parts-check/1' || !isObject(report.build) || report.build.model_sha256 !== model || model === undefined) {
      refuse('RECORD_REPORT_INVALID', `${reportPath}: expected a rig-parts-check/1 report whose build.model_sha256 equals ${from}/${MODEL_FILE}; run rig-parts check on this build and record again`);
    }

    const pkgs = [run.package, build.package] as JsonObject[];
    const node: JsonObject = {
      at: new Date(now).toISOString(),
      built_by: options['--by'] ?? 'agent',
      built_with: Object.fromEntries(pkgs.map(pkg => [String(pkg.name), String(pkg.version)])),
      files,
      files_sha256: outputSetHash(files),
      built_from: builtFrom.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
      run: { path: `${root}/${RUN_RECORD_NAME}`, sha256: byPath.get(`${root}/${RUN_RECORD_NAME}`)! },
      report: { path: `${root}/${CHECK_DIR}/${RIG_CHECK_REPORT_FILE}`, sha256: byPath.get(`${root}/${CHECK_DIR}/${RIG_CHECK_REPORT_FILE}`)! },
      rebuild: { recorded: false, note: REBUILD_NOTE },
    };
    const shape = currentShapeFindings('rig', node)[0];
    if (shape) refuse(shape.code, shape.message);
    const current = isObject(project.current) ? project.current : {};
    const candidate: JsonObject = { ...project, current: { ...current, rig: node } };
    const baseline = baselineOf(checkProject(dir, undefined, { now }));
    const [fresh, ...more] = newFindings(baseline, checkProject(dir, candidate, { now }).refusals);
    if (fresh) refuse(fresh.code, [fresh.message, ...more.map(f => `${f.code}: ${f.message}`)].join('\n  '));

    // Install by rename (never copy): old tree aside, new tree in place, record, then delete the old tree.
    if (from !== root && existsSync(join(dir, root)) && !lstatSync(join(dir, root)).isDirectory()) {
      refuse('RECORD_DESTINATION_INVALID', `${root}: expected a folder or nothing; move the file away and record again`);
    }
    const aside = `${root}.old-${process.pid}-${randomUUID()}`;
    let movedOld = false;
    let movedNew = false;
    let recorded = false;
    try {
      if (from !== root) {
        mkdirSync(join(dir, posix.dirname(root)), { recursive: true });
        if (existsSync(join(dir, root))) { renameSync(join(dir, root), join(dir, aside)); movedOld = true; }
        renameSync(join(dir, from), join(dir, root));
        movedNew = true;
      }
      if (!isDeepStrictEqual(treeFiles(dir, root), files)) refuse('RECORD_SOURCE_CHANGED', `${from}: changed while record rig was validating; let the producer finish and record again`);
      writeRecord(file, original, candidate, 'record-rig', 'RECORD_SOURCE_CHANGED');
      recorded = true;
    } finally {
      if (!recorded) {
        if (movedNew) renameSync(join(dir, root), join(dir, from));
        if (movedOld) renameSync(join(dir, aside), join(dir, root));
      }
    }
    if (movedOld) rmSync(join(dir, aside), { recursive: true, force: true });
    const bytes = files.reduce((total, f) => total + f.bytes, 0);
    return { stdout: json ? JSON.stringify(node, null, 2)
      : `record rig: ${root} recorded (${files.length} files, ${bytes} bytes); built from ${builtFrom.map(b => b.path).join(', ')}`, exit: 0 };
  } catch (error) {
    if (error instanceof Refusal) throw error;
    return refuse('RECORD_WRITE_FAILED', `record rig: ${error instanceof Error ? error.message : String(error)}; the record and ${root} were left as they were`);
  } finally {
    closeSync(descriptor);
    rmSync(lock, { force: true });
    release();
  }
}
