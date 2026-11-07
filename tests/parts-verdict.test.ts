/**
 * The parts-review sign-off carries the parts verdict it rests on
 * (rig-c/create#51): one planted control per refusal, the green path, a
 * verdict kept outside the parts directory (`../` source paths), and an
 * in-flight project that keeps #48's warning and is not asked for one.
 * Verdicts are synthetic, written field for field as rig-review's parts view
 * writes them (tests/parts-package.ts).
 */
import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import { readFileSync, writeFileSync, mkdirSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { reopenCommand } from '../src/reopen.ts';
import { checkProject, type CheckReport } from '../src/check.ts';
import { sourceSha256 } from '../src/parts-verdict.ts';
import { STAGE_VALUES } from '../src/stages.ts';
import { readTemplate, type Json, type JsonObject } from '../src/templates.ts';
import { arr, fixture, historicalFixture, obj, rehashSignoffs, step, type Mutate } from './fixtures.ts';
import { tempDir } from './helpers.ts';
import { EXAMPLE_PARTS_DIR, EXAMPLE_VERDICT, asciiPartImage, partsPackage, type PackageOptions, type PartsPackage } from './parts-package.ts';

const BEFORE_RIGGING = new Set(['interview', 'plan-approved', 'parts', 'parts-review']);
const LATER_RIG_STEPS = ['bones', 'meshes', 'constraints', 'motion'];

/** The filled example at the moment rigging starts (as in tests/parts-review.test.ts). */
function atRiggingStart(p: JsonObject): void {
  p.stage = 'rigging';
  p.signoffs = arr(p.signoffs).filter((s) => BEFORE_RIGGING.has(String(obj(s).stage)) && !(obj(s).stage === 'plan-approved' && Array.isArray(obj(s).steps)));
  for (const s of arr(obj(p.plan).steps).map(obj)) if (s.phase === 'post' || LATER_RIG_STEPS.includes(String(s.id))) s.status = 'pending';
  p.versions = [];
}

function partsReviewSignoff(p: JsonObject): JsonObject {
  const found = arr(p.signoffs).map(obj).filter((s) => s.stage === 'parts-review');
  const last = found[found.length - 1];
  if (last === undefined) throw new Error('no parts-review sign-off');
  return last;
}

/** Points the parts-review sign-off at `pkg`'s verdict. */
const evidenceFor = (pkg: PartsPackage) => ({ kind: 'parts-verdict', path: pkg.verdictPath, sha256: pkg.verdictSha256 });

/** A project at rigging start whose parts-review sign-off rests on a verdict built with `options`; `mutate` runs last. */
function project(options: PackageOptions = {}, mutate: Mutate = () => {}, files: Record<string, string> = {}): string {
  const pkg = partsPackage(options);
  return fixture(
    (p) => {
      atRiggingStart(p);
      partsReviewSignoff(p).evidence = evidenceFor(pkg);
      mutate(p);
    },
    'legacy-example-project.json',
    { ...pkg.files, ...files },
  );
}

const verdictCodes = (r: CheckReport): string[] => r.refusals.map((f) => f.code).filter((c) => c.startsWith('PARTS_VERDICT_'));
const only = (r: CheckReport, code: string): string => {
  expect(r.refusals.map((f) => f.code)).toEqual([code]);
  return r.refusals[0]?.message ?? '';
};

describe('source.sha256', () => {
  test("matches review's pinned vector", () => {
    const a = 'a'.repeat(64);
    const b = 'b'.repeat(64);
    expect(sourceSha256([{ path: 'parts/a.png', sha256: b }, { path: 'parts.json', sha256: a }])).toBe('a09d7097efe0d87e9043b441fa9e9312fac7c7249e250f1b77be9275ec41571f');
  });

  test('sorts by path bytewise, not by locale: an upper-case path sorts before a lower-case one', () => {
    const a = 'a'.repeat(64);
    const b = 'b'.repeat(64);
    expect(sourceSha256([{ path: 'a', sha256: a }, { path: 'B', sha256: b }])).toBe(sourceSha256([{ path: 'B', sha256: b }, { path: 'a', sha256: a }]));
    const hasher = new Bun.CryptoHasher('sha256');
    hasher.update(`B\t${b}\na\t${a}\n`);
    expect(sourceSha256([{ path: 'a', sha256: a }, { path: 'B', sha256: b }])).toBe(hasher.digest('hex'));
  });
});

describe('green', () => {
  test('the filled example: an approved parts verdict beside parts.json, every source file as reviewed', () => {
    expect(checkProject(fixture()).refusals).toEqual([]);
    expect(checkProject(project()).refusals).toEqual([]);
  });

  test('a verdict kept outside the parts directory: its ../ source paths resolve against the verdict file', () => {
    const pkg = partsPackage({ verdict: 'evidence/parts-review.json' });
    const verdict = JSON.parse(String(pkg.files['evidence/parts-review.json'] ?? '{}')) as { source: { files: { path: string }[] } };
    expect(verdict.source.files[0]?.path).toBe(`../${EXAMPLE_PARTS_DIR}/parts.json`);
    expect(checkProject(project({ verdict: 'evidence/parts-review.json' })).refusals).toEqual([]);
  });

  test('a sign-off at parts-review, before rigging starts, is not read yet', () => {
    const dir = fixture(atRiggingStart);
    setSystemTime(new Date('2026-11-20T00:00:00Z'));
    writeFileSync(join(dir, 'words.txt'), 'Revisit the synthetic parts.');
    reopenCommand(['parts-review', dir, '--by', 'user', '--verbatim-file', join(dir, 'words.txt')]);
    const p = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
    delete partsReviewSignoff(p).evidence;
    writeFileSync(join(dir, 'project.json'), JSON.stringify(p));
    expect(checkProject(dir).refusals).toEqual([]);
  });
});

describe('refused, each by name', () => {
  test('PARTS_VERDICT_MISSING: the sign-off carries no parts-verdict evidence', () => {
    const message = only(checkProject(project({}, (p) => { delete partsReviewSignoff(p).evidence; })), 'PARTS_VERDICT_MISSING');
    expect(message).toContain('"kind": "parts-verdict"');
  });

  test('PARTS_VERDICT_MISSING: evidence of another kind is not a parts verdict', () => {
    only(checkProject(project({}, (p) => { obj(partsReviewSignoff(p).evidence).kind = 'still'; })), 'PARTS_VERDICT_MISSING');
  });

  test('PARTS_VERDICT_MISSING: a rigging step run at parts-review on a sign-off without evidence', () => {
    const dir = fixture((p) => {
      atRiggingStart(p);
      p.stage = 'parts-review';
      delete partsReviewSignoff(p).evidence;
      step(p, 'bones').status = 'in-progress';
    });
    expect(verdictCodes(checkProject(dir))).toEqual(['PARTS_VERDICT_MISSING']);
  });

  test('the latest parts-review sign-off is the one read: a later one without evidence is refused', () => {
    const dir = project({}, (p) => {
      arr(p.signoffs).push({ stage: 'parts-review', checkpoint: null, by: 'user', at: '2026-11-11T11:00:00Z', verbatim: 'looked again, fine', diff_map: partsReviewSignoff(p).diff_map });
    });
    expect(checkProject(dir).refusals.map((f) => [f.code, f.path])).toEqual([['PARTS_VERDICT_MISSING', `signoffs[${4}].evidence`]]);
  });

  test('PARTS_VERDICT_UNREAD: the verdict file is missing; create reads exactly the named file, no default lookup', () => {
    const dir = project({ verdict: 'evidence/parts-review.json' });
    rmSync(join(dir, 'evidence', 'parts-review.json'));
    // The default-location verdict the fixture also wrote is not looked up.
    const message = only(checkProject(dir), 'PARTS_VERDICT_UNREAD');
    expect(message).toContain('evidence/parts-review.json is not there');
  });

  test("PARTS_VERDICT_UNREAD: the verdict's bytes are not the recorded sha256", () => {
    const message = only(checkProject(project({}, (p) => { obj(partsReviewSignoff(p).evidence).sha256 = '0'.repeat(64); })), 'PARTS_VERDICT_UNREAD');
    expect(message).toContain('not the recorded');
  });

  test('PARTS_VERDICT_UNREAD: a verdict path that leaves the project', () => {
    only(checkProject(project({}, (p) => { obj(partsReviewSignoff(p).evidence).path = '../parts-review.json'; })), 'PARTS_VERDICT_UNREAD');
  });

  test('PARTS_VERDICT_SCHEMA_UNKNOWN: unknown /3 stays refused', () => {
    only(checkProject(project({ edit: (v) => { v.schema = 'rig-review-parts-verdict/3'; } })), 'PARTS_VERDICT_SCHEMA_UNKNOWN');
  });

  test('PARTS_VERDICT_ATLAS: an atlas-mode verdict is informational and never gates parts-review', () => {
    const message = only(checkProject(project({ mode: 'atlas' })), 'PARTS_VERDICT_ATLAS');
    expect(message).toContain('never gates');
  });

  test('PARTS_VERDICT_MALFORMED: a mode that is neither parts nor atlas', () => {
    only(checkProject(project({ edit: (v) => { v.mode = 'sheet'; } })), 'PARTS_VERDICT_MALFORMED');
  });

  test('PARTS_VERDICT_MALFORMED: no source files, or parts.json not first', () => {
    only(checkProject(project({ edit: (v) => { (v.source as JsonObject).files = []; } })), 'PARTS_VERDICT_MALFORMED');
    only(
      checkProject(project({ edit: (v) => { const s = v.source as { files: unknown[] }; s.files = [...s.files.slice(1), s.files[0]]; } })),
      'PARTS_VERDICT_MALFORMED',
    );
  });

  test('PARTS_VERDICT_NOT_APPROVED: pending, or changes requested', () => {
    expect(only(checkProject(project({ status: 'pending' })), 'PARTS_VERDICT_NOT_APPROVED')).toContain('"pending"');
    expect(only(checkProject(project({ status: 'changes-requested' })), 'PARTS_VERDICT_NOT_APPROVED')).toContain('"changes-requested"');
  });

  test('PARTS_VERDICT_SOURCE_CHANGED: a part repainted after the sign-off', () => {
    const dir = project({}, () => {}, { [`${EXAMPLE_PARTS_DIR}/parts/torso.png`]: `${asciiPartImage('torso')}repainted\n` });
    const report = checkProject(dir);
    expect(only(report, 'PARTS_VERDICT_SOURCE_CHANGED')).toContain('parts/torso.png');
  });

  test('PARTS_VERDICT_SOURCE_CHANGED: a part removed after the sign-off', () => {
    const dir = project();
    rmSync(join(dir, EXAMPLE_PARTS_DIR, 'parts', 'lantern.png'));
    expect(only(checkProject(dir), 'PARTS_VERDICT_SOURCE_CHANGED')).toContain('parts/lantern.png is not on disk');
  });

  test('PARTS_VERDICT_SOURCE_CHANGED: same sha256 recorded, other byte count', () => {
    const dir = project({ edit: (v) => { const f = (v.source as { files: JsonObject[] }).files[1] as JsonObject; f.bytes = Number(f.bytes) + 1; (v.source as JsonObject).sha256 = sourceSha256((v.source as { files: { path: string; sha256: string }[] }).files); } });
    only(checkProject(dir), 'PARTS_VERDICT_SOURCE_CHANGED');
  });

  test('PARTS_VERDICT_SOURCE_MISMATCH: source.sha256 is recomputed, never trusted', () => {
    const message = only(checkProject(project({ edit: (v) => { (v.source as JsonObject).sha256 = 'f'.repeat(64); } })), 'PARTS_VERDICT_SOURCE_MISMATCH');
    expect(message).toContain('hash to');
  });

  test('every refusal found is reported: not approved and a part changed, together', () => {
    const dir = project({ status: 'pending' }, () => {}, { [`${EXAMPLE_PARTS_DIR}/parts/torso.png`]: 'changed\n' });
    expect(verdictCodes(checkProject(dir)).sort()).toEqual(['PARTS_VERDICT_NOT_APPROVED', 'PARTS_VERDICT_SOURCE_CHANGED']);
  });

});

describe('the reach: the parts gate rigging until a rig version is accepted at rig-review', () => {
  /** A fresh clone: derived/ is ignored by git, so the verdict and the parts are not there. */
  const freshClone = (dir: string): string => {
    rmSync(join(dir, 'derived'), { recursive: true, force: true });
    return dir;
  };

  test('an accepted project with the verdict and the parts missing is not refused', () => {
    expect(checkProject(freshClone(fixture())).refusals).toEqual([]);
  });

  test('the filled example at stage rigging on a fresh clone: the verdict is tracked, the parts must be on disk', () => {
    const dir = freshClone(fixture((p) => { atRiggingStart(p); }));
    expect(new Set(verdictCodes(checkProject(dir)))).toEqual(new Set(['PARTS_VERDICT_SOURCE_CHANGED']));
  });

  test('the same project at stage rigging is refused', () => {
    expect(verdictCodes(checkProject(freshClone(project())))).toEqual(['PARTS_VERDICT_UNREAD']);
  });

  test('a part repainted during rigging is still refused', () => {
    const dir = project({}, (p) => { step(p, 'bones').status = 'done'; }, { [`${EXAMPLE_PARTS_DIR}/parts/background.png`]: 'changed\n' });
    expect(verdictCodes(checkProject(dir))).toEqual(['PARTS_VERDICT_SOURCE_CHANGED']);
  });

  test('past rigging with no rig version accepted yet, the verdict is still read', () => {
    const dir = project({}, (p) => { p.stage = 'rig-review'; });
    rmSync(join(dir, EXAMPLE_PARTS_DIR, 'parts', 'torso.png'));
    expect(verdictCodes(checkProject(dir))).toEqual(['PARTS_VERDICT_SOURCE_CHANGED']);
  });

  test('after rig-review acceptance a repainted part is not re-read here', () => {
    const dir = fixture(() => {}, 'legacy-example-project.json', { [`${EXAMPLE_PARTS_DIR}/parts/background.png`]: 'changed\n' });
    expect(verdictCodes(checkProject(dir))).toEqual([]);
  });
});

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/** Moves every timestamp in the record back by `days` (as in tests/parts-review.test.ts). */
function shiftDates(v: Json, days: number): Json {
  if (typeof v === 'string') return ISO.test(v) ? new Date(Date.parse(v) - days * 86_400_000).toISOString() : v;
  if (Array.isArray(v)) return v.map((x) => shiftDates(x, days));
  if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shiftDates(x, days)]));
  return v;
}

