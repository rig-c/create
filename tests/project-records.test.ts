import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_BOUNCE_SINCE } from '../src/stages.ts';
import type { Json } from '../src/templates.ts';
import { LEGACY_POST_DRAFT_WARNINGS, arr, fixture, obj, waypoint, withCode } from './fixtures.ts';
import { cli, gitEnv, tempDir } from './helpers.ts';
import { checkProject } from './clock.ts';

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const read = (dir: string) => JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'));
const history = (p: Parameters<typeof waypoint>[0]) => arr(waypoint(p, 'seethrough').history);

describe('prepared inputs recorded after external work', () => {
  test('the filled example verifies both shipped files and its agent bounce', () => {
    const r = checkProject(fixture());
    expect(r.refusals).toEqual([]);
    expect(r.warnings.map(f => f.code)).toEqual(['QUESTION_SET_STALE', 'PARTS_VERDICT_FILE_LEGACY', ...LEGACY_POST_DRAFT_WARNINGS, 'RIGGING_INTERVIEW_PAINTING_LEGACY', 'STAGE_ORDER_LEGACY', 'INPUT_WRITER_MISSING', 'CHOICE_ANSWERS_LEGACY', 'CORRECTION_PATH_LEGACY']);
  });

  test('derived add appends source, result, operation and both measured hashes through the CLI', () => {
    const dir = fixture();
    const before = read(dir);
    const source = readFileSync(join(dir, 'inputs/preparation-source.svg'), 'utf8');
    const output = readFileSync(join(dir, 'derived/prepared.svg'), 'utf8');
    const command = cli(['derived', 'add', dir, '--source', 'inputs/preparation-source.svg', '--file', 'derived/prepared.svg', '--operation', 'external scaling and white composite', '--json'], dir, gitEnv());
    expect(command.code).toBe(0);
    expect(command.stderr).toBe('');
    expect(JSON.parse(command.stdout)).toEqual({ kind: 'prepared-input', source: { path: 'inputs/preparation-source.svg', sha256: sha(source) }, path: 'derived/prepared.svg', sha256: sha(output), operation: 'external scaling and white composite' });
    const after = read(dir);
    expect(after.derived.slice(0, -1)).toEqual(before.derived);
    expect(after.stage).toBe(before.stage);
    expect(after.signoffs).toEqual(before.signoffs);
    expect(readFileSync(join(dir, 'inputs/preparation-source.svg'), 'utf8')).toBe(source);
    expect(readFileSync(join(dir, 'derived/prepared.svg'), 'utf8')).toBe(output);
    expect(checkProject(dir).ok).toBe(true);
  });

  for (const [name, at] of [['inputs/preparation-source.svg', 'derived[0].source'], ['derived/prepared.svg', 'derived[0]']]) {
    test(`changed file is refused by name: ${name}`, () => {
      const dir = fixture();
      writeFileSync(join(dir, name as string), 'changed');
      const r = checkProject(dir);
      expect(withCode(r, 'DERIVED_FILE_CHANGED').map((f) => f.path)).toEqual([`${at}.sha256`]);
      expect(withCode(r, 'DERIVED_FILE_CHANGED')[0]?.message).toContain(name as string);
      expect(r.ok).toBe(false);
      expect(cli(['interview', '--check', dir, '--json'], dir, gitEnv()).code).toBe(1);
    });
  }

  test('a missing tracked source is refused by name', () => {
    const dir = fixture();
    rmSync(join(dir, 'inputs/preparation-source.svg'));
    const r = checkProject(dir);
    expect(withCode(r, 'DERIVED_FILE_UNREADABLE').map((f) => f.path)).toEqual(['derived[0].source.path']);
    expect(withCode(r, 'DERIVED_FILE_UNREADABLE')[0]?.message).toContain('inputs/preparation-source.svg');
    expect(r.ok).toBe(false);
  });

  test('an absent regenerable result passes with its name and recorded operation in a warning', () => {
    const dir = fixture();
    const operation = read(dir).derived[0].operation;
    rmSync(join(dir, 'derived/prepared.svg'));
    const r = checkProject(dir);
    expect(r.refusals).toEqual([]);
    expect(r.ok).toBe(true);
    const warnings = r.warnings.filter((finding) => finding.code === 'DERIVED_RESULT_MISSING');
    expect(warnings.map((finding) => finding.path)).toEqual(['derived[0].path']);
    expect(warnings[0]?.message).toContain('derived/prepared.svg');
    expect(warnings[0]?.message).toContain(operation);
    expect(cli(['interview', '--check', dir, '--json'], dir, gitEnv()).code).toBe(0);
  });

  test('old projects without derived entries, and old untagged intermediates, pass', () => {
    expect(checkProject(fixture((p) => { p.derived = []; })).ok).toBe(true);
    expect(checkProject(fixture((p) => { delete p.derived; })).ok).toBe(true);
    expect(checkProject(fixture((p) => { p.derived = arr(p.derived).slice(1); })).ok).toBe(true);
  });

  test('malformed tagged records are refused, including an absent hash and an escaping path', () => {
    for (const edit of [{ operation: ' ' }, { sha256: null }, { path: '../outside.svg' }, { path: 'project.json' }, { path: 'inputs/preparation-source.svg' }, { source: {} }]) {
      const r = checkProject(fixture((p) => Object.assign(obj(arr(p.derived)[0]), edit)));
      expect(withCode(r, 'DERIVED_MALFORMED').map((f) => f.path)).toEqual(['derived[0]']);
    }
  });

  test('failed registration writes nothing', () => {
    const dir = fixture();
    const original = readFileSync(join(dir, 'project.json'), 'utf8');
    for (const [source, output, code] of [
      ['missing.svg', 'derived/prepared.svg', 'DERIVED_FILE_UNREADABLE'],
      ['../outside.svg', 'derived/prepared.svg', 'DERIVED_PATH_INVALID'],
      ['inputs/preparation-source.svg', 'inputs/preparation-source.svg', 'DERIVED_PATH_INVALID'],
      ['project.json', 'derived/prepared.svg', 'DERIVED_PATH_INVALID'],
    ]) {
      const r = cli(['derived', 'add', dir, '--source', source as string, '--file', output as string, '--operation', 'external work'], dir, gitEnv());
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(code as string);
      expect(readFileSync(join(dir, 'project.json'), 'utf8')).toBe(original);
    }
    const usage = cli(['derived', 'add', dir, '--source', 'a'], dir, gitEnv());
    expect(usage.code).toBe(2);
    expect(usage.stderr).toContain('DERIVED_USAGE');
    expect(readFileSync(join(dir, 'project.json'), 'utf8')).toBe(original);
  });

  test('derived add records a run folder entry with sorted members and reproducible digest, leaving single-file entries unchanged', () => {
    const dir = fixture();
    const before = read(dir);
    const source = readFileSync(join(dir, 'inputs/preparation-source.svg'), 'utf8');
    mkdirSync(join(dir, 'derived/seethrough-run/parts'), { recursive: true });
    writeFileSync(join(dir, 'derived/seethrough-run/parts/b.png'), 'synthetic-part-b');
    writeFileSync(join(dir, 'derived/seethrough-run/layers.json'), '{"layers":["a","b"]}\n');
    writeFileSync(join(dir, 'derived/seethrough-run/parts/a.png'), 'synthetic-part-a');

    const expectedMembers = [
      { path: 'layers.json', sha256: sha('{"layers":["a","b"]}\n') },
      { path: 'parts/a.png', sha256: sha('synthetic-part-a') },
      { path: 'parts/b.png', sha256: sha('synthetic-part-b') },
    ];
    const expectedDigest = sha(expectedMembers.map((m) => `${m.path}\t${m.sha256}\n`).join(''));

    const command = cli(['derived', 'add', dir, '--source', 'inputs/preparation-source.svg', '--file', 'derived/seethrough-run', '--operation', 'synthetic seethrough pass', '--json'], dir, gitEnv());
    expect(command.code).toBe(0);
    expect(command.stderr).toBe('');
    expect(JSON.parse(command.stdout)).toEqual({
      kind: 'run',
      source: { path: 'inputs/preparation-source.svg', sha256: sha(source) },
      path: 'derived/seethrough-run',
      members: expectedMembers,
      sha256: expectedDigest,
      operation: 'synthetic seethrough pass',
    });

    const after = read(dir);
    expect(after.derived.slice(0, -1)).toEqual(before.derived);
    expect(after.derived[0]).toEqual(before.derived[0]);
    expect(checkProject(dir).ok).toBe(true);

    const dir2 = fixture();
    mkdirSync(join(dir2, 'derived/seethrough-run/parts'), { recursive: true });
    writeFileSync(join(dir2, 'derived/seethrough-run/layers.json'), '{"layers":["a","b"]}\n');
    writeFileSync(join(dir2, 'derived/seethrough-run/parts/a.png'), 'synthetic-part-a');
    writeFileSync(join(dir2, 'derived/seethrough-run/parts/b.png'), 'synthetic-part-b');
    const second = cli(['derived', 'add', dir2, '--source', 'inputs/preparation-source.svg', '--file', 'derived/seethrough-run', '--json'], dir2, gitEnv());
    expect(second.code).toBe(0);
    expect(JSON.parse(second.stdout).sha256).toBe(expectedDigest);
    expect(JSON.parse(second.stdout).members).toEqual(expectedMembers);
  });

  test('a run folder without layers.json is refused with DERIVED_RUN_MISSING_LAYERS and leaves project.json byte-identical', () => {
    const dir = fixture();
    mkdirSync(join(dir, 'derived/no-layers/parts'), { recursive: true });
    writeFileSync(join(dir, 'derived/no-layers/parts/a.png'), 'synthetic-part-a');
    writeFileSync(join(dir, 'derived/no-layers/parts/b.png'), 'synthetic-part-b');
    const original = readFileSync(join(dir, 'project.json'), 'utf8');

    const r = cli(['derived', 'add', dir, '--source', 'inputs/preparation-source.svg', '--file', 'derived/no-layers', '--operation', 'synthetic run'], dir, gitEnv());
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('DERIVED_RUN_MISSING_LAYERS');
    expect(readFileSync(join(dir, 'project.json'), 'utf8')).toBe(original);
  });

  test('a run whose source sits inside its own folder is refused by the writer and by check', () => {
    const dir = fixture();
    mkdirSync(join(dir, 'derived/self-run/parts'), { recursive: true });
    writeFileSync(join(dir, 'derived/self-run/layers.json'), '{"layers":["a"]}\n');
    writeFileSync(join(dir, 'derived/self-run/parts/a.png'), 'synthetic-part-a');
    const original = readFileSync(join(dir, 'project.json'), 'utf8');
    const r = cli(['derived', 'add', dir, '--source', 'derived/self-run/layers.json', '--file', 'derived/self-run', '--operation', 'synthetic run'], dir, gitEnv());
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('DERIVED_PATH_INVALID');
    expect(readFileSync(join(dir, 'project.json'), 'utf8')).toBe(original);

    const ok = cli(['derived', 'add', dir, '--source', 'inputs/preparation-source.svg', '--file', 'derived/self-run', '--operation', 'synthetic run'], dir, gitEnv());
    expect(ok.code).toBe(0);
    const project = read(dir);
    const entry = project.derived[project.derived.length - 1];
    entry.source = { path: 'derived/self-run/layers.json', sha256: entry.members.find((m: { path: string }) => m.path === 'layers.json').sha256 };
    writeFileSync(join(dir, 'project.json'), `${JSON.stringify(project, null, 2)}\n`);
    expect(checkProject(dir).refusals.map(f => f.code)).toContain('DERIVED_MALFORMED');
  });

  test('changing one run member bytes causes check to refuse with DERIVED_FILE_CHANGED and the member path', () => {
    const dir = fixture();
    mkdirSync(join(dir, 'derived/seethrough-run/parts'), { recursive: true });
    writeFileSync(join(dir, 'derived/seethrough-run/layers.json'), '{"layers":["a","b"]}\n');
    writeFileSync(join(dir, 'derived/seethrough-run/parts/a.png'), 'synthetic-part-a');
    writeFileSync(join(dir, 'derived/seethrough-run/parts/b.png'), 'synthetic-part-b');
    const add = cli(['derived', 'add', dir, '--source', 'inputs/preparation-source.svg', '--file', 'derived/seethrough-run', '--operation', 'synthetic seethrough pass'], dir, gitEnv());
    expect(add.code).toBe(0);
    const index = read(dir).derived.length - 1;

    writeFileSync(join(dir, 'derived/seethrough-run/parts/a.png'), 'tampered-part-a');
    const r = checkProject(dir);
    expect(r.ok).toBe(false);
    const findings = withCode(r, 'DERIVED_FILE_CHANGED');
    expect(findings.map((f) => f.path)).toEqual([`derived[${index}].members[1].sha256`]);
    expect(findings[0]?.message).toContain('derived/seethrough-run/parts/a.png');
    expect(findings[0]?.message).toContain('parts/a.png');

    rmSync(join(dir, 'derived/seethrough-run/parts/b.png'));
    const missingMember = checkProject(dir);
    expect(withCode(missingMember, 'DERIVED_FILE_UNREADABLE').map((f) => f.path)).toEqual([`derived[${index}].members[2].path`]);
    expect(withCode(missingMember, 'DERIVED_FILE_UNREADABLE')[0]?.message).toContain('derived/seethrough-run/parts/b.png');

    rmSync(join(dir, 'derived/seethrough-run'), { recursive: true });
    const missingFolder = checkProject(dir);
    expect(missingFolder.ok).toBe(true);
    const warnings = missingFolder.warnings.filter((w) => w.code === 'DERIVED_RESULT_MISSING' && w.path === `derived[${index}].path`);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain('derived/seethrough-run');
  });
});

