import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type Finding } from '../src/check.ts';
import { CHOICE_ORDER_SPEC, CHOICE_SPEC, OPTIONS_SPEC, optionContext } from '../src/choices.ts';
import { objects } from '../src/direction.ts';
import { checkPlateRegistrations } from '../src/plate-receipt.ts';
import {
  SCENE_CHOICE_MISMATCH,
  SCENE_CHOICE_MISSING,
  checkScenes,
  currentScene,
  readScene,
  sceneCurrentAt,
  sceneReference,
  validateScene,
} from '../src/scene.ts';
import type { Json, JsonObject } from '../src/templates.ts';
import { checkProject, sceneCommand, testClock } from './clock.ts';
import { sceneFixture } from './scene-fixture.ts';

afterEach(() => testClock.reset());

const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');

function writeWithDirs(f: ReturnType<typeof sceneFixture>, path: string, bytes: string | Buffer): JsonObject {
  mkdirSync(dirname(join(f.dir, path)), { recursive: true });
  return f.write(path, bytes);
}

function snapshotTree(dir: string): Map<string, Buffer> {
  const names = readdirSync(dir, { recursive: true })
    .map(entry => String(entry))
    .sort();
  const out = new Map<string, Buffer>();
  for (const name of names) {
    try {
      out.set(name, readFileSync(join(dir, name)));
    } catch {
      // Directory entries have no file bytes.
    }
  }
  return out;
}

function rejectIdentical(dir: string, code: string, operation: () => unknown): Error {
  const beforeProject = readFileSync(join(dir, 'project.json'));
  const beforeTree = snapshotTree(dir);
  let caught: Error | undefined;
  try {
    operation();
  } catch (error) {
    caught = error as Error;
  }
  expect(caught).toBeDefined();
  expect(caught).toEqual(expect.objectContaining({ code }));
  expect(readFileSync(join(dir, 'project.json'))).toEqual(beforeProject);
  const afterTree = snapshotTree(dir);
  expect([...afterTree.keys()]).toEqual([...beforeTree.keys()]);
  for (const [path, bytes] of beforeTree) {
    expect(afterTree.get(path)).toEqual(bytes);
  }
  return caught!;
}

