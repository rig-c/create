/**
 * `rig-create init --collection <dir>` and `rig-create init --member <collection dir> <name>`
 * (docs/COLLECTIONS.md § Layout).
 *
 * A collection is one git repository. Its members are ordinary project folders
 * under `members/<name>/` inside that repository, not repositories of their
 * own: the folder path is the membership record (COLLECTIONS.md § Members live
 * inside the collection), and a collection version pins member builds, so the
 * collection's history has to hold the member records it pins. A nested
 * repository would make the collection's git see a member as an opaque gitlink.
 *
 * For the same reason a member has no `package.json` of its own: the
 * collection pins the rig-c packages once, so every member is built with the
 * same versions and a cross bar measures one toolchain. `interview --check` in
 * a member reads the collection's install (src/parts-sections.ts).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import { CREATE_DOCS, DERIVED_LINK, PACKAGE_DOCS, READ_FIRST, createDocUrl, packageDocPath, writeAgentGuide } from './agent-guide.ts';
import { COLLECTION_SCHEMA, collectionAnswer, readJsonObject } from './check.ts';
import {
  checkTarget,
  FALLBACK_IDENTITY,
  GITIGNORE,
  hasGitIdentity,
  IGNORED_DIRS,
  INTERVIEW_DOC_URL,
  run,
  TRACKED_EMPTY_DIRS,
  writePackageJson,
} from './init.ts';
import { PINNED_PACKAGES } from './pins.ts';
import { refuse, USAGE_EXIT } from './refusal.ts';
import { CHOICE_ORDER_SPEC } from './choices.ts';
import { readTemplate, TEMPLATES_DIR, type Json, type JsonObject } from './templates.ts';

/** The collection's stages, in order (COLLECTIONS.md § Collection stages); `closed_by` as in src/stages.ts. */
export const COLLECTION_STAGES = [
  { id: 'interview', closed_by: 'signoff' },
  { id: 'plan-approved', closed_by: 'signoff' },
  { id: 'reference', closed_by: 'signoff' },
  { id: 'members', closed_by: 'bar' },
  { id: 'post-interview', closed_by: 'signoff' },
  { id: 'post', closed_by: 'bar' },
  { id: 'direction-review', closed_by: 'signoff' },
  { id: 'accepted', closed_by: 'none' },
] as const satisfies readonly { id: string; closed_by: 'signoff' | 'bar' | 'none' }[];

export const COLLECTION_STAGE_VALUES: readonly string[] = [...COLLECTION_STAGES.map((s) => s.id), 'paused'];

/** A collection folder holds members/ besides a project's tracked folders. */
export const COLLECTION_TRACKED_EMPTY_DIRS = ['members', ...TRACKED_EMPTY_DIRS] as const;

export const COLLECTION_GUIDE_TEMPLATE = 'collection-agent-guide.md';

/** A member name is one folder name: it becomes `members/<name>/` and the `from.collection` key nobody retypes. */
const MEMBER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface CollectionInitResult {
  dir: string;
  name: string;
  installed: boolean;
  installError: string | null;
  committed: string[];
  commit: string;
  fallbackIdentity: boolean;
}

export interface MemberInitResult {
  collectionDir: string;
  collection: string;
  dir: string;
  name: string;
  inherited: string[];
  own: string[];
  committed: string[];
  /** `null` when the collection folder is not a git work tree: files are written, nothing is committed. */
  commit: string | null;
  fallbackIdentity: boolean;
}

function writeJson(file: string, value: JsonObject): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function isObject(v: Json | undefined): v is JsonObject {
  return v !== null && v !== undefined && typeof v === 'object' && !Array.isArray(v);
}

function identityArgs(dir: string): { args: string[]; fallback: boolean } {
  const fallback = !hasGitIdentity(dir);
  return {
    fallback,
    args: fallback ? ['-c', `user.name=${FALLBACK_IDENTITY.name}`, '-c', `user.email=${FALLBACK_IDENTITY.email}`] : [],
  };
}

function commitPaths(dir: string, paths: string[], message: string): { commit: string; fallback: boolean } {
  const add = run(['git', 'add', '--', ...paths], dir);
  if (!add.ok) refuse('INIT_GIT_FAILED', `git add failed in ${dir}\n${add.out}`);
  const identity = identityArgs(dir);
  const commit = run(['git', ...identity.args, 'commit', '-q', '-m', message, '--', ...paths], dir);
  if (!commit.ok) refuse('INIT_GIT_FAILED', `git commit failed in ${dir}\n${commit.out}`);
  return { commit: run(['git', 'rev-parse', '--short', 'HEAD'], dir).out, fallback: identity.fallback };
}

