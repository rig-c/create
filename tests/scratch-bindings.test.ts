import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initProject } from '../src/init.ts';
import { checkCollection } from '../src/pins-check.ts';
import { Refusal } from '../src/refusal.ts';
import { SCRATCH_BINDING_FORBIDDEN, SCRATCH_BINDING_SINCE } from '../src/scratch-bindings.ts';
import type { JsonObject } from '../src/templates.ts';
import {
  amendCommand,
  checkProject,
  derivedCommand,
  inputCommand,
  interviewDecisionCommand,
  planCommand,
  signoffCommand,
  testClock,
} from './clock.ts';
import { ownerChatArgs, tempDir } from './helpers.ts';

const SYNTHETIC_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zb1sAAAAASUVORK5CYII=',
  'base64',
);

let seedRoot = '';
let seedDir = '';

beforeAll(() => {
  seedRoot = mkdtempSync(join(tmpdir(), 'rig-scratch-seed-'));
  const painting = join(seedRoot, 'painting.png');
  writeFileSync(painting, SYNTHETIC_PNG);
  seedDir = join(seedRoot, 'project');
  initProject(seedDir, {
    install: false,
    ownerLanguage: 'en',
    now: Date.parse('2026-11-27T01:00:00Z'),
    painting: { file: painting, origin: 'Synthetic 1x1 test painting.', projectsRoot: seedRoot },
  });
}, 30_000);

afterAll(() => {
  if (seedRoot) rmSync(seedRoot, { recursive: true, force: true });
});

afterEach(() => testClock.reset());

function freshSyntheticProject(): string {
  const dir = join(tempDir(), 'project');
  cpSync(seedDir, dir, { recursive: true });
  return dir;
}

const readProjectJson = (dir: string): JsonObject =>
  JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;

const writeProjectJson = (dir: string, project: JsonObject): void =>
  writeFileSync(join(dir, 'project.json'), `${JSON.stringify(project, null, 2)}\n`);

test('#988 owner-chat and decision files read from scratch/ and copied verbatim are accepted and left untouched on disk', () => {
  testClock.set('2026-11-27T01:00:00Z');
  const dir = freshSyntheticProject();
  const planFile = join(dir, 'plans/parts.md');
  mkdirSync(join(dir, 'plans'), { recursive: true });
  writeFileSync(planFile, 'Build a standing idle character. Use core projection.\n');
  planCommand(['propose', 'parts', dir, '--file', 'plans/parts.md', '--by', 'agent']);

  const reasonFile = join(dir, 'scratch/reason.txt');
  const valueFile = join(dir, 'scratch/value.json');
  const quoteFile = join(dir, 'scratch/quote.txt');
  writeFileSync(reasonFile, 'Follow the synthetic plan.\n');
  writeFileSync(valueFile, '"character.idle"\n');
  writeFileSync(quoteFile, 'Build a standing idle character.');
  interviewDecisionCommand([
    'rig_type', dir, '--by', 'agent',
    '--reasoning-file', reasonFile,
    '--value-file', valueFile,
    '--plan-quote-file', quoteFile,
  ]);

  writeFileSync(valueFile, '{"project":"core"}\n');
  writeFileSync(quoteFile, 'Use core projection.');
  interviewDecisionCommand([
    'assemble', dir, '--by', 'agent',
    '--reasoning-file', reasonFile,
    '--value-file', valueFile,
    '--plan-quote-file', quoteFile,
  ]);

  planCommand([
    'add', 'seethrough', dir, '--by', 'agent', '--phase', 'rig', '--order', '1',
    '--does', 'Prepare synthetic layers.', '--produces', 'derived/layers/',
    '--rests-on', 'seethrough', '--bar', 'Synthetic bar.', '--checkpoint-proposed', 'false',
  ]);
  planCommand([
    'add', 'assemble', dir, '--by', 'agent', '--phase', 'rig', '--order', '2',
    '--does', 'Assemble synthetic parts.', '--produces', 'outputs/parts/',
    '--rests-on', 'assemble', '--bar', 'Synthetic bar.', '--checkpoint-proposed', 'false',
  ]);

  const ownerWords = 'Approved in chat for the synthetic interview.\n';
  const wordsFile = join(dir, 'scratch/owner-words.txt');
  writeFileSync(wordsFile, ownerWords);
  signoffCommand(['interview', dir, '--by', 'owner', ...ownerChatArgs(wordsFile)]);

  const rawText = readFileSync(join(dir, 'project.json'), 'utf8');
  expect(rawText).not.toContain('scratch/');
  const project = readProjectJson(dir);
  const signoffs = project.signoffs as JsonObject[];
  expect(signoffs[0]?.verbatim).toBe(ownerWords);
  expect(signoffs[0]?.source).toBe('owner chat, relayed');

  const report = checkProject(dir);
  expect(report.refusals.map(f => f.code)).toEqual([]);
  expect(report.warnings.map(f => f.code)).toEqual([]);
  expect(existsSync(wordsFile)).toBe(true);
  expect(readFileSync(wordsFile, 'utf8')).toBe(ownerWords);
});

