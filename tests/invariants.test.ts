import { retainSignoffs } from './fixtures.ts';
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RigInvariants } from '@rig-c/core/rig';
import { translateInvariants, type InvariantsDocument } from '../src/invariants.ts';
import { readTemplate, type Json, type JsonObject } from '../src/templates.ts';
import { generateInvariantsExample } from '../scripts/generate-invariants-example.ts';
import { tempDir } from './helpers.ts';
import { stageIndex } from '../src/stages.ts';
import { arr, fixture, obj, waypoint } from './fixtures.ts';
import { checkProject, interviewAnswerCommand, interviewOptionsCommand, testClock } from './clock.ts';

const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const answer = (value: Json, verbatim = 'Keep the stated direction.'): JsonObject => ({ delegated: false, value, verbatim });
const project = (guide: Json): JsonObject => ({ interview: { waypoints: [{ id: 'motion', guide }] } });
const path = 'interview.waypoints[motion].guide';

// Independent census of CURRENT normalized readings: not discovered from translator output.
const EXPECTED: Record<string, Json[]> = {
  rig_type: ['character.idle'], reference: ['none'],
  seethrough: ['synthetic layers on the approved parts', 'synthetic resolution on the approved parts', 'synthetic head_crop on the approved parts', 'synthetic seed on the approved parts'],
  assemble: ['core', 'plain', ...['cut', 'emphasis', 'draw_order', 'authored', 'occluders', 'outfits'].map(k => `synthetic ${k} on the approved parts`)],
  bones: ['synthetic chains on the approved parts', 'synthetic placement on the approved parts', 'synthetic length on the approved parts'],
  meshes: ['synthetic bend on the approved parts', 'synthetic rigid on the approved parts', 'synthetic density on the approved parts'],
  constraints: ['synthetic effects on the approved parts', 'synthetic strength on the approved parts', 'synthetic extent on the approved parts', 'synthetic gravity on the approved parts', 'synthetic stops on the approved parts'],
  motion: ['synthetic tracks on the approved parts', 'synthetic extent on the approved parts', 'synthetic speed on the approved parts', 'synthetic loop on the approved parts', 'synthetic blink on the approved parts'],
  camera_depth: ['push_in', false], post_timing: [8, true, 'beam sweep', 'near the end'], post_composition: ['lighthouse fully in frame', 'as painted'],
};
// Substring retention checks only; these do not prove per-concept semantic coverage.
const WORDS: Record<string, string[]> = {
  rig_type: ['standing character', 'idle', 'lantern'],
  assemble: ['joints', 'face exactly as painted', 'lantern is its own part', 'rest is up to you', 'core projection'],
  camera_depth: ['slow push-in', 'no parallax'],
  post_timing: ['Eight seconds', 'looping', 'beam', 'once', 'near the end'],
  post_composition: ['whole lighthouse in frame', "night; don't brighten it"],
};

/** Reused unchanged for the green document and a disabled INPUT control. */
function expectExampleRetention(doc: InvariantsDocument): void {
  expect(doc.sources.map(s => s.question)).toEqual(Object.keys(EXPECTED));
  for (const [question, values] of Object.entries(EXPECTED)) {
    expect(doc.gaps.filter(g => g.from.question === question && g.gap === 'vocabulary').map(g => g.value)).toEqual(values);
    const prose = doc.gaps.filter(g => g.from.question === question && g.gap === 'sentence_semantics');
    expect(prose).toHaveLength(1);
    for (const word of WORDS[question] ?? []) expect(prose[0]?.sentence).toContain(word);
  }
}

describe('current worked example, including words not in normalized values', () => {
  test('retains expected normalized leaves and whole sentences containing the named words', () => {
    const doc = translateInvariants(readTemplate('example-project.json'));
    expectExampleRetention(doc);
    expect(doc.entries).toEqual([]); // Current synthetic readings cannot justify structural assertions.
    expect(doc.gaps.filter(g => g.gap.startsWith('pending'))).toEqual([]);
    const bytes = JSON.stringify(doc);
    for (const historical of ['a little more than the coat tails', 'flame_flicker', 'coat_tail_l', 'swing on its own']) expect(bytes).not.toContain(historical);
  });
  test('disabled input controls: missing sentence or normalized leaf makes the same retention census red', () => {
    const doc = translateInvariants(readTemplate('example-project.json'));
    const disabled = { ...doc, gaps: doc.gaps.filter(g => g.from.question !== 'post_timing' || g.gap !== 'sentence_semantics') };
    expect(() => expectExampleRetention(disabled)).toThrow();
    const missingLeaf = { ...doc, gaps: doc.gaps.filter(g => g.from.question !== 'post_timing' || g.gap !== 'vocabulary' || g.value !== 8) };
    expect(() => expectExampleRetention(missingLeaf)).toThrow();
  });
  test('generated bytes are reproducible from the active template', () => {
    const bytes = generateInvariantsExample(join(tempDir(), 'fresh'));
    expect(bytes).toBe(readFileSync(join(import.meta.dir, '../templates/example-invariants/invariants.json'), 'utf8'));
    expect(() => generateInvariantsExample(tempDir())).toThrow();
  });
});

