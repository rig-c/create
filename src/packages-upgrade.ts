import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { isObject, type CheckReport } from './check.ts';
import { acquireBoundJobWrite, jobRuntimeExecArgv } from './job-writer.ts';
import { PACKAGE_NAMES, compareVersions, exactVersion, packageUpgradeFindings } from './package-upgrades.ts';
import { PINNED_PACKAGES } from './pins.ts';
import { Refusal, refuse, USAGE_EXIT } from './refusal.ts';
import type { JsonObject } from './templates.ts';

/** Value spans permit literal edits without reserializing unrelated JSON. */
export function jsonSpans(text: string): Map<string, [number, number]> {
  JSON.parse(text);
  let at = 0;
  const spans = new Map<string, [number, number]>();
  const ws = () => { while (/\s/.test(text[at] ?? '') && at < text.length) at++; };
  const string = () => { const start = at++; while (at < text.length) { if (text[at++] === '"') break; if (text[at - 1] === '\\') at++; } return JSON.parse(text.slice(start, at)) as string; };
  const value = (path: string[]) => {
    ws(); const start = at;
    if (text[at] === '{') {
      at++; ws(); const keys = new Set<string>();
      while (text[at] !== '}') {
        const key = string();
        if (keys.has(key)) refuse('PACKAGE_UPGRADE_INPUT', 'package.json/project.json: duplicate JSON keys; remove the ambiguity before packages upgrade');
        keys.add(key); ws(); at++; value([...path, key]); ws();
        if (text[at] !== ',') break;
        at++; ws();
      }
      at++;
    } else if (text[at] === '[') {
      at++; ws(); let index = 0;
      while (text[at] !== ']') { value([...path, String(index++)]); ws(); if (text[at] !== ',') break; at++; ws(); }
      at++;
    } else if (text[at] === '"') string();
    else { while (at < text.length && !/[\s,\]}]/.test(text[at]!)) at++; }
    spans.set(JSON.stringify(path), [start, at]);
  };
  value([]); return spans;
}
function edit(text: string, path: string[], replacement: string): string {
  const spans = jsonSpans(text);
  const span = spans.get(JSON.stringify(path));
  if (span) return text.slice(0, span[0]) + replacement + text.slice(span[1]);
  const parent = path.slice(0, -1);
  const container = spans.get(JSON.stringify(parent));
  if (!container) refuse('PACKAGE_UPGRADE_INPUT', 'package.json/project.json: missing object; restore the project manifest before packages upgrade');
  const object = JSON.parse(text.slice(...container));
  const pos = container[1] - 1;
  return text.slice(0, pos) + `${Object.keys(object).length ? ',' : ''}\n  ${JSON.stringify(path.at(-1))}: ${replacement}\n` + text.slice(pos);
}
function appendUpgrade(text: string, row: object): string {
  const span = jsonSpans(text).get(JSON.stringify(['package_upgrades']));
  if (!span) return edit(text, ['package_upgrades'], JSON.stringify([row]));
  const prior = JSON.parse(text.slice(...span));
  const at = span[1] - 1;
  return text.slice(0, at) + `${prior.length ? ',' : ''}${JSON.stringify(row)}` + text.slice(at);
}
function checked(dir: string, project: JsonObject, now: number): CheckReport {
  const child = Bun.spawnSync([process.execPath, ...jobRuntimeExecArgv(), join(import.meta.dir, 'packages-upgrade-check.ts')], { stdin: Buffer.from(JSON.stringify({ dir, project, now })), stdout: 'pipe', stderr: 'pipe' });
  if (child.exitCode !== 0) refuse('PACKAGE_UPGRADE_CHECK_FAILED', 'project.json: check process failed; restore the installed packages and retry packages upgrade');
  return JSON.parse(child.stdout.toString()) as CheckReport;
}