function configurePostCompositionChoice(
  f: ReturnType<typeof sceneFixture>,
  options: {
    fragment: Json;
    delegated?: boolean;
    setId?: string;
    at?: string;
  },
): { setBinding: JsonObject; answer: JsonObject; citations: JsonObject } {
  const p = f.load();
  const at = options.at ?? '2026-11-07T09:56:00Z';
  const setId = options.setId ?? 'post-composition-scene-set';
  const interview = p.interview as JsonObject;
  interview.order = {
    spec: CHOICE_ORDER_SPEC,
    adopted_at: '2026-11-07T09:00:00Z',
    choices_adopted_at: '2026-11-07T09:00:00Z',
  };
  const optionSet: JsonObject = {
    schema: OPTIONS_SPEC,
    id: setId,
    question: 'post_composition',
    stage: 'post-interview',
    drafted_by: 'agent',
    drafted_at: '2026-11-07T09:55:30Z',
    context: {
      kind: 'rig',
      rig_version: 1,
      signoff_at: '2026-11-07T09:55:00Z',
      config: f.modelBinding,
      parts: { path: 'parts', files: [f.background, f.foreground] },
    },
    assembly: { rule: 'single' },
    asks: [
      {
        id: 'post_composition',
        prompt: 'Choose how the scene plates are composed around the rig.',
        options: [
          {
            id: 'keep',
            kind: 'value',
            label: 'Keep the painted background behind the rig.',
            effect: 'Place the registered plates at their declared world rects.',
            fragment: options.fragment,
            recommended: true,
            reason: 'Matches the painted composition.',
          },
          {
            id: 'alt',
            kind: 'value',
            label: 'Use an alternate framing.',
            effect: 'Place the background at an expanded rect.',
            fragment: {
              scene: {
                background: {
                  path: f.background.path,
                  rect: { x: -128, y: -50, width: 256, height: 256 },
                },
              },
            },
            recommended: false,
          },
          {
            id: 'other',
            kind: 'other',
            label: 'Other',
            effect: 'Describe a custom composition.',
            recommended: false,
          },
          {
            id: 'auto',
            kind: 'auto',
            label: 'Delegate',
            effect: 'Delegate scene composition to the agent.',
            recommended: false,
          },
        ],
      },
    ],
  };
  const setBinding = writeWithDirs(f, `evidence/interview/${setId}.json`, `${JSON.stringify(optionSet, null, 2)}\n`);
  const postItems = ((interview.post as JsonObject).items as JsonObject[]);
  const item = postItems.find(entry => entry.id === 'post_composition')!;
  const answer: JsonObject = options.delegated
    ? {
        by: 'user',
        at,
        verbatim: 'Delegate\nDelegate scene composition to the agent.',
        source: 'review questionnaire',
        delegated: true,
        asks: [{ id: 'post_composition', state: 'delegated' }],
        choice: {
          spec: CHOICE_SPEC,
          set: setBinding,
          picks: [
            {
              ask: 'post_composition',
              option_id: 'auto',
              shown: {
                label: 'Delegate',
                effect: 'Delegate scene composition to the agent.',
              },
            },
          ],
        },
        agent_decision: {
          by: 'agent',
          at: '2026-11-07T09:56:30Z',
          reasoning: 'Select the receipt-bound plates and world rects for the accepted rig.',
          covers: 'post_composition',
          fragments: [{ ask: 'post_composition', fragment: options.fragment }],
          value: options.fragment,
        },
      }
    : {
        by: 'user',
        at,
        verbatim: 'Keep the painted background behind the rig.\nPlace the registered plates at their declared world rects.',
        source: 'review questionnaire',
        delegated: false,
        asks: [{ id: 'post_composition', state: 'user' }],
        choice: {
          spec: CHOICE_SPEC,
          set: setBinding,
          picks: [
            {
              ask: 'post_composition',
              option_id: 'keep',
              shown: {
                label: 'Keep the painted background behind the rig.',
                effect: 'Place the registered plates at their declared world rects.',
              },
            },
          ],
        },
        value: options.fragment,
      };
  item.guide = answer;
  const cite: JsonObject = options.delegated
    ? { guide: 'post_composition', asks: ['post_composition'], delegated: true }
    : { guide: 'post_composition', asks: ['post_composition'], quote: 'Keep the painted background behind the rig.' };
  const citations: JsonObject = { background: cite, foreground: cite };
  writeWithDirs(f, 'evidence/citations.json', JSON.stringify({ background: cite }));
  writeWithDirs(f, 'evidence/citations-both.json', JSON.stringify(citations));
  // Align post-interview signoff answer_hashes so full checkProject stays green when exercised.
  const signoffs = objects(p.signoffs);
  const postSignoff = signoffs.find(s => s.stage === 'post-interview');
  if (postSignoff && typeof postSignoff.answer_hashes === 'object' && postSignoff.answer_hashes !== null) {
    (postSignoff.answer_hashes as JsonObject).post_composition = sha256(JSON.stringify(answer));
  }
  f.save(p);
  return { setBinding, answer, citations };
}

function loadScene(f: ReturnType<typeof sceneFixture>): JsonObject {
  const entry = currentScene(f.load())!;
  return JSON.parse(readFileSync(join(f.dir, String(entry.path)), 'utf8')) as JsonObject;
}

function sceneFindings(f: ReturnType<typeof sceneFixture>): Finding[] {
  const ctx = { dir: f.dir, project: f.load(), refusals: [] as Finding[] };
  checkScenes(ctx);
  return ctx.refusals;
}