test('explicit structural readings copy exact core vocabulary, never infer exemptions', () => {
  const value = {
    meshSlots: 2, meshTriangles: 20, axisBone: 'axis', massBone: 'mass',
    axes: [{ name: 'face', through: ['left', 'right'], bones: ['eye'], tolerance: 1 }],
    detached: [{ bone: 'lamp', notUnder: 'arm', why: 'independent parentage' }],
    deformMayFold: [{ slot: 'page', why: 'deliberate page fold' }],
    consumerDrivenMix: [{ constraint: 'look', type: 'ik', why: 'consumer sets mix' }],
    idleDrivesMeshes: { why: 'idle intentionally drives meshes' },
  } satisfies RigInvariants;
  const doc = translateInvariants(project(answer(value)));
  expect(doc.entries.map(e => e.invariant)).toEqual(Object.entries(value).map(([k, v]) => ({ [k]: v })));
  expect(doc.entries.every(e => e.from.question === 'motion' && e.from.verbatim_sha256 === sha('Keep the stated direction.'))).toBe(true);
  expect(doc.gaps.map(g => g.gap)).toEqual(['sentence_semantics']);
  const arbitrary = translateInvariants(project(answer([{ part: 'bust', effect: 'jiggle', extent: 'not below waist' }], 'Cut the bust, not the waist; it must jiggle.')));
  expect(arbitrary.entries).toEqual([]);
  expect(arbitrary.gaps.filter(g => g.gap === 'vocabulary').map(g => g.value)).toEqual(['bust', 'jiggle', 'not below waist']);
});

test('invalid/retired/unknown structural shapes keep all fields as gaps', () => {
  const value: JsonObject = { axes: [{ name: 'face', through: ['a', 'a'], bones: ['b'], tolerance: 90 }], idleDrivesMeshes: { why: '' }, deformMayFold: [{ slot: 'x', why: 'fold', extra: 'retain me' }], consumerDrivenMix: [{ constraint: 'x', type: 'physics', why: 'wind' }], meshSlots: -1, editorRoundTrip: true, future: {} };
  const doc = translateInvariants(project(answer(value)));
  expect(doc.entries).toEqual([]);
  expect(doc.gaps.some(g => g.value === 'retain me')).toBe(true);
  expect(doc.gaps.some(g => g.value_path.endsWith('["editorRoundTrip"]') && g.value === true)).toBe(true);
  expect(doc.gaps.some(g => g.value_path.endsWith('["future"]') && JSON.stringify(g.value) === '{}')).toBe(true);
});

test('consumerDrivenMix accepts the scalar type only; array coercion remains vocabulary', () => {
  const row = { constraint: 'look', why: 'consumer sets mix' };
  // Paired input control: changing only the type's shape switches entry to gap.
  for (const type of ['ik', 'transform'] as const) {
    const scalar = translateInvariants(project(answer({ consumerDrivenMix: [{ ...row, type }] })));
    expect(scalar.entries.map(e => e.invariant)).toEqual([{ consumerDrivenMix: [{ ...row, type }] }]);
    const array = translateInvariants(project(answer({ consumerDrivenMix: [{ ...row, type: [type] }] })));
    expect(array.entries).toEqual([]);
    expect(array.gaps.filter(g => g.gap === 'vocabulary').map(g => g.value)).toEqual(['look', 'consumer sets mix', type]);
    expect(array.gaps.find(g => g.value === type)?.value_path).toBe(`${path}.value["consumerDrivenMix"][0]["type"][0]`);
  }
});