/** The collection's AGENTS.md, from templates/collection-agent-guide.md. */
export function renderCollectionGuide(): string {
  const fills: Record<string, string> = {
    COLLECTIONS_LINK: `[COLLECTIONS.md](${createDocUrl('docs/COLLECTIONS.md')})`,
    DERIVED_LINK: `[INTERVIEW.md § Derived answers](${createDocUrl(DERIVED_LINK.path, DERIVED_LINK.anchor)})`,
    READ_FIRST,
    PACKAGE_DOCS: PACKAGE_DOCS.map((doc) => `- [${doc.package} ${doc.path}](${packageDocPath(doc)}): ${doc.why}.`).join('\n'),
    CREATE_DOCS: CREATE_DOCS.map((doc) => `- [${doc.path}](${createDocUrl(doc.path)}): ${doc.why}.`).join('\n'),
  };
  const template = readFileSync(join(TEMPLATES_DIR, COLLECTION_GUIDE_TEMPLATE), 'utf8');
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (marker, key: string) => {
    const fill = fills[key];
    if (fill === undefined) throw new Error(`${COLLECTION_GUIDE_TEMPLATE}: unknown marker ${marker}`);
    return fill;
  });
}

/**
 * Creates a collection in `target`: collection.json and shared/conventions.json
 * from the templates (both named after the folder), members/, the project
 * folders a collection shares (inputs/references, evidence, and the ignored
 * derived, outputs, scratch), .gitignore, package.json pinning the rig-c
 * packages once for every member, the install (unless skipped), the agent
 * guide, and a first commit of exactly those files.
 */
export function initCollection(target: string, options: { install: boolean }): CollectionInitResult {
  const dir = resolve(target);
  checkTarget(dir);
  const name = basename(dir);
  mkdirSync(join(dir, 'shared'), { recursive: true });
  const written: string[] = [];

  const collection = readTemplate('collection.json');
  collection.name = name;
  writeJson(join(dir, 'collection.json'), collection);
  written.push('collection.json');
  const conventions = readTemplate('shared/conventions.json');
  conventions.collection = name;
  writeJson(join(dir, 'shared', 'conventions.json'), conventions);
  written.push('shared/conventions.json');
  writePackageJson(dir, name);
  written.push('package.json');
  writeFileSync(join(dir, '.gitignore'), GITIGNORE);
  written.push('.gitignore');
  for (const sub of COLLECTION_TRACKED_EMPTY_DIRS) {
    mkdirSync(join(dir, sub), { recursive: true });
    writeFileSync(join(dir, sub, '.gitkeep'), '');
    written.push(`${sub}/.gitkeep`);
  }
  for (const sub of IGNORED_DIRS) mkdirSync(join(dir, sub), { recursive: true });
  writeFileSync(join(dir, 'AGENTS.md'), renderCollectionGuide());
  writeFileSync(join(dir, 'CLAUDE.md'), ['@AGENTS.md', '', 'The agent guide for this collection is AGENTS.md, imported above. It is the only copy: change it there, not here.', ''].join('\n'));
  written.push('AGENTS.md', 'CLAUDE.md');

  let installError: string | null = null;
  if (options.install) {
    const install = run([process.execPath, 'install'], dir);
    if (install.ok) written.push('bun.lock');
    else installError = install.out;
  }
  const gitInit = run(['git', 'init', '-q'], dir);
  if (!gitInit.ok) refuse('INIT_GIT_FAILED', `git init failed in ${dir}\n${gitInit.out}`);
  const { commit, fallback } = commitPaths(dir, written, `Create collection ${name}`);
  return { dir, name, installed: options.install && installError === null, installError, committed: written, commit, fallbackIdentity: fallback };
}

/** Reads `<dir>/collection.json`, refusing by name when the folder is not a collection. */
export function readCollection(dir: string): JsonObject {
  const file = join(dir, 'collection.json');
  if (!existsSync(file)) refuse('INIT_NOT_A_COLLECTION', `${dir} is not a collection: it has no collection.json (make one with rig-create init --collection <dir>)`);
  const read = readJsonObject(file);
  if (!read.ok) refuse('INIT_NOT_A_COLLECTION', `${file}: ${read.error}`);
  if (read.value.schema !== COLLECTION_SCHEMA) {
    refuse('INIT_NOT_A_COLLECTION', `${file}: schema is ${JSON.stringify(read.value.schema ?? null)}, not ${COLLECTION_SCHEMA}`);
  }
  return read.value;
}

/**
 * Where the member's answer starts: a reference to the collection's answer
 * when the collection gave one (anything but `null` or `"per-member"`), and
 * `null` — the member's own question — otherwise. The value is never copied.
 */
