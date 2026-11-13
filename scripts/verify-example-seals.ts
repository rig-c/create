/** Verify installed example seals, or pack a temporary copy without nested ignore losses. */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

const packageRoot = resolve(import.meta.dir, '..');
const hash = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');

function within(root: string, path: string): string {
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw Error(`invalid example path: ${path}`);
  return target;
}

function files(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return files(path);
    if (!entry.isFile()) throw Error(`expected a regular example file: ${path}`);
    return [path];
  }).sort();
}

export function verifyExampleSeals(root: string): { ok: number; failures: string[]; sealedFiles: string[] } {
  const chainRoot = join(root, 'templates/example-chain');
  const index = JSON.parse(readFileSync(join(chainRoot, 'chain.json'), 'utf8')) as { checkpoints: { name: string }[] };
  if (!Array.isArray(index.checkpoints) || index.checkpoints.length === 0) throw Error('example-chain/chain.json: no checkpoints to verify');
  let ok = 0;
  const failures: string[] = [];
  const sealedFiles: string[] = [];
  for (const { name } of index.checkpoints) {
    const declaration = within(join(chainRoot, 'checkpoints'), `${name}.json`);
    if (!existsSync(declaration)) { failures.push(`missing checkpoint declaration: ${relative(root, declaration)}`); continue; }
    const seal = JSON.parse(readFileSync(declaration, 'utf8')) as {
      schema: string; name: string; files: { path: string; sha256: string }[]; project_sha256: string;
    };
    if (seal.schema !== 'rig-create/example-checkpoint@1' || seal.name !== name || !Array.isArray(seal.files) || seal.files.length === 0) {
      throw Error(`${relative(root, declaration)}: invalid checkpoint seal`);
    }
    const checkpoint = within(join(chainRoot, 'checkpoints'), name);
    for (const entry of [...seal.files, { path: 'project.json', sha256: seal.project_sha256 }]) {
      const path = within(checkpoint, entry.path);
      const label = relative(root, path);
      sealedFiles.push(path);
      if (!existsSync(path)) failures.push(`missing sealed file: ${label}`);
      else if (!/^[a-f0-9]{64}$/.test(entry.sha256) || hash(path) !== entry.sha256) failures.push(`sha256 mismatch: ${label}`);
      else ok++;
    }
  }
  return { ok, failures, sealedFiles };
}

function report(root: string, log: (line: string) => void): ReturnType<typeof verifyExampleSeals> {
  const result = verifyExampleSeals(root);
  for (const failure of result.failures) log(failure);
  log(`checkpoint seals: ${result.ok} ok / ${result.failures.length} fail (files[] plus project_sha256)`);
  if (result.failures.length) throw Error('example seals failed; repack the unmodified source with scripts/verify-example-seals.ts --pack <output-dir>');
  return result;
}

function run(command: string, args: string[], cwd?: string): string {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw Error(`${command} ${args.join(' ')} failed: ${result.error?.message ?? result.status}\n${result.stderr}`);
  return result.stdout;
}

/** Only the disposable copy gets .npmignore; every original example byte is retained. */
function stage(root: string, destination: string): void {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { files: string[] };
  mkdirSync(destination);
  cpSync(join(root, 'package.json'), join(destination, 'package.json'));
  for (const path of manifest.files) {
    const target = within(destination, path);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(within(root, path), target, { recursive: true });
  }
  for (const path of files(join(destination, 'templates')).filter(path => path.endsWith(`${sep}.gitignore`))) {
    const npmignore = join(dirname(path), '.npmignore');
    if (existsSync(npmignore)) throw Error(`pack staging would overwrite ${npmignore}`);
    writeFileSync(npmignore, '!**\n');
  }
}

export function verifyTarball(tarball: string, sourceRoot?: string): void {
  const scratch = mkdtempSync(join(tmpdir(), 'create-example-seals-'));
  try {
    run('tar', ['-xzf', resolve(tarball), '-C', scratch]);
    const root = join(scratch, 'package');
    const verified = report(root, console.error);
    if (sourceRoot) {
      const source = join(sourceRoot, 'templates');
      const originals = files(source);
      for (const path of originals) {
        const target = join(root, 'templates', relative(source, path));
        if (!existsSync(target) || hash(target) !== hash(path)) throw Error(`packed template missing or changed: templates/${relative(source, path)}`);
      }
      console.error(`template byte parity: ${originals.length} files match source`);
    }
    // Negative control operates only on the extracted tree, after the positive gate.
    const deleted = verified.sealedFiles.find(path => path.endsWith(`${sep}.gitignore`))!;
    unlinkSync(deleted);
    const planted = verifyExampleSeals(root);
    const expected = `missing sealed file: ${relative(root, deleted)}`;
    if (planted.failures.length !== 1 || planted.failures[0] !== expected || planted.ok !== verified.ok - 1) {
      throw Error(`planted deletion was not detected: ${expected}`);
    }
    console.error(`planted deletion detected: ${expected} (${planted.ok} ok / 1 fail)`);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

export function packExamples(output: string, stageOutput?: string): string {
  const scratch = mkdtempSync(join(tmpdir(), 'create-example-pack-'));
  try {
    const destination = resolve(output);
    mkdirSync(destination, { recursive: true });
    const staged = stageOutput === undefined ? join(scratch, 'source') : resolve(stageOutput);
    stage(packageRoot, staged);
    const [packed] = JSON.parse(run('npm', ['pack', '.', '--json', '--pack-destination', destination], staged)) as {
      filename: string; entryCount: number; size: number; unpackedSize: number;
    }[];
    const tarball = join(destination, packed!.filename);
    console.error(`npm pack: ${packed!.entryCount} files / ${packed!.size} bytes compressed / ${packed!.unpackedSize} bytes unpacked`);
    verifyTarball(tarball, packageRoot);
    return tarball;
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

if (import.meta.main) {
  try {
    const [mode, path, ...extra] = process.argv.slice(2);
    if (mode === undefined) report(packageRoot, console.log);
    else if (path && extra.length === 0 && mode === '--pack') console.log(packExamples(path));
    else if (path && extra.length === 0 && mode === '--tarball') verifyTarball(path);
    else if (path && extra.length === 0 && mode === '--stage') {
      const scratch = mkdtempSync(join(tmpdir(), 'create-example-stage-gate-'));
      try { packExamples(scratch, path); console.log(resolve(path)); }
      finally { rmSync(scratch, { recursive: true, force: true }); }
    }
    else throw Error('usage: bun scripts/verify-example-seals.ts [--pack <output-dir> | --tarball <file.tgz> | --stage <fresh-dir>]');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
