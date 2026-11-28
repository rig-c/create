/** Direction contract adoption, historical post reader check, and current-path direction spec writer. */
import { closeSync, existsSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { checkProject, type Finding } from './check.ts';
import { CURRENT_DIRECTION_PATH, prepareCurrentDirection } from './current-direction.ts';
import { DIRECTION_CONTRACT, DirectionError, checkDirections, directionBytes, directionContract, directionFail, directionJson, directionVersion, objects, readDirection } from './direction.ts';
import { assertDraftHasRig, readAssembleOnlyDraftTarget } from './draft-layout.ts';
import { writeDirectionSpec } from './direction-spec-write.ts';
import { sceneBytes, SceneError } from './scene.ts';
import { refuseNumberedWriter } from './numbered-retirement.ts';
import { refuse, USAGE_EXIT } from './refusal.ts';
import { baselineOf, newFindings } from './refusal-baseline.ts';
import type { CommandResult } from './interview.ts';
import { assertCleanProjectStep, commitProjectStep, commitToolWrite } from './project-step-commit.ts';
import { acquireBoundJobWrite } from './job-writer.ts';
import type { JsonObject } from './templates.ts';

export const DIRECTION_HELP = `direction --adopt [<dir>]
direction check <N> [<dir>] [--json]
  Documents are immutable evidence/direction/v<N>.json. No rendering or producer builds.
direction write [<dir>] --file <retained intent JSON>
  Write specs/direction/direction.json with current rig and scene bindings and the cited take.
  The intent contains {take, citations}. Record the green compose output with record direction.`;

const DIRECTION_REPLACEMENT = 'use rig-create direction write [<dir>] --file <intent.json> and rig-create record direction --from <dir> --direction specs/direction/direction.json';
const NUMBERED_WRITE_FLAGS = ['--rig', '--compose-out', '--compose-scene', '--answers'] as const;

function usage(why: string): never {
  refuse('DIRECTION_USAGE', `direction: ${why}; ${DIRECTION_HELP}`, USAGE_EXIT);
}

function ownValidation(dir: string, project: JsonObject, now: number): void {
  const refusals: Finding[] = [];
  checkDirections({ dir, project, refusals }, now);
  if (refusals[0]) {
    const f = refusals[0];
    directionFail(f.code, f.path, f.message);
  }
}

function prospective(dir: string, before: JsonObject, next: JsonObject, now: number): void {
  const f = newFindings(baselineOf(checkProject(dir, before, { now })), checkProject(dir, next, { now }).refusals)[0];
  if (f) directionFail(f.code, f.path, f.message);
}

/** A narrow seam for fault-injected transaction tests; CLI never supplies a hook. */
export interface DirectionWriteHooks { beforeCommit?: () => void; }

export function directionCommand(args: string[], now: number, hooks: DirectionWriteHooks = {}): CommandResult {
  try {
    if (args[0] === 'patch' || args.some(arg => arg === '--patch-file' || arg.startsWith('--patch-file='))) {
      refuseNumberedWriter('direction patch', { path: 'project.json.versions', replacement: DIRECTION_REPLACEMENT });
    }
    if (args[0] === 'write') {
      const hasNumberedFlag = args.some(arg => NUMBERED_WRITE_FLAGS.some(flag => arg === flag || arg.startsWith(`${flag}=`)));
      if (hasNumberedFlag || /^[0-9]+$/.test(args[1] ?? '')) {
        refuseNumberedWriter('direction write <n> --rig', { path: 'project.json.versions', replacement: DIRECTION_REPLACEMENT });
      }
      return writeCurrentDirection(args.slice(1), now, hooks);
    }
    if (args[0] === 'check') return checkDirectionCommand(args.slice(1), now);
    if (args[0] === '--adopt') return adoptDirectionCommand(args.slice(1), now, hooks);
    return usage('unknown action/directory count');
  } catch (e) {
    if (e instanceof SceneError && e.code === 'DIRECTION_SOURCE_CHANGED') refuse(e.code, e.message);
    if (e instanceof DirectionError) refuse(e.code, e.message, e.code === 'DIRECTION_USAGE' ? USAGE_EXIT : 1);
    throw e;
  }
}

function writeCurrentDirection(args: string[], now: number, hooks: DirectionWriteHooks): CommandResult {
  let input: string | undefined;
  let root: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--file' && input === undefined) {
      input = args[++i];
      if (!input || input.startsWith('-')) return usage('--file requires a retained intent JSON');
    } else if (arg.startsWith('-') || root !== undefined) return usage(`unexpected argument ${arg}`);
    else root = arg;
  }
  if (!input) return usage('write requires --file <retained intent JSON>');
  const dir = resolve(root ?? process.cwd());
  writeDirectionSpec(dir, CURRENT_DIRECTION_PATH, 'DIRECTION_SOURCE_CHANGED', snapshots => {
    const project = directionJson(sceneBytes(dir, 'project.json', 'DIRECTION_SOURCE_CHANGED', snapshots), 'project.json');
    if (project.schema !== 'rig-create/project@0') directionFail('DIRECTION_SCHEMA', 'project.json.schema', 'expected rig-create/project@0');
    const bytes = directionBytes(dir, input);
    snapshots.set(input, bytes);
    return prepareCurrentDirection(dir, project, directionJson(bytes, input), snapshots, now);
  }, hooks.beforeCommit);
  const stderr = commitProjectStep(dir, 'direction', ['direction', 'write', ...args].join(' '), CURRENT_DIRECTION_PATH);
  return { stdout: `direction: ${CURRENT_DIRECTION_PATH} written`, exit: 0, ...(stderr ? { stderr } : {}) };
}