/** Actual option registration and answer writer, then checkProject and translation of disk bytes. */
function writtenMotion(otherPending = false): InvariantsDocument {
  try {
    const dir = fixture(p => {
      p.stage = 'rigging-interview'; p.versions = []; p.scenes = []; delete p.direction_contract;
      retainSignoffs(p, s => stageIndex(String(obj(s).stage)) < stageIndex('rigging-interview'));
      for (const step of arr(obj(p.plan).steps).map(obj)) if (!['seethrough', 'assemble'].includes(String(step.id))) step.status = 'pending';
      for (const item of arr(obj(obj(p.interview).post).items).map(obj)) item.guide = null;
    }, 'example-project.json');
    const load = (): JsonObject => JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'));
    const binding = obj(obj(obj(waypoint(load(), 'motion').guide).choice).set);
    const set: JsonObject = JSON.parse(readFileSync(join(dir, String(binding.path)), 'utf8'));
    set.id = 'invariants-motion'; set.drafted_at = '2026-11-11T11:20:00Z';
    const setPath = 'evidence/interview/invariants-motion.json';
    const bytes = `${JSON.stringify(set, null, 2)}\n`;
    writeFileSync(join(dir, setPath), bytes);
    writeFileSync(join(dir, 'other.txt'), 'Allow this deliberate page fold.\n');
    const fragment = { deformMayFold: [{ slot: 'page', why: 'deliberate page fold' }] };
    writeFileSync(join(dir, 'fragment.json'), JSON.stringify(fragment));
    testClock.set(new Date('2026-11-11T11:21:00Z'));
    interviewOptionsCommand(['motion', dir, '--file', setPath]);
    const picks = arr(set.asks).flatMap(a => ['--pick', `${String(obj(a).id)}=${obj(a).id === 'tracks' || (otherPending && obj(a).id === 'extent') ? 'other' : 'keep'}`]);
    interviewAnswerCommand(['motion', dir, '--set', setPath, '--sha256', sha(bytes), '--by', 'user', ...picks,
      '--other', `tracks=${join(dir, 'other.txt')}`, '--other-fragment', `tracks=${join(dir, 'fragment.json')}`,
      ...(otherPending ? ['--other', `extent=${join(dir, 'other.txt')}`] : [])]);
    const p = load();
    expect(obj(waypoint(p, 'motion').guide).value).toEqual(otherPending ? null : { ...fragment, extent: 'synthetic extent on the approved parts', speed: 'synthetic speed on the approved parts', loop: 'synthetic loop on the approved parts', blink: 'synthetic blink on the approved parts' });
    const checked = checkProject(dir);
    expect(checked.ok).toBe(true); expect(checked.refusals).toEqual([]);
    return translateInvariants(p);
  } finally { testClock.reset(); }
}

test('writer Other deformMayFold translates exactly once, including with a pending Other sibling', () => {
  for (const pending of [false, true]) {
    const doc = writtenMotion(pending);
    expect(doc.entries).toHaveLength(1);
    expect(doc.entries[0]?.invariant).toEqual({ deformMayFold: [{ slot: 'page', why: 'deliberate page fold' }] });
    expect(doc.entries[0]?.value_path).toBe(pending ? `${path}.choice.picks[0].other_fragment["deformMayFold"]` : `${path}.value["deformMayFold"]`);
    expect(doc.gaps.filter(g => g.gap === 'pending_other')).toHaveLength(pending ? 1 : 0);
    // Ordinary option siblings are retained in sources, but their fragments are not reconstructed.
    expect(doc.gaps.some(g => g.value === 'synthetic speed on the approved parts')).toBe(!pending);
  }
});

test('raw UTF-8 binding, deterministic paths, deep-copy purity, false/zero/null/empty survive', () => {
  const words = '바람.\r\ne\u0301  \n';
  const input = project(answer({ 'a.b': [false, 0, null, [], {}] }, words));
  const before = JSON.stringify(input);
  const doc = translateInvariants(input);
  expect(doc.gaps.every(g => g.from.verbatim_sha256 === sha(words) && g.sentence === words)).toBe(true);
  expect(doc.gaps.filter(g => g.gap === 'vocabulary').map(g => g.value)).toEqual([false, 0, null, [], {}]);
  expect(doc.gaps[1]?.value_path).toBe(`${path}.value["a.b"][0]`);
  expect(JSON.stringify(translateInvariants(input))).toBe(JSON.stringify(doc));
  doc.sources[0]!.record = null;
  expect(JSON.stringify(input)).toBe(before);
  expect(translateInvariants(project(answer({}, words.trim()))).gaps[0]?.from.verbatim_sha256).not.toBe(sha(words));
});

