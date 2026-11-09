import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { checkProject, isObject, PROJECT_SCHEMA } from './check.ts';
import {
  COLLECTION_BINDING_SPEC,
  COLLECTION_SCHEMA,
  DEFAULT_COLLECTION_BINDING_PATH,
  IGNORED_BINDING_ROOTS,
  checkCollectionBinding,
  externalCollectionFile,
  extractCollectionInterviewSnapshot,
  extractInheritedAnswers,
  isLiveMemberRoot,
  isValidCollectionBindingPath,
  loadCollectionForDir,
  projectUsesCollection,
  readExternalCollection,
  readRegularBindingFile,
  sha256Hex,
  verifyCollectionBinding,
  withCandidateProject,
  type CollectionBindingFinding,
  type CollectionBindingVerification,
} from './collection-binding-reader.ts';
import { acquireBoundJobWrite } from './job-writer.ts';
import { refuse, USAGE_EXIT } from './refusal.ts';
import type { JsonObject } from './templates.ts';

export {
  COLLECTION_BINDING_SPEC,
  COLLECTION_SCHEMA,
  DEFAULT_COLLECTION_BINDING_PATH,
  IGNORED_BINDING_ROOTS,
  checkCollectionBinding,
  externalCollectionFile,
  extractCollectionInterviewSnapshot,
  extractInheritedAnswers,
  isLiveMemberRoot,
  isValidCollectionBindingPath,
  loadCollectionForDir,
  projectUsesCollection,
  readExternalCollection,
  readRegularBindingFile,
  sha256Hex,
  verifyCollectionBinding,
  withCandidateProject,
  type CollectionBindingFinding,
  type CollectionBindingVerification,
};

export const COLLECTION_BINDING_HELP = 'collection-binding [<member dir>] [--out <project-relative .json path>]';

export interface CollectionBindingPointer {
  readonly path: string;
  readonly sha256: string;
  readonly spec: typeof COLLECTION_BINDING_SPEC;
  readonly collection_sha256: string;
}

export interface CollectionBindingResult {
  readonly dir: string;
  readonly collection: string;
  readonly member: string;
  readonly binding: CollectionBindingPointer;
}

function usage(why: string): never {
  refuse('COLLECTION_BINDING_USAGE', `collection-binding: ${why}; usage: rig-create ${COLLECTION_BINDING_HELP}`, USAGE_EXIT);
}

function ensureSafeDestination(realRoot: string, relPath: string): void {
  if (!isValidCollectionBindingPath(relPath)) {
    refuse(
      'COLLECTION_BINDING_PATH_INVALID',
      `collection-binding: --out ${JSON.stringify(relPath)} must be a literal project-relative .json path outside ignored roots`,
    );
  }
  const pieces = relPath.split('/');
  let current = realRoot;
  for (let i = 0; i < pieces.length; i++) {
    current = join(current, pieces[i]!);
    if (!existsSync(current)) {
      try {
        // An existing broken symlink returns false for existsSync but succeeds on lstatSync.
        if (lstatSync(current)) {
          refuse('COLLECTION_BINDING_PATH_INVALID', `collection-binding: ${relPath} cannot traverse or overwrite a symlink`);
        }
      } catch {
        continue;
      }
    }
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      refuse('COLLECTION_BINDING_PATH_INVALID', `collection-binding: cannot inspect ${relPath}`);
    }
    if (stat.isSymbolicLink()) {
      refuse('COLLECTION_BINDING_PATH_INVALID', `collection-binding: ${relPath} cannot traverse or overwrite a symlink`);
    }
    const isLast = i === pieces.length - 1;
    if (isLast && !stat.isFile()) {
      refuse('COLLECTION_BINDING_PATH_INVALID', `collection-binding: ${relPath} exists and is not a regular file`);
    }
    if (!isLast && !stat.isDirectory()) {
      refuse('COLLECTION_BINDING_PATH_INVALID', `collection-binding: parent of ${relPath} exists and is not a directory`);
    }
    try {
      if (realpathSync(current) !== current) {
        refuse('COLLECTION_BINDING_PATH_INVALID', `collection-binding: ${relPath} must resolve inside the member root without symlinks`);
      }
    } catch {
      refuse('COLLECTION_BINDING_PATH_INVALID', `collection-binding: ${relPath} cannot resolve cleanly inside the member root`);
    }
  }
}