describe('a project that passed plan-approved before the stages existed', () => {
  test('keeps the warning and is not asked for a verdict', () => {
    const dir = historicalFixture((p) => {
      const shifted = obj(shiftDates(p, 30));
      for (const k of Object.keys(p)) delete p[k];
      Object.assign(p, shifted);
      rehashSignoffs(p);
      p.stage_values = STAGE_VALUES.filter((s) => s !== 'parts' && s !== 'parts-review');
      p.signoffs = arr(p.signoffs).filter((s) => obj(s).stage !== 'parts-review');
      for (const s of arr(p.signoffs).map(obj)) if (s.stage === 'parts') s.stage = 'rigging';
    });
    const report = checkProject(dir);
    expect(report.refusals).toEqual([]);
    expect(report.warnings.map((w) => w.code).sort()).toEqual(['CHOICE_ANSWERS_LEGACY', 'CORRECTION_PATH_LEGACY', 'PARTS_REVIEW_PREDATES_STAGE', 'QUESTION_SET_STALE', 'SIGNOFF_ANSWERS_MISSING_LEGACY', 'SIGNOFF_ANSWERS_MISSING_LEGACY', 'SIGNOFF_ANSWERS_MISSING_LEGACY', 'SIGNOFF_ANSWERS_MISSING_LEGACY', 'STAGE_ORDER_LEGACY', 'STAGE_VALUES_STALE']);
  });
});

