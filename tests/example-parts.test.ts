import { expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, posix } from 'node:path';
import { generateExampleOrder } from '../scripts/generate-example-order.ts';
import { checkProject, type Finding } from '../src/check.ts';
import { checkPartsVerdict } from '../src/parts-verdict.ts';
import type { JsonObject } from '../src/templates.ts';
import { sha256 } from '../src/choices.ts';
import { EXAMPLE_PARTS_DIR, EXAMPLE_VERDICT } from './parts-package.ts';
import { EXAMPLE_DRAFT } from './draft-fixture.ts';
import { fixture } from './fixtures.ts';
import { tempDir } from './helpers.ts';

const load = createRequire(import.meta.url);
const { decodePng } = load('@rig-c/core/plate') as {
  decodePng: (bytes: Uint8Array) => { width: number; height: number; data: Uint8Array };
};

test('the whole producer-backed fixture is byte-identical across fresh runs and every bound part decodes', () => {
  const first = generateExampleOrder(join(tempDir(), 'first'));
  const second = generateExampleOrder(join(tempDir(), 'second'));
  expect(second.project).toEqual(first.project);
  expect(Object.keys(second.files)).toEqual(Object.keys(first.files));
  for (const [path, bytes] of Object.entries(first.files)) {
    expect(Buffer.from(second.files[path]!)).toEqual(Buffer.from(bytes));
    const shipped = path.startsWith('evidence/interview/')
      ? `example-interview-options/${path.slice('evidence/interview/'.length)}`
      : path.startsWith(EXAMPLE_DRAFT) ? `example-draft/${path.slice(EXAMPLE_DRAFT.length + 1)}` : `example-draft/${path}`;
    expect(readFileSync(join(import.meta.dir, '../templates', shipped))).toEqual(Buffer.from(bytes));
  }
  const referenced = new Set<string>();
  for (const [path, text] of Object.entries(first.files)) {
    if (!path.startsWith('evidence/interview/') || typeof text !== 'string') continue;
    const set = JSON.parse(text);
    const evidence = set.context?.accepted_parts?.evidence;
    if (evidence) expect(sha256(Buffer.from(first.files[evidence.path]!))).toBe(evidence.sha256);
    for (const binding of set.context?.parts?.files ?? []) {
      const bytes = Buffer.from(first.files[binding.path]!);
      expect(sha256(bytes)).toBe(binding.sha256);
      if (!binding.path.endsWith('.png')) continue;
      referenced.add(binding.path);
      const png = decodePng(bytes);
      expect(png.width).toBeGreaterThan(0);
      expect(png.height).toBeGreaterThan(0);
      expect(png.data.length).toBe(png.width * png.height * 4);
    }
  }
  const assets = Object.keys(first.files).filter(path => path.startsWith(EXAMPLE_DRAFT) && path.endsWith('.png'));
  expect([...referenced].sort()).toEqual(assets.sort());
  expect(referenced.size).toBe(6);
  const accepted = Object.keys(first.files).filter(path => path.startsWith('derived/parts/') && path.endsWith('.png'));
  expect(accepted.length).toBe(7); // Six parts and the existing synthetic recomposite control.
  for (const path of accepted) {
    const png = decodePng(Buffer.from(first.files[path]!));
    expect(png.width).toBeGreaterThan(0);
    expect(png.height).toBeGreaterThan(0);
    expect(png.data.length).toBe(png.width * png.height * 4);
  }
  const verdict = JSON.parse(String(first.files[EXAMPLE_VERDICT]));
  const manifest = JSON.parse(Buffer.from(first.files[`${EXAMPLE_DRAFT}/input/parts.json`]!).toString('utf8'));
  expect(verdict.source.files.map((file: { path: string }) => posix.basename(file.path))).toEqual(['parts.json', ...manifest.parts.map((part: { name: string }) => `${part.name}.png`)]);
  for (const source of verdict.source.files) {
    const path = posix.normalize(posix.join(posix.dirname(EXAMPLE_VERDICT), source.path));
    const bytes = Buffer.from(first.files[path]!);
    const draft = `${EXAMPLE_DRAFT}/input/${posix.relative(EXAMPLE_PARTS_DIR, path)}`;
    expect(bytes).toEqual(Buffer.from(first.files[draft]!));
    expect(source.sha256).toBe(sha256(bytes));
    expect(source.bytes).toBe(bytes.length);
  }
}, 30_000);

test('changing one byte of each producer asset is refused with its path', () => {
  const input = join(import.meta.dir, '../templates/example-draft/input/parts.json');
  const parts = JSON.parse(readFileSync(input, 'utf8')).parts as { name: string }[];
  for (const part of parts) {
    const dir = fixture(() => {}, 'example-project.json');
    const path = `${EXAMPLE_DRAFT}/input/parts/${part.name}.png`;
    const bytes = readFileSync(join(dir, path));
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
    writeFileSync(join(dir, path), bytes);
    const refusals = checkProject(dir).refusals;
    expect(refusals.some(finding => finding.code === 'DRAFT_RIG_FILE' && finding.message.includes(path))).toBe(true);
    expect(refusals.some(finding => finding.code === 'INTERVIEW_OPTIONS_STALE' && finding.message.includes(path))).toBe(true);
    const acceptedDir = fixture(() => {}, 'example-project.json');
    const acceptedPath = `${EXAMPLE_PARTS_DIR}/parts/${part.name}.png`;
    const acceptedBytes = readFileSync(join(acceptedDir, acceptedPath));
    acceptedBytes[acceptedBytes.length - 1] = acceptedBytes[acceptedBytes.length - 1]! ^ 1;
    writeFileSync(join(acceptedDir, acceptedPath), acceptedBytes);
    const project = JSON.parse(readFileSync(join(acceptedDir, 'project.json'), 'utf8'));
    const signoff = project.signoffs.find((entry: JsonObject) => entry.stage === 'parts-review');
    const sourceRefusals: Finding[] = [];
    checkPartsVerdict(acceptedDir, signoff, 'signoffs[parts-review]', sourceRefusals);
    expect(sourceRefusals.some(finding => finding.code === 'PARTS_VERDICT_SOURCE_CHANGED' && finding.message.includes(acceptedPath))).toBe(true);
  }
});