test('agent scene write succeeds with a selected post_composition Review choice for background and optional foreground', () => {
  const f = sceneFixture();
  const customRect = { x: -128, y: -50, width: 256, height: 256 };
  configurePostCompositionChoice(f, {
    fragment: {
      scene: {
        background: { path: f.background.path, rect: customRect },
      },
    },
  });
  // Omitting --background-rect derives the exact rect from the cited choice (not from frame.stage).
  const res = sceneCommand(['write', '--rig', '1', '--background', String(f.background.path), '--citations-file', 'evidence/citations.json', '--by', 'agent', f.dir]);
  expect(res.exit).toBe(0);
  const p = f.load();
  const entry = currentScene(p)!;
  expect(entry.by).toBe('agent');
  const doc = loadScene(f);
  expect((doc.plates as JsonObject[])[0]!.rect).toEqual(customRect);
  expect(doc.layers).toEqual(['background', 'rig']);
  expect(sceneFindings(f)).toEqual([]);
  expect(readScene(f.dir, p, sceneReference(entry))).toEqual(doc);
  expect(sceneCurrentAt(f.dir, p, testClock.now())).toEqual(entry);
  expect(optionContext(p, 'post-interview', testClock.now(), f.dir)).toEqual({
    kind: 'scene',
    scene: sceneReference(entry),
  });

  // Also test background + foreground with explicit matching CLI rect flags.
  const f2 = sceneFixture();
  const fgRect = { x: -32, y: -25, width: 64, height: 64 };
  configurePostCompositionChoice(f2, {
    fragment: {
      scene: {
        background: { path: f2.background.path, rect: f2.model.stage },
        foreground: { path: f2.foreground.path, rect: fgRect },
      },
    },
  });
  expect(
    sceneCommand([
      'write',
      '--rig',
      '1',
      '--background',
      String(f2.background.path),
      '--background-rect',
      '-64,5,128,128',
      '--foreground',
      String(f2.foreground.path),
      '--foreground-rect',
      '-32,-25,64,64',
      '--citations-file',
      'evidence/citations-both.json',
      '--by',
      'agent',
      f2.dir,
    ]).exit,
  ).toBe(0);
  const doc2 = loadScene(f2);
  expect(doc2.layers).toEqual(['background', 'rig', 'foreground']);
  expect((doc2.plates as JsonObject[])[1]!.rect).toEqual(fgRect);
  expect(sceneFindings(f2)).toEqual([]);
});

test('agent scene write succeeds with an explicitly decided post_composition delegation', () => {
  const f = sceneFixture();
  configurePostCompositionChoice(f, {
    delegated: true,
    fragment: {
      scene: {
        background: { path: f.background.path, rect: f.model.stage },
        foreground: { path: f.foreground.path, rect: f.model.stage },
      },
    },
  });
  expect(
    sceneCommand([
      'write',
      '--rig',
      '1',
      '--background',
      String(f.background.path),
      '--foreground',
      String(f.foreground.path),
      '--citations-file',
      'evidence/citations-both.json',
      '--by',
      'agent',
      f.dir,
    ]).exit,
  ).toBe(0);
  const p = f.load();
  const entry = currentScene(p)!;
  expect(entry.by).toBe('agent');
  const doc = loadScene(f);
  expect((doc.plates as JsonObject[])[0]!.citation).toEqual({
    guide: 'post_composition',
    asks: ['post_composition'],
    delegated: true,
  });
  expect(sceneFindings(f)).toEqual([]);
  expect(readScene(f.dir, p, sceneReference(entry))).toEqual(doc);
});

test('agent scene accepts a receipt-bound derived plate and refuses an unreceipted derived plate', () => {
  const f = sceneFixture();
  const p = f.load();
  const mask = writeWithDirs(f, 'inputs/mask.png', readFileSync(join(f.dir, String(f.foreground.path))));
  const prepared = writeWithDirs(f, 'derived/plates/bg-clean.png', readFileSync(join(f.dir, String(f.background.path))));
  p.inputs = [...objects(p.inputs), { ...mask, origin: 'synthetic mask' }];
  const receiptDoc: JsonObject = {
    spec: 'rig-parts-plate-receipt/1',
    mode: 'inpaint',
    painting: { path: `../../${String(f.background.path)}`, sha256: f.background.sha256 },
    mask: { source: 'user', from: 'upload', path: `../../${String(mask.path)}`, sha256: mask.sha256 },
    model: { id: 'synthetic-model', sha256: 'a'.repeat(64) },
    params: { seed: 1 },
    graph: { sha256: 'b'.repeat(64) },
    gpu: { backend: 'cpu' },
    output: { path: `../../${String(prepared.path)}`, sha256: prepared.sha256 },
  };
  const receiptBinding = writeWithDirs(f, 'derived/plates/receipt.json', `${JSON.stringify(receiptDoc, null, 2)}\n`);
  p.derived = [
    {
      kind: 'prepared-input',
      ...prepared,
      sources: [f.background, mask],
      operation: 'Synthetic receipted plate preparation',
      receipt: { ...receiptBinding, spec: 'rig-parts-plate-receipt/1' },
    },
  ];
  f.save(p);
  configurePostCompositionChoice(f, {
    fragment: {
      scene: {
        background: { path: prepared.path, rect: f.model.stage },
      },
    },
  });
  expect(
    sceneCommand([
      'write',
      '--rig',
      '1',
      '--background',
      String(prepared.path),
      '--citations-file',
      'evidence/citations.json',
      '--by',
      'agent',
      f.dir,
    ]).exit,
  ).toBe(0);
  const doc = loadScene(f);
  expect((doc.plates as JsonObject[])[0]!.registered).toEqual({ kind: 'derived', ref: 'derived[0]' });
  expect(sceneFindings(f)).toEqual([]);
  const plateCheck = { dir: f.dir, project: f.load(), refusals: [] as Finding[], warnings: [] as Finding[] };
  checkPlateRegistrations(plateCheck);
  expect(plateCheck.refusals).toEqual([]);

  // Removing the receipt from the derived plate refuses agent scene validation and writing.
  const withoutReceipt = f.load();
  delete (objects(withoutReceipt.derived)[0] as JsonObject).receipt;
  f.save(withoutReceipt);
  expect(sceneFindings(f).map(finding => finding.code)).toEqual(['SCENE_PLATE_UNREGISTERED']);
  rejectIdentical(f.dir, 'SCENE_PLATE_UNREGISTERED', () =>
    sceneCommand([
      'write',
      '--rig',
      '1',
      '--background',
      String(prepared.path),
      '--citations-file',
      'evidence/citations.json',
      '--by',
      'agent',
      f.dir,
    ]),
  );
});

