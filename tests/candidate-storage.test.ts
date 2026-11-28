import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertCandidateStorage, candidateStorageBytes, CANDIDATE_STORAGE_LIMIT_BYTES, CANDIDATE_OPTION_RESERVATION_BYTES } from '../src/candidate-storage.ts';
import { tempDir } from './helpers.ts';

test('candidate storage refuses the option whose reservation crosses the live allocation ceiling', () => {
  const dir = tempDir();
  writeFileSync(join(dir, 'allocated.bin'), Buffer.alloc(8192, 42));
  const held = candidateStorageBytes(dir);
  expect(held).toBeGreaterThanOrEqual(8192);
  const existingReservations = CANDIDATE_STORAGE_LIMIT_BYTES - held - CANDIDATE_OPTION_RESERVATION_BYTES;
  expect(() => assertCandidateStorage(dir, 'post_composition', 'choice-1', held,
    existingReservations + CANDIDATE_OPTION_RESERVATION_BYTES, 0, 'within-budget')).not.toThrow();
  expect(() => assertCandidateStorage(dir, 'post_composition', 'choice-1', held,
    existingReservations + CANDIDATE_OPTION_RESERVATION_BYTES + 1, 0, 'crossing-option'))
    .toThrow(expect.objectContaining({ code: 'CANDIDATE_STORAGE_LIMIT', message: expect.stringContaining('Composing crossing-option') }));
});
