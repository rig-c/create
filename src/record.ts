/**
 * `record <kind>`: write `current.<kind>` and install the producer's output by rename (docs/CURRENT-DATA.md §1.3).
 * create reads the producer's run records and check report and never re-derives them (AGENTS.md invariant 1).
 * Every refusal comes before the first rename, so a refused write leaves project.json and outputs/<kind>/ byte-identical.
 */
import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, renameSync, rmSync } from 'node:fs';
import { isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { existsSync, lstatSync, readFileSync, realpathSync } from './check-reads.ts';
import { checkProject, isObject, PROJECT_SCHEMA } from './check.ts';
import { literalFile } from './choices.ts';
import { readDirectionOutput } from './current-direction.ts';
import { builtFromNameAllowed, CURRENT_KINDS, CURRENT_RIG_MODEL, currentFileBinding, currentFindings, currentHash, currentShapeFindings, isRunRecordFile, outputRoot, outputSetHash, RUN_RECORD_NAME, sha256, treeFiles, type CurrentKind, type RebuildRunSpec } from './current.ts';
import { DirectionError } from './direction.ts';
import { readProject } from './feedback.ts';
import { acquireBoundJobWrite } from './job-writer.ts';
import type { CommandResult } from './interview.ts';
import { PARTS_CHECK_FILE, PARTS_CHECK_SPEC, partsCheckFindings, partsCheckRecord } from './parts-check.ts';
import { commitProjectStep } from './project-step-commit.ts';
import { writeRecord } from './record-input.ts';
import { Refusal, refuse, USAGE_EXIT } from './refusal.ts';
import { baselineOf, newFindings } from './refusal-baseline.ts';
import { checkRigReport, parseRigCheckReport, RIG_CHECK_REPORT_FILE } from './rig-check-report.ts';
import { RunRecordError, validateRunRecord, type RunSpec } from './run-record.ts';
import type { JsonObject } from './templates.ts';

export const RECORD_HELP = `record:
  rig-create record parts [<dir>] --from <producer out> --config <rig config> [--by <who>] [--json]
                 record the producer's parts output as current.parts and rename it into outputs/parts/ (the old tree is
                 deleted after). <producer out> must be a folder beside outputs/parts/ (normally outputs/parts.next) or
                 outputs/parts itself, holding the parts assemble output with run.json (rig-run/1) and check/parts-check.json
                 (rig-parts-parts-check/1). --config must be the config the run names by sha256. --by defaults to agent.
  rig-create record rig [<dir>] --from <producer out> --config <rig config> [--by <who>] [--json]
                 record the producer's rig output as current.rig and rename it into outputs/rig/ (the old tree is deleted
                 after). <producer out> must be a folder beside outputs/rig/ (normally outputs/rig.next) or outputs/rig itself,
                 holding the parts rig output with run.json (rig-run/1) or build-run.json (rig-run/2), check/check.json
                 (rig-parts-check/1), check/build/ with its run.json (rigc-run/1), and optional check/check-run.json (rig-run/2)
                 and render-run.json (rigc-run/2). --config must be the config the run names by sha256. --by defaults to agent.
  rig-create record motion [<dir>] --from <render out> [--by <who>] [--json]
                 record rigc frames.json and its render tree beside outputs/motion/, with render-run.json when present.
  rig-create record direction [<dir>] --from <compose out> --direction specs/direction/direction.json [--by <who>] [--json]
                 record green rig-parts compose output beside outputs/direction/, with compose-run.json and check/check.json.`;

type RecordableKind = CurrentKind;
type FileHash = { path: string; sha256: string };

const CHECK_DIR = 'check';
const CHECK_RUN_FILE = `${CHECK_DIR}/check-run.json`;
const BUILD_RUN_FILE = 'build-run.json';
const RENDER_RUN_FILE = 'render-run.json';
const BUILD_DIR = `${CHECK_DIR}/build`;
const MODEL_FILE = `${BUILD_DIR}/skeleton.model.json`;
const REBUILD_NOTE = 'The rig check and idle render arguments are not recorded: no producer report records its arguments yet.';
const MOTION_REBUILD_NOTE = 'The render has no render-run.json recording the rigc render arguments or input hashes.';
const UNRECORDED_RENDER_NOTE = 'An output outside the rig and check directories has no render-run.json recording its arguments.';

const usage = (why: string, kind: RecordableKind = 'rig'): never => refuse(
  'RECORD_USAGE',
  `record: ${why}; rig-create record ${kind} [<dir>] --from <producer out>${kind === 'motion' ? '' : kind === 'direction' ? ' --direction specs/direction/direction.json' : ' --config <rig config>'} [--by <who>] [--json]`,
  USAGE_EXIT,
);

/** A path named on the command line as a project-relative literal path inside the project, with no symlink on the way. */
function projectPath(dir: string, arg: string, flag: string, code: string, kind: RecordableKind): string {
  const rel = relative(dir, resolve(dir, arg)).split(sep).join('/');
  if (!rel || isAbsolute(rel) || rel.split('/').some(part => part === '..' || part === '' || part === '.')) {
    refuse(code, `record ${kind} ${flag} ${arg}: name a path inside the project`);
  }
  return rel;
}

function runAt(
  dir: string,
  from: string,
  rel: string,
  spec: RunSpec,
  command: string,
  files: Map<string, string>,
  kind: RecordableKind,
): { record: JsonObject; outputs: Set<string> } {
  const path = `${from}/${rel}`;
  let bytes: Buffer;
  try { bytes = readFileSync(literalFile(dir, path)); }
  catch { return refuse('RECORD_RUN_INVALID', `${path}: the producer run record is missing; re-run the producer into ${from} so it writes ${rel}`); }
  let record: JsonObject;
  try {
    const validated = validateRunRecord(bytes, path, { allowAssembleInputs: command === 'assemble' });
    if (validated.spec !== spec) throw new RunRecordError('RUN_RECORD_SPEC_UNKNOWN', `${path}.spec`, `expected ${spec}`);
    record = validated.record;
  } catch (error) {
    const why = error instanceof RunRecordError ? `${error.code} ${error.path}: ${error.why}` : String(error);
    return refuse('RECORD_RUN_INVALID', `${path}: ${why}; re-run the producer into ${from} and record again`);
  }
  if (record.command !== command) refuse('RECORD_RUN_INVALID', `${path}.command: expected ${command}, got ${JSON.stringify(record.command)}`);
  if (command === 'assemble' && !Array.isArray(record.inputs)) {
    refuse('RECORD_RUN_INVALID', `${path}.inputs: expected source, full and optional head inputs; re-run rig-parts assemble into ${from} and record again`);
  }
  const base = posix.dirname(rel);
  const outputs = new Set<string>();
  for (const out of record.outputs as JsonObject[]) {
    const inside = posix.normalize(posix.join(base, String(out.path)));
    const target = `${outputRoot(kind)}/${inside}`;
    if (files.get(target) !== out.sha256) {
      refuse('RECORD_RUN_INVALID', `${path}: output ${String(out.path)} is missing from ${from} or differs from the run's sha256; re-run the producer into ${from} and record again`);
    }
    outputs.add(target);
  }
  return { record, outputs };
}

function bindRunInputs(
  dir: string,
  from: string,
  root: string,
  rel: string,
  inputs: JsonObject[],
  byPath: Map<string, string>,
  builtFrom: { path: string; sha256: string }[],
  staleRemedy: string,
): void {
  const base = posix.dirname(rel);
  for (const input of inputs) {
    const resolved = posix.normalize(posix.join(from, base, String(input.path)));
    const where = `${from}/${rel} input ${String(input.role)} ${String(input.path)}`;
    if (resolved === from || resolved.startsWith(`${from}/`)) {
      // Inputs inside the producer folder must match the files on disk, or the folder mixes an earlier and later run.
      if (byPath.get(`${root}${resolved.slice(from.length)}`) !== input.sha256) {
        refuse('RECORD_INPUT_CHANGED', `${where}: ${resolved} is missing or now differs from the sha256 the run read, so the folder mixes runs; ${staleRemedy}`);
      }
      continue;
    }
    if (resolved.startsWith('..') || posix.isAbsolute(resolved)) refuse('RECORD_INPUT_CHANGED', `${where}: resolves outside the project; build from inputs inside the project`);
    if (!builtFromNameAllowed(resolved)) refuse('RECORD_BUILT_FROM_INVALID', `${where}: a run record is provenance and never a built_from input; name the product file the build read`);
    let bytes: Buffer | undefined;
    try { bytes = readFileSync(literalFile(dir, resolved)); } catch { bytes = undefined; }
    if (bytes === undefined || sha256(bytes) !== input.sha256) refuse('RECORD_INPUT_CHANGED', `${where}: ${resolved} is missing or now differs from the sha256 the run read; rebuild from the current input and record again`);
    if (!builtFrom.some(entry => entry.path === resolved)) builtFrom.push({ path: resolved, sha256: String(input.sha256) });
  }
}

function recordPartsInputs(
  dir: string,
  from: string,
  root: string,
  run: JsonObject,
  builtFrom: { path: string; sha256: string }[],
): void {
  const insideProject = (path: string): boolean =>
    Boolean(path) && path !== '.' && !path.startsWith('..') && !posix.isAbsolute(path)
    && path.split('/').every(part => part !== '' && part !== '.' && part !== '..');

  const matchesHash = (candidate: string, expectedSha256: string): boolean => {
    if (!insideProject(candidate)) return false;
    try { return sha256(readFileSync(literalFile(dir, candidate))) === expectedSha256; }
    catch { return false; }
  };

  const policyRefusal = (candidate: string, where: string): { code: string; message: string } | undefined => {
    if (candidate === from || candidate.startsWith(`${from}/`) || candidate === root || candidate.startsWith(`${root}/`)) {
      return { code: 'RECORD_BUILT_FROM_INVALID', message: `${where}: ${candidate} lies inside the parts output; keep assemble inputs outside ${root}/ and record again` };
    }
    if (!builtFromNameAllowed(candidate)) {
      return { code: 'RECORD_BUILT_FROM_INVALID', message: `${where}: a run record is provenance and never a built_from input; name the product file assemble read` };
    }
    return undefined;
  };

  for (const input of run.inputs as JsonObject[]) {
    const rawInput = String(input.path);
    const expectedSha256 = String(input.sha256);
    const where = `${from}/${RUN_RECORD_NAME} input ${String(input.role)} ${rawInput}`;
    // New convention (parts#1555): path is relative to --out and already names <dir>/layers.json for a See-through directory.
    const fromCandidate = posix.normalize(posix.join(from, rawInput));
    // Old convention (Parts <= 2.56.0): path is relative to cwd, naming <dir> with the sha256 of <dir>/layers.json.
    const rawRoot = posix.normalize(rawInput);
    let rootIsDir = false;
    if (rawRoot === '.') rootIsDir = true;
    else if (insideProject(rawRoot)) {
      try { rootIsDir = realpathSync(join(dir, rawRoot)) === join(realpathSync(dir), rawRoot) && lstatSync(join(dir, rawRoot)).isDirectory(); }
      catch { rootIsDir = false; }
    }
    const rootCandidate = (input.role === 'full' || input.role === 'head') && rootIsDir
      ? (rawRoot === '.' ? 'layers.json' : `${rawRoot}/layers.json`)
      : rawRoot;

    const candidates = fromCandidate === rootCandidate ? [fromCandidate] : [fromCandidate, rootCandidate];
    // The first candidate whose bytes match is the file assemble read; its policy refusal stands, with no fallback.
    const candidate = candidates.find(c => matchesHash(c, expectedSha256));
    if (candidate !== undefined) {
      const problem = policyRefusal(candidate, where);
      if (problem) refuse(problem.code, problem.message);
      if (!builtFrom.some(entry => entry.path === candidate)) builtFrom.push({ path: candidate, sha256: expectedSha256 });
    } else {
      refuse(
        'RECORD_INPUT_CHANGED',
        `${where}: neither ${fromCandidate} (from ${from}) nor ${rootCandidate} (from project root) matches the sha256 assemble read; run rig-parts assemble from the project root on inputs inside the project and record again`,
      );
    }
  }
}

interface RecordDetails {
  built_with: JsonObject;
  built_from: FileHash[];
  run?: JsonObject;
  report?: JsonObject;
  rebuild?: JsonObject;
}

function recordPartsOrRig(
  dir: string, kind: 'parts' | 'rig', from: string, config: string, at: string,
  files: FileHash[], byPath: Map<string, string>,
): RecordDetails {
  const root = outputRoot(kind);
  let hasBuildRun = false;
  let primaryRunRel = RUN_RECORD_NAME;
  let primaryRun: { record: JsonObject; outputs: Set<string> };
  let build: JsonObject | undefined;
  let checkRun: JsonObject | undefined;
  if (kind === 'parts') {
    primaryRun = runAt(dir, from, RUN_RECORD_NAME, 'rig-run/1', 'assemble', byPath, kind);
  } else {
    const hasRigRun = byPath.has(`${root}/${RUN_RECORD_NAME}`);
    hasBuildRun = byPath.has(`${root}/${BUILD_RUN_FILE}`);
    if (hasRigRun && hasBuildRun) {
      refuse('RECORD_RUN_INVALID', `${from}: holds both ${RUN_RECORD_NAME} and ${BUILD_RUN_FILE}; build into a clean folder and record again`);
    }
    primaryRunRel = hasBuildRun ? BUILD_RUN_FILE : RUN_RECORD_NAME;
    primaryRun = hasBuildRun
      ? runAt(dir, from, BUILD_RUN_FILE, 'rig-run/2', 'build', byPath, kind)
      : runAt(dir, from, RUN_RECORD_NAME, 'rig-run/1', 'rig', byPath, kind);
    build = runAt(dir, from, `${BUILD_DIR}/${RUN_RECORD_NAME}`, 'rigc-run/1', 'build', byPath, kind).record;

    if (byPath.has(`${root}/${CHECK_RUN_FILE}`)) {
      if (hasBuildRun) {
        refuse('RECORD_RUN_INVALID', `${from}: holds both ${BUILD_RUN_FILE} and ${CHECK_RUN_FILE}; run either rig-parts build or rig-parts rig + check into a clean folder and record again`);
      }
      checkRun = runAt(dir, from, CHECK_RUN_FILE, 'rig-run/2', 'check', byPath, kind).record;
    }
  }
  const run = primaryRun.record;

  let configBytes: Buffer;
  try { configBytes = readFileSync(literalFile(dir, config)); }
  catch { return refuse('RECORD_CONFIG_MISMATCH', `record ${kind} --config ${config}: expected a regular file inside the project`); }
  const configRun = run.config as JsonObject;
  if (sha256(configBytes) !== configRun.sha256) {
    refuse('RECORD_CONFIG_MISMATCH', `record ${kind} --config ${config}: its sha256 ${sha256(configBytes)} differs from the config ${String(configRun.sha256)} that ${from}/${primaryRunRel} names; pass the config the ${kind === 'parts' ? 'parts were assembled' : 'rig was built'} from`);
  }
  if (!builtFromNameAllowed(config)) {
    refuse('RECORD_BUILT_FROM_INVALID', `record ${kind} --config ${config}: a run record is provenance and never a built_from input; name the config file`);
  }
  const builtFrom: { path: string; sha256: string }[] = [{ path: config, sha256: sha256(configBytes) }];
  const renderRuns: { rel: string; record: JsonObject; outputs: Set<string> }[] = [];
  if (build) {
    bindRunInputs(dir, from, root, `${BUILD_DIR}/${RUN_RECORD_NAME}`, build.inputs as JsonObject[], byPath, builtFrom,
      `rebuild with rigc and run rig-parts check into ${from}, then record again`);
    // rig-parts build stamps nothing outside check/ but build-run.json (its rig stage writes no rig/run.json), so any other record mixes runs.
    for (const entry of files) {
      const rel = entry.path.slice(`${root}/`.length);
      if (rel === primaryRunRel || rel === `${CHECK_DIR}` || rel.startsWith(`${CHECK_DIR}/`) || !isRunRecordFile(rel)) continue;
      if (posix.basename(rel) !== RENDER_RUN_FILE) {
        refuse('RECORD_RUN_INVALID', `${from}/${rel}: unexpected run record outside ${CHECK_DIR}/; expected ${RENDER_RUN_FILE} (rigc-run/2)`);
      }
      const validatedRender = runAt(dir, from, rel, 'rigc-run/2', 'render', byPath, kind);
      bindRunInputs(dir, from, root, rel, validatedRender.record.inputs as JsonObject[], byPath, builtFrom,
        `re-render into ${from}/${posix.dirname(rel)} from the current build and record again`);
      renderRuns.push({ rel, record: validatedRender.record, outputs: validatedRender.outputs });
    }
  }

  let reportRel: string;

  if (kind === 'parts') {
    recordPartsInputs(dir, from, root, run, builtFrom);
    reportRel = `${CHECK_DIR}/${PARTS_CHECK_FILE}`;
    const reportPath = `${from}/${reportRel}`;
    let reportBytes: Buffer;
    try { reportBytes = readFileSync(literalFile(dir, reportPath)); }
    catch (error) { return refuse('RECORD_REPORT_INVALID', `${reportPath}: ${error instanceof Error ? error.message : String(error)}; run rig-parts check-parts --parts ${from}/rig --out ${from}/${CHECK_DIR} and record again`); }
    const checked = partsCheckRecord(dir, reportPath, `${from}/rig`, reportPath, () => reportBytes);
    if ('refusal' in checked || checked.record.spec !== PARTS_CHECK_SPEC) {
      refuse('RECORD_REPORT_INVALID', `${reportPath}: expected a ${PARTS_CHECK_SPEC} report; run rig-parts check-parts --parts ${from}/rig --out ${from}/${CHECK_DIR} and record again`);
    }
    const outcome = partsCheckFindings(dir, checked.record, reportPath, true, () => reportBytes)[0];
    if (outcome) refuse(outcome.code, `${outcome.message}; record parts records a green check only`);
  } else {
    reportRel = `${CHECK_DIR}/${RIG_CHECK_REPORT_FILE}`;
    const reportPath = `${from}/${reportRel}`;
    let report: JsonObject;
    let reportBytes: Buffer;
    try { reportBytes = readFileSync(literalFile(dir, reportPath)); report = parseRigCheckReport(reportBytes); }
    catch (error) { return refuse('RECORD_REPORT_INVALID', `${reportPath}: ${error instanceof Error ? error.message : String(error)}; run rig-parts check with --out ${from}/${CHECK_DIR} and record again`); }
    const model = byPath.get(`${root}/${MODEL_FILE}`);
    if (report.spec !== 'rig-parts-check/1' || !isObject(report.build) || report.build.model_sha256 !== model || model === undefined) {
      refuse('RECORD_REPORT_INVALID', `${reportPath}: expected a rig-parts-check/1 report whose build.model_sha256 equals ${from}/${MODEL_FILE}; run rig-parts check on this build and record again`);
    }

    // The report's outcomes go through the registration reader as they are: a failed bar, unmet line or failed source
    // exposure refuses by that reader's code. record rig takes no owner acceptance, so none is passed.
    const outcome = checkRigReport({ at, check_report: { path: reportPath, spec: report.spec ?? null } }, `${reportPath}`, reportPath, model,
      () => reportBytes, [])[0];
    if (outcome) refuse(outcome.code, `${outcome.message}; record rig records a green check only`);
  }

  const allRuns = [run, ...(build ? [build] : []), ...(checkRun ? [checkRun] : []), ...renderRuns.map(r => r.record)];
  const builtWith = new Map<string, string>();
  for (const r of allRuns) {
    const pkg = r.package as JsonObject;
    const name = String(pkg.name);
    const version = String(pkg.version);
    const prior = builtWith.get(name);
    if (prior !== undefined && prior !== version) {
      refuse('RECORD_RUN_INVALID', `${from}: run records disagree on ${name} version (${prior} vs ${version}); rebuild with one installed toolchain and record again`);
    }
    builtWith.set(name, version);
  }

  const partsArgvEntry = hasBuildRun
    ? { rel: BUILD_RUN_FILE, spec: 'rig-run/2' as RebuildRunSpec, argv: run.argv as string[] }
    : checkRun
      ? { rel: CHECK_RUN_FILE, spec: 'rig-run/2' as RebuildRunSpec, argv: checkRun.argv as string[] }
      : undefined;
  const coveredOutsideCheck = new Set<string>([...primaryRun.outputs]);
  for (const r of renderRuns) for (const outPath of r.outputs) coveredOutsideCheck.add(outPath);
  const hasUnrecordedExtraFiles = files.some(f => {
    if (isRunRecordFile(f.path)) return false;
    const rel = f.path.slice(`${root}/`.length);
    if (rel.startsWith(`${CHECK_DIR}/`)) return false;
    return !coveredOutsideCheck.has(f.path);
  });
  const rebuild: JsonObject | undefined = kind === 'parts' ? undefined : partsArgvEntry && !hasUnrecordedExtraFiles
    ? {
        recorded: true,
        runs: [
          partsArgvEntry,
          ...renderRuns.map(r => ({ rel: r.rel, spec: 'rigc-run/2' as RebuildRunSpec, argv: r.record.argv as string[] })),
        ]
          .map(entry => ({
            path: `${root}/${entry.rel}`,
            sha256: byPath.get(`${root}/${entry.rel}`)!,
            spec: entry.spec,
            argv: entry.argv,
          }))
          .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
      }
    : {
        recorded: false,
        note: partsArgvEntry ? UNRECORDED_RENDER_NOTE : REBUILD_NOTE,
      };

  return {
    built_with: Object.fromEntries(builtWith),
    built_from: builtFrom,
    run: { path: `${root}/${primaryRunRel}`, sha256: byPath.get(`${root}/${primaryRunRel}`)! },
    report: { path: `${root}/${reportRel}`, sha256: byPath.get(`${root}/${reportRel}`)! },
    ...(rebuild ? { rebuild } : {}),
  };
}

function recordMotion(dir: string, project: JsonObject, from: string, byPath: Map<string, string>): RecordDetails {
  const root = outputRoot('motion');
  const model = currentFileBinding(project, 'rig', CURRENT_RIG_MODEL);
  if (!model) refuse('RECORD_MOTION_RIG_INVALID', 'current.rig.files: record the rig with its compiled model before recording motion');
  let modelBytes: Buffer;
  try { modelBytes = readFileSync(literalFile(dir, model.path)); }
  catch { return refuse('RECORD_MOTION_RIG_INVALID', `${model.path}: restore the compiled model or record the rig again before rendering`); }
  if (sha256(modelBytes) !== model.sha256) {
    refuse('RECORD_MOTION_RIG_INVALID', `${model.path}: differs from current.rig; restore the bound model or record the rig again, then re-render`);
  }

  const framesPath = `${from}/frames.json`;
  let frames: JsonObject;
  try { frames = JSON.parse(readFileSync(literalFile(dir, framesPath)).toString('utf8')) as JsonObject; }
  catch { return refuse('RECORD_MOTION_FRAMES_INVALID', `${framesPath}: expected rigc's frames.json; render into ${from} and record again`); }
  if (!isObject(frames) || frames.spec !== 'rigc-frames/1' || !Array.isArray(frames.sets) || !frames.sets.length) {
    refuse('RECORD_MOTION_FRAMES_INVALID', `${framesPath}: expected rigc-frames/1 with at least one frame set; render into ${from} and record again`);
  }
  const runPath = `${root}/${RENDER_RUN_FILE}`;
  const runHash = byPath.get(runPath);
  const builtFrom: FileHash[] = [model];
  if (runHash === undefined) return { built_with: {}, built_from: builtFrom, rebuild: { recorded: false, note: MOTION_REBUILD_NOTE } };

  const rendered = runAt(dir, from, RENDER_RUN_FILE, 'rigc-run/2', 'render', byPath, 'motion');
  if (!rendered.outputs.has(`${root}/frames.json`)) {
    refuse('RECORD_MOTION_FRAMES_INVALID', `${framesPath}: is not covered by ${from}/${RENDER_RUN_FILE}; re-render into a clean ${from} and record again`);
  }
  const inputs = rendered.record.inputs as JsonObject[];
  const skeleton = inputs.find(input => input.role === 'skeleton')!;
  const expectedSkeleton = `${outputRoot('rig')}/${BUILD_DIR}/skeleton.json`;
  const binding = currentFileBinding(project, 'rig', expectedSkeleton);
  if (!binding || posix.normalize(posix.join(from, String(skeleton.path))) !== binding.path || skeleton.sha256 !== binding.sha256) {
    refuse('RECORD_MOTION_RIG_INVALID', `${from}/${RENDER_RUN_FILE}.inputs: render the skeleton bound in current.rig at ${expectedSkeleton} and record again`);
  }
  for (const input of inputs.filter(input => input.role === 'atlas' || input.role === 'model')) {
    const expectedPath = input.role === 'model' ? model.path : `${outputRoot('rig')}/${BUILD_DIR}/skeleton.atlas`;
    const expected = currentFileBinding(project, 'rig', expectedPath);
    if (!expected || posix.normalize(posix.join(from, String(input.path))) !== expected.path || input.sha256 !== expected.sha256) {
      refuse('RECORD_MOTION_RIG_INVALID', `${from}/${RENDER_RUN_FILE}.inputs: use the ${String(input.role)} bound in current.rig at ${expectedPath} and record again`);
    }
  }
  bindRunInputs(dir, from, root, RENDER_RUN_FILE, inputs, byPath, builtFrom, `re-render into a clean ${from} and record again`);
  const pkg = rendered.record.package as JsonObject;
  const run = { path: runPath, sha256: runHash };
  return {
    built_with: { [String(pkg.name)]: pkg.version! },
    built_from: builtFrom,
    run,
    rebuild: { recorded: true, runs: [{ ...run, spec: 'rigc-run/2', argv: rendered.record.argv! }] },
  };
}

export function recordCommand(args: string[], now: number): CommandResult {
  const [rawKind, ...rest] = args;
  if (!(CURRENT_KINDS as readonly string[]).includes(rawKind ?? '')) return usage(`${JSON.stringify(rawKind ?? null)} is not a kind this release records; choose ${CURRENT_KINDS.join(', ')}`);
  const kind = rawKind as RecordableKind;
  const sourceFlag = kind === 'direction' ? '--direction' : kind === 'motion' ? undefined : '--config';
  const positional: string[] = [];
  const options: Record<string, string> = {};
  let json = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === '--json' && !json) json = true;
    else if (['--from', '--by', sourceFlag].includes(arg) && options[arg] === undefined) {
      const value = rest[++i];
      if (value === undefined || value.startsWith('--') || !value.trim()) usage(`${arg} needs one value`, kind);
      options[arg] = value!;
    } else if (arg.startsWith('-')) usage(`unexpected or repeated option ${arg}`, kind);
    else positional.push(arg);
  }
  if (positional.length > 1 || !options['--from'] || (sourceFlag && !options[sourceFlag])) {
    usage(`pass --from${sourceFlag ? ` and ${sourceFlag}` : ''}, and at most one project folder`, kind);
  }
  const dir = resolve(positional[0] ?? process.cwd());
  const root = outputRoot(kind);
  const from = projectPath(dir, options['--from']!, '--from', 'RECORD_FROM_INVALID', kind);
  const config = sourceFlag === '--config'
    ? projectPath(dir, options[sourceFlag]!, sourceFlag, 'RECORD_CONFIG_MISMATCH', kind)
    : undefined;
  if (posix.dirname(from) !== posix.dirname(root) || (from !== root && CURRENT_KINDS.some(other => from === outputRoot(other)))) {
    refuse('RECORD_FROM_INVALID', `record ${kind} --from ${from}: name a folder beside ${root}/, normally ${root}.next, or ${root} itself`);
  }
  if (config && (config === from || config.startsWith(`${from}/`) || config.startsWith(`${root}/`))) {
    refuse('RECORD_CONFIG_MISMATCH', `record ${kind} --config ${config}: the config is a source, not part of the output; keep it under specs/rig/`);
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
    if (project.schema !== PROJECT_SCHEMA) refuse('SCHEMA_UNKNOWN', `project.json.schema: record ${kind} reads ${PROJECT_SCHEMA}`);

    // The producer's tree, read in place: every regular file, recorded at its path after the rename.
    let fromIsDir = false;
    try { fromIsDir = realpathSync(join(dir, from)) === join(realpathSync(dir), from) && lstatSync(join(dir, from)).isDirectory(); } catch { fromIsDir = false; }
    if (!fromIsDir) refuse('RECORD_FROM_INVALID', `record ${kind} --from ${from}: expected a real folder inside the project, with no symlink on the way`);
    let files: { path: string; sha256: string; bytes: number }[];
    try { files = treeFiles(dir, from, root); }
    catch (error) { return refuse('RECORD_FROM_INVALID', `record ${kind} --from ${from}: ${error instanceof Error ? error.message : String(error)}; keep only regular files in the producer output`); }
    const byPath = new Map(files.map(f => [f.path, f.sha256]));

    const at = new Date(now).toISOString();
    const snapshots = new Map<string, Buffer>();
    const details: RecordDetails = kind === 'motion'
      ? recordMotion(dir, project, from, byPath)
      : kind === 'direction'
        ? readDirectionOutput(dir, project, from, options['--direction']!, byPath, snapshots)
        : recordPartsOrRig(dir, kind, from, config!, at, files, byPath);
    const node: JsonObject = {
      at,
      built_by: options['--by'] ?? 'agent',
      built_with: details.built_with,
      files,
      files_sha256: outputSetHash(files),
      built_from: details.built_from.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
      ...(details.run ? { run: details.run } : {}),
      ...(details.report ? { report: details.report } : {}),
      ...(details.rebuild ? { rebuild: details.rebuild } : {}),
    };
    const shape = currentShapeFindings(kind, node)[0];
    if (shape) refuse(shape.code, shape.message);
    const current = isObject(project.current) ? project.current : {};
    const candidate: JsonObject = { ...project, current: { ...current, [kind]: node } };
    const baseline = baselineOf(checkProject(dir, undefined, { now }));
    const [fresh, ...more] = newFindings(baseline, checkProject(dir, candidate, { now }).refusals);
    if (fresh) refuse(fresh.code, [fresh.message, ...more.map(f => `${f.code}: ${f.message}`)].join('\n  '));
    if (kind === 'motion' || kind === 'direction') {
      const requireHash = (path: string, expected: string): void => {
        let actual: string | undefined;
        try {
          actual = CURRENT_KINDS.some(kind => outputRoot(kind) === path)
            ? currentHash(dir, path)
            : sha256(readFileSync(literalFile(dir, path)));
        } catch { /* Refuse below. */ }
        if (actual !== expected) refuse('RECORD_SOURCE_CHANGED', `${path}: changed while record ${kind} was validating; restore the source and record again`);
      };
      for (const binding of details.built_from) requireHash(binding.path, binding.sha256);
      for (const [path, bytes] of snapshots) requireHash(path, sha256(bytes));
    }

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
      if (!isDeepStrictEqual(treeFiles(dir, root), files)) refuse('RECORD_SOURCE_CHANGED', `${from}: changed while record ${kind} was validating; let the producer finish and record again`);
      writeRecord(file, original, candidate, `record-${kind}`, 'RECORD_SOURCE_CHANGED');
      recorded = true;
    } finally {
      if (!recorded) {
        if (movedNew) renameSync(join(dir, root), join(dir, from));
        if (movedOld) renameSync(join(dir, aside), join(dir, root));
      }
    }
    if (movedOld) rmSync(join(dir, aside), { recursive: true, force: true });
    let stderr: string | undefined;
    if (kind === 'motion' || kind === 'direction') {
      const warnings: ReturnType<typeof currentFindings> = [];
      currentFindings(dir, candidate, warnings);
      const stale = warnings.filter(f => f.code === 'OUTPUT_STALE').map(f => f.path.slice('current.'.length));
      const writer = ['record', kind, '--from', from, ...(kind === 'direction' ? ['--direction', options['--direction']!] : [])].join(' ');
      stderr = commitProjectStep(dir, kind, writer, 'project.json', root, stale);
    }
    const bytes = files.reduce((total, f) => total + f.bytes, 0);
    return { stdout: json ? JSON.stringify(node, null, 2)
      : `record ${kind}: ${root} recorded (${files.length} files, ${bytes} bytes); built from ${details.built_from.map(b => b.path).join(', ')}`, exit: 0, ...(stderr ? { stderr } : {}) };
  } catch (error) {
    if (error instanceof Refusal) throw error;
    if (error instanceof DirectionError) return refuse(error.code, error.message);
    return refuse('RECORD_WRITE_FAILED', `record ${kind}: ${error instanceof Error ? error.message : String(error)}; the record and ${root} were left as they were`);
  } finally {
    closeSync(descriptor);
    rmSync(lock, { force: true });
    release();
  }
}
