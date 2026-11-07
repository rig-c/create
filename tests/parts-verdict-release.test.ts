/**
 * The card's last bar (rig-c/create#51): a verdict written by the released
 * rig-review CLI passes the reader, and a one-byte change to a part refuses.
 *
 * tests/fixtures/rig-review-1.5.0/ is a synthetic three-part package (flat
 * colour PNGs, no painting) and the verdict rig-review@1.5.0 wrote for it,
 * unedited. It was generated outside this repository, headless, through the
 * release's own route: `bun add rig-review@1.5.0` in a scratch folder, then
 *
 *   rig-review parts <proj>/derived/parts/rig --verdict <proj>/evidence/parts-review.json --port 0
 *
 * and the request the page's Save button makes: POST /api/parts/verdict with
 * the printed capability (X-Review-Capability), a same-origin Origin, and
 * { "status": "approved", "parts": { <each part>: { "outcome": "clean" } } }.
 * No browser and no `rig-review open`. The verdict sits outside the parts
 * directory, so its source paths start with `../`.
 */
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { appendFileSync, cpSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JsonObject } from '../src/templates.ts';
import { arr, fixture, obj } from './fixtures.ts';
import { checkProject } from './clock.ts';

const RELEASE = join(import.meta.dir, 'fixtures', 'rig-review-1.5.0');
const VERDICT = 'evidence/parts-review.json';

/** The filled example at rigging start, its parts-review sign-off resting on the release-written verdict. */
function project(): string {
  const bytes = readFileSync(join(RELEASE, VERDICT));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const dir = fixture((p: JsonObject) => {
    p.stage = 'rigging';
    p.versions = [];
    p.signoffs = arr(p.signoffs).filter((s) => ['interview', 'plan-approved', 'parts', 'parts-review'].includes(String(obj(s).stage)) && !Array.isArray(obj(s).steps));
    for (const s of arr(obj(p.plan).steps).map(obj)) if (s.phase === 'post' || ['bones', 'meshes', 'constraints', 'motion'].includes(String(s.id))) s.status = 'pending';
    const signoff = arr(p.signoffs).map(obj).find((s) => s.stage === 'parts-review');
    if (signoff === undefined) throw new Error('no parts-review sign-off');
    signoff.evidence = { kind: 'parts-verdict', path: VERDICT, sha256 };
  });
  cpSync(RELEASE, dir, { recursive: true });
  return dir;
}

describe('a verdict written by rig-review@1.5.0', () => {
  test('is the release, as written', () => {
    const verdict = JSON.parse(readFileSync(join(RELEASE, VERDICT), 'utf8')) as { schema: string; mode: string; tool: { version: string }; source: { files: { path: string }[] } };
    expect(verdict).toMatchObject({ schema: 'rig-review-parts-verdict/1', mode: 'parts', tool: { name: '@rig-c/review', version: '1.5.0' }, status: 'approved' });
    expect(verdict.source.files[0]?.path).toBe('../derived/parts/rig/parts.json');
  });

  test('passes the reader', () => {
    expect(checkProject(project()).refusals).toEqual([]);
  });

  test('a one-byte change to a part is PARTS_VERDICT_SOURCE_CHANGED', () => {
    const dir = project();
    appendFileSync(join(dir, 'derived/parts/rig/parts/torso.png'), Buffer.from([0]));
    const report = checkProject(dir);
    expect(report.refusals.map((f) => f.code)).toEqual(['PARTS_VERDICT_SOURCE_CHANGED']);
    expect(report.refusals[0]?.message).toContain('parts/torso.png');
  });
});
