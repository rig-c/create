/**
 * Which option context a post set takes once a scene exists (#216). Every
 * record comes from the public writers on a copy of the writer-built example
 * chain, plus the chain's one declared seed kind for a new rig version.
 */
import { afterEach, expect, test } from 'bun:test';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { SCENE_CONTEXT_SINCE, optionContext, sha256 } from '../src/choices.ts';
import { asArray, isObject } from '../src/check.ts';
import { currentScene, sceneReference } from '../src/scene.ts';
import type { JsonObject } from '../src/templates.ts';
import { tempDir } from './helpers.ts';
import { advanceCommand, checkProject, interviewAnswerCommand, interviewOptionsCommand, main, reopenCommand, reviewCommand, sceneCommand, signoffCommand, testClock } from './clock.ts';

afterEach(() => testClock.reset());
const load = (dir: string): JsonObject => JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
const words = (dir: string): string => { const path = join(dir, 'words.txt'); writeFileSync(path, 'Revise the synthetic example.'); return path; };
let base = Date.parse('2026-11-08T12:00:00Z');
afterEach(() => { base = Date.parse('2026-11-08T12:00:00Z'); });
const tick = (seconds: number): void => testClock.set(base + seconds * 1000);

/** The finished example chain: scene s1 on accepted rig v1, then a post accepted at direction-review. */
function chainProject(): string {
  const root = join(import.meta.dir, '../templates/example-chain');
  const dir = join(tempDir(), 'project');
  cpSync(root, dir, { recursive: true, filter: source => !source.slice(root.length).split(sep).includes('checkpoints') });
  return dir;
}
function reopen(dir: string, stage: string): void { reopenCommand([stage, dir, '--by', 'user', '--verbatim-file', words(dir)]); }
/** The agent drafts a post_composition set against the context create projects at that instant. */
function draft(dir: string, id: string, context: JsonObject): string {
  const set = JSON.parse(readFileSync(join(dir, 'evidence/interview/post_composition.json'), 'utf8')) as JsonObject;
  const path = `evidence/interview/${id}.json`;
  writeFileSync(join(dir, path), `${JSON.stringify({ ...set, id, drafted_at: testClock.iso(), context }, null, 2)}\n`);
  return path;
}
function register(dir: string, path: string): void { interviewOptionsCommand(['post_composition', dir, '--file', path]); }
function refused(code: string, run: () => unknown, dir: string): void {
  const before = readFileSync(join(dir, 'project.json'));
  expect(run).toThrow(expect.objectContaining({ code }));
  expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
}
const scene = (dir: string): JsonObject => ({ kind: 'scene', scene: sceneReference(currentScene(load(dir))!) });
const at = (): number => testClock.now();
const answer = (dir: string, set: string) => () => interviewAnswerCommand(['post_composition', dir, '--set', set, '--sha256', sha256(readFileSync(join(dir, set))), '--by', 'user', '--pick', 'post_composition=keep']);
const optionCodes = (dir: string): string[] => checkProject(dir).refusals.filter(f => f.path.startsWith('interview.post.items[')).map(f => f.code);

/** A new rig v3 accepted after s1, through review-package, review and signoff, from tick `start`. */
function acceptNewRig(dir: string, start = 0): void {
  const tick = (seconds: number): void => testClock.set(base + (start + seconds) * 1000);
  tick(0); reopen(dir, 'rig-review');
  const p = load(dir);
  const v1 = asArray(p.versions).filter(isObject).find(v => v.n === 1)!;
  tick(1);
  // The chain's declared seed kind: one new rig version declaration, no binding fields.
  const { review_package: _package, ...declaration } = structuredClone(v1);
  p.versions = [...asArray(p.versions), { ...declaration, n: 3, at: testClock.iso(), verdicts: [] }];
  writeFileSync(join(dir, 'project.json'), `${JSON.stringify(p, null, 2)}\n`);
  tick(2); expect(main(['review-package', '3', dir, '--config', 'evidence/v1/config.json', '--from', 'outputs/v1/out'])).toBe(0);
  tick(3); reviewCommand(['3', dir, '--verdict', 'accepted', '--by', 'user', '--review', 'rig-review', '--verbatim-file', words(dir), '--source', 'synthetic example']);
  tick(4); signoffCommand(['rig-review', dir, '--by', 'user', '--verbatim-file', words(dir), '--version', '3']);
  tick(5); advanceCommand(['post-interview', dir, '--by', 'user', '--verbatim-file', words(dir)]);
}

test('(a) a rig accepted after the scene anchors post sets on that rig, never on the previous rig\'s scene', () => {
  const dir = chainProject(); acceptNewRig(dir);
  tick(6);
  const context = optionContext(load(dir), 'post-interview', at(), dir);
  expect(context.kind).toBe('rig');
  expect(context.rig_version).toBe(3);
  register(dir, draft(dir, 'post-composition-rig', context));
  tick(7);
  refused('INTERVIEW_OPTIONS_STALE', () => register(dir, draft(dir, 'post-composition-scene', scene(dir))), dir);
  expect(checkProject(dir).refusals).toEqual([]);
});

