import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { isObject, type CheckReport } from './check.ts';
import { acquireBoundJobWrite, jobRuntimeExecArgv } from './job-writer.ts';
import { PACKAGE_NAMES, compareVersions, exactVersion, packageUpgradeFindings } from './package-upgrades.ts';
import { CREATE_PACKAGE, PINNED_PACKAGES, runningCreateVersion } from './pins.ts';
import { writeRecord } from './record-input.ts';
import { Refusal, refuse, USAGE_EXIT } from './refusal.ts';
import type { JsonObject } from './templates.ts';

function checkNoDuplicateKeys(text: string): void {
  let at = 0;
  const ws = () => { while (/\s/.test(text[at] ?? '') && at < text.length) at++; };
  const string = () => { const start = at++; while (at < text.length) { if (text[at++] === '"') break; if (text[at - 1] === '\\') at++; } return JSON.parse(text.slice(start, at)) as string; };
  const value = () => {
    ws();
    if (text[at] === '{') {
      at++; ws(); const keys = new Set<string>();
      while (text[at] !== '}') {
        const key = string();
        if (keys.has(key)) refuse('PACKAGE_UPGRADE_INPUT', 'package.json/project.json: duplicate JSON keys; remove the ambiguity before packages upgrade');
        keys.add(key); ws(); at++; value(); ws();
        if (text[at] !== ',') break;
        at++; ws();
      }
      at++;
    } else if (text[at] === '[') {
      at++; ws();
      while (text[at] !== ']') { value(); ws(); if (text[at] !== ',') break; at++; ws(); }
      at++;
    } else if (text[at] === '"') string();
    else { while (at < text.length && !/[\s,\]}]/.test(text[at]!)) at++; }
  };
  value();
}

