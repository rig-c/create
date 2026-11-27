/** Materialize a Parts build layout from retained, hash-bound adopted files. */
import { closeSync, constants, copyFileSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { isObject } from './check.ts';
import { currentShapeFindings, sha256, treeFiles } from './current.ts';
import type { CommandResult } from './interview.ts';
import { adoptedOutputBindings } from './record-adopt.ts';
import { Refusal, refuse, USAGE_EXIT } from './refusal.ts';
import { readVersions } from './review.ts';
import type { Json, JsonObject } from './templates.ts';

export const ADOPTED_COMPOSE_BUILD = 'derived/direction-adopted-build';
const COPY_RECEIPT = 'adopted-copy.json';
const CHECK_REPORT = 'check/check.json';
const MODEL = 'check/build/skeleton.model.json';
const REQUIRED_FILES = ['parts.json', 'rig/rig.json', 'rig/motion.json', MODEL, CHECK_REPORT];
const CODE = 'ADOPTED_COMPOSE_STAGE_INVALID';

function fail(path: string, why: string): never {
  return refuse(CODE, `${path}: ${why}; restore the retained bindings or preserve the occupied staging tree before running scene stage-adopted again`);
}

function stat(path: string): ReturnType<typeof lstatSync> | undefined {
  try { return lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function copyPlan(project: JsonObject) {
  const rig = isObject(project.current) ? project.current.rig : undefined;
  const version = isObject(rig) && isObject(rig.adopted) ? rig.adopted.version : undefined;
  if (typeof version !== 'number' || currentShapeFindings('rig', rig, project).length > 0
    || !readVersions(project).rigs.some(item => item.n === version && item.live && item.accepted !== null)) {
    fail('current.rig', 'expected a live owner-accepted adopted rig');
  }
  const numbered = adoptedOutputBindings(project, 'rig', version);
  const parts = adoptedOutputBindings(project, 'parts', version);
  if (!numbered.ok) fail(numbered.path, numbered.why);
  if (!parts.ok) fail(parts.path, parts.why);
  const prefix = `outputs/v${version}/out/`;
  const copies = new Map([...numbered.files, ...parts.files]
    .filter(binding => binding.path.startsWith(prefix)).map(binding => [binding.path.slice(prefix.length), binding]));
  if (!copies.has(CHECK_REPORT)) {
    const registration = numbered.source.registration;
    const report = isObject(registration) ? registration.check_report : undefined;
    if (!isObject(report) || report.path !== `evidence/v${version}/registration/check.json`
      || typeof report.sha256 !== 'string') fail('current.rig', 'the numbered registration does not bind the retained check report');
    copies.set(CHECK_REPORT, { path: report.path, sha256: report.sha256 });
  }
  for (const required of REQUIRED_FILES) {
    if (!copies.has(required)) fail('current.rig', `the adopted inventory does not bind ${required}`);
  }
  if (copies.has(COPY_RECEIPT)) fail('current.rig', 'the numbered output collides with the copy receipt');
  const rows = [...copies].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const receipt = `${JSON.stringify({ version, files: rows.map(([path, binding]) => ({ path, source: binding.path, sha256: binding.sha256 })) }, null, 2)}\n`;
  const expected = new Map(rows.map(([path, binding]) => [`${ADOPTED_COMPOSE_BUILD}/${path}`, binding.sha256]));
  expected.set(`${ADOPTED_COMPOSE_BUILD}/${COPY_RECEIPT}`, sha256(receipt));
  return { version, copies, rows, receipt, expected };
}

function treeMatches(dir: string, relative: string, expected: ReadonlyMap<string, string>): boolean {
  const absolute = join(realpathSync(dir), relative);
  if (realpathSync(absolute) !== absolute || !lstatSync(absolute).isDirectory()) return false;
  const files = treeFiles(dir, relative, ADOPTED_COMPOSE_BUILD);
  return files.length === expected.size && files.every(file => expected.get(file.path) === file.sha256);
}

/** The retained tree is usable in place when the report already lives in its Parts layout. */
export function adoptedComposeBuildMatches(dir: string, project: JsonObject, relative = ADOPTED_COMPOSE_BUILD): boolean {
  try {
    const plan = copyPlan(project);
    if (relative === ADOPTED_COMPOSE_BUILD) return treeMatches(dir, relative, plan.expected);
    if (relative !== `outputs/v${plan.version}/out`) return false;
    const root = realpathSync(dir);
    return plan.rows.every(([path, binding]) => {
      const file = join(root, binding.path);
      return binding.path === `${relative}/${path}` && realpathSync(file) === file && lstatSync(file).isFile()
        && sha256(readFileSync(file)) === binding.sha256;
    });
  } catch { return false; }
}

export function stageAdoptedCompose(args: string[]): CommandResult {
  if (args.length > 1 || args[0]?.startsWith('-')) {
    refuse(CODE, 'scene stage-adopted: pass at most one project dir', USAGE_EXIT);
  }
  const dir = realpathSync(resolve(args[0] ?? process.cwd()));
  const lockPath = join(dir, '.direction.lock');
  let lock: number;
  try { lock = openSync(lockPath, 'wx'); }
  catch { return fail('project.json', 'another scene or direction writer holds the lock'); }
  let staging: string | undefined;
  try {
    const projectPath = join(dir, 'project.json');
    if (realpathSync(projectPath) !== projectPath || !lstatSync(projectPath).isFile()) fail('project.json', 'expected a literal record file');
    const original = readFileSync(projectPath);
    const project = JSON.parse(original.toString('utf8')) as Json;
    if (!isObject(project) || project.schema !== 'rig-create/project@0') fail('project.json', 'expected rig-create/project@0');
    const { version, copies, rows, receipt, expected } = copyPlan(project);

    const source = (path: string): string => {
      if (posix.isAbsolute(path) || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..')) {
        fail(path, 'expected a literal project-relative source path');
      }
      const file = join(dir, path);
      if (realpathSync(file) !== file || !lstatSync(file).isFile()) fail(path, 'expected a literal regular source file');
      return file;
    };
    const check = JSON.parse(readFileSync(source(copies.get(CHECK_REPORT)!.path), 'utf8'));
    if (!isObject(check) || check.spec !== 'rig-parts-check/1'
      || !isObject(check.build) || check.build.model_sha256 !== copies.get(MODEL)!.sha256) {
      fail(copies.get(CHECK_REPORT)!.path, 'the check report does not bind the adopted compiled model');
    }
    const verifyTree = (relative: string): void => {
      if (!treeMatches(dir, relative, expected)) fail(relative, 'the staging files differ from the retained inventory');
    };

    const target = join(dir, ADOPTED_COMPOSE_BUILD);
    const parent = dirname(target);
    if (!stat(parent)) mkdirSync(parent);
    if (realpathSync(parent) !== parent || !lstatSync(parent).isDirectory()) fail('derived', 'expected a real staging parent');
    const prior = stat(target);
    if (prior) {
      if (!prior.isDirectory() || realpathSync(target) !== target) fail(ADOPTED_COMPOSE_BUILD, 'expected a real staging directory');
      verifyTree(ADOPTED_COMPOSE_BUILD);
    } else {
      staging = mkdtempSync(join(parent, '.direction-adopted-'));
      for (const [path, binding] of rows) {
        const to = join(staging, path);
        mkdirSync(dirname(to), { recursive: true });
        copyFileSync(source(binding.path), to, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
      }
      writeFileSync(join(staging, COPY_RECEIPT), receipt, { flag: 'wx' });
      verifyTree(posix.relative(dir, staging));
    }
    for (const [, binding] of rows) {
      if (sha256(readFileSync(source(binding.path))) !== binding.sha256) fail(binding.path, 'retained source bytes differ from their recorded hash');
    }
    if (!readFileSync(projectPath).equals(original)) fail('project.json', 'the adopted record changed during staging');
    if (staging) {
      if (stat(target)) fail(ADOPTED_COMPOSE_BUILD, 'the destination became occupied during staging');
      renameSync(staging, target);
      staging = undefined;
    }
    return { stdout: `scene: staged adopted v${version} at ${ADOPTED_COMPOSE_BUILD} (${rows.length} verified files)`, exit: 0 };
  } catch (error) {
    if (error instanceof Refusal) throw error;
    return fail(ADOPTED_COMPOSE_BUILD, error instanceof Error ? error.message : 'could not verify the adopted inputs');
  } finally {
    if (staging) rmSync(staging, { recursive: true, force: true });
    closeSync(lock);
    rmSync(lockPath);
  }
}