describe('an in-flight project that a person did review', () => {
  test('passes with one build-identity WARN per rig version without requiring a legacy verdict', () => {
    const dir = historicalFixture((p) => {
      const shifted = obj(shiftDates(p, 30));
      for (const k of Object.keys(p)) delete p[k];
      Object.assign(p, shifted);
      rehashSignoffs(p);
      p.stage_values = STAGE_VALUES.filter((s) => s !== 'parts' && s !== 'parts-review');
      for (const s of arr(p.signoffs).map(obj)) if (s.stage === 'parts') s.stage = 'rigging';
      delete partsReviewSignoff(p).evidence;
    });
    const report = checkProject(dir);
    expect(report.refusals).toEqual([]);
    expect(report.warnings.map((w) => w.code)).toEqual(['STAGE_VALUES_STALE', 'SIGNOFF_ANSWERS_MISSING_LEGACY', 'SIGNOFF_ANSWERS_MISSING_LEGACY', 'SIGNOFF_ANSWERS_MISSING_LEGACY', 'SIGNOFF_ANSWERS_MISSING_LEGACY', 'QUESTION_SET_STALE', 'REVIEW_PACKAGE_PARTS_UNREAD', 'REVIEW_PACKAGE_PARTS_UNREAD', 'STAGE_ORDER_LEGACY', 'CHOICE_ANSWERS_LEGACY', 'CORRECTION_PATH_LEGACY']);
  });
});