export function writeCollectionBinding(
  targetDir: string,
  options: { readonly out?: string; readonly now?: number } = {},
): CollectionBindingResult {
  const now = options.now ?? Date.now();
  const outPath = options.out ?? DEFAULT_COLLECTION_BINDING_PATH;
  const dir = resolve(targetDir);
  if (!existsSync(dir)) {
    refuse('PROJECT_JSON_MISSING', `${join(dir, 'project.json')} does not exist; run collection-binding in a member project folder`);
  }
  try {
    if (lstatSync(dir).isSymbolicLink()) {
      refuse('COLLECTION_BINDING_PATH_INVALID', `collection-binding: ${dir} must not be a symlink`);
    }
  } catch (e) {
    if (e && typeof e === 'object' && 'code' in e && (e as { code: unknown }).code === 'COLLECTION_BINDING_PATH_INVALID') throw e;
    refuse('PROJECT_JSON_MISSING', `${join(dir, 'project.json')} does not exist; run collection-binding in a member project folder`);
  }
  let realRoot = dir;
  try {
    realRoot = realpathSync(dir);
  } catch {
    refuse('PROJECT_JSON_MISSING', `${join(dir, 'project.json')} does not exist; run collection-binding in a member project folder`);
  }
  ensureSafeDestination(realRoot, outPath);

  const projectFile = join(realRoot, 'project.json');
  if (!existsSync(projectFile)) {
    refuse('PROJECT_JSON_MISSING', `${projectFile} does not exist; run collection-binding in a member project folder`);
  }
  try {
    const stat = lstatSync(projectFile);
    if (stat.isSymbolicLink() || !stat.isFile() || realpathSync(projectFile) !== projectFile) {
      refuse('PROJECT_JSON_INVALID', `${projectFile}: must be a regular file without symlinks`);
    }
  } catch (e) {
    if (e && typeof e === 'object' && 'code' in e && typeof (e as { code: unknown }).code === 'string' && String((e as { code: string }).code).startsWith('PROJECT_')) {
      throw e;
    }
    refuse('PROJECT_JSON_INVALID', `${projectFile}: unreadable project record`);
  }

  const originalProjectBytes = readFileSync(projectFile);
  let parsedProject: unknown;
  try {
    parsedProject = JSON.parse(originalProjectBytes.toString('utf8'));
  } catch (e) {
    refuse('PROJECT_JSON_INVALID', `${projectFile}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!isObject(parsedProject as JsonObject)) {
    refuse('PROJECT_JSON_INVALID', `${projectFile}: not a JSON object`);
  }
  const project = parsedProject as JsonObject;
  if (project.schema !== PROJECT_SCHEMA) {
    refuse('SCHEMA_UNKNOWN', `schema is ${JSON.stringify(project.schema ?? null)}; collection-binding reads ${PROJECT_SCHEMA}`);
  }

  if (!isLiveMemberRoot(realRoot)) {
    refuse(
      'COLLECTION_BINDING_NOT_A_MEMBER',
      `${realRoot}: not a member project under <collection>/members/<name>/`,
    );
  }
  const external = readExternalCollection(realRoot);
  if (!external.exists || external.collection === null || external.sha256 === null) {
    refuse(
      'COLLECTION_BINDING_NOT_A_MEMBER',
      `${external.file}: missing or invalid collection.json (${external.error ?? 'missing'})`,
    );
  }
  if (external.collection.schema !== COLLECTION_SCHEMA) {
    refuse(
      'COLLECTION_BINDING_NOT_A_MEMBER',
      `${external.file}: schema is ${JSON.stringify(external.collection.schema ?? null)}, not ${COLLECTION_SCHEMA}`,
    );
  }
  const collectionName = typeof external.collection.name === 'string' && external.collection.name.trim() !== '' ? external.collection.name : null;
  if (collectionName === null) {
    refuse('COLLECTION_BINDING_NOT_A_MEMBER', `${external.file}: collection name is missing`);
  }

  const folderMemberName = basename(realRoot);
  if (typeof project.name !== 'string' || project.name.trim() === '' || project.name !== folderMemberName) {
    refuse(
      'COLLECTION_BINDING_MEMBER_MISMATCH',
      `project.json: project.name ${JSON.stringify(project.name ?? null)} does not match member folder '${folderMemberName}'`,
    );
  }
  if (project.collection !== undefined && project.collection !== null && project.collection !== collectionName) {
    refuse(
      'COLLECTION_BINDING_MEMBER_MISMATCH',
      `project.json: project.collection ${JSON.stringify(project.collection)} does not match parent collection '${collectionName}'`,
    );
  }
  if (
    Array.isArray(external.collection.members) &&
    external.collection.members.length > 0 &&
    !external.collection.members.some((m) => isObject(m) && m.name === folderMemberName)
  ) {
    refuse(
      'COLLECTION_BINDING_MEMBER_MISMATCH',
      `project.json: member '${folderMemberName}' is not registered in ${external.file} members[]`,
    );
  }

  const interviewSnapshot = extractCollectionInterviewSnapshot(external.collection);
  if (interviewSnapshot === null) {
    refuse('COLLECTION_BINDING_NOT_A_MEMBER', `${external.file}: collection interview structure is malformed`);
  }

  const inherited = extractInheritedAnswers(project, external.collection);
  if (!inherited.ok) {
    refuse('COLLECTION_BINDING_INHERITED_INVALID', `project.json: ${inherited.reason}`);
  }

  const snapshotRecord: JsonObject = {
    schema: COLLECTION_BINDING_SPEC,
    collection: {
      name: collectionName,
      sha256: external.sha256,
    },
    member: folderMemberName,
    interview: interviewSnapshot,
    inherited_answers: inherited.answers,
  };
  const snapshotBytes = Buffer.from(`${JSON.stringify(snapshotRecord, null, 2)}\n`, 'utf8');
  const snapshotSha256 = sha256Hex(snapshotBytes);

  const binding: CollectionBindingPointer = {
    path: outPath,
    sha256: snapshotSha256,
    spec: COLLECTION_BINDING_SPEC,
    collection_sha256: external.sha256,
  };

  const candidate = structuredClone(project);
  candidate.collection_binding = { ...binding };

  const outAbs = join(realRoot, outPath);
  const hadExistingBinding = existsSync(outAbs);
  const previousBindingBytes = hadExistingBinding ? readFileSync(outAbs) : null;

  const createdDirs: string[] = [];
  const parentDir = dirname(outAbs);
  if (!existsSync(parentDir)) {
    const relDir = dirname(outPath);
    let walk = realRoot;
    for (const part of relDir.split('/')) {
      if (!part || part === '.') continue;
      walk = join(walk, part);
      if (!existsSync(walk)) createdDirs.push(walk);
    }
  }

  const releaseJobWrite = acquireBoundJobWrite(realRoot);
  let committed = false;
  try {
    for (const d of createdDirs) mkdirSync(d);
    const tmpBinding = join(dirname(outAbs), `.collection-binding-${process.pid}-${randomUUID()}.tmp`);
    writeFileSync(tmpBinding, snapshotBytes, { flag: 'wx' });
    renameSync(tmpBinding, outAbs);

    const report = checkProject(realRoot, candidate, { now });
    const first = report.refusals[0] ?? report.holes?.[0];
    if (first !== undefined) {
      refuse(first.code, first.message);
    }

    const tmpProject = join(realRoot, `.project-${process.pid}-${randomUUID()}.tmp`);
    writeFileSync(tmpProject, `${JSON.stringify(candidate, null, 2)}\n`, { flag: 'wx' });
    renameSync(tmpProject, projectFile);
    committed = true;
  } finally {
    if (!committed) {
      try {
        if (previousBindingBytes !== null) {
          writeFileSync(outAbs, previousBindingBytes);
        } else {
          rmSync(outAbs, { force: true });
        }
      } catch {
        /* Best-effort rollback of unstaged binding file. */
      }
      for (const d of [...createdDirs].reverse()) {
        try {
          rmdirSync(d);
        } catch {
          /* Best-effort cleanup of newly created parent directories. */
        }
      }
    }
    releaseJobWrite();
  }

  return {
    dir: realRoot,
    collection: collectionName,
    member: folderMemberName,
    binding,
  };
}

export function collectionBindingCommand(args: string[], now = Date.now()): string {
  const positional: string[] = [];
  let out: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--out') {
      const value = args[++i];
      if (value === undefined || value.startsWith('-')) usage('--out needs a path');
      if (out !== undefined) usage('duplicate --out');
      out = value;
    } else if (arg.startsWith('--out=')) {
      const value = arg.slice('--out='.length);
      if (!value) usage('--out needs a path');
      if (out !== undefined) usage('duplicate --out');
      out = value;
    } else if (arg.startsWith('-')) {
      refuse('UNKNOWN_OPTION', `collection-binding does not take ${arg}`, USAGE_EXIT);
    } else {
      positional.push(arg);
    }
  }
  if (positional.length > 1) {
    usage('takes at most one member directory');
  }
  const result = writeCollectionBinding(positional[0] ?? '.', { ...(out === undefined ? {} : { out }), now });
  return JSON.stringify(result.binding);
}
