import { expect, test } from 'bun:test';

import { PINNED_PACKAGES } from '../src/pins.ts';
import { readTemplate } from '../src/templates.ts';

const EXACT = /^\d+\.\d+\.\d+$/;

test('every pin is an exact version, no range', () => {
  expect(Object.keys(PINNED_PACKAGES).sort()).toEqual(['@rig-c/core', '@rig-c/parts']);
  for (const [pkg, version] of Object.entries(PINNED_PACKAGES)) {
    expect(`${pkg}@${version}`).toBe(`${pkg}@${version.match(EXACT)?.[0]}`);
  }
});

test("the template's waypoints were read from the pinned @rig-c/parts", () => {
  const interview = readTemplate('project.json').interview;
  if (interview === null || typeof interview !== 'object' || Array.isArray(interview)) {
    throw new Error('template has no interview object');
  }
  expect(interview.question_set).toContain(`@rig-c/parts ${PINNED_PACKAGES['@rig-c/parts']})`);
});
