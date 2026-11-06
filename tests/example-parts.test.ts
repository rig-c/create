import { expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { generateExampleOrder } from '../scripts/generate-example-order.ts';
import { checkProject } from '../src/check.ts';
import { sha256 } from '../src/choices.ts';
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
  const assets = Object.keys(first.files).filter(path => path.endsWith('.png'));
  expect([...referenced].sort()).toEqual(assets.sort());
  expect(referenced.size).toBe(6);
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
  }
});
