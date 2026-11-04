import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { checkProject } from '../src/check.ts';
import { COLLECTION_STAGE_VALUES } from '../src/collection.ts';
import { checkCollection } from '../src/pins-check.ts';
import { readTemplate, type Json, type JsonObject } from '../src/templates.ts';
import { cli, gitEnv, run, tempDir } from './helpers.ts';

const ENV = gitEnv({ name: 'Test User', email: 'test@example.com' });

function readJson(file: string): JsonObject {
  return JSON.parse(readFileSync(file, 'utf8')) as JsonObject;
}
function writeJson(file: string, value: JsonObject): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
function obj(v: Json | undefined): JsonObject {
  if (v === null || v === undefined || typeof v !== 'object' || Array.isArray(v)) throw new Error('expected an object');
  return v;
}
function arr(v: Json | undefined): Json[] {
  if (!Array.isArray(v)) throw new Error('expected an array');
  return v;
}
function byId(list: Json | undefined, id: string): JsonObject {
  const found = arr(list).find((x) => obj(x).id === id);
  if (found === undefined) throw new Error(`no item ${id}`);
  return obj(found);
}
const sha = (bytes: string): string => createHash('sha256').update(bytes).digest('hex');

const ANSWER = (verbatim: string): JsonObject => ({ delegated: false, by: 'user', at: '2026-11-11T15:00:00Z', verbatim, value: verbatim, source: 'interview, chat' });

function initCollection(): string {
  const dir = join(tempDir(), 'harbour');
  const made = cli(['init', '--collection', dir, '--no-install'], dirname(dir), ENV);
  expect(made.stderr).toBe('');
  expect(made.code).toBe(0);
  return dir;
}

/** Edits collection.json and commits it, as a person would before adding a member. */
function editCollection(dir: string, edit: (c: JsonObject) => void): void {
  const file = join(dir, 'collection.json');
  const c = readJson(file);
  edit(c);
  writeJson(file, c);
  expect(run(['git', 'commit', '-q', '-m', 'answers', '--', 'collection.json'], dir, ENV).code).toBe(0);
}

/** Every collection question, framing answer and waypoint guide answered: the collection interview is complete. */
function answerAll(c: JsonObject): void {
  const interview = obj(c.interview);
  for (const q of arr(interview.questions)) obj(q).answer = ANSWER(`question ${String(obj(q).id)}`);
  for (const q of arr(interview.framing)) obj(q).answer = ANSWER(`framing ${String(obj(q).id)}`);
  for (const w of arr(interview.waypoints)) obj(w).guide = ANSWER(`guide ${String(obj(w).id)}`);
}

function addMember(dir: string, name: string) {
  return cli(['init', '--member', dir, name], dir, ENV);
}

/** A member rig build: outputs/v<n>/ files and derived/v<n>/config.json on disk, recorded as versions[] entry n. */
function build(collectionDir: string, member: string, n: number, flavour: string): void {
  const dir = join(collectionDir, 'members', member);
  const files: Record<string, string> = {
    [`outputs/v${n}/skeleton.json`]: `{"skeleton":"${member} ${flavour}"}`,
    [`outputs/v${n}/atlas.atlas`]: `atlas ${member} ${flavour}`,
    [`outputs/v${n}/atlas.png`]: `png ${member} ${flavour}`,
    [`outputs/v${n}/take.mp4`]: `take ${member} ${flavour}`,
    [`derived/v${n}/config.json`]: `{"config":"${member} ${flavour}"}`,
  };
  for (const [path, bytes] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), bytes);
  }
  const project = readJson(join(dir, 'project.json'));
  const outputs = Object.entries(files)
    .filter(([p]) => p.startsWith('outputs/'))
    .map(([path, bytes]) => ({ path, sha256: sha(bytes), bytes: bytes.length }));
  const configPath = `derived/v${n}/config.json`;
  project.versions = [
    ...arr(project.versions),
    {
      n,
      kind: 'rig',
      rig_version: null,
      at: '2026-11-12T18:00:00Z',
      built_by: 'agent',
      outputs,
      provenance: { config: { path: configPath, sha256: sha(files[configPath] as string) }, sections: {} },
      verdicts: [],
    },
  ];
  writeJson(join(dir, 'project.json'), project);
}