test('#988 recorded bindings into scratch/ refuse from SCRATCH_BINDING_SINCE and WARN before it', () => {
  testClock.set('2026-11-27T02:00:00Z');
  const dir = freshSyntheticProject();
  const base = readProjectJson(dir);

  const cases: [string, string, (p: JsonObject, at: string) => void][] = [
    ['current.parts.built_from', 'current.parts.built_from[0].path', (p, at) => {
      p.current = {
        parts: {
          at,
          built_by: 'agent',
          built_with: { '@rig-c/parts': '2.60.0' },
          files: [{ path: 'outputs/parts/rig/parts.json', sha256: 'a'.repeat(64), bytes: 2 }],
          files_sha256: 'b'.repeat(64),
          built_from: [{ path: 'scratch/assemble.json', sha256: 'c'.repeat(64) }],
          run: { path: 'outputs/parts/run.json', sha256: 'd'.repeat(64) },
          report: { path: 'outputs/parts/check/parts-check.json', sha256: 'e'.repeat(64) },
        },
      };
    }],
    ['comments.saw', 'comments[0].saw[0].path', (p, at) => {
      p.comments = [{
        source: 'review act job-1/act-1',
        at,
        by: 'owner',
        comments: [],
        saw: [{ path: 'scratch/preview.png', sha256: 'a'.repeat(64) }],
        record: null,
      }];
    }],
    ['inputs', 'inputs[1].path', (p, at) => {
      p.inputs = [...(p.inputs as JsonObject[]), {
        path: './scratch/ref.png',
        sha256: 'a'.repeat(64),
        bytes: 10,
        origin: 'synthetic scratch input',
        at,
      }];
    }],
    ['owner-chat source', 'signoffs[0].source', (p, at) => {
      p.signoffs = [{
        stage: 'interview',
        checkpoint: null,
        by: 'owner',
        at,
        verbatim: 'ok',
        source: 'scratch/owner-words.txt',
      }];
    }],
    ['evidence pointer', 'signoffs[0].evidence.path', (p, at) => {
      p.signoffs = [{
        stage: 'parts-review',
        checkpoint: null,
        by: 'owner',
        at,
        verbatim: 'approved',
        evidence: { kind: 'parts-verdict', path: 'scratch/verdict.json', sha256: 'a'.repeat(64) },
      }];
    }],
    ['registration requirements_source.source_path', 'versions[0].registration.requirements_source.source_path', (p, at) => {
      p.versions = [{
        n: 1,
        kind: 'rig',
        at,
        registration: {
          kind: 'frozen-rig/1',
          at,
          requirements_source: {
            path: 'evidence/v1/registration/requirements-source.json',
            sha256: 'a'.repeat(64),
            bytes: 12,
            source_path: 'scratch/rig/interview-requirements.json',
          },
        },
      }];
    }],
  ];

  for (const [, expectedPath, mutate] of cases) {
    const afterCutoff = structuredClone(base);
    mutate(afterCutoff, SCRATCH_BINDING_SINCE);
    const refused = checkProject(dir, afterCutoff);
    expect(refused.refusals.filter(f => f.code === SCRATCH_BINDING_FORBIDDEN).map(f => f.path)).toEqual([expectedPath]);
    expect(refused.warnings.filter(f => f.code === SCRATCH_BINDING_FORBIDDEN)).toEqual([]);

    const beforeCutoff = structuredClone(base);
    mutate(beforeCutoff, '2026-11-26T23:59:59Z');
    const warned = checkProject(dir, beforeCutoff);
    expect(warned.refusals.filter(f => f.code === SCRATCH_BINDING_FORBIDDEN)).toEqual([]);
    expect(warned.warnings.filter(f => f.code === SCRATCH_BINDING_FORBIDDEN).map(f => f.path)).toEqual([expectedPath]);
  }
});