function serializePackageJson(pkg: JsonObject, original: Buffer): string {
  const text = original.toString('utf8');
  const indent = text.match(/\n([ \t]+)"/)?.[1] ?? 2;
  const trailing = text.match(/\r?\n$/)?.[0] ?? '';
  return `${JSON.stringify(pkg, null, indent)}${trailing}`;
}

type UpgradeCheck = CheckReport & { waypoint_configs: Record<string, string[]> | null };
const PARTS_IN_QUESTION_SET = /@rig-c\/parts \d+\.\d+\.\d+/;
/** The question set moves with the parts it names; a string naming no parts version is left for the warning. */
function questionSetMove(project: JsonObject, parts: string): { from: string; to: string } | null {
  const from = isObject(project.interview) ? project.interview.question_set : undefined;
  if (typeof from !== 'string' || !PARTS_IN_QUESTION_SET.test(from) || from.includes(`@rig-c/parts ${parts}`)) return null;
  return { from, to: from.replace(PARTS_IN_QUESTION_SET, `@rig-c/parts ${parts}`) };
}
/** Record waypoints whose config[] is not the set the installed parts places there, matched as the check matches them. */
function waypointConfigMoves(project: JsonObject, placed: Record<string, string[]> | null): { index: number; id: string; from: string[]; to: string[] }[] {
  const waypoints = isObject(project.interview) && Array.isArray(project.interview.waypoints) ? project.interview.waypoints : [];
  return Object.entries(placed ?? {}).flatMap(([id, to]) => {
    const index = waypoints.findIndex(w => isObject(w) && w.id === id);
    if (index < 0) return [];
    const raw = (waypoints[index] as JsonObject).config;
    const from = (Array.isArray(raw) ? raw : []).filter((c): c is string => typeof c === 'string');
    return [...from].sort().join(',') === [...to].sort().join(',') ? [] : [{ index, id, from, to }];
  });
}
function checked(dir: string, project: JsonObject, now: number): UpgradeCheck {
  const child = Bun.spawnSync([process.execPath, ...jobRuntimeExecArgv(), join(import.meta.dir, 'packages-upgrade-check.ts')], { stdin: Buffer.from(JSON.stringify({ dir, project, now })), stdout: 'pipe', stderr: 'pipe' });
  if (child.exitCode !== 0) refuse('PACKAGE_UPGRADE_CHECK_FAILED', 'project.json: check process failed; restore the installed packages and retry packages upgrade');
  return JSON.parse(child.stdout.toString()) as UpgradeCheck;
}

function rehearsalTarballPath(spec: string): string | null {
  if (!spec.startsWith('file:')) return null;
  const tarball = spec.slice('file:'.length);
  if (!tarball.startsWith('/') || tarball.startsWith('//') || resolve(tarball) !== tarball || !tarball.endsWith('.tgz') || basename(tarball) === '.tgz') return null;
  return tarball;
}

const DEFAULT_INSTALL_REFUSAL = 'package.json/bun.lock: staged bun install failed; check registry access and package versions before retrying packages upgrade';

function unpublishedRunningCreate(stderr: string, runningVersion: string): { name: string; version: string } | null {
  const text = stripVTControlCharacters(stderr).replace(/\r\n/g, '\n');
  const resolution = text.split(/^warn:\s+Ignoring lockfile\s*$/m).pop()!;
  const errors = [...resolution.matchAll(/^error:\s+(.+)$/gm)].map(match => match[1]!.trim());
  if (errors.length === 0) return null;
  let unresolved: { name: string; version: string } | null = null;
  let missingOnRegistry = false;
  for (const line of errors) {
    const failed = /^(.+)@([^\s@]+)\s+failed to resolve$/.exec(line);
    if (failed) {
      if (unresolved !== null || failed[1] !== CREATE_PACKAGE || failed[2] !== runningVersion) return null;
      unresolved = { name: failed[1], version: failed[2] };
      continue;
    }
    const noMatch = /^No version matching "([^"]+)" found for specifier "([^"]+)"(?:\s+\(but package exists\))?$/.exec(line);
    if (noMatch) {
      if (noMatch[2] !== CREATE_PACKAGE || noMatch[1] !== runningVersion) return null;
      missingOnRegistry = true;
      continue;
    }
    if (/^GET\s+\S+@rig-c(?:\/|%2[fF])create\s+-\s+404\b/.test(line)) {
      missingOnRegistry = true;
      continue;
    }
    return null;
  }
  return unresolved !== null && missingOnRegistry ? unresolved : null;
}

export function packagesCommand(args: string[], now: number, options?: { runningCreateVersion?: string }): string {
  const usage = 'project.json: use packages upgrade [dir] --by <operator> [--rehearsal]';
  if (args[0] !== 'upgrade') refuse('PACKAGE_UPGRADE_USAGE', usage, USAGE_EXIT);
  let by = ''; let dirArg: string | undefined; let rehearsal = false;
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--by' && !by && args[i + 1] && !args[i + 1]!.startsWith('-')) by = args[++i]!;
    else if (arg === '--rehearsal' && !rehearsal) rehearsal = true;
    else if (!arg.startsWith('-') && dirArg === undefined) dirArg = arg;
    else refuse('PACKAGE_UPGRADE_USAGE', usage, USAGE_EXIT);
  }
  if (!by.trim()) refuse('PACKAGE_UPGRADE_USAGE', 'project.json: packages upgrade requires --by <operator>', USAGE_EXIT);
  const dir = resolve(dirArg ?? process.cwd());
  const release = acquireBoundJobWrite(dir);
  const lock = join(dir, '.rig-create-packages.lock');
  let fd: number;
  try { fd = openSync(lock, 'wx'); } catch { release(); return refuse('PACKAGE_UPGRADE_CONFLICT', 'project.json: another package writer holds the lock; finish it before packages upgrade'); }
  let scratch: string | undefined;
  let swapped = false; let committed = false;
  const backup = join(dir, `.node_modules-${randomUUID()}`);
  const paths = ['package.json', 'bun.lock', 'project.json'];
  const originals = new Map<string, Buffer | null>();
  try {
    for (const path of paths) originals.set(path, existsSync(join(dir, path)) ? readFileSync(join(dir, path)) : null);
    const pkgBytes = originals.get('package.json'); const recordBytes = originals.get('project.json');
    if (!pkgBytes || !recordBytes) refuse('PACKAGE_UPGRADE_INPUT', 'project.json/package.json: missing record or manifest; restore them before packages upgrade');
    let pkg: JsonObject; let project: JsonObject;
    try { pkg = JSON.parse(pkgBytes.toString()); project = JSON.parse(recordBytes.toString()); checkNoDuplicateKeys(pkgBytes.toString()); checkNoDuplicateKeys(recordBytes.toString()); }
    catch (error) { if (error instanceof Refusal) throw error; return refuse('PACKAGE_UPGRADE_INPUT', 'project.json/package.json: invalid JSON; restore valid objects before packages upgrade'); }
    if (!isObject(project) || !isObject(pkg)) refuse('PACKAGE_UPGRADE_INPUT', 'project.json/package.json: expected JSON objects; restore valid objects before packages upgrade');
    if (project.schema !== 'rig-create/project@0' || !pkg.dependencies || typeof pkg.dependencies !== 'object' || Array.isArray(pkg.dependencies)) refuse('PACKAGE_UPGRADE_INPUT', 'project.json/package.json: expected a project and dependencies object; restore them before packages upgrade');
    const malformed = packageUpgradeFindings(project)[0];
    if (malformed) refuse(malformed.code, malformed.message);
    const dependencies = pkg.dependencies as JsonObject;
    const reviewPin = (JSON.parse(readFileSync(join(import.meta.dir, '../package.json'), 'utf8')) as { dependencies: Record<string, string> }).dependencies['@rig-c/review']!;
    const createVersion = options?.runningCreateVersion ?? runningCreateVersion();
    const pins: Record<(typeof PACKAGE_NAMES)[number], string> = {
      '@rig-c/core': PINNED_PACKAGES['@rig-c/core'],
      [CREATE_PACKAGE]: createVersion,
      '@rig-c/parts': PINNED_PACKAGES['@rig-c/parts'],
      '@rig-c/review': reviewPin,
    };
    // A staging install must not resolve local dependencies against a different directory.
    const localDeps: { name: string; path: string; sha256: string }[] = [];
    const rehearsedDeps = new Set<string>();
    const seenLocalNames = new Set<string>();
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      const entries = pkg[section];
      if (entries && typeof entries === 'object') {
        if (rehearsal && Array.isArray(entries)) refuse('PACKAGE_UPGRADE_INPUT', `package.json.${section}: expected a dependency object before packages upgrade`);
        for (const [name, value] of Object.entries(entries)) {
          if (typeof value !== 'string' || !/^(?:file:|link:|workspace:|\.\.?\/|\/)/.test(value)) continue;
          if (!rehearsal) refuse('PACKAGE_UPGRADE_INPUT', `package.json.${section}: local dependencies cannot be staged safely; publish or resolve them before packages upgrade`);
          const tarball = rehearsalTarballPath(value);
          if (tarball === null) refuse('PACKAGE_UPGRADE_INPUT', `package.json.${section}[${name}]: --rehearsal accepts only file:<absolute path to an existing .tgz>; pack local dependencies before packages upgrade`);
          let tarballBytes: Buffer;
          try {
            if (!statSync(tarball).isFile()) throw new Error('not a regular file');
            tarballBytes = readFileSync(tarball);
          } catch {
            return refuse('PACKAGE_UPGRADE_INPUT', `package.json.${section}[${name}]: rehearsal tarball does not exist or is not a regular file; supply file:<absolute path to an existing .tgz>`);
          }
          if (seenLocalNames.has(name)) refuse('PACKAGE_UPGRADE_INPUT', `package.json.${section}[${name}]: duplicate local dependency across manifest sections; keep each rehearsal tarball in one section`);
          seenLocalNames.add(name);
          if (section === 'dependencies') rehearsedDeps.add(name);
          localDeps.push({ name, path: tarball, sha256: createHash('sha256').update(tarballBytes).digest('hex') });
        }
      }
    }
    const packages = PACKAGE_NAMES.map(name => {
      const rawFrom = dependencies[name] ?? null;
      const from = rehearsedDeps.has(name) ? null : rawFrom;
      const to = pins[name];
      if (!exactVersion(to) || from !== null && !exactVersion(from)) refuse('PACKAGE_UPGRADE_INPUT', `package.json.dependencies[${name}]: expected an exact release version; resolve ranges before packages upgrade`);
      if (from !== null && compareVersions(from as string, to) > 0) refuse('PACKAGE_UPGRADE_DOWNGRADE', `package.json.dependencies[${name}]: ${from} is newer than ${to}; use a newer Create release`);
      for (const section of ['devDependencies', 'optionalDependencies', 'peerDependencies']) {
        if (pkg[section] && typeof pkg[section] === 'object' && name in pkg[section]) refuse('PACKAGE_UPGRADE_INPUT', `package.json.${section}[${name}]: duplicate pin location; keep the release pin in dependencies before packages upgrade`);
      }
      return { name, from, to };
    });
    const current = rehearsedDeps.size === 0 && packages.every(pin => pin.from === pin.to);
    const questionSet = questionSetMove(project, pins['@rig-c/parts']);
    const currentRefusal = () => refuse('PACKAGE_UPGRADE_CURRENT', 'package.json.dependencies: all packages already match Create release pins, and interview.question_set and waypoint config[] match the installed parts; no upgrade to record');
    if (pkg.workspaces) refuse('PACKAGE_UPGRADE_INPUT', 'package.json.workspaces: upgrade a standalone project install; resolve workspace ownership before packages upgrade');
    const before = checked(dir, project, now);
    if (before.stage === null) refuse('PACKAGE_UPGRADE_CHECK_FAILED', 'project.json: check stopped before validating the project; repair its schema and stage before packages upgrade');
    if (current && questionSet === null && !before.warnings.some(w => w.code === 'WAYPOINT_CONFIG_STALE')) currentRefusal();
    const nextDependencies: JsonObject = { ...dependencies };
    for (const pin of packages) if (!rehearsedDeps.has(pin.name)) nextDependencies[pin.name] = pin.to;
    const manifest = serializePackageJson({ ...pkg, dependencies: nextDependencies }, pkgBytes);
    scratch = mkdtempSync(join(tmpdir(), 'rig-create-packages-'));
    writeFileSync(join(scratch, 'package.json'), manifest);
    const oldLock = originals.get('bun.lock');
    if (oldLock) writeFileSync(join(scratch, 'bun.lock'), oldLock);
    const install = Bun.spawnSync([process.execPath, 'install', '--ignore-scripts'], { cwd: scratch, stdout: 'pipe', stderr: 'pipe' });
    if (install.exitCode !== 0 || !existsSync(join(scratch, 'bun.lock'))) {
      const unpublished = rehearsedDeps.has(CREATE_PACKAGE) ? null : unpublishedRunningCreate(install.stderr.toString(), createVersion);
      if (unpublished) {
        refuse(
          'PACKAGE_UPGRADE_INSTALL',
          `package.json/bun.lock: staged bun install failed because running ${unpublished.name}@${unpublished.version} is not published on the registry; run a published Create release, or use --rehearsal with ${unpublished.name} set to file:<absolute .tgz>`,
        );
      }
      refuse('PACKAGE_UPGRADE_INSTALL', DEFAULT_INSTALL_REFUSAL);
    }
    const nextLock = readFileSync(join(scratch, 'bun.lock'));
    const row: JsonObject = { by, at: new Date(now).toISOString(), packages, lock_sha256: createHash('sha256').update(nextLock).digest('hex') };
    if (rehearsal) {
      row.rehearsal = true;
      row.local_dependencies = localDeps.map(({ name, sha256 }) => ({ name, sha256 }));
    }
    if (questionSet) row.question_set = questionSet;
    const history = [...(project.package_upgrades as JsonObject[] | undefined ?? []), row];
    const candidate: JsonObject = { ...structuredClone(project), package_upgrades: history };
    if (questionSet) (candidate.interview as JsonObject).question_set = questionSet.to;
    const invalid = packageUpgradeFindings(candidate)[0];
    if (invalid) refuse(invalid.code, invalid.message);
    for (const [path, bytes] of originals) {
      const current = existsSync(join(dir, path)) ? readFileSync(join(dir, path)) : null;
      if (bytes === null ? current !== null : !current?.equals(bytes)) refuse('PACKAGE_UPGRADE_CONFLICT', `project.json: ${path} changed during installation; retry packages upgrade against the current files`);
    }
    for (const dep of localDeps) {
      let unchanged = false;
      try {
        unchanged = statSync(dep.path).isFile() && createHash('sha256').update(readFileSync(dep.path)).digest('hex') === dep.sha256;
      } catch { unchanged = false; }
      if (!unchanged) refuse('PACKAGE_UPGRADE_CONFLICT', `project.json: rehearsal tarball for ${dep.name} changed during installation; retry packages upgrade --rehearsal against the current tarball`);
    }
    if (existsSync(join(dir, 'node_modules'))) {
      if (!lstatSync(join(dir, 'node_modules')).isDirectory()) refuse('PACKAGE_UPGRADE_INPUT', 'package.json: node_modules must be a project-owned directory; restore a standalone install before packages upgrade');
      renameSync(join(dir, 'node_modules'), backup);
    }
    swapped = true;
    renameSync(join(scratch, 'node_modules'), join(dir, 'node_modules'));
    // The check sees the candidate install and package pins, but never a committed history row.
    writeFileSync(join(dir, 'package.json'), manifest);
    writeFileSync(join(dir, 'bun.lock'), nextLock);
    let after = checked(dir, candidate, now);
    const configs = waypointConfigMoves(candidate, after.waypoint_configs);
    if (configs.length > 0) {
      const waypoints = (candidate.interview as JsonObject).waypoints as JsonObject[];
      for (const move of configs) waypoints[move.index]!.config = move.to;
      row.waypoint_config = configs.map(({ id, from, to }) => ({ id, from, to }));
      const invalidMove = packageUpgradeFindings(candidate)[0];
      if (invalidMove) refuse(invalidMove.code, invalidMove.message);
      after = checked(dir, candidate, now);
    }
    if (current && questionSet === null && configs.length === 0) currentRefusal();
    const counts = new Map<string, number>();
    const key = (finding: CheckReport['refusals'][number]) => JSON.stringify(finding);
    for (const finding of before.refusals) counts.set(key(finding), (counts.get(key(finding)) ?? 0) + 1);
    for (const finding of after.refusals) {
      const count = counts.get(key(finding)) ?? 0;
      if (!count) refuse('PACKAGE_UPGRADE_REFUSAL', `project.json: ${finding.code} at ${finding.path} changed after upgrading ${packages.filter(pin => pin.from !== pin.to).map(pin => pin.name).join(', ')}; keep the original pins and resolve this finding before retrying (${finding.message})`);
      counts.set(key(finding), count - 1);
    }
    writeRecord(join(dir, 'project.json'), recordBytes, candidate, 'packages', 'PACKAGE_UPGRADE_CONFLICT');
    committed = true;
    const moved = [...(questionSet ? [`interview.question_set → ${JSON.stringify(questionSet.to)}`] : []), ...configs.map(move => `interview.waypoints[${move.id}].config → [${move.to.join(', ')}]`)];
    return `packages: upgraded ${packages.map(pin => `${pin.name} ${pin.from ?? '(absent)'} → ${pin.to}`).join(', ')}${moved.length ? `; ${moved.join('; ')}` : ''}; recorded package_upgrades[${history.length - 1}]${rehearsal ? ' (rehearsal)' : ''}`;
  } catch (error) {
    if (error instanceof Refusal) throw error;
    return refuse('PACKAGE_UPGRADE_INSTALL', 'project.json/package.json: package migration could not complete; restore filesystem access and retry packages upgrade');
  } finally {
    if (swapped && !committed) {
      rmSync(join(dir, 'node_modules'), { recursive: true, force: true });
      if (existsSync(backup)) renameSync(backup, join(dir, 'node_modules'));
      for (const [path, bytes] of originals) if (bytes === null) rmSync(join(dir, path), { force: true }); else writeFileSync(join(dir, path), bytes);
    }
    if (committed) rmSync(backup, { recursive: true, force: true });
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    closeSync(fd); rmSync(lock); release();
  }
}
