/**
 * A synthetic parts package and the `rig-review-parts-verdict/1` file
 * rig-review's parts view writes for it, field for field as rig-c/review
 * src/parts-view.ts `buildVerdict` and docs/PARTS_VIEW.md define them:
 * `source.files` is parts.json then every part image in parts.json order, each
 * path relative to the verdict file's directory in POSIX form; `source.sha256`
 * is recomputed the way review computes it. Nothing here is a real painting.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';

import { sourceSha256 } from '../src/parts-verdict.ts';
import { exampleDiffFiles } from './diff-fixture.ts';
import { preparedExampleFiles } from './prepared-fixture.ts';
import { alignLegacyBuilds, reviewExampleFiles } from './review-fixture.ts';
import type { JsonObject } from '../src/templates.ts';

/**
 * Where the filled example keeps its assembled parts (derived/, not in git) and
 * their verdict (written with `--verdict` to a tracked path, so the sign-off's
 * evidence survives a clone) — templates/example-project.json.
 */
export const EXAMPLE_PARTS_DIR = 'derived/parts/rig';
export const EXAMPLE_VERDICT = 'evidence/parts-review.json';

export const PART_NAMES = ['background', 'torso', 'lantern'] as const;

const sha = (s: string | Uint8Array): string => createHash('sha256').update(s).digest('hex');

export function partsJson(names: readonly string[] = PART_NAMES): string {
  const parts = names.map((name, i) => ({ name, x: 10 * i, y: 20 * i, w: 64, h: 64 }));
  return `${JSON.stringify({ rig_size: [512, 768], parts }, null, 2)}\n`;
}
/** ASCII-only variant for raw-binding refusal tests; never used by the interview draft. */
export const asciiPartImage = (name: string): string => `synthetic part image: ${name}\n`;

export interface PackageOptions {
  /** Producer-relative parts.json and parts/*.png bytes; omitted for frozen legacy fixtures. */
  readonly input?: Record<string, string | Uint8Array>;
  /** The assembled parts' directory, relative to the project. */
  readonly partsDir?: string;
  /** The verdict file, relative to the project (default: `parts-review.json` beside parts.json). */
  readonly verdict?: string;
  readonly status?: 'pending' | 'approved' | 'changes-requested';
  readonly mode?: 'parts' | 'atlas';
  /** Change the verdict document after it is built (a planted control), before it is serialized. */
  readonly edit?: (verdict: Record<string, unknown>) => void;
}

export interface PartsPackage {
  /** Project-relative path → content, ready for `fixture(…, files)`. */
  readonly files: Record<string, string | Uint8Array>;
  /** The verdict file, project-relative, and its sha256: what the sign-off's evidence records. */
  readonly verdictPath: string;
  readonly verdictSha256: string;
}

export function partsPackage(options: PackageOptions = {}): PartsPackage {
  const partsDir = options.partsDir ?? EXAMPLE_PARTS_DIR;
  const verdictPath = options.verdict ?? posix.join(partsDir, 'parts-review.json');
  const verdictDir = posix.dirname(verdictPath);
  // No input preserves the frozen legacy-example-project.json verdict and its ASCII source bindings.
  const input = options.input ?? { 'parts.json': partsJson(), ...Object.fromEntries(PART_NAMES.map(name => [`parts/${name}.png`, asciiPartImage(name)])) };
  const manifest = JSON.parse(Buffer.from(input['parts.json']!).toString('utf8')) as { parts: { name: string }[]; painting_in_rig?: { path: string } };
  const names = manifest.parts.map(part => part.name);
  const paths = ['parts.json', ...names.map(name => `parts/${name}.png`), ...(manifest.painting_in_rig ? [manifest.painting_in_rig.path] : [])];
  const files: Record<string, string | Uint8Array> = Object.fromEntries(paths.map(path => [posix.join(partsDir, path), input[path]!]));
  const source = Object.entries(files).map(([path, content]) => ({
    path: posix.relative(verdictDir, path),
    bytes: Buffer.byteLength(content),
    sha256: sha(content),
  }));
  const status = options.status ?? 'approved';
  const outcome = status === 'approved' ? 'clean' : status === 'pending' ? 'pending' : 'flagged';
  const verdict: Record<string, unknown> = {
    schema: 'rig-review-parts-verdict/1',
    mode: options.mode ?? 'parts',
    tool: { name: '@rig-c/review', version: '0.0.0-synthetic' },
    source: { sha256: sourceSha256(source), files: source, flags: [] },
    status,
    parts: Object.fromEntries(names.map((name) => [name, { outcome, note: outcome === 'flagged' ? 'a ragged rim' : '', flags: [] }])),
    updatedAt: '2026-11-11T10:15:00.000Z',
  };
  options.edit?.(verdict);
  const text = `${JSON.stringify(verdict, null, 2)}\n`;
  files[verdictPath] = text;
  return { files: { ...files, ...exampleDiffFiles(partsDir) }, verdictPath, verdictSha256: sha(text) };
}

/**
 * Copies the parts a verdict under `dir` reviewed into `<root>/input/` (parts.json
 * and its parts, paths relative to parts.json), so a draft recorded from that
 * input binds the same bytes the verdict reviewed (rig-c/create#236). A verdict
 * that also shows meshes (writeMeshVerdict) lists rig outputs too: those under
 * the listed rig.json's directory are copied into `<root>/out/`, relative to it,
 * so the draft binds them among its outputs (rig-c/create#245).
 */