function collectionOutput(dir: string, n: number): void {
  mkdirSync(join(dir, 'outputs', `v${n}`), { recursive: true });
  writeFileSync(join(dir, 'outputs', `v${n}`, 'lineup.png'), `lineup v${n}`);
}

describe('init --collection', () => {
  const dir = initCollection();

  test('writes the collection layout and commits exactly what it wrote', () => {
    const tracked = run(['git', 'ls-files'], dir, ENV).stdout.trim().split('\n').sort();
    expect(tracked).toEqual([
      '.gitignore',
      'AGENTS.md',
      'CLAUDE.md',
      'collection.json',
      'evidence/.gitkeep',
      'inputs/references/.gitkeep',
      'members/.gitkeep',
      'package.json',
      'shared/conventions.json',
    ]);
    for (const ignored of ['derived', 'outputs', 'scratch']) expect(existsSync(join(dir, ignored))).toBe(true);
    expect(run(['git', 'status', '--porcelain'], dir, ENV).stdout).toBe('');
  });

  test('names the collection and its conventions after the folder', () => {
    const c = readJson(join(dir, 'collection.json'));
    expect(c.schema).toBe('rig-create/collection@0');
    expect(c.name).toBe('harbour');
    expect(readJson(join(dir, 'shared', 'conventions.json')).collection).toBe('harbour');
    expect(readJson(join(dir, 'package.json')).dependencies).toBeDefined();
  });

  test('the template stage_values are the collection stages the check uses', () => {
    expect(readTemplate('collection.json').stage_values).toEqual([...COLLECTION_STAGE_VALUES]);
  });

  test('the agent guide is the collection guide, with no unfilled marker', () => {
    const guide = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
    expect(guide).toContain('rig collection');
    expect(guide).toContain('rig-create collection --check');
    expect(guide).toContain('docs/INTERVIEW.md#derived-answers');
    expect(guide).not.toContain('{{');
  });
});

