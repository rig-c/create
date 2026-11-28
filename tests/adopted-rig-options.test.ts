import { expect, test } from 'bun:test';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXAMPLE_NOW } from '../scripts/example-time.ts';
import { interviewAnswerCommand, interviewOptionsCommand } from '../src/choice-writers.ts';
import { checkProject, collectItems } from '../src/check.ts';
import { optionContext, sha256 } from '../src/choices.ts';
import { recordCommand } from '../src/record.ts';
import { sorted } from '../src/step-hash.ts';
import { TEMPLATES_DIR, type JsonObject } from '../src/templates.ts';
import { tempDir } from './helpers.ts';

const originalSet = 'evidence/interview/post_composition.json';
const newSet = 'evidence/interview/post_composition-adopted.json';

function adoptedProject() {
  const dir = join(tempDir('adopted-rig-options-'), 'project');
  cpSync(join(TEMPLATES_DIR, 'example-chain/checkpoints/4-direction-post'), dir, { recursive: true });
  const projectFile = join(dir, 'project.json');
  const read = (): JsonObject => JSON.parse(readFileSync(projectFile, 'utf8')) as JsonObject;
  const rig = JSON.parse(recordCommand(['rig', dir, '--adopt', '--json'], EXAMPLE_NOW).stdout!) as JsonObject;
  expect(rig.adopted).toEqual({ version: 1 });
  const draft = JSON.parse(readFileSync(join(dir, originalSet), 'utf8')) as JsonObject;
  const context = { kind: 'adopted-rig', target: { subject: 'current.rig', record_sha256: sha256(Buffer.from(JSON.stringify(sorted(rig)))),
    files_sha256: rig.files_sha256! } };
  const bytes = Buffer.from(JSON.stringify({ ...draft, id: 'post-composition-adopted', drafted_at: new Date(EXAMPLE_NOW).toISOString(), context }));
  writeFileSync(join(dir, newSet), bytes);
  return { dir, rig, context, projectFile, read, binding: { path: newSet, sha256: sha256(bytes) } };
}

test('#1127 registers fresh post-composition options against the adopted rig', () => {
  const { dir, read, binding, context } = adoptedProject();
  const signoffs = read().signoffs;
  expect(JSON.parse(interviewOptionsCommand(['post_composition', dir, '--file', newSet], EXAMPLE_NOW))).toEqual(binding);
  expect(optionContext(read(), 'post-interview', EXAMPLE_NOW, dir)).toEqual(context);
  expect(checkProject(dir, undefined, { now: EXAMPLE_NOW }).refusals).toEqual([]);
  const words = join(dir, 'owner-words.txt');
  writeFileSync(words, 'Use the synthetic composition.\n');
  interviewAnswerCommand(['post_composition', dir, '--set', newSet, '--sha256', binding.sha256,
    '--pick', 'post_composition=keep', '--by', 'user', '--owner-chat', words,
    '--said-at', new Date(EXAMPLE_NOW).toISOString(), '--relayed-by', 'operator'], EXAMPLE_NOW + 1_000);
  const project = read();
  expect(project.signoffs).toEqual(signoffs);
  const item = collectItems(project, { collection: null }).find(item => item.id === 'post_composition');
  expect(item?.raw).toMatchObject({ choice: { set: binding } });
  // The numbered fixture retains a historical post-interview signoff on the previous answer.
  expect(checkProject(dir, undefined, { now: EXAMPLE_NOW + 1_000 }).refusals).toEqual([
    expect.objectContaining({ code: 'SIGNOFF_ANSWERS_STALE', path: expect.stringContaining('.answer_hashes[post_composition]') }),
  ]);
});

test.each(['files', 'built_from'] as const)('#1127 rejects changed adopted rig %s before writing', field => {
  const { dir, rig, projectFile } = adoptedProject();
  const before = readFileSync(projectFile);
  const binding = (rig[field] as JsonObject[])[0]!;
  const file = join(dir, String(binding.path));
  writeFileSync(file, Buffer.concat([readFileSync(file), Buffer.from('\n')]));
  expect(() => interviewOptionsCommand(['post_composition', dir, '--file', newSet], EXAMPLE_NOW))
    .toThrow(expect.objectContaining({ code: 'INTERVIEW_OPTIONS_STALE', message: expect.stringContaining(binding.path as string) }));
  expect(readFileSync(projectFile)).toEqual(before);
});
