/**
 * A synthetic parts package and the `rig-review-parts-verdict/1` file
 * rig-review's parts view writes for it, field for field as rig-c/review
 * src/parts-view.ts `buildVerdict` and docs/PARTS_VIEW.md define them:
 * `source.files` is parts.json then every part image in parts.json order, each
 * path relative to the verdict file's directory in POSIX form; `source.sha256`
 * is recomputed the way review computes it. Nothing here is a real painting.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';

import { sourceSha256 } from '../src/parts-verdict.ts';
import { preparedExampleFiles } from './prepared-fixture.ts';

/**
 * Where the filled example keeps its assembled parts (derived/, not in git) and
 * their verdict (written with `--verdict` to a tracked path, so the sign-off's
 * evidence survives a clone) — templates/example-project.json.
 */
export const EXAMPLE_PARTS_DIR = 'derived/parts/rig';
export const EXAMPLE_VERDICT = 'evidence/parts-review.json';

export const PART_NAMES = ['background', 'torso', 'lantern'] as const;

const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

export function partsJson(names: readonly string[] = PART_NAMES): string {
  const parts = names.map((name, i) => ({ name, x: 10 * i, y: 20 * i, w: 64, h: 64 }));
  return `${JSON.stringify({ rig_size: [512, 768], parts }, null, 2)}\n`;
}
/** Stand-in bytes for a part image; the reader hashes them and never decodes them. */
export const partImage = (name: string): string => `synthetic part image: ${name}\n`;

export interface PackageOptions {
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
  readonly files: Record<string, string>;
  /** The verdict file, project-relative, and its sha256: what the sign-off's evidence records. */
  readonly verdictPath: string;
  readonly verdictSha256: string;
}

export function partsPackage(options: PackageOptions = {}): PartsPackage {
  const partsDir = options.partsDir ?? EXAMPLE_PARTS_DIR;
  const verdictPath = options.verdict ?? posix.join(partsDir, 'parts-review.json');
  const verdictDir = posix.dirname(verdictPath);
  const files: Record<string, string> = { [posix.join(partsDir, 'parts.json')]: partsJson() };
  for (const name of PART_NAMES) files[posix.join(partsDir, 'parts', `${name}.png`)] = partImage(name);
  const source = Object.entries(files).map(([path, content]) => ({
    path: posix.relative(verdictDir, path),
    bytes: Buffer.byteLength(content, 'utf8'),
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
    parts: Object.fromEntries(PART_NAMES.map((name) => [name, { outcome, note: outcome === 'flagged' ? 'a ragged rim' : '', flags: [] }])),
    updatedAt: '2026-11-11T10:15:00.000Z',
  };
  options.edit?.(verdict);
  const text = `${JSON.stringify(verdict, null, 2)}\n`;
  files[verdictPath] = text;
  return { files, verdictPath, verdictSha256: sha(text) };
}

/** Writes a package's files under a project folder (default: the filled example's approved package). */
export function writePartsPackage(dir: string, pkg: PartsPackage = partsPackage({ verdict: EXAMPLE_VERDICT })): void {
  for (const [path, content] of Object.entries({ ...preparedExampleFiles(), ...pkg.files })) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}