export function packagesCommand(args: string[], now: number): string {
  if (args[0] !== 'upgrade') refuse('PACKAGE_UPGRADE_USAGE', 'project.json: use packages upgrade [dir] --by <operator>', USAGE_EXIT);
  let by = ''; let dirArg: string | undefined;
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--by' && !by && args[i + 1] && !args[i + 1]!.startsWith('-')) by = args[++i]!;
    else if (!arg.startsWith('-') && dirArg === undefined) dirArg = arg;
    else refuse('PACKAGE_UPGRADE_USAGE', 'project.json: use packages upgrade [dir] --by <operator>', USAGE_EXIT);
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
    try { pkg = JSON.parse(pkgBytes.toString()); project = JSON.parse(recordBytes.toString()); jsonSpans(pkgBytes.toString()); jsonSpans(recordBytes.toString()); }
    catch { return refuse('PACKAGE_UPGRADE_INPUT', 'project.json/package.json: invalid JSON; restore valid objects before packages upgrade'); }
    if (!isObject(project) || !isObject(pkg)) refuse('PACKAGE_UPGRADE_INPUT', 'project.json/package.json: expected JSON objects; restore valid objects before packages upgrade');
    if (project.schema !== 'rig-create/project@0' || !pkg.dependencies || typeof pkg.dependencies !== 'object' || Array.isArray(pkg.dependencies)) refuse('PACKAGE_UPGRADE_INPUT', 'project.json/package.json: expected a project and dependencies object; restore them before packages upgrade');
    const malformed = packageUpgradeFindings(project)[0];
    if (malformed) refuse(malformed.code, malformed.message);
    const dependencies = pkg.dependencies as JsonObject;
    const pins = { ...PINNED_PACKAGES, '@rig-c/review': JSON.parse(readFileSync(join(import.meta.dir, '../package.json'), 'utf8')).dependencies['@rig-c/review'] as string };
    const packages = PACKAGE_NAMES.map(name => {
      const from = dependencies[name] ?? null; const to = pins[name];
      if (!exactVersion(to) || from !== null && !exactVersion(from)) refuse('PACKAGE_UPGRADE_INPUT', `package.json.dependencies[${name}]: expected an exact release version; resolve ranges before packages upgrade`);
      if (from !== null && compareVersions(from as string, to) > 0) refuse('PACKAGE_UPGRADE_DOWNGRADE', `package.json.dependencies[${name}]: ${from} is newer than ${to}; use a newer Create release`);
      for (const section of ['devDependencies', 'optionalDependencies', 'peerDependencies']) {
        if (pkg[section] && typeof pkg[section] === 'object' && name in pkg[section]) refuse('PACKAGE_UPGRADE_INPUT', `package.json.${section}[${name}]: duplicate pin location; keep the release pin in dependencies before packages upgrade`);
      }
      return { name, from, to };
    });
    if (packages.every(pin => pin.from === pin.to)) refuse('PACKAGE_UPGRADE_CURRENT', 'package.json.dependencies: all packages already match Create release pins; no upgrade to record');
    // A staging install must not resolve local dependencies against a different directory.
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      const entries = pkg[section];
      if (entries && typeof entries === 'object') for (const value of Object.values(entries)) if (typeof value === 'string' && /^(?:file:|link:|workspace:|\.\.?\/|\/)/.test(value)) refuse('PACKAGE_UPGRADE_INPUT', `package.json.${section}: local dependencies cannot be staged safely; publish or resolve them before packages upgrade`);
    }
    if (pkg.workspaces) refuse('PACKAGE_UPGRADE_INPUT', 'package.json.workspaces: upgrade a standalone project install; resolve workspace ownership before packages upgrade');
    const before = checked(dir, project, now);
    if (before.stage === null) refuse('PACKAGE_UPGRADE_CHECK_FAILED', 'project.json: check stopped before validating the project; repair its schema and stage before packages upgrade');
    let manifest = pkgBytes.toString();
    for (const pin of packages) manifest = edit(manifest, ['dependencies', pin.name], JSON.stringify(pin.to));
    scratch = mkdtempSync(join(tmpdir(), 'rig-create-packages-'));
    writeFileSync(join(scratch, 'package.json'), manifest);
    const oldLock = originals.get('bun.lock');
    if (oldLock) writeFileSync(join(scratch, 'bun.lock'), oldLock);
    const install = Bun.spawnSync([process.execPath, 'install', '--ignore-scripts'], { cwd: scratch, stdout: 'pipe', stderr: 'pipe' });
    if (install.exitCode !== 0 || !existsSync(join(scratch, 'bun.lock'))) refuse('PACKAGE_UPGRADE_INSTALL', 'package.json/bun.lock: staged bun install failed; check registry access and package versions before retrying packages upgrade');
    const nextLock = readFileSync(join(scratch, 'bun.lock'));
    const row = { by, at: new Date(now).toISOString(), packages, lock_sha256: createHash('sha256').update(nextLock).digest('hex') };
    const history = [...(project.package_upgrades as JsonObject[] | undefined ?? []), row];
    const candidate = { ...project, package_upgrades: history };
    const invalid = packageUpgradeFindings(candidate)[0];
    if (invalid) refuse(invalid.code, invalid.message);
    for (const [path, bytes] of originals) {
      const current = existsSync(join(dir, path)) ? readFileSync(join(dir, path)) : null;
      if (bytes === null ? current !== null : !current?.equals(bytes)) refuse('PACKAGE_UPGRADE_CONFLICT', `project.json: ${path} changed during installation; retry packages upgrade against the current files`);
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
    const after = checked(dir, candidate, now);
    const counts = new Map<string, number>();
    const key = (finding: CheckReport['refusals'][number]) => JSON.stringify(finding);
    for (const finding of before.refusals) counts.set(key(finding), (counts.get(key(finding)) ?? 0) + 1);
    for (const finding of after.refusals) {
      const count = counts.get(key(finding)) ?? 0;
      if (!count) refuse('PACKAGE_UPGRADE_REFUSAL', `project.json: ${finding.code} at ${finding.path} changed after upgrading ${packages.filter(pin => pin.from !== pin.to).map(pin => pin.name).join(', ')}; keep the original pins and resolve this finding before retrying (${finding.message})`);
      counts.set(key(finding), count - 1);
    }
    writeFileSync(join(dir, 'project.json'), appendUpgrade(recordBytes.toString(), row));
    committed = true;
    return `packages: upgraded ${packages.map(pin => `${pin.name} ${pin.from ?? '(absent)'} → ${pin.to}`).join(', ')}; recorded package_upgrades[${history.length - 1}]`;
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