test('SCENE_CHOICE_MISSING refuses prose-only answers, pending delegations, and missing role/path/rect fields without fallback', () => {
  // 1. Default fixture has a prose-only post_composition answer without choice.
  const prose = sceneFixture();
  const errProse = rejectIdentical(prose.dir, SCENE_CHOICE_MISSING, () =>
    sceneCommand(['write', '--rig', '1', '--background', String(prose.background.path), '--citations-file', 'background-citation.json', '--by', 'agent', prose.dir]),
  );
  expect(errProse.message).toContain('interview.post.items[post_composition].guide.choice');
  expect(errProse.message).toContain('Review tool');

  // 2. Choice with descriptive fragment lacking value.scene.
  const noScene = sceneFixture();
  configurePostCompositionChoice(noScene, { fragment: { framing: 'whole synthetic plate' } });
  const errNoScene = rejectIdentical(noScene.dir, SCENE_CHOICE_MISSING, () =>
    sceneCommand(['write', '--rig', '1', '--background', String(noScene.background.path), '--citations-file', 'evidence/citations.json', '--by', 'agent', noScene.dir]),
  );
  expect(errNoScene.message).toContain('interview.post.items[post_composition].guide.value.scene');
  expect(errNoScene.message).toContain('Review tool');

  // 3. Choice with value.scene.background missing rect (no full-stage default allowed, even when CLI supplies or omits --background-rect).
  const noRect = sceneFixture();
  configurePostCompositionChoice(noRect, {
    fragment: {
      scene: {
        background: { path: noRect.background.path },
      },
    },
  });
  const errOmittedRect = rejectIdentical(noRect.dir, SCENE_CHOICE_MISSING, () =>
    sceneCommand(['write', '--rig', '1', '--background', String(noRect.background.path), '--citations-file', 'evidence/citations.json', '--by', 'agent', noRect.dir]),
  );
  expect(errOmittedRect.message).toContain('interview.post.items[post_composition].guide.value.scene.background.rect');
  const errTypedRect = rejectIdentical(noRect.dir, SCENE_CHOICE_MISSING, () =>
    sceneCommand([
      'write',
      '--rig',
      '1',
      '--background',
      String(noRect.background.path),
      '--background-rect',
      '-64,5,128,128',
      '--citations-file',
      'evidence/citations.json',
      '--by',
      'agent',
      noRect.dir,
    ]),
  );
  expect(errTypedRect.message).toContain('interview.post.items[post_composition].guide.value.scene.background.rect');

  // 4. Choice with value.scene.background missing path (no singleton input inference).
  const noPath = sceneFixture();
  configurePostCompositionChoice(noPath, {
    fragment: {
      scene: {
        background: { rect: noPath.model.stage },
      },
    },
  });
  const errNoPath = rejectIdentical(noPath.dir, SCENE_CHOICE_MISSING, () =>
    sceneCommand(['write', '--rig', '1', '--background', String(noPath.background.path), '--citations-file', 'evidence/citations.json', '--by', 'agent', noPath.dir]),
  );
  expect(errNoPath.message).toContain('interview.post.items[post_composition].guide.value.scene.background.path');

  // 5. Pending delegation (auto picked, but interview-decision not yet recorded).
  const pendingDelegation = sceneFixture();
  configurePostCompositionChoice(pendingDelegation, {
    delegated: true,
    fragment: { scene: { background: { path: pendingDelegation.background.path, rect: pendingDelegation.model.stage } } },
  });
  const p = pendingDelegation.load();
  const item = (((p.interview as JsonObject).post as JsonObject).items as JsonObject[]).find(entry => entry.id === 'post_composition')!;
  (item.guide as JsonObject).agent_decision = { covers: 'post_composition' };
  pendingDelegation.save(p);
  const errPending = rejectIdentical(pendingDelegation.dir, SCENE_CHOICE_MISSING, () =>
    sceneCommand([
      'write',
      '--rig',
      '1',
      '--background',
      String(pendingDelegation.background.path),
      '--citations-file',
      'evidence/citations.json',
      '--by',
      'agent',
      pendingDelegation.dir,
    ]),
  );
  expect(errPending.message).toContain('interview.post.items[post_composition].guide.agent_decision');
});