describe('init --member', () => {
  test('inherits the answers the collection gave, by reference, and leaves the rest to the member', () => {
    const dir = initCollection();
    editCollection(dir, (c) => {
      const interview = obj(c.interview);
      byId(interview.framing, 'rig_type').answer = { ...ANSWER('A character, standing idle.'), value: 'character.idle' };
      byId(interview.waypoints, 'bones').guide = {
        ...ANSWER('A chain down every scarf. Place its bones along the scarf for its full length.'),
        asks: [{ id: 'chains', state: 'user' }, { id: 'placement', state: 'user' }, { id: 'length', state: 'user' }],
      };
      byId(interview.waypoints, 'motion').guide = { ...ANSWER('per-member'), value: 'per-member' };
    });
    const made = addMember(dir, 'keeper');
    expect(made.stderr).toBe('');
    expect(made.code).toBe(0);

    const member = join(dir, 'members', 'keeper');
    const project = readJson(join(member, 'project.json'));
    const interview = obj(project.interview);
    expect(obj(byId(interview.framing, 'rig_type').answer)).toMatchObject({ basis: 'inherited', from: { collection: 'harbour', question: 'rig_type' } });
    expect(obj(byId(interview.waypoints, 'bones').guide)).toMatchObject({ basis: 'inherited', from: { collection: 'harbour', question: 'bones' } });
    // Not copied: the member holds a reference, never the collection's words.
    expect(JSON.stringify(project)).not.toContain('A chain down every scarf.');
    expect(byId(interview.waypoints, 'motion').guide).toBeNull();
    expect(byId(interview.waypoints, 'meshes').guide).toBeNull();

    // Registered, and committed in the collection's repository with nothing else.
    const members = arr(readJson(join(dir, 'collection.json')).members).map(obj);
    expect(members).toEqual([{ name: 'keeper', project: 'members/keeper/project.json', input: null, note: null }]);
    expect(existsSync(join(member, '.git'))).toBe(false);
    expect(existsSync(join(member, 'package.json'))).toBe(false);
    expect(run(['git', 'status', '--porcelain'], dir, ENV).stdout).toBe('');
    expect(run(['git', 'log', '-1', '--format=%s'], dir, ENV).stdout.trim()).toBe('Add member keeper to collection harbour');

    // Bar 2: the inherited answers resolve through the collection; its null and per-member answers are silence, not missing.
    const report = checkProject(member);
    const incomplete = report.refusals.filter((f) => f.code === 'INTERVIEW_INCOMPLETE').map((f) => f.path);
    expect(incomplete).not.toContain('interview.framing[rig_type].answer');
    expect(incomplete).not.toContain('interview.waypoints[bones].guide');
    expect(incomplete).toContain('interview.waypoints[motion].guide');
    expect(incomplete).toContain('interview.waypoints[meshes].guide');
    expect(incomplete).toContain('interview.framing[reference].answer');
    expect(new Set(report.refusals.map((f) => f.code))).toEqual(new Set(['INTERVIEW_INCOMPLETE']));
    expect(report.parts).not.toBeNull();

    // A later change to the collection reaches the member: its answer withdrawn is the member's silence, with the reason.
    editCollection(dir, (c) => {
      byId(obj(c.interview).waypoints, 'bones').guide = null;
    });
    const after = checkProject(member).refusals.filter((f) => f.path === 'interview.waypoints[bones].guide');
    expect(after.map((f) => f.code)).toEqual(['INTERVIEW_INCOMPLETE']);
    expect(after[0]?.message).toContain("collection 'harbour' answer 'bones' is null");
  });

  test('a folder that is not a collection is refused by name, and nothing is written', () => {
    const root = tempDir();
    const project = join(root, 'single');
    expect(cli(['init', project, '--no-install'], root, ENV).code).toBe(0);
    const before = readdirSync(project).sort();
    const r = cli(['init', '--member', project, 'keeper'], root, ENV);
    expect(r.code).toBe(1);
    expect(r.stderr).toStartWith('rig-create: INIT_NOT_A_COLLECTION: ');
    expect(r.stderr).toContain(project);
    expect(readdirSync(project).sort()).toEqual(before);

    const missing = cli(['init', '--member', join(root, 'nowhere'), 'keeper'], root, ENV);
    expect(missing.stderr).toStartWith('rig-create: INIT_NOT_A_COLLECTION: ');
    expect(existsSync(join(root, 'nowhere'))).toBe(false);
  });

  test('a duplicate member name is refused by name', () => {
    const dir = initCollection();
    expect(addMember(dir, 'keeper').code).toBe(0);
    const again = addMember(dir, 'keeper');
    expect(again.code).toBe(1);
    expect(again.stderr).toStartWith("rig-create: INIT_MEMBER_EXISTS: collection 'harbour' already has a member 'keeper'");
    // A folder already there under members/ is refused too, though not registered.
    mkdirSync(join(dir, 'members', 'drifter'));
    expect(addMember(dir, 'drifter').stderr).toStartWith('rig-create: INIT_MEMBER_EXISTS: ');
    expect(arr(readJson(join(dir, 'collection.json')).members)).toHaveLength(1);
  });

  test('a name that is not one folder name, and an uncommitted collection.json, are refused by name', () => {
    const dir = initCollection();
    expect(addMember(dir, '../escape').stderr).toStartWith('rig-create: INIT_MEMBER_NAME_INVALID: ');
    writeFileSync(join(dir, 'collection.json'), `${readFileSync(join(dir, 'collection.json'), 'utf8')} `);
    expect(addMember(dir, 'keeper').stderr).toStartWith('rig-create: INIT_COLLECTION_DIRTY: ');
    expect(existsSync(join(dir, 'members', 'keeper'))).toBe(false);
  });

  test('usage errors exit 2', () => {
    const dir = initCollection();
    expect(cli(['init', '--member', dir], dir, ENV).code).toBe(2);
    expect(cli(['init', '--collection', '--member', dir, 'x'], dir, ENV).code).toBe(2);
  });
});