test('#988 prose fields mentioning scratch or "from scratch" do not trigger SCRATCH_BINDING_FORBIDDEN', () => {
  testClock.set('2026-11-27T02:00:00Z');
  const dir = freshSyntheticProject();
  const project = readProjectJson(dir);
  project.signoffs = [{
    stage: 'interview',
    checkpoint: null,
    by: 'owner',
    at: '2026-11-27T02:00:00Z',
    verbatim: 'scratch/old-draft can be deleted any time; built from scratch',
    source: 'built from scratch in interview chat',
    note: 'measured with scratch/probe.py on synthetic frames',
  }];
  const report = checkProject(dir, project);
  expect(report.refusals.filter(f => f.code === SCRATCH_BINDING_FORBIDDEN)).toEqual([]);
  expect(report.warnings.filter(f => f.code === SCRATCH_BINDING_FORBIDDEN)).toEqual([]);
});

test('#988 writers refuse scratch/ bindings before writing and leave project.json byte-identical', () => {
  testClock.set('2026-11-27T02:00:00Z');
  const dir = freshSyntheticProject();
  const scratchAsset = join(dir, 'scratch/extra.png');
  writeFileSync(scratchAsset, SYNTHETIC_PNG);
  const wordsFile = join(dir, 'scratch/words.txt');
  writeFileSync(wordsFile, 'Replace the synthetic input.\n');
  const before = readFileSync(join(dir, 'project.json'));

  const expectRefused = (fn: () => unknown): void => {
    let caught: unknown;
    try { fn(); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(Refusal);
    expect((caught as Refusal).code).toBe(SCRATCH_BINDING_FORBIDDEN);
    expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
  };

  expectRefused(() => inputCommand(['add', 'scratch/extra.png', dir, '--origin', 'synthetic']));
  expectRefused(() => derivedCommand(['add', dir, '--source', 'inputs/painting.png', '--file', 'scratch/extra.png', '--operation', 'synthetic copy']));
  expectRefused(() => amendCommand([
    'parts', dir, '--kind', 'part', '--target', 'torso',
    '--change', 'scratch/extra.png', '--by', 'owner', '--verbatim-file', wordsFile,
  ]));
});

test('#988 collection check also enforces SCRATCH_BINDING_FORBIDDEN', () => {
  const root = tempDir();
  writeFileSync(join(root, 'collection.json'), `${JSON.stringify({
    schema: 'rig-create/collection@0',
    name: 'synthetic-collection',
    stage: 'interview',
    stage_values: ['interview', 'plan-approved', 'reference', 'members', 'post-interview', 'post', 'direction-review', 'accepted', 'paused'],
    members: [],
    signoffs: [{
      stage: 'interview',
      checkpoint: null,
      by: 'owner',
      at: '2026-11-27T01:00:00Z',
      verbatim: 'ok',
      evidence: { path: 'scratch/collection-evidence.json', sha256: 'a'.repeat(64) },
    }],
    interview: { questions: [], framing: [], waypoints: [], post: { items: [] } },
    versions: [],
  }, null, 2)}\n`);
  const report = checkCollection(root);
  expect(report.refusals.filter(f => f.code === SCRATCH_BINDING_FORBIDDEN).map(f => f.path)).toEqual(['signoffs[0].evidence.path']);
});