describe('state × translator readers (source / normalized reading / pending gap)', () => {
  test('legacy full delegation pending and decided; stale user value cannot become an invariant', () => {
    const pending = translateInvariants(project({ delegated: true, verbatim: 'auto', value: { meshSlots: 99 } }));
    expect(pending.entries).toEqual([]);
    expect(pending.gaps.some(g => g.gap === 'pending_delegation')).toBe(true);
    const decided = translateInvariants(project({ delegated: true, verbatim: 'auto', agent_decision: { value: { meshSlots: 2 }, reasoning: 'budget', by: 'agent' } }));
    expect(decided.entries[0]?.value_path).toBe(`${path}.agent_decision.value["meshSlots"]`);
    expect(decided.gaps.some(g => g.gap === 'pending_delegation')).toBe(false);
  });
  test('legacy user and partial delegated reading, additions, and history exclusion', () => {
    const guide = answer([{ motion: 'breath' }], 'Breath. The rest is yours.');
    guide.agent_decision = { covers: 'loop', value: { loop_seconds: 8 }, reasoning: 'one cycle' };
    guide.additions = [{ verbatim: 'The lamp must swing independently.', value: [{ hinge: 'lamp', from: 'hand' }], by: 'user' }];
    const p = project(guide);
    const w = ((p.interview as JsonObject).waypoints as JsonObject[])[0]!;
    w.history = [answer({ old: 'DO NOT RESURRECT' })];
    const doc = translateInvariants(p);
    expect(doc.sources).toHaveLength(2);
    expect(doc.gaps.filter(g => g.gap === 'vocabulary').map(g => g.value)).toEqual(['breath', 8, 'lamp', 'hand']);
    expect(doc.gaps.filter(g => g.gap === 'malformed_answer' || g.gap === 'pending_delegation')).toEqual([]);
    expect(JSON.stringify(doc)).not.toContain('DO NOT RESURRECT');
    expect(doc.gaps.find(g => g.source_path.endsWith('.additions[0]'))?.from.verbatim_sha256).toBe(sha('The lamp must swing independently.'));
  });
  test('current choices: user + auto pending/decided preserve both contributions', () => {
    const guide = answer({ tracks: 'blink' }, 'Blink. Let the agent decide the speed.');
    guide.asks = [{ id: 'tracks', state: 'user' }, { id: 'speed', state: 'delegated' }];
    guide.choice = { picks: [{ ask: 'tracks', option_id: 'keep' }, { ask: 'speed', option_id: 'auto' }] };
    guide.agent_decision = { covers: 'speed' };
    const pending = translateInvariants(project(guide));
    expect(pending.gaps.filter(g => g.gap === 'pending_delegation')).toHaveLength(1);
    expect(pending.gaps.some(g => g.value === 'blink')).toBe(true);
    guide.agent_decision = { covers: 'speed', value: { speed: 'slow' }, reasoning: 'subtle', fragments: [{ ask: 'speed', fragment: { speed: 'slow' } }] };
    const decided = translateInvariants(project(guide));
    expect(decided.gaps.filter(g => g.gap === 'vocabulary').map(g => g.value)).toEqual(['blink', 'slow']);
    expect(decided.gaps.filter(g => g.gap === 'pending_delegation')).toEqual([]);
    (guide.agent_decision as JsonObject).fragments = [];
    expect(translateInvariants(project(guide)).gaps.some(g => g.gap === 'pending_delegation')).toBe(true);
  });
  test('all-auto choices pending/decided and Other with fragment / sibling pending', () => {
    const guide: JsonObject = { delegated: true, verbatim: 'Let the agent decide.', asks: [{ id: 'tracks', state: 'delegated' }], choice: { picks: [{ ask: 'tracks', option_id: 'auto' }] } };
    expect(translateInvariants(project(guide)).gaps.some(g => g.gap === 'pending_delegation')).toBe(true);
    guide.agent_decision = { value: ['blink'], reasoning: 'idle', fragments: [{ ask: 'tracks', fragment: ['blink'] }] };
    expect(translateInvariants(project(guide)).gaps.filter(g => g.gap === 'vocabulary').map(g => g.value)).toEqual(['blink']);
    const other = answer(null, 'Other\nKeep the wings.\nOther\nLater.');
    other.asks = [{ id: 'parts', state: 'user' }, { id: 'extent', state: 'other-pending' }];
    other.choice = { picks: [{ ask: 'parts', other_text: 'Keep the wings.  \n', other_fragment: { part: 'wings' } }, { ask: 'extent', other_text: 'Later.' }] };
    const pending = translateInvariants(project(other));
    expect(pending.gaps.some(g => g.value === 'wings')).toBe(true);
    expect(pending.gaps.some(g => g.value === 'Keep the wings.  \n')).toBe(true);
    expect(pending.gaps.filter(g => g.gap === 'pending_other')).toHaveLength(1);
    other.value = { part: 'wings', extent: 'tip' }; other.asks = [{ id: 'parts', state: 'user' }, { id: 'extent', state: 'user' }];
    const complete = translateInvariants(project(other));
    expect(complete.gaps.some(g => g.gap === 'pending_other')).toBe(false);
    expect(complete.gaps.filter(g => g.gap === 'vocabulary').map(g => g.value)).toEqual(['wings', 'tip']);
  });
  test.each([null, { not_applicable: true, because: 'no post' }, { basis: 'inherited', from: { collection: 'synthetic', question: 'motion' } }, { delegated: false, value: { meshSlots: 2 } }])('explicitly retains absent, N/A, inherited, malformed (%j)', raw => {
    const doc = translateInvariants(project(raw as Json));
    expect(doc.sources[0]?.record).toEqual(raw as Json);
    expect(doc.entries).toEqual([]);
    expect(doc.gaps.length).toBeGreaterThan(0);
    expect(doc.gaps.every(g => g.from.verbatim_sha256 === null)).toBe(true);
  });
});
