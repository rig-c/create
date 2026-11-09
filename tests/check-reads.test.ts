/**
 * The recorded reader is complete by measurement (create#286): every project
 * file the check reads goes through src/check-reads.ts, and a copy of exactly
 * the recorded files gives the check the same result.
 */
import { afterAll, expect, mock, test } from 'bun:test';
import { cpSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as intake from '../src/intake.ts';
import { checkProject, type CheckReport } from '../src/check.ts';
import { TEST_NOW } from './clock.ts';
import { fixture } from './fixtures.ts';
import { tempDir } from './helpers.ts';
import { installStrictReads, uninstallStrictReads } from './strict-reads.ts';

installStrictReads();
afterAll(uninstallStrictReads);

const SRC = join(import.meta.dir, '..', 'src');
const TEMPLATES = join(import.meta.dir, '..', 'templates');
const READS = new Set(['readFileSync', 'existsSync', 'lstatSync', 'statSync', 'realpathSync', 'readdirSync']);

/** The modules check.ts reaches through static imports. */
function checkModules(): string[] {
  const seen = new Set<string>();
  const stack = ['check.ts'];
  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const match of readFileSync(join(SRC, file), 'utf8').matchAll(/from '\.\/([\w.-]+\.ts)'/g)) stack.push(match[1]!);
  }
  return [...seen].sort();
}

test('no check module imports a read function from node:fs', () => {
  const modules = checkModules();
  expect(modules).toContain('check-reads.ts');
  const bypasses = modules.filter(file => file !== 'check-reads.ts').flatMap(file => {
    const imports = [...readFileSync(join(SRC, file), 'utf8').matchAll(/import \{([^}]*)\} from '(?:node:)?fs'/g)];
    return imports.flatMap(match => match[1]!.split(',').map(name => name.trim()).filter(name => READS.has(name)).map(name => `${file}: ${name}`));
  });
  expect(bypasses).toEqual([]);
});

/** Each committed example as a fresh project folder: the example folders copied, the record templates materialized. */
const EXAMPLES: [string, () => string][] = [
  ...['example-chain', ...readdirSync(join(TEMPLATES, 'example-chain', 'checkpoints'), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => `example-chain/checkpoints/${entry.name}`), 'example-direction', 'example-remesh']
    .map(name => [name, () => {
      const dir = join(tempDir(), 'project');
      cpSync(join(TEMPLATES, name), dir, { recursive: true });
      return realpathSync(dir);
    }] as [string, () => string]),
  ...['example-project.json', 'legacy-example-project.json', 'example-reopened/project.json', 'project.json']
    .map(name => [name, () => realpathSync(fixture(() => {}, name))] as [string, () => string]),
];

const shape = (report: CheckReport, dir: string): string => JSON.stringify({ ...report, reads: undefined }).split(dir).join('<project>');

test.each(EXAMPLES)('%s: strict check throws nothing, its findings are unchanged and its recorded closure reproduces it', (_name, make) => {
  const dir = make();
  const plain = checkProject(dir, undefined, { now: TEST_NOW, readOnly: true });
  const recorded = checkProject(dir, undefined, { now: TEST_NOW, readOnly: true, recordReads: true });
  expect(plain.reads).toBeUndefined();
  expect(shape(recorded, dir)).toBe(shape(plain, dir));
  const reads = recorded.reads!;
  expect(reads.map(read => read.path)).toEqual(reads.map(read => read.path).sort());
  const copy = join(tempDir(), 'retained');
  mkdirSync(copy);
  for (const read of reads) {
    mkdirSync(dirname(join(copy, read.path)), { recursive: true });
    cpSync(join(dir, read.path), join(copy, read.path));
  }
  const again = checkProject(copy, undefined, { now: TEST_NOW, readOnly: true, recordReads: true });
  expect(shape(again, copy)).toBe(shape(plain, dir));
  expect(again.reads).toEqual(reads);
}, 30000);

test('a planted direct read in a check module makes strict mode throw CHECK_READ_UNRECORDED', () => {
  const dir = realpathSync(fixture(() => {}, 'example-project.json'));
  const original = { ...intake };
  mock.module('../src/intake.ts', () => ({ ...original, intakeWarnings: (root: string, project: never) => {
    readFileSync(join(root, 'project.json'));
    return original.intakeWarnings(root, project);
  } }));
  try {
    expect(() => checkProject(dir, undefined, { now: TEST_NOW, readOnly: true, recordReads: true })).toThrow(expect.objectContaining({ code: 'CHECK_READ_UNRECORDED' }));
    // Outside a recording session the same direct read is ordinary.
    expect(checkProject(dir, undefined, { now: TEST_NOW, readOnly: true }).refusals).toEqual([]);
  } finally {
    mock.module('../src/intake.ts', () => original);
  }
});
