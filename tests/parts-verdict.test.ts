import { expect, test } from 'bun:test';
import { sourceSha256, comparePartsVerdictBindings } from '../src/parts-verdict.ts';

test('source.sha256 matches the pinned producer vector', () => {
  expect(sourceSha256([{ path: 'parts/a.png', sha256: 'b'.repeat(64) }, { path: 'parts.json', sha256: 'a'.repeat(64) }]))
    .toBe('a09d7097efe0d87e9043b441fa9e9312fac7c7249e250f1b77be9275ec41571f');
});

test('source.sha256 sorts paths bytewise', () => {
  const files = [{ path: 'a', sha256: 'a'.repeat(64) }, { path: 'B', sha256: 'b'.repeat(64) }];
  expect(sourceSha256(files)).toBe(sourceSha256([...files].reverse()));
  expect(sourceSha256(files)).toBe(new Bun.CryptoHasher('sha256').update(`B\t${'b'.repeat(64)}\na\t${'a'.repeat(64)}\n`).digest('hex'));
});

test('binding comparison preserves multiplicity and permits unlisted outputs', () => {
  const part = { path: 'draft/part', sha256: 'a'.repeat(64) };
  const output = { path: 'draft/out', sha256: 'b'.repeat(64) };
  expect(comparePartsVerdictBindings([part], [part], [output])).toEqual({ verdictOnly: [], draftOnly: [] });
  expect(comparePartsVerdictBindings([part, part], [part], [output])).toEqual({ verdictOnly: ['draft/part'], draftOnly: [] });
  expect(comparePartsVerdictBindings([output], [part], [output])).toEqual({ verdictOnly: [], draftOnly: ['draft/part'] });
});
