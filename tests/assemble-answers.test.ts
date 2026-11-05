import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { PROJECTION_ASKS_SINCE } from '../src/assemble-answers.ts';
import { checkProject } from '../src/check.ts';
import { interviewCommand } from '../src/interview.ts';
import { stepHash } from '../src/step-hash.ts';
import { readTemplate, type Json } from '../src/templates.ts';
import { arr, fixture, obj, version, waypoint } from './fixtures.ts';

function project(projectRule: string | undefined, ground?: Json, delegated = false, at = PROJECTION_ASKS_SINCE): string {
  return fixture((p) => {
    const guide = obj(waypoint(p, 'assemble').guide);
    guide.at = at;
    obj(guide.value).project = projectRule ?? 'core';
    if (delegated) {
      obj(obj(guide.agent_decision).value).ground = ground ?? null;
    } else if (ground !== undefined) obj(guide.value).ground = ground;
    if (ground !== undefined) arr(guide.asks).push({ id: 'ground', state: delegated ? 'delegated' : 'user' });
  }, 'legacy-example-project.json', { 'config.json': JSON.stringify({ assemble: { ...(projectRule === undefined ? {} : { project: projectRule }) } }) });
}

for (const ground of ['plain', 'busy']) {
  for (const delegated of [false, true]) {
    test(`visible records ${ground}, delegated=${delegated}`, () => {
      const report = checkProject(project('visible', ground, delegated));
      expect(report.refusals).toEqual([]);
      expect(report.warnings.map(f => f.code)).toEqual(['QUESTION_SET_STALE', 'STAGE_ORDER_LEGACY', 'CHOICE_ANSWERS_LEGACY', 'CORRECTION_PATH_LEGACY']);
    });
  }
}

test('visible config without a ground answer refuses through the CLI with a remedy', () => {
  const result = interviewCommand(['--check', project('visible'), '--json']);
  expect(result.exit).toBe(1);
  const report = JSON.parse(result.stdout);
  expect(report.refusals.some((f: { code: string }) => f.code === 'ASSEMBLE_GROUND_UNANSWERED')).toBe(true);
  expect(report.refusals.find((f: { code: string }) => f.code === 'ASSEMBLE_GROUND_UNANSWERED').message).toContain('plain or busy');
  expect(report.refusals.some((f: { path: string }) => f.path.endsWith('asks[ground]'))).toBe(true);
});

for (const rule of ['core', undefined]) {
  test(`config projection ${rule} adds no ground ask or refusal`, () => {
    const report = checkProject(project(rule));
    expect(report.refusals).toEqual([]);
    expect(report.warnings.map(f => f.code)).toEqual(['QUESTION_SET_STALE', 'STAGE_ORDER_LEGACY', 'CHOICE_ANSWERS_LEGACY', 'CORRECTION_PATH_LEGACY']);
  });
}

for (const ground of [null, 'unknown', ['plain'], { value: 'busy' }]) {
  test(`claimed ground coverage requires a valid scalar answer: ${JSON.stringify(ground)}`, () => {
    const report = checkProject(project('visible', ground));
    expect(report.refusals.some((f) => f.code === 'ASSEMBLE_GROUND_UNANSWERED')).toBe(true);
    expect(report.refusals.some((f) => f.path.endsWith('asks[ground]'))).toBe(true);
  });
}

test('projection question is required on new guides', () => {
  const dir = fixture((p) => {
    const guide = obj(waypoint(p, 'assemble').guide);
    guide.at = PROJECTION_ASKS_SINCE;
    guide.asks = arr(guide.asks).filter((raw) => obj(raw).id !== 'projection');
  });
  expect(checkProject(dir).refusals.map((f) => f.path)).toEqual(['interview.waypoints[assemble].guide.asks[projection]']);
});

for (const at of ['2026-11-05T23:59:59Z', 'unreadable']) {
  test(`legacy visible guide gets warning instead of new refusals: ${at}`, () => {
    const dir = project('visible', undefined, false, at);
    const report = checkProject(dir);
    expect(report.refusals).toEqual([]);
    expect(report.warnings.some((f) => f.code === 'GUIDE_ASKS_LEGACY')).toBe(true);
  });
}

test('retained version config is checked for a non-CG project too', () => {
  const bytes = JSON.stringify({ assemble: { project: 'visible' }, requirements: 'requirements.json' });
  const dir = fixture((p) => {
    const guide = obj(waypoint(p, 'assemble').guide);
    guide.at = PROJECTION_ASKS_SINCE;
    obj(version(p, 1).provenance).config = { path: 'evidence/visible.json', sha256: createHash('sha256').update(bytes).digest('hex') };
  }, 'legacy-example-project.json', {
    'evidence/visible.json': bytes,
    'evidence/requirements.json': JSON.stringify({
      spec: 'spine-parts-requirements/1', fps: 12, requirements: [], setup_painting: { required: true },
    }),
  });
  expect(checkProject(dir).refusals.some((f) => f.code === 'ASSEMBLE_GROUND_UNANSWERED' && f.path.startsWith('versions[v1]'))).toBe(true);
});

test('config visible activates ground even while the recorded projection says core', () => {
  const dir = project('core');
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ assemble: { project: 'visible' } }));
  expect(checkProject(dir).refusals.some((f) => f.code === 'ASSEMBLE_GROUND_UNANSWERED')).toBe(true);
});

test('answered guide visible activates ground before a config is written', () => {
  const dir = project('visible');
  writeFileSync(join(dir, 'config.json'), '{}');
  expect(checkProject(dir).refusals.map((f) => f.path)).toEqual(['interview.waypoints[assemble].guide.asks[ground]']);
});

test('filled example remains clean and every recorded step hash matches stepHash', () => {
  const report = checkProject(fixture());
  expect(report.refusals).toEqual([]);
  expect(report.warnings.map(f => f.code)).toEqual(['QUESTION_SET_STALE', 'STAGE_ORDER_LEGACY', 'CHOICE_ANSWERS_LEGACY', 'CORRECTION_PATH_LEGACY']);
  const p = readTemplate('legacy-example-project.json');
  for (const raw of arr(p.signoffs)) {
    const signoff = obj(raw);
    if (!signoff.step_hashes) continue;
    for (const [id, hash] of Object.entries(obj(signoff.step_hashes))) {
      const step = arr(obj(p.plan).steps).find((raw) => obj(raw).id === id);
      expect(stepHash(obj(step))).toBe(String(hash));
    }
  }
});

test('projection can be explicitly delegated beside a user guide', () => {
  const dir = fixture((p) => {
    const guide = obj(waypoint(p, 'assemble').guide);
    obj(arr(guide.asks).find((raw) => obj(raw).id === 'projection')).state = 'delegated';
    obj(obj(guide.agent_decision).value).project = 'visible';
    obj(guide.value).ground = 'busy';
    arr(guide.asks).push({ id: 'ground', state: 'user' });
  });
  expect(checkProject(dir).refusals).toEqual([]);
});

test('projection coverage cannot substitute an array for the scalar choice', () => {
  const dir = fixture((p) => {
    obj(obj(waypoint(p, 'assemble').guide).value).project = ['core'];
  });
  expect(checkProject(dir).refusals.map((f) => f.path)).toEqual(['interview.waypoints[assemble].guide.asks[projection]']);
});
