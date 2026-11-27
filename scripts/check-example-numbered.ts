import { deepStrictEqual } from 'node:assert';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { generatorArgs } from './generator-args.ts';

const fixture = join(import.meta.dir, '../templates/example-numbered');
const baseline = join(import.meta.dir, 'example-numbered-baseline.json');
const cli = join(import.meta.dir, '../src/cli.ts');

type Findings = { code: string }[];

function sortedCodes(findings: Findings = []): string[] {
  return findings.map(({ code }) => code).sort();
}

function fileHashes(root: string, prefix = ''): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(files, fileHashes(root, path));
    else if (entry.isFile()) files[path] = createHash('sha256').update(readFileSync(join(root, path))).digest('hex');
    else throw new Error(`${path}: expected a regular fixture file or directory`);
  }
  return files;
}

type ReaderReport = {
  refusals?: Findings;
  warnings?: Findings;
  stage?: string;
  moves?: unknown[];
  rig_version?: number;
  post?: number;
};

function readerResults(dir: string) {
  const project = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as {
    versions: { kind: string; n: number }[];
  };
  const commands = [
    ['interview', '--check'],
    ['next'],
    ['handoff'],
    ...project.versions.filter(version => version.kind === 'rig').map(({ n }) => ['handoff', '--rig', String(n)]),
    ...project.versions.filter(version => version.kind === 'post').map(({ n }) => ['direction', 'check', String(n)]),
  ];
  return commands.map(command => observe(dir, command, true));
}

function observe(dir: string, command: string[], json: boolean) {
  const label = command.join(' ');
  const run = Bun.spawnSync([process.execPath, cli, ...command, ...(json ? ['--json'] : [])], {
    cwd: dir, stdout: 'pipe', stderr: 'pipe',
  });
  if (run.exitCode === null) throw new Error(`${label} ended by ${run.signalCode}`);
  const stderr = run.stderr.toString().trim();
  const refusals: string[] = [];
  const warnings: string[] = [];
  for (const line of stderr ? stderr.split('\n') : []) {
    const match = /^rig-create: (WARN )?([A-Z][A-Z0-9_]+): /.exec(line);
    if (!match?.[2]) throw new Error(`${label}: ${line}`);
    (match[1] ? warnings : refusals).push(match[2]);
  }
  const stdout = run.stdout.toString().trim();
  const report = json && stdout ? JSON.parse(stdout) as ReaderReport : {};
  const row = {
    command: label,
    exit: run.exitCode,
    refusals: [...sortedCodes(report.refusals), ...refusals].sort(),
    warnings: [...sortedCodes(report.warnings), ...warnings].sort(),
    stage: report.stage,
    moves: report.moves?.length,
    rig: report.rig_version,
    post: report.post,
  };
  return Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined));
}

function adoptionResults(project: string) {
  const scratch = mkdtempSync(join(tmpdir(), 'create-numbered-adoption-'));
  const copy = join(scratch, 'project');
  try {
    cpSync(project, copy, { recursive: true });
    return [
      ...['parts', 'rig', 'motion', 'direction'].map(kind => observe(copy, ['record', kind, '--adopt'], true)),
      observe(copy, ['direction', '--adopt'], false),
      observe(copy, ['correction', '--adopt'], false),
      observe(copy, ['interview', '--check'], true),
    ];
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Measure copies of the retained bytes. The CLI only compares against the committed baseline. */
export function measureNumberedExample(destination: string, expectedFiles?: Record<string, string>) {
  if (existsSync(destination)) throw new Error('numbered example needs a fresh directory');
  const files = fileHashes(fixture);
  if (expectedFiles) {
    for (const [path, sha256] of Object.entries(expectedFiles)) {
      if (files[path] !== sha256) throw new Error(`${path}: frozen fixture file is missing or its SHA-256 differs`);
    }
    for (const path of Object.keys(files)) {
      if (!Object.hasOwn(expectedFiles, path)) throw new Error(`${path}: unexpected frozen fixture file`);
    }
  }
  cpSync(fixture, destination, { recursive: true, force: false, errorOnExist: true });
  renameSync(join(destination, 'example-project.json'), join(destination, 'project.json'));
  return { files, readers: readerResults(destination), adoption: adoptionResults(destination) };
}

if (import.meta.main) {
  const usage = 'usage: bun scripts/check-example-numbered.ts <fresh dir> --check';
  const { destination, check } = generatorArgs(import.meta.file, usage);
  if (!check) throw new Error(usage);
  const expected = JSON.parse(readFileSync(baseline, 'utf8')) as ReturnType<typeof measureNumberedExample>;
  const measured = measureNumberedExample(resolve(destination), expected.files);
  deepStrictEqual(measured.readers, expected.readers, 'frozen numbered reader results differ');
  deepStrictEqual(measured.adoption, expected.adoption, 'frozen numbered adoption results differ');
  console.log(`numbered example: ${Object.keys(measured.files).length} file hashes and ${measured.readers.length} reader results match`);
  for (const result of measured.readers) console.log(JSON.stringify(result));
  console.log(`numbered example: ${measured.adoption.length} adoption results match`);
  for (const result of measured.adoption) console.log(JSON.stringify(result));
}