test('SCENE_CHOICE_MISMATCH refuses role, path or rect discrepancies between the scene and cited choice', () => {
  const f = sceneFixture();
  configurePostCompositionChoice(f, {
    fragment: {
      scene: {
        background: { path: f.background.path, rect: f.model.stage },
      },
    },
  });

  // 1. Wrong background path.
  const errPath = rejectIdentical(f.dir, SCENE_CHOICE_MISMATCH, () =>
    sceneCommand(['write', '--rig', '1', '--background', String(f.foreground.path), '--citations-file', 'evidence/citations.json', '--by', 'agent', f.dir]),
  );
  expect(errPath.message).toContain('scene.plates[0].path');
  expect(errPath.message).toContain('Review tool');

  // 2. Wrong background rect.
  const errRect = rejectIdentical(f.dir, SCENE_CHOICE_MISMATCH, () =>
    sceneCommand([
      'write',
      '--rig',
      '1',
      '--background',
      String(f.background.path),
      '--background-rect',
      '-128,-50,256,256',
      '--citations-file',
      'evidence/citations.json',
      '--by',
      'agent',
      f.dir,
    ]),
  );
  expect(errRect.message).toContain('scene.plates[0].rect');

  // 3. Undeclared foreground added when choice only binds background.
  const errExtraFg = rejectIdentical(f.dir, SCENE_CHOICE_MISMATCH, () =>
    sceneCommand([
      'write',
      '--rig',
      '1',
      '--background',
      String(f.background.path),
      '--foreground',
      String(f.foreground.path),
      '--citations-file',
      'evidence/citations-both.json',
      '--by',
      'agent',
      f.dir,
    ]),
  );
  expect(errExtraFg.message).toContain('scene.plates[1]');

  // 4. Missing foreground when choice binds both background and foreground.
  const fBoth = sceneFixture();
  configurePostCompositionChoice(fBoth, {
    fragment: {
      scene: {
        background: { path: fBoth.background.path, rect: fBoth.model.stage },
        foreground: { path: fBoth.foreground.path, rect: fBoth.model.stage },
      },
    },
  });
  const errMissingFg = rejectIdentical(fBoth.dir, SCENE_CHOICE_MISMATCH, () =>
    sceneCommand(['write', '--rig', '1', '--background', String(fBoth.background.path), '--citations-file', 'evidence/citations.json', '--by', 'agent', fBoth.dir]),
  );
  expect(errMissingFg.message).toContain('scene.plates');
});

