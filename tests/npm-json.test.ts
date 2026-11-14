import { expect, test } from 'bun:test';
import { readNpmJson } from '../scripts/npm-json.ts';

const name = '@rig-c/synthetic';
const packCommand = 'npm pack . --json --pack-destination output';
const viewCommand = `npm view ${name}@1.2.3 version --json`;
const entry = { name, filename: 'rig-c-synthetic-1.2.3.tgz', entryCount: 3, size: 200, unpackedSize: 500 };

for (const [label, value] of [['npm 11 array', [entry]], ['npm 12 keyed object', { [name]: entry }]] as const) {
  test(`npm pack reads ${label} with validated metadata`, () => {
    expect(readNpmJson(JSON.stringify(value), packCommand, 'pack', name)).toEqual({
      filename: entry.filename, entryCount: 3, size: 200, unpackedSize: 500,
    });
  });
}

for (const [label, value, field] of [
  ['neither envelope', null, 'stdout'],
  ['empty array', [], 'stdout'],
  ['multiple packs', [entry, entry], 'stdout'],
  ['wrong package key', { other: entry }, 'stdout'],
  ['extra package key', { [name]: entry, other: entry }, 'stdout'],
  ['non-object entry', { [name]: null }, 'pack entry'],
  ['mismatched name', [{ ...entry, name: '@rig-c/other' }], 'name'],
  ['missing filename', [{ ...entry, filename: undefined }], 'filename'],
  ['path filename', [{ ...entry, filename: '../escape.tgz' }], 'filename'],
  ['non-tarball filename', [{ ...entry, filename: 'archive.zip' }], 'filename'],
  ['missing entryCount', [{ ...entry, entryCount: undefined }], 'entryCount'],
  ['string size', [{ ...entry, size: '200' }], 'size'],
  ['null size', [{ ...entry, size: null }], 'size'],
  ['fractional size', [{ ...entry, size: 1.5 }], 'size'],
  ['negative unpackedSize', [{ ...entry, unpackedSize: -1 }], 'unpackedSize'],
  ['unsafe entryCount', [{ ...entry, entryCount: Number.MAX_SAFE_INTEGER + 1 }], 'entryCount'],
] as const) {
  test(`npm pack refuses ${label} with command, field, expected and actual shape`, () => {
    const read = () => readNpmJson(JSON.stringify(value), packCommand, 'pack', name);
    expect(read).toThrow(`${packCommand}: ${field}: expected`);
    expect(read).toThrow('actual');
  });
}

for (const value of ['1.2.3', ['1.2.3']]) {
  test(`npm view version accepts ${Array.isArray(value) ? 'npm 12 array' : 'npm 11 string'}`, () => {
    expect(readNpmJson(JSON.stringify(value), viewCommand, 'version', '1.2.3')).toBe('1.2.3');
  });
}

for (const value of [null, { version: '1.2.3' }, [], ['1.2.3', '1.2.3'], [123], '1.2.4']) {
  test(`npm view refuses unexpected version ${JSON.stringify(value)}`, () => {
    const read = () => readNpmJson(JSON.stringify(value), viewCommand, 'version', '1.2.3');
    expect(read).toThrow(`${viewCommand}: version: expected`);
    expect(read).toThrow('actual');
  });
}

test('both npm versions permit only structured E404 for an unpublished-version dry-run', () => {
  expect(readNpmJson('{"error":{"code":"E404"}}', viewCommand, 'e404')).toBe('E404');
  for (const value of [{ error: { code: 'E401' } }, { error: { code: 'ETIMEDOUT' } }, {}, [], { code: 'E404' }]) {
    expect(() => readNpmJson(JSON.stringify(value), viewCommand, 'e404')).toThrow(`${viewCommand}: error.code: expected`);
  }
  expect(() => readNpmJson('{"error":{"code":"E401"}}', viewCommand, 'e404')).toThrow('actual string "E401"');
});

test('malformed JSON names the command, stdout field, expected envelope and actual non-JSON output', () => {
  for (const kind of ['pack', 'version', 'e404'] as const) {
    const read = () => kind === 'e404' ? readNpmJson('not JSON', viewCommand, kind)
      : kind === 'pack' ? readNpmJson('not JSON', packCommand, kind, name)
      : readNpmJson('not JSON', viewCommand, kind, '1.2.3');
    expect(read).toThrow('stdout: expected valid JSON');
    expect(read).toThrow('actual invalid JSON "not JSON"');
  }
});
