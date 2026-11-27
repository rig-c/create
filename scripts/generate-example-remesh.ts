/** Frozen five-version amended example checker. */
import { deepStrictEqual } from 'node:assert';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { asArray, isObject } from '../src/check.ts';
import type { JsonObject } from '../src/templates.ts';
import { fileHashes, observe, readerResults, repinNumberedCopy } from './check-example-numbered.ts';
import { EXAMPLE_BREATH_AMP } from './generate-example-draft.ts';
import { generatorArgs } from './generator-args.ts';

const fixture = join(import.meta.dir, '../templates/example-remesh');
const baseline = join(import.meta.dir, 'example-remesh-baseline.json');

export function remeshFiles(dir: string, prefix = ''): Record<string, Buffer> {
  const files: Record<string, Buffer> = {};
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === '.git') continue;
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(files, remeshFiles(join(dir, entry.name), name));
    else files[name] = readFileSync(join(dir, entry.name));
  }
  return files;
}

/**
 * Distinct breath amplitudes for rig versions v1-v3, derived from EXAMPLE_BREATH_AMP (0.9) across the
 * passing range of scripts/generate-example-draft.ts's BREATH_VISIBLE curve (0.8 -> torso_heat_mean 3.948,
 * 0.9 -> 4.259, 1.0 -> 4.912 vs torso_floor 3.809) so review's Stage 3 correction gate
 * (EDIT_SUBMIT_UNCHECKED / CORRECTION_CHECK_FAILED) passes on every version.
 */
export const REMESH_RIG_BREATH_AMPS: readonly [number, number, number] = [
  Math.round((EXAMPLE_BREATH_AMP - 0.1) * 10) / 10,
  EXAMPLE_BREATH_AMP,
  Math.round((EXAMPLE_BREATH_AMP + 0.1) * 10) / 10,
];

function preAmendmentReaders(amendedCopy: string) {
  const scratch = mkdtempSync(join(tmpdir(), 'create-remesh-pre-amend-'));
  const copy = join(scratch, 'project');
  try {
    cpSync(amendedCopy, copy, { recursive: true });
    const projectPath = join(copy, 'project.json');
    const project = JSON.parse(readFileSync(projectPath, 'utf8')) as JsonObject;
    delete project.amendments;
    for (const step of asArray((project.plan as JsonObject).steps).filter(isObject)) {
      const last = asArray(step.status_history).filter(isObject).at(-1);
      if (last?.status !== undefined) step.status = last.status;
    }
    writeFileSync(projectPath, `${JSON.stringify(project, null, 2)}\n`);
    return [observe(copy, ['interview', '--check'], true), observe(copy, ['next'], true)];
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function measureRemeshExample(destination: string, expectedFiles?: Record<string, string>) {
  if (existsSync(destination)) throw new Error('remesh example needs a fresh directory');
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
  repinNumberedCopy(destination);
  return { files, preAmendment: preAmendmentReaders(destination), readers: readerResults(destination) };
}

if (import.meta.main) {
  const usage = 'usage: bun scripts/generate-example-remesh.ts <fresh dir> --check';
  const { destination, check } = generatorArgs(import.meta.file, usage);
  if (!check) throw new Error(usage);
  const expected = JSON.parse(readFileSync(baseline, 'utf8')) as ReturnType<typeof measureRemeshExample>;
  const measured = measureRemeshExample(resolve(destination), expected.files);
  deepStrictEqual(measured.preAmendment, expected.preAmendment, 'frozen remesh pre-amendment reader results differ');
  deepStrictEqual(measured.readers, expected.readers, 'frozen remesh reader results differ');
  console.log(`example remesh: ${Object.keys(measured.files).length} file hashes, ${measured.preAmendment.length} pre-amendment checks and ${measured.readers.length} reader results match`);
}