test('readers and sceneCurrentAt surface named refusals on tampered agent scenes without silent fallback', () => {
  const f = sceneFixture();
  configurePostCompositionChoice(f, {
    fragment: {
      scene: {
        background: { path: f.background.path, rect: f.model.stage },
      },
    },
  });
  expect(
    sceneCommand(['write', '--rig', '1', '--background', String(f.background.path), '--citations-file', 'evidence/citations.json', '--by', 'agent', f.dir]).exit,
  ).toBe(0);

  // Plant a mismatched rect in s1.json and update its hash so raw-byte seal passes.
  const p = f.load();
  const entry = currentScene(p)!;
  const doc = loadScene(f);
  ((doc.plates as JsonObject[])[0]!.rect as JsonObject).x = 0;
  entry.sha256 = f.write(String(entry.path), `${JSON.stringify(doc, null, 2)}\n`).sha256!;
  f.save(p);

  expect(sceneFindings(f).map(finding => finding.code)).toEqual([SCENE_CHOICE_MISMATCH]);
  expect(() => validateScene(f.dir, f.load(), loadScene(f))).toThrow(expect.objectContaining({ code: SCENE_CHOICE_MISMATCH }));
  expect(() => readScene(f.dir, f.load(), sceneReference(entry))).toThrow(expect.objectContaining({ code: SCENE_CHOICE_MISMATCH }));
  // sceneCurrentAt must throw SCENE_CHOICE_MISMATCH rather than silently returning undefined.
  expect(() => sceneCurrentAt(f.dir, f.load(), testClock.now())).toThrow(expect.objectContaining({ code: SCENE_CHOICE_MISMATCH }));
  expect(() => optionContext(f.load(), 'post-interview', testClock.now(), f.dir)).toThrow(
    expect.objectContaining({ code: 'INTERVIEW_OPTIONS_STALE', message: expect.stringContaining('scene.plates[0].rect') }),
  );
});

test('historical agent scene remains valid in history after post_composition is replaced, while new authoring must match current choice', () => {
  const f = sceneFixture();
  const first = configurePostCompositionChoice(f, {
    setId: 'post-composition-v1',
    at: '2026-11-07T09:56:00Z',
    fragment: {
      scene: {
        background: { path: f.background.path, rect: f.model.stage },
      },
    },
  });
  expect(
    sceneCommand(['write', '--rig', '1', '--background', String(f.background.path), '--citations-file', 'evidence/citations.json', '--by', 'agent', f.dir]).exit,
  ).toBe(0);

  // Replace post_composition with a new choice (delegated) that moves the first answer to history[].
  const p = f.load();
  const item = (((p.interview as JsonObject).post as JsonObject).items as JsonObject[]).find(entry => entry.id === 'post_composition')!;
  item.history = [structuredClone(first.answer)];
  f.save(p);

  const customRect = { x: -128, y: -50, width: 256, height: 256 };
  configurePostCompositionChoice(f, {
    setId: 'post-composition-v2',
    at: '2026-11-07T10:02:00Z',
    delegated: true,
    fragment: {
      scene: {
        background: { path: f.background.path, rect: customRect },
      },
    },
  });
  // Restore history after configurePostCompositionChoice overwrote guide.
  const updated = f.load();
  const updatedItem = (((updated.interview as JsonObject).post as JsonObject).items as JsonObject[]).find(entry => entry.id === 'post_composition')!;
  updatedItem.history = [structuredClone(first.answer)];
  f.save(updated);

  // Historical s1 remains valid because its cited choice is preserved in history[].
  expect(sceneFindings(f)).toEqual([]);

  // Attempting to author s2 citing the superseded history quote refuses with SCENE_CHOICE_MISMATCH.
  writeWithDirs(
    f,
    'evidence/stale-citations.json',
    JSON.stringify({ background: { guide: 'post_composition', asks: ['post_composition'], quote: 'Keep the painted background behind the rig.' } }),
  );
  rejectIdentical(f.dir, SCENE_CHOICE_MISMATCH, () =>
    sceneCommand(['write', '--rig', '1', '--background', String(f.background.path), '--citations-file', 'evidence/stale-citations.json', '--by', 'agent', f.dir]),
  );

  // Authoring s2 citing the current decided delegation succeeds.
  testClock.set('2026-11-07T10:05:00Z');
  expect(
    sceneCommand(['write', '--rig', '1', '--background', String(f.background.path), '--citations-file', 'evidence/citations.json', '--by', 'agent', f.dir]).exit,
  ).toBe(0);
  expect(currentScene(f.load())!.n).toBe(2);
  expect(sceneFindings(f)).toEqual([]);
});