function startingAnswer(collection: JsonObject, collectionName: string, id: string, at: string): { answer: Json; inherited: boolean } {
  const answer = collectionAnswer(collection, id);
  if (answer === undefined || answer === null) return { answer: null, inherited: false };
  if (isObject(answer) && ('deferred' in answer || answer.value === 'per-member')) return { answer: null, inherited: false };
  return { answer: { basis: 'inherited', from: { collection: collectionName, question: id }, by: 'rig-create', at }, inherited: true };
}

/**
 * Creates `<collection>/members/<name>/` as an ordinary project (PROJECT.md §
 * Layout, without package.json and without a repository of its own), its
 * answers inherited from the collection where the collection answered, and
 * registers it in collection.json `members[]`. Commits exactly the files
 * written and collection.json in the collection's repository; refuses when
 * collection.json has uncommitted changes, so that commit never carries
 * someone else's edit.
 */
export function initMember(collectionArg: string, name: string, now: Date): MemberInitResult {
  const collectionDir = resolve(collectionArg);
  if (!MEMBER_NAME_RE.test(name)) {
    refuse('INIT_MEMBER_NAME_INVALID', `member name ${JSON.stringify(name)} is not one folder name (letters, digits, '.', '_', '-'; not starting with '.', '_' or '-')`);
  }
  const collection = readCollection(collectionDir);
  const collectionName = typeof collection.name === 'string' && collection.name !== '' ? collection.name : null;
  if (collectionName === null) refuse('INIT_COLLECTION_UNNAMED', `${join(collectionDir, 'collection.json')} has no name; an inherited answer names its collection`);
  const members = Array.isArray(collection.members) ? collection.members : [];
  const dir = join(collectionDir, 'members', name);
  if (members.some((m) => isObject(m) && m.name === name)) {
    refuse('INIT_MEMBER_EXISTS', `collection '${collectionName}' already has a member '${name}' in members[]`);
  }
  if (existsSync(dir)) refuse('INIT_MEMBER_EXISTS', `${dir} already exists; collection '${collectionName}' has a folder for '${name}'`);

  const inGit = run(['git', 'rev-parse', '--is-inside-work-tree'], collectionDir).ok;
  if (inGit) {
    const dirty = run(['git', 'status', '--porcelain', '--', 'collection.json'], collectionDir).out;
    if (dirty !== '') {
      refuse('INIT_COLLECTION_DIRTY', `${join(collectionDir, 'collection.json')} has uncommitted changes; commit them first, so registering '${name}' commits only that`);
    }
  }

  const at = now.toISOString();
  const project = readTemplate('project.json');
  project.name = name;
  project.corrections_contract = { schema: 'rig-create/corrections@1', adopted_at: at };
  project.corrections = [];
  const inherited: string[] = [];
  const own: string[] = [];
  const interview = isObject(project.interview) ? project.interview : {};
  interview.order = { spec: CHOICE_ORDER_SPEC, adopted_at: at, choices_adopted_at: at };
  const post = isObject(interview.post) ? interview.post : {};
  const lists: [Json | undefined, 'answer' | 'guide'][] = [
    [interview.framing, 'answer'],
    [interview.waypoints, 'guide'],
    [post.items, 'guide'],
  ];
  for (const [list, field] of lists) {
    for (const item of Array.isArray(list) ? list : []) {
      if (!isObject(item) || typeof item.id !== 'string') continue;
      const start = startingAnswer(collection, collectionName, item.id, at);
      item[field] = start.answer;
      (start.inherited ? inherited : own).push(item.id);
    }
  }

  mkdirSync(dir, { recursive: true });
  const rel = (p: string): string => `members/${name}/${p}`;
  const written: string[] = [];
  writeJson(join(dir, 'project.json'), project);
  written.push(rel('project.json'));
  writeFileSync(join(dir, '.gitignore'), GITIGNORE);
  written.push(rel('.gitignore'));
  for (const sub of TRACKED_EMPTY_DIRS) {
    mkdirSync(join(dir, sub), { recursive: true });
    writeFileSync(join(dir, sub, '.gitkeep'), '');
    written.push(rel(`${sub}/.gitkeep`));
  }
  for (const sub of IGNORED_DIRS) mkdirSync(join(dir, sub), { recursive: true });
  // The member's guide links the installed docs in the collection's node_modules, two folders up.
  written.push(...writeAgentGuide(dir).map(rel));
  const guide = join(dir, 'AGENTS.md');
  writeFileSync(guide, readFileSync(guide, 'utf8').replaceAll('](node_modules/', '](../../node_modules/'));

  collection.members = [...members, { name, project: rel('project.json'), input: null, note: null }];
  writeJson(join(collectionDir, 'collection.json'), collection);
  written.push('collection.json');

  let commit: string | null = null;
  let fallbackIdentity = false;
  if (inGit) {
    const made = commitPaths(collectionDir, written, `Add member ${name} to collection ${collectionName}`);
    commit = made.commit;
    fallbackIdentity = made.fallback;
  }
  return { collectionDir, collection: collectionName, dir, name, inherited, own, committed: written, commit, fallbackIdentity };
}