describe('agent-found bounces in guide history', () => {
  test('the fixture states cause, failed route, bar and replacement, without a human verdict', () => {
    const p = read(fixture());
    expect(p.interview.waypoints[0].history[0].bounce.cause).toBe('agent');
    expect(checkProject(fixture()).feedback).toHaveLength(2);
  });

  for (const bounce of [null, 'free-form', {}, { cause: 'user', failed: 'a', bar: 'b', replacement: 'c' }, { cause: 'agent', failed: ' ', bar: 'b', replacement: 'c' }, { cause: 'agent', failed: 'a', bar: 'b' }] as Json[]) {
    test(`new malformed bounce is refused by its history path: ${JSON.stringify(bounce)}`, () => {
      const dir = fixture((p) => { waypoint(p, 'seethrough').history = [{ at: AGENT_BOUNCE_SINCE, bounce }]; });
      const r = checkProject(dir);
      expect(withCode(r, 'AGENT_BOUNCE_MALFORMED').map((f) => f.path)).toEqual(['interview.waypoints[seethrough].history[0].bounce']);
      expect(r.ok).toBe(false);
      expect(cli(['interview', '--check', dir], dir, gitEnv()).code).toBe(1);
    });
  }

  for (const at of ['2026-11-04T23:59:59.999Z', 'unreadable', null]) {
    test(`legacy free-form bounce warns, preserving a passing project: ${at}`, () => {
      const dir = fixture((p) => { waypoint(p, 'seethrough').history = [{ at, bounce: { reason: 'first route failed' } }]; });
      const r = checkProject(dir);
      expect(r.ok).toBe(true);
      expect(withCode(r, 'AGENT_BOUNCE_MALFORMED')).toEqual([]);
      expect(r.warnings.filter((w) => w.code === 'AGENT_BOUNCE_LEGACY').map((w) => w.path)).toEqual(['interview.waypoints[seethrough].history[0].bounce']);
      expect(r.warnings.find((w) => w.code === 'AGENT_BOUNCE_LEGACY')?.message).toContain("{ cause: 'agent', failed, bar, replacement }");
      expect(cli(['interview', '--check', dir], dir, gitEnv()).code).toBe(0);
    });
  }

  test('a missing date is legacy; ordinary replaced answers are untouched', () => {
    const r = checkProject(fixture((p) => { history(p).push({ bounce: {} }, { delegated: false, verbatim: 'an old answer', value: 'a' }); }));
    expect(r.ok).toBe(true);
    expect(r.warnings.filter((w) => w.code === 'AGENT_BOUNCE_LEGACY')).toHaveLength(1);
  });

  test('an inherited guide validates the collection history it reads', () => {
    const original = fixture((p) => {
      waypoint(p, 'seethrough').guide = { basis: 'inherited', from: { collection: 'group', question: 'seethrough' } };
    });
    const root = tempDir();
    mkdirSync(join(root, 'members'));
    const dir = join(root, 'members', 'member');
    renameSync(original, dir);
    writeFileSync(join(root, 'collection.json'), JSON.stringify({ name: 'group', interview: { waypoints: [{ id: 'seethrough', guide: { delegated: true }, history: [{ at: AGENT_BOUNCE_SINCE, bounce: {} }] }] } }));
    expect(withCode(checkProject(dir), 'AGENT_BOUNCE_MALFORMED').map((f) => f.path)).toEqual(['collection.interview[seethrough].history[0].bounce']);
  });
});