describe('the filled example', () => {
  test("its parts-review sign-off names the verdict the fixture writes, by path and sha256", () => {
    const pkg = partsPackage({ verdict: EXAMPLE_VERDICT });
    const dir = fixture();
    const example = arr(readTemplate('legacy-example-project.json').signoffs).map(obj).find((s) => s.stage === 'parts-review');
    expect(example?.evidence).toEqual(evidenceFor(pkg));
    expect(checkProject(dir).refusals).toEqual([]);
  });
});

describe('containment follows links: a symlink out of the project is an escape', () => {
  /** Moves `rel` (a file or folder under `dir`) to `to` and leaves a real symlink in its place. */
  function relink(dir: string, rel: string, to: string): void {
    mkdirSync(dirname(to), { recursive: true });
    renameSync(join(dir, rel), to);
    symlinkSync(to, join(dir, rel));
  }

  test('a symlinked folder holding the verdict, pointing outside the project: refused', () => {
    const dir = project({ verdict: 'verdicts/parts-review.json' });
    relink(dir, 'verdicts', join(tempDir(), 'elsewhere'));
    const message = only(checkProject(dir), 'PARTS_VERDICT_UNREAD');
    expect(message).toContain('not under the project');
  });

  test('a symlinked source file pointing outside the project: refused', () => {
    const dir = project();
    relink(dir, `${EXAMPLE_PARTS_DIR}/parts/torso.png`, join(tempDir(), 'torso.png'));
    const message = only(checkProject(dir), 'PARTS_VERDICT_MALFORMED');
    expect(message).toContain('parts/torso.png is not under the project');
  });

  test('a broken source link is a part not on disk', () => {
    const dir = project();
    const outside = join(tempDir(), 'torso.png');
    relink(dir, `${EXAMPLE_PARTS_DIR}/parts/torso.png`, outside);
    rmSync(outside);
    only(checkProject(dir), 'PARTS_VERDICT_SOURCE_CHANGED');
  });

  test('symlinks that stay inside the project: accepted', () => {
    const dir = project({ verdict: 'evidence/parts-review.json' });
    relink(dir, `${EXAMPLE_PARTS_DIR}/parts/torso.png`, join(dir, 'scratch', 'torso.png'));
    relink(dir, 'evidence', join(dir, 'scratch', 'evidence'));
    expect(checkProject(dir).refusals).toEqual([]);
  });
});

afterEach(() => setSystemTime());