describe('pins', () => {
  function collectionWithBuilds(): string {
    const dir = initCollection();
    editCollection(dir, answerAll);
    expect(addMember(dir, 'keeper').code).toBe(0);
    expect(addMember(dir, 'lamplighter').code).toBe(0);
    build(dir, 'keeper', 1, 'first');
    build(dir, 'lamplighter', 1, 'first');
    collectionOutput(dir, 1);
    const pinned = cli(['collection', 'pin', dir, '--changed', 'first lineup'], dir, ENV);
    expect(pinned.stdout).toContain('collection v1: keeper v1, lamplighter v1');
    expect(pinned.code).toBe(0);
    expect(run(['git', 'commit', '-q', '-m', 'collection v1', '--', 'collection.json'], dir, ENV).code).toBe(0);
    return dir;
  }

  test('pin records each member version and the hash of every rig file, per variant', () => {
    const dir = collectionWithBuilds();
    const v1 = obj(arr(readJson(join(dir, 'collection.json')).versions)[0]);
    expect(v1.n).toBe(1);
    expect(v1.changed).toBe('first lineup');
    expect(arr(v1.outputs).map((o) => obj(o).path)).toEqual(['outputs/v1/lineup.png']);
    const keeper = obj(arr(v1.pins).map(obj).find((p) => p.member === 'keeper'));
    expect(keeper.version).toBe(1);
    const rig = obj(arr(keeper.rigs)[0]);
    expect(rig.variant).toBe('default');
    // The take is not a rig file; model, both atlas files and the config are.
    expect(arr(rig.files).map((f) => `${String(obj(f).role)} ${String(obj(f).path)}`)).toEqual([
      'model outputs/v1/skeleton.json',
      'atlas outputs/v1/atlas.atlas',
      'atlas outputs/v1/atlas.png',
      'config derived/v1/config.json',
    ]);
    expect(obj(arr(rig.files)[0]).sha256).toBe(sha('{"skeleton":"keeper first"}'));

    const report = checkCollection(dir);
    expect(report.refusals).toEqual([]);
    expect(report.pins_checked).toBe(1);
    expect(cli(['collection', '--check', dir], dir, ENV).code).toBe(0);
  });

  test('bar 1: a member rebuilt without new pins fails by member name; re-pinning clears it', () => {
    const dir = collectionWithBuilds();

    // keeper gets a new version; lamplighter is rebuilt in place with no new version.
    build(dir, 'keeper', 2, 'second');
    writeFileSync(join(dir, 'members', 'lamplighter', 'outputs', 'v1', 'skeleton.json'), '{"skeleton":"lamplighter rebuilt"}');

    const check = cli(['collection', '--check', dir], dir, ENV);
    expect(check.code).toBe(1);
    expect(check.stdout).toContain('REFUSED PIN_STALE: members[keeper]: rig version 2 is not pinned; pin v1 names version 1');
    expect(check.stdout).toContain('REFUSED PIN_STALE: members[lamplighter]: model sha256 differs from pin v1 (outputs/v1/skeleton.json');
    const stale = checkCollection(dir).refusals.filter((f) => f.code === 'PIN_STALE').map((f) => f.path);
    expect(stale).toEqual(['members[keeper]', 'members[lamplighter]']);

    // interview --check on the collection runs the same check, never SCHEMA_UNKNOWN.
    for (const target of [dir, join(dir, 'collection.json')]) {
      const viaInterview = cli(['interview', '--check', target], dir, ENV);
      expect(viaInterview.code).toBe(1);
      expect(viaInterview.stdout).toContain('PIN_STALE: members[keeper]');
      expect(viaInterview.stdout).not.toContain('SCHEMA_UNKNOWN');
    }

    // A pin over a file rebuilt in place is refused: the pin would name a build no version records.
    const refused = cli(['collection', 'pin', dir], dir, ENV);
    expect(refused.code).toBe(1);
    expect(refused.stdout).toContain('REFUSED PIN_SOURCE_DRIFT: members[lamplighter]: model outputs/v1/skeleton.json');
    expect(arr(readJson(join(dir, 'collection.json')).versions)).toHaveLength(1);

    // Record the rebuild as a version, make the new output, and pin it.
    build(dir, 'lamplighter', 2, 'second');
    collectionOutput(dir, 2);
    const repin = cli(['collection', 'pin', dir], dir, ENV);
    expect(repin.stdout).toContain('collection v2: keeper v2, lamplighter v2');
    expect(repin.code).toBe(0);
    const clean = cli(['collection', '--check', dir], dir, ENV);
    expect(clean.stdout).toContain('checked against collection v2');
    expect(clean.code).toBe(0);
  });

  test('a member added after the pins, and a pin for a member that is gone, are refused by name', () => {
    const dir = collectionWithBuilds();
    expect(addMember(dir, 'ferryman').code).toBe(0);
    editCollection(dir, (c) => {
      c.members = arr(c.members).filter((m) => obj(m).name !== 'lamplighter');
    });
    const report = checkCollection(dir);
    expect(report.refusals.map((f) => `${f.code} ${f.path}`)).toEqual(['PIN_MISSING members[ferryman]', 'PIN_UNKNOWN_MEMBER members[lamplighter]']);
    expect(report.warnings.map((w) => `${w.code} ${w.path}`)).toEqual(['MEMBER_UNREGISTERED members/lamplighter']);
  });

  test('a pin with no member builds is refused by member name', () => {
    const dir = initCollection();
    expect(addMember(dir, 'keeper').code).toBe(0);
    const r = cli(['collection', 'pin', dir], dir, ENV);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('REFUSED PIN_NO_BUILD: members[keeper]: has no rig version');
  });

  test('a pin made before a member had versions[] checks the hashes alone', () => {
    const dir = initCollection();
    editCollection(dir, answerAll);
    expect(addMember(dir, 'keeper').code).toBe(0);
    const model = join(dir, 'members', 'keeper', 'legacy', 'keeper.json');
    mkdirSync(dirname(model), { recursive: true });
    writeFileSync(model, 'legacy build');
    editCollection(dir, (c) => {
      c.versions = [{
        n: 1,
        pins: [{ member: 'keeper', version: null, note: 'predates versions[]', rigs: [{ variant: 'default', files: [{ role: 'model', path: 'legacy/keeper.json', sha256: sha('legacy build') }] }] }],
        outputs: [{ path: 'outputs/v1/lineup.png', sha256: sha('lineup v1'), bytes: 9 }],
      }];
    });
    expect(checkCollection(dir).refusals).toEqual([]);
    writeFileSync(model, 'legacy build, touched');
    expect(checkCollection(dir).refusals.map((f) => `${f.code} ${f.path}`)).toEqual(['PIN_STALE members[keeper]']);
  });

  test('a pin whose file hashes cannot be read is malformed, not a pass', () => {
    const dir = initCollection();
    editCollection(dir, answerAll);
    expect(addMember(dir, 'keeper').code).toBe(0);
    editCollection(dir, (c) => {
      c.versions = [{
        n: 1,
        pins: [{ member: 'keeper', version: null, rigs: [{ variant: 'default', model_sha256: sha('old shape') }] }],
        outputs: [{ path: 'outputs/v1/lineup.png', sha256: sha('lineup v1'), bytes: 9 }],
      }];
    });
    expect(checkCollection(dir).refusals.map((f) => f.code)).toContain('PIN_MALFORMED');
  });
});

describe('collection --check on the record', () => {
  test('a collection past interview with an unanswered question and no sign-off is refused by name', () => {
    const dir = initCollection();
    editCollection(dir, (c) => {
      c.stage = 'plan-approved';
    });
    const report = checkCollection(dir);
    expect(report.refusals.some((f) => f.code === 'STAGE_UNSIGNED' && f.message.includes("past 'interview'"))).toBe(true);
    expect(report.refusals.some((f) => f.code === 'COLLECTION_ITEM_SILENT' && f.path === 'interview.questions[reference_member].answer')).toBe(true);
  });

  test('an unknown stage is refused before anything else', () => {
    const dir = initCollection();
    editCollection(dir, (c) => {
      c.stage = 'rigging';
    });
    expect(checkCollection(dir).refusals.map((f) => f.code)).toEqual(['STAGE_UNKNOWN']);
  });
});