export function describeCollectionInit(result: CollectionInitResult): string {
  const pins = Object.entries(PINNED_PACKAGES).map(([pkg, version]) => `${pkg} ${version}`).join(', ');
  const lines = [
    `Created collection ${result.name} at ${result.dir}`,
    result.installed
      ? `  installed ${pins} for every member (bun.lock written)`
      : result.installError === null
        ? `  pinned ${pins} for every member; install skipped (--no-install)`
        : `  pinned ${pins}; bun install FAILED, so bun.lock is not in the first commit`,
    `  first commit ${result.commit}: ${result.committed.join(', ')}`,
  ];
  if (result.fallbackIdentity) lines.push(`  no git identity is configured; the first commit is authored as "${FALLBACK_IDENTITY.name} <${FALLBACK_IDENTITY.email}>"`);
  lines.push('', 'Next:');
  let step = 1;
  if (!result.installed) lines.push(`  ${step++}. cd ${result.dir} && bun install, then commit bun.lock`);
  lines.push(`  ${step++}. put the group painting in inputs/, then hold the collection interview: ${INTERVIEW_DOC_URL}`);
  lines.push(`  ${step++}. add members once the shared answers are given: rig-create init --member ${result.dir} <name>`);
  return lines.join('\n');
}

export function describeMemberInit(result: MemberInitResult): string {
  const lines = [
    `Created member ${result.name} of collection ${result.collection} at ${result.dir}`,
    `  inherited from the collection (${result.inherited.length}): ${result.inherited.join(', ') || 'none'}`,
    `  the member's own to answer (${result.own.length}): ${result.own.join(', ') || 'none'}`,
    result.commit === null
      ? `  ${result.collectionDir} is not a git work tree; nothing committed (written: ${result.committed.join(', ')})`
      : `  commit ${result.commit}: ${result.committed.join(', ')}`,
  ];
  if (result.fallbackIdentity) lines.push(`  no git identity is configured; the commit is authored as "${FALLBACK_IDENTITY.name} <${FALLBACK_IDENTITY.email}>"`);
  lines.push('', 'Next:', `  1. interview the member on what it does not inherit: rig-create interview --check ${result.dir}`);
  return lines.join('\n');
}

/**
 * `init --collection <dir> [--no-install]` and `init --member <collection dir> <name>`.
 * The member is named, not pathed: the command derives `members/<name>/`, so a
 * member cannot be made outside `members/`, and "not a collection" is refused
 * on the folder the user named, before anything is written.
 */
export function collectionInitCommand(args: string[], now: number): { stdout: string; installError: string | null; dir: string } {
  let collection = false;
  let member = false;
  let install = true;
  const positional: string[] = [];
  for (const arg of args) {
    if (arg === '--collection') collection = true;
    else if (arg === '--member') member = true;
    else if (arg === '--no-install') install = false;
    else if (arg.startsWith('-')) refuse('UNKNOWN_OPTION', `init does not take ${arg}`, USAGE_EXIT);
    else positional.push(arg);
  }
  if (collection && member) refuse('INIT_TOO_MANY_ARGUMENTS', 'init takes --collection or --member, not both', USAGE_EXIT);
  if (collection) {
    if (positional.length !== 1) refuse('INIT_DIR_MISSING', 'init --collection takes one folder: rig-create init --collection <dir>', USAGE_EXIT);
    const result = initCollection(positional[0] as string, { install });
    return { stdout: describeCollectionInit(result), installError: result.installError, dir: result.dir };
  }
  if (!install) refuse('UNKNOWN_OPTION', 'init --member does not take --no-install: a member installs nothing (the collection pins the packages)', USAGE_EXIT);
  if (positional.length !== 2) refuse('INIT_DIR_MISSING', 'init --member takes the collection folder and a member name: rig-create init --member <collection dir> <name>', USAGE_EXIT);
  const result = initMember(positional[0] as string, positional[1] as string, new Date(now));
  return { stdout: describeMemberInit(result), installError: null, dir: result.dir };
}