test('(b) a scene current on the live accepted rig anchors post sets after a post-interview bounce', () => {
  const dir = chainProject();
  tick(0); reopen(dir, 'post-interview');
  tick(1);
  const context = optionContext(load(dir), 'post-interview', at(), dir);
  expect(context).toEqual(scene(dir));
  const path = draft(dir, 'post-composition-scene', context);
  register(dir, path);
  expect(checkProject(dir).refusals).toEqual([]);
  // A later scene write makes the set stale; so does a changed scene file.
  tick(2); sceneCommand(['write', '--rig', '1', '--background', 'inputs/background.png', '--citations-file', 'evidence/scene-citations.json', '--by', 'user', dir]);
  refused('INTERVIEW_OPTIONS_STALE', answer(dir, path), dir);
  tick(3);
  const fresh = draft(dir, 'post-composition-s2', optionContext(load(dir), 'post-interview', at(), dir));
  expect(JSON.parse(readFileSync(join(dir, fresh), 'utf8')).context).toEqual(scene(dir));
  register(dir, fresh);
  writeFileSync(join(dir, 'evidence/scene/s2.json'), '{}');
  refused('INTERVIEW_OPTIONS_STALE', answer(dir, fresh), dir);
});

test('(c) reopening rig-review after the scene leaves no post context until a rig is accepted again', () => {
  const dir = chainProject();
  tick(0); reopen(dir, 'post-interview');
  tick(1); const before = draft(dir, 'post-composition-before', optionContext(load(dir), 'post-interview', at(), dir));
  register(dir, before);
  tick(2); reopen(dir, 'rig-review');
  tick(3);
  expect(() => optionContext(load(dir), 'post-interview', at(), dir)).toThrow(expect.objectContaining({ code: 'INTERVIEW_OPTIONS_STALE' }));
  // The set drafted before the reopen is stale by the existing reopen rule.
  refused('INTERVIEW_OPTIONS_STALE', answer(dir, before), dir);
});

test('currentness is read at the instant in question: a scene-kind answer stays valid after a later rig is accepted', () => {
  const dir = chainProject();
  tick(0); reopen(dir, 'post-interview');
  tick(1); const path = draft(dir, 'post-composition-scene', optionContext(load(dir), 'post-interview', at(), dir));
  register(dir, path);
  tick(2); answer(dir, path)();
  acceptNewRig(dir, 3);
  tick(10);
  expect(optionContext(load(dir), 'post-interview', at(), dir).kind).toBe('rig');
  expect(optionContext(load(dir), 'post-interview', base + 1000, dir)).toEqual(scene(dir));
  expect(optionCodes(dir)).toEqual([]);
});

test('the three-argument call keeps its rig kind with no scene, and refuses by name when a scene needs the folder', () => {
  const root = join(import.meta.dir, '../templates/example-chain/checkpoints/4-direction-post');
  const project = JSON.parse(readFileSync(join(root, 'project.json'), 'utf8')) as JsonObject;
  expect(project.scenes).toBeUndefined();
  expect(optionContext(project, 'post-interview', at()).kind).toBe('rig');
  const dir = chainProject();
  expect(() => optionContext(load(dir), 'post-interview', at())).toThrow(expect.objectContaining({ code: 'INTERVIEW_OPTIONS_STALE', message: expect.stringContaining('needs the project folder') }));
});

const sinceOffset = (seconds: number): number => Date.parse(SCENE_CONTEXT_SINCE) + seconds * 1000;
for (const offset of [-1, 0, 1]) {
  test(`SCENE_CONTEXT_SINCE dates a scene-kind set on a stale scene drafted at ${new Date(sinceOffset(offset)).toISOString()}`, () => {
    const dir = chainProject();
    base = sinceOffset(offset) - 6000; acceptNewRig(dir);
    tick(6);
    const path = draft(dir, 'post-composition-scene', scene(dir));
    if (offset >= 0) { refused('INTERVIEW_OPTIONS_STALE', () => register(dir, path), dir); return; }
    // Before the date the set keeps the verdict of its day, with a WARN on each record that relies on it.
    register(dir, path);
    const pending = checkProject(dir);
    expect(pending.refusals).toEqual([]);
    expect(pending.warnings.filter(w => w.code === 'INTERVIEW_OPTIONS_SCENE_LEGACY').map(w => w.path)).toEqual([expect.stringMatching(/\.pending_options$/)]);
    tick(7); answer(dir, path)();
    const answered = checkProject(dir);
    expect(answered.refusals).toEqual([]);
    const warned = answered.warnings.filter(w => w.code === 'INTERVIEW_OPTIONS_SCENE_LEGACY');
    expect(warned.length).toBe(1);
    expect(warned[0]!.message).toContain('redraft against the current context');
  });
}
