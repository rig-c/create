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
  const manifest = JSON.parse(Buffer.from(input['parts.json']!).toString('utf8')) as { parts: { name: string }[] };
  const names = manifest.parts.map(part => part.name);
  const paths = ['parts.json', ...names.map(name => `parts/${name}.png`)];
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
 * input binds the same bytes the verdict reviewed (rig-c/create#236).
 */
export function writeReviewedInput(dir: string, root: string, verdict = EXAMPLE_VERDICT): void {
  const verdictDir = posix.dirname(verdict);
  const files = (JSON.parse(readFileSync(join(dir, verdict), 'utf8')) as { source: { files: { path: string }[] } }).source.files;
  const partsDir = posix.dirname(posix.join(verdictDir, files[0]!.path));
  for (const { path } of files) {
    const from = posix.join(verdictDir, path);
    const to = join(dir, root, 'input', posix.relative(partsDir, from));
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, readFileSync(join(dir, from)));
  }
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