function checkDirectionCommand(args: string[], now: number): { stdout: string; exit: number } {
  const positional: string[] = [];
  let json = false;
  for (const arg of args) {
    if (arg === '--json') {
      if (json) usage('duplicate json');
      json = true;
    } else if (arg.startsWith('-')) {
      usage(`unknown ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  if (positional.length > 2) usage('unknown action/directory count');
  const dir = resolve(positional[1] ?? process.cwd());
  const n = Number(positional[0]);
  if (!Number.isSafeInteger(n) || n < 1) {
    assertDraftHasRig(readAssembleOnlyDraftTarget(dir, positional[0]), 'project.json.versions');
    usage('N must be positive integer');
  }
  const original = directionBytes(dir, 'project.json');
  const project = directionJson(original, 'project.json');
  if (project.schema !== 'rig-create/project@0') directionFail('DIRECTION_SCHEMA', 'project.json.schema', 'expected rig-create/project@0');
  const v = directionVersion(project, n);
  if (v.kind !== 'post') directionFail('DIRECTION_VERSION', 'versions', 'direction check needs a post');
  const errors: Finding[] = [];
  checkDirections({ dir, project, refusals: errors }, now, n);
  if (errors[0]) directionFail(errors[0].code, errors[0].path, errors[0].message);
  const doc = readDirection(dir, project, n, false);
  return {
    stdout: json
      ? JSON.stringify({ schema: 'rig-create/direction-check@1', post: n, direction: (v.provenance as JsonObject).direction, document: doc })
      : `direction: v${n} valid`,
    exit: 0,
  };
}

function adoptDirectionCommand(args: string[], now: number, hooks: DirectionWriteHooks): CommandResult {
  const positional: string[] = [];
  for (const arg of args) {
    if (arg.startsWith('-')) usage(`unknown ${arg}`);
    positional.push(arg);
  }
  if (positional.length > 1) usage('unknown action/directory count');
  const dir = resolve(positional[0] ?? process.cwd());
  const file = join(dir, 'project.json');
  const original = directionBytes(dir, 'project.json');
  const project = directionJson(original, 'project.json');
  if (project.schema !== 'rig-create/project@0') directionFail('DIRECTION_SCHEMA', 'project.json.schema', 'expected rig-create/project@0');
  const collectionRoot = basename(dirname(dir)) === 'members' ? dirname(dirname(dir)) : null;
  const collectionBytes = collectionRoot && existsSync(join(collectionRoot, 'collection.json'))
    ? directionBytes(collectionRoot, 'collection.json')
    : null;
  const lock = join(dir, '.direction.lock');
  let fd: number;
  try { fd = openSync(lock, 'wx'); }
  catch { return directionFail('DIRECTION_SOURCE_CHANGED', 'project.json', 'another direction writer holds the lock'); }
  const staged: string[] = [];
  let releasePublication = () => {};
  try {
    releasePublication = acquireBoundJobWrite(dir, undefined, true);
    const contract = directionContract(project, now);
    if (contract) return { stdout: 'direction: already adopted; original adoption preserved', exit: 0 };
    const next = structuredClone(project);
    next.direction_contract = {
      schema: DIRECTION_CONTRACT,
      adopted_at: new Date(now).toISOString(),
      grandfathered_posts: objects(project.versions).filter(v => v.kind === 'post').map(v => v.n as number).sort((a, b) => a - b),
    };
    ownValidation(dir, next, now);
    prospective(dir, project, next, now);
    hooks.beforeCommit?.();
    if (collectionRoot && collectionBytes && !directionBytes(collectionRoot, 'collection.json').equals(collectionBytes)) {
      directionFail('DIRECTION_SOURCE_CHANGED', 'collection.json', 'inherited answer context changed during publication');
    }
    if (!directionBytes(dir, 'project.json').equals(original)) {
      directionFail('DIRECTION_SOURCE_CHANGED', 'project.json', 'source bytes changed during publication');
    }
    assertCleanProjectStep(dir, ['project.json']);
    const recordBytes = Buffer.from(`${JSON.stringify(next, null, 2)}\n`);
    const temp = join(dir, `.direction-${crypto.randomUUID()}.tmp`);
    staged.push(temp);
    writeFileSync(temp, recordBytes, { flag: 'wx' });
    renameSync(temp, file);
    const warning = commitToolWrite(dir, 'direction adopt', ['project.json']);
    return {
      stdout: 'direction: adopted; historical posts preserved',
      exit: 0,
      ...(warning === undefined ? {} : { stderr: warning }),
    };
  } finally {
    for (const path of staged) rmSync(path, { force: true });
    closeSync(fd);
    rmSync(lock);
    releasePublication();
  }
}