export function writeReviewedInput(dir: string, root: string, verdict = EXAMPLE_VERDICT): void {
  const verdictDir = posix.dirname(verdict);
  const files = (JSON.parse(readFileSync(join(dir, verdict), 'utf8')) as { source: { files: { path: string }[] } }).source.files;
  const partsDir = posix.dirname(posix.join(verdictDir, files[0]!.path));
  const rig = files.find(f => posix.basename(f.path) === 'rig.json');
  const rigDir = rig === undefined ? null : posix.dirname(posix.join(verdictDir, rig.path));
  for (const { path } of files) {
    const from = posix.join(verdictDir, path);
    const output = rigDir !== null && from.startsWith(`${rigDir}/`);
    const to = output ? join(dir, root, 'out', posix.relative(rigDir, from)) : join(dir, root, 'input', posix.relative(partsDir, from));
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, readFileSync(join(dir, from)));
  }
}

export interface MeshVerdictOptions {
  /** The parts-only verdict whose files this one starts from (default: the filled example's). */
  readonly from?: string;
  /** The verdict to write, project-relative. */
  readonly verdict: string;
  /** The rig output directory (`rig-parts rig --out`), project-relative. */
  readonly out: string;
  /** The parts rig.json gives a mesh attachment; every other part gets a region. */
  readonly meshes: readonly string[];
  /** Verdict entries to leave out, by path ending (a planted control); source.sha256 is recomputed after. */
  readonly omit?: readonly string[];
}

const synthetic = (what: string, name: string): string => `synthetic ${what}: ${name}\n`;

/**
 * Synthetic rig outputs at `out` for the parts `from` reviewed, and the verdict
 * rig-review's parts view writes when it also shows their meshes
 * (`rig-review parts <dir> --rig <out>/rig.json --mesh-report <out>/mesh_report.json`).
 * In rig-c/review 2.4.6 src/parts-view.ts, `loadPartsMode` lists parts.json, the
 * part images in parts.json order and the declared painting, then
 * `locateMeshRasters` adds `<rig.images>/<mesh.image>` (resolved inside the
 * rig.json directory) for each part with a mesh attachment, in parts.json
 * order, then rig.json, then mesh_report.json. Region rasters, motion.json and
 * run.json are written but not listed. Returns the files the verdict lists.
 */
export function writeMeshVerdict(dir: string, options: MeshVerdictOptions): string[] {
  const from = options.from ?? EXAMPLE_VERDICT;
  const reviewed = JSON.parse(readFileSync(join(dir, from), 'utf8')) as { source: { files: { path: string; bytes: number; sha256: string }[] } } & Record<string, unknown>;
  const fromDir = posix.dirname(from);
  const verdictDir = posix.dirname(options.verdict);
  const projectPath = (path: string): string => posix.join(fromDir, path);
  const manifest = JSON.parse(readFileSync(join(dir, projectPath(reviewed.source.files[0]!.path)), 'utf8')) as { parts: { name: string; w: number; h: number }[] };
  const names = manifest.parts.map(part => part.name);
  const skin: Record<string, Record<string, unknown>> = {};
  for (const part of manifest.parts) {
    skin[part.name] = { [part.name]: options.meshes.includes(part.name)
      ? { type: 'mesh', image: part.name, width: part.w + 2, height: part.h + 2, uvs: [0, 0, 1, 0, 1, 1], triangles: [0, 1, 2] }
      : { image: part.name, width: part.w, height: part.h } };
  }
  const outputs: Record<string, string> = {
    'rig.json': `${JSON.stringify({ spec: 'rigc-rig/1', images: 'images', skins: { default: skin } }, null, 2)}\n`,
    'mesh_report.json': `${JSON.stringify(options.meshes.map(part => ({ part, mode: 'grid', vertices: 3, triangles: 1 })), null, 2)}\n`,
    'motion.json': '{}\n',
    ...Object.fromEntries(names.map(name => [`images/${name}.png`, synthetic(options.meshes.includes(name) ? 'mesh raster' : 'region raster', name)])),
  };
  for (const [path, content] of Object.entries(outputs)) {
    mkdirSync(dirname(join(dir, options.out, path)), { recursive: true });
    writeFileSync(join(dir, options.out, path), content);
  }
  const listed = [
    ...reviewed.source.files.map(f => projectPath(f.path)),
    ...names.filter(name => options.meshes.includes(name)).map(name => posix.join(options.out, 'images', `${name}.png`)),
    posix.join(options.out, 'rig.json'),
    posix.join(options.out, 'mesh_report.json'),
  ].filter(path => !(options.omit ?? []).some(end => path.endsWith(end)));
  const files = listed.map(path => {
    const bytes = readFileSync(join(dir, path));
    return { path: posix.relative(verdictDir, path), bytes: bytes.length, sha256: sha(bytes) };
  });
  const verdict = { ...reviewed, source: { sha256: sourceSha256(files), files, flags: [{ path: posix.relative(verdictDir, posix.join(options.out, 'mesh_report.json')), sha256: sha(outputs['mesh_report.json']!) }] } };
  mkdirSync(dirname(join(dir, options.verdict)), { recursive: true });
  writeFileSync(join(dir, options.verdict), `${JSON.stringify(verdict, null, 2)}\n`);
  return listed;
}

/** Writes a package's files under a project folder (default: the filled example's approved package). */
export function writePartsPackage(dir: string, pkg: PartsPackage = partsPackage({ verdict: EXAMPLE_VERDICT })): void {
  const files = { ...preparedExampleFiles(), ...reviewExampleFiles(), ...pkg.files };
  if (existsSync(join(dir, 'project.json'))) {
    const project = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
    alignLegacyBuilds(project, files);
    writeFileSync(join(dir, 'project.json'), `${JSON.stringify(project, null, 2)}\n`);
  }
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}
