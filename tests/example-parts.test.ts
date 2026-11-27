import { expect, test } from 'bun:test';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, posix } from 'node:path';
import { recordedPartsVerdict } from '../src/parts-verdict-record.ts';
import type { JsonObject } from '../src/templates.ts';
import { sha256 } from '../src/choices.ts';
import { EXAMPLE_PARTS_DIR, EXAMPLE_VERDICT } from './parts-package.ts';
import { EXAMPLE_DRAFT } from './draft-fixture.ts';
import { fixture } from './fixtures.ts';
import { checkProject } from './clock.ts';

const load = createRequire(import.meta.url);
const { decodePng } = load('@rig-c/core/plate') as {
  decodePng: (bytes: Uint8Array) => { width: number; height: number; data: Uint8Array };
};

test('the frozen parts, option contexts and verdict bind the retained producer bytes', () => {
  const dir = fixture(() => {}, 'example-numbered/example-project.json');
  const read = (path: string): Buffer => readFileSync(join(dir, path));
  const partPngs = (root: string): string[] => [
    ...readdirSync(join(dir, root, 'parts')).map(name => `${root}/parts/${name}`),
    ...readdirSync(join(dir, root)).map(name => `${root}/${name}`),
  ].filter(path => path.endsWith('.png'));
  const referenced = new Set<string>();
  for (const name of readdirSync(join(dir, 'evidence/interview'))) {
    const set = JSON.parse(read(`evidence/interview/${name}`).toString('utf8'));
    const evidence = set.context?.accepted_parts?.evidence;
    if (evidence) expect(sha256(read(evidence.path))).toBe(evidence.sha256);
    for (const binding of set.context?.parts?.files ?? []) {
      const bytes = read(binding.path);
      expect(sha256(bytes)).toBe(binding.sha256);
      if (!binding.path.endsWith('.png')) continue;
      referenced.add(binding.path);
      const png = decodePng(bytes);
      expect(png.width).toBeGreaterThan(0);
      expect(png.height).toBeGreaterThan(0);
      expect(png.data.length).toBe(png.width * png.height * 4);
    }
  }
  const assets = partPngs(`${EXAMPLE_DRAFT}/input`).filter(path => path !== `${EXAMPLE_DRAFT}/input/recomposite_rig.png`);
  expect([...referenced].sort()).toEqual(assets.sort());
  expect(read(`${EXAMPLE_DRAFT}/input/recomposite_rig.png`)).toEqual(read(`${EXAMPLE_PARTS_DIR}/recomposite_rig.png`));
  expect(referenced.size).toBe(7); // Six parts and the painting_in_rig raster parts.json declares.
  const accepted = partPngs(EXAMPLE_PARTS_DIR);
  expect(accepted.length).toBe(8); // Six parts, the declared painting, and the synthetic recomposite control.
  for (const path of accepted) {
    const png = decodePng(read(path));
    expect(png.width).toBeGreaterThan(0);
    expect(png.height).toBeGreaterThan(0);
    expect(png.data.length).toBe(png.width * png.height * 4);
  }
  const verdict = JSON.parse(read(EXAMPLE_VERDICT).toString('utf8'));
  const manifest = JSON.parse(read(`${EXAMPLE_DRAFT}/input/parts.json`).toString('utf8'));
  expect(verdict.source.files.map((file: { path: string }) => posix.basename(file.path))).toEqual(['parts.json', ...manifest.parts.map((part: { name: string }) => `${part.name}.png`), 'painting_in_rig.png']);
  for (const source of verdict.source.files) {
    const path = posix.normalize(posix.join(posix.dirname(EXAMPLE_VERDICT), source.path));
    const bytes = read(path);
    const draft = `${EXAMPLE_DRAFT}/input/${posix.relative(EXAMPLE_PARTS_DIR, path)}`;
    expect(bytes).toEqual(read(draft));
    expect(source.sha256).toBe(sha256(bytes));
    expect(source.bytes).toBe(bytes.length);
  }
});

test('changing one byte of each producer asset is refused with its path', () => {
  const input = join(import.meta.dir, '../templates/example-numbered', EXAMPLE_DRAFT, 'input/parts.json');
  const parts = JSON.parse(readFileSync(input, 'utf8')).parts as { name: string }[];
  for (const part of parts) {
    const dir = fixture(() => {}, 'example-numbered/example-project.json');
    const path = `${EXAMPLE_DRAFT}/input/parts/${part.name}.png`;
    const bytes = readFileSync(join(dir, path));
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
    writeFileSync(join(dir, path), bytes);
    const refusals = checkProject(dir).refusals;
    expect(refusals.some(finding => finding.code === 'DRAFT_RIG_FILE' && finding.message.includes(path))).toBe(true);
    expect(refusals.some(finding => finding.code === 'INTERVIEW_OPTIONS_STALE' && finding.message.includes(path))).toBe(true);
    const acceptedDir = fixture(() => {}, 'example-numbered/example-project.json');
    const acceptedPath = `${EXAMPLE_PARTS_DIR}/parts/${part.name}.png`;
    const acceptedBytes = readFileSync(join(acceptedDir, acceptedPath));
    acceptedBytes[acceptedBytes.length - 1] = acceptedBytes[acceptedBytes.length - 1]! ^ 1;
    writeFileSync(join(acceptedDir, acceptedPath), acceptedBytes);
    const project = JSON.parse(readFileSync(join(acceptedDir, 'project.json'), 'utf8'));
    const signoff = project.signoffs.find((entry: JsonObject) => entry.stage === 'parts-review');
    expect(recordedPartsVerdict(acceptedDir, project, signoff.draft_id, signoff.evidence).partsFile).toBe(join(acceptedDir, EXAMPLE_DRAFT, 'input/parts.json'));
  }
});
