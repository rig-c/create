import { afterEach, expect, test } from 'bun:test';
import { cpSync, existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXAMPLE_NOW } from '../scripts/example-time.ts';
import { renderAgentGuide } from '../src/agent-guide.ts';
import { asArray, checkProject, isObject } from '../src/check.ts';
import { main } from '../src/cli.ts';
import { freshProjectRecord } from '../src/init.ts';
import { openCreateJob, openCurrentPublication, openRecordPublication, requestedRecordResult } from '../src/job-host.ts';
import { enqueuePublication, JOB_BINDING_FILE, JOB_OUTBOX_DIRECTORY, type WriterBinding } from '../src/job-outbox.ts';
import { nextCommand, nextProject, type NextMove } from '../src/next.ts';
import { Refusal } from '../src/refusal.ts';
import { readTemplate, type JsonObject } from '../src/templates.ts';
import { cli, tempDir } from './helpers.ts';

const roots: string[] = [];
const path = 'project.json.owner.language';
const now = Date.parse('2026-11-20T06:00:00Z');
const env = Object.fromEntries(Object.entries(process.env)
  .filter((entry): entry is [string, string] => entry[1] !== undefined));

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(project = freshProjectRecord('synthetic', now)): string {
  const root = tempDir();
  roots.push(root);
  writeFileSync(join(root, 'project.json'), JSON.stringify(project) + '\n');
  return root;
}

test('check warns for an undeclared language at both legacy and current dates', () => {
  const project = readTemplate('legacy-example-project.json');
  delete project.owner;
  const root = fixture(project);
  for (const date of ['2026-11-01T00:00:00Z', '2026-11-21T00:00:00Z']) {
    const report = checkProject(root, project, { now: Date.parse(date) });
    const declared = checkProject(root, { ...project, owner: { language: 'ko' } }, { now: Date.parse(date) });
    expect(report.warnings).toContainEqual(expect.objectContaining({ code: 'OWNER_LANGUAGE_MISSING', path }));
    expect(report.refusals).toEqual(declared.refusals);
    expect(report.ok).toBe(declared.ok);
  }
});

test('set records a canonical tag, preserves sibling metadata and is byte-idempotent', () => {
  const project = { ...freshProjectRecord('synthetic', now), owner: { display_name: 'Synthetic owner' } };
  const root = fixture(project);
  const file = join(root, 'project.json');
  const original = readFileSync(file);
  const invalid = cli(['owner-language', 'set', 'en_US'], root, env);
  expect(invalid.code).toBe(2);
  expect(invalid.stderr).toContain('OWNER_LANGUAGE_INVALID');
  expect(readFileSync(file)).toEqual(original);
  expect(cli(['owner-language', 'set', 'KO-kr'], root, env).code).toBe(0);
  const current = readFileSync(file);
  expect(JSON.parse(current.toString('utf8'))).toEqual({ ...project, owner: { ...project.owner, language: 'ko-KR' } });
  expect(cli(['owner-language', 'set', 'ko-KR'], root, env).code).toBe(0);
  expect(readFileSync(file)).toEqual(current);
});

test('bad init language refuses before scaffolding', () => {
  const root = fixture();
  const target = join(root, 'bad');
  const result = cli(['init', target, '--no-install', '--owner-language', 'ko_KR'], root, env);
  expect(result.code).toBe(2);
  expect(result.stderr).toContain('OWNER_LANGUAGE_INVALID');
  expect(existsSync(target)).toBe(false);
});

test('plan, question and draft publication refuse an undeclared language before opening a host', () => {
  const root = fixture({ ...freshProjectRecord('synthetic', now), drafts: [{ id: 'synthetic' }] });
  const file = join(root, 'project.json');
  const original = readFileSync(file);
  for (const target of [['--plan'], ['--question', 'rig_type'], ['--draft', 'synthetic']]) {
    const result = cli(['job', 'open', root, '--reviewer', 'owner', '--role', 'owner', ...target], root, env);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('OWNER_LANGUAGE_MISSING');
    expect(result.stderr).toContain(path);
    expect(result.stderr).toContain('owner-language set');
    expect(result.stdout).toBe('');
  }
  expect(existsSync(join(root, JOB_BINDING_FILE))).toBe(false);
  expect(existsSync(join(root, JOB_OUTBOX_DIRECTORY))).toBe(false);
  expect(readFileSync(file)).toEqual(original);
});

test('a new live publication validates candidate bytes before writing an outbox receipt', () => {
  const project = { ...freshProjectRecord('synthetic', now), owner: { language: 'ko' } };
  const root = fixture(project);
  const file = join(root, 'project.json');
  const original = readFileSync(file);
  const binding = {} as WriterBinding;
  const result = { path: 'review-draft-1.json', selector: { kind: 'draft', id: '1' } } as const;
  const candidate: JsonObject = { ...project, owner: { language: 'not_a_tag' } };
  expect(() => enqueuePublication(root, binding, result, Buffer.from(JSON.stringify(candidate))))
    .toThrow(expect.objectContaining({ code: 'OWNER_LANGUAGE_INVALID' }));
  expect(existsSync(join(root, JOB_OUTBOX_DIRECTORY))).toBe(false);
  expect(readFileSync(file)).toEqual(original);
});

test('the rendered guide names each authored field and fits its byte budget', () => {
  const guide = renderAgentGuide();
  const language = guide.slice(guide.indexOf('**Owner language.**'), guide.indexOf('**Prior words.**'));
  for (const field of ['owner.language', 'does', 'produces', 'bar', 'asks[].prompt', 'label', 'effect', 'reason']) {
    expect(language.split('`' + field + '`')).toHaveLength(2);
  }
  expect(Buffer.byteLength(guide)).toBeLessThan(10_000);
});

function needsJobHost(move: NextMove): boolean {
  return Boolean(move.command && (move.command.startsWith('rig-create job ') || move.command.includes('--from-review')));
}

function printedArgs(command: string): string[] {
  const words: string[] = [];
  let word = '', quote = '', started = false;
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;
    if (quote) {
      if (char === quote) quote = '';
      else word += char;
      started = true;
    } else if (char === "'" || char === '"') { quote = char; started = true; }
    else if (char === '\\') { word += command[++i]!; started = true; }
    else if (/\s/.test(char)) { if (started) { words.push(word); word = ''; started = false; } }
    else { word += char; started = true; }
  }
  if (started) words.push(word);
  return words;
}

function runMainQuiet(argv: string[], at: number): number {
  const origOut = process.stdout.write;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    return main(argv, at);
  } finally {
    process.stdout.write = origOut;
  }
}

test('#1077 next offers owner-language set before job open when owner language is missing or invalid', async () => {
  const freshDir = realpathSync(fixture(freshProjectRecord('synthetic-fresh', EXAMPLE_NOW)));
  expect(() => requestedRecordResult(freshDir, undefined, true, EXAMPLE_NOW))
    .toThrow(expect.objectContaining({ code: 'OWNER_LANGUAGE_MISSING' }));
  const freshReport = nextProject(freshDir, EXAMPLE_NOW);
  const freshLanguageMove = freshReport.moves.find(move => move.field === 'owner.language');
  expect(freshLanguageMove).toMatchObject({
    role: 'agent',
    field: 'owner.language',
    awaits: 'owner.language',
    command: `rig-create owner-language set '<tag>' ${freshDir}`,
  });
  expect(freshLanguageMove!.act).toContain('OWNER_LANGUAGE_MISSING');
  expect(freshLanguageMove!.act).toContain('relayed chat');
  expect(runMainQuiet(printedArgs(freshLanguageMove!.command!).slice(1).map(arg => arg === '<tag>' ? 'ko' : arg), EXAMPLE_NOW)).toBe(0);
  expect(nextProject(freshDir, EXAMPLE_NOW).moves.some(move => move.field === 'owner.language')).toBe(false);
  let freshError: unknown;
  try { requestedRecordResult(freshDir, undefined, true, EXAMPLE_NOW); } catch (error) { freshError = error; }
  expect(freshError).toBeInstanceOf(Refusal);
  expect((freshError as Refusal).code).toBe('JOB_RECORD_INCOMPLETE');

  const chainDir = join(import.meta.dir, '../templates/example-chain');
  const chainQuestionDir = join(chainDir, 'checkpoints/0a-interview-options');
  const currentExampleDir = join(import.meta.dir, '../templates/example-current');

  for (const [checkpointDir, mutate, expectedCode, kind] of [
    [chainQuestionDir, (project: JsonObject) => { delete project.owner; }, 'OWNER_LANGUAGE_MISSING', 'question'] as const,
    [currentExampleDir, (project: JsonObject) => { project.owner = { language: 'en_US' }; }, 'OWNER_LANGUAGE_INVALID', 'parts'] as const,
  ]) {
    const root = realpathSync(tempDir());
    roots.push(root);
    cpSync(checkpointDir, root, { recursive: true });
    const file = join(root, 'project.json');
    if (kind === 'parts') {
      const atParts = JSON.parse(readFileSync(file, 'utf8')) as JsonObject;
      atParts.owner = { language: 'en' };
      atParts.stage = 'parts';
      atParts.signoffs = asArray(atParts.signoffs).slice(0, 2);
      atParts.advances = asArray(atParts.advances).slice(0, 2);
      delete (atParts.current as JsonObject).rig;
      delete (atParts.current as JsonObject).motion;
      delete (atParts.current as JsonObject).direction;
      (atParts.plan as JsonObject).steps = asArray((atParts.plan as JsonObject).steps).filter(
        step => isObject(step) && (step.id === 'seethrough' || step.id === 'assemble'),
      );
      delete (atParts.interview as JsonObject).rigging_context;
      for (const item of asArray(((atParts.interview as JsonObject).post as JsonObject).items).filter(isObject)) item.guide = null;
      writeFileSync(file, `${JSON.stringify(atParts, null, 2)}\n`);
    }
    const baseline = nextCommand([root, '--json'], EXAMPLE_NOW);

    const mutated = JSON.parse(readFileSync(file, 'utf8')) as JsonObject;
    mutate(mutated);
    writeFileSync(file, `${JSON.stringify(mutated, null, 2)}\n`);

    expect(checkProject(root, undefined, { now: EXAMPLE_NOW, readOnly: true }).warnings)
      .toContainEqual(expect.objectContaining({ code: expectedCode, path }));

    if (kind === 'question') {
      expect(() => requestedRecordResult(root, 'rig_type', false, EXAMPLE_NOW))
        .toThrow(expect.objectContaining({ code: expectedCode }));
    } else {
      const refused = cli(['job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner', '--current', 'parts'], root, env);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain(expectedCode);
    }

    const report = nextProject(root, EXAMPLE_NOW);
    const moveIndex = report.moves.findIndex(move => move.field === 'owner.language');
    const firstJobMoveIndex = report.moves.findIndex(needsJobHost);
    expect(moveIndex).toBeGreaterThanOrEqual(0);
    expect(firstJobMoveIndex).toBe(moveIndex + 1);
    const jobMove = report.moves[firstJobMoveIndex]!;
    expect(jobMove.command).toStartWith('rig-create job open ');
    expect(jobMove.command).toContain(kind === 'question' ? '--question rig_type' : '--current parts');
    expect(report.awaits).toContain('owner.language');

    const languageMove = report.moves[moveIndex]!;
    expect(languageMove).toMatchObject({
      role: 'agent',
      field: 'owner.language',
      awaits: 'owner.language',
      command: `rig-create owner-language set '<tag>' ${root}`,
    });
    expect(languageMove.act).toContain(expectedCode);
    expect(languageMove.act).toContain('relayed chat');

    const setArgv = printedArgs(languageMove.command!).slice(1).map(arg => arg === '<tag>' ? 'en' : arg);
    expect(runMainQuiet(setArgv, EXAMPLE_NOW)).toBe(0);

    const after = nextCommand([root, '--json'], EXAMPLE_NOW);
    expect(after).toEqual(baseline);

    const host = await openCreateJob(root, { id: 'synthetic-owner', role: 'owner' }, EXAMPLE_NOW, undefined, kind === 'question');
    try {
      const lines = kind === 'question'
        ? await openRecordPublication(root, host, 'rig_type', false, EXAMPLE_NOW)
        : await openCurrentPublication(root, host, 'parts', EXAMPLE_NOW);
      expect(lines[0]).toContain('published');
    } finally {
      host.stop();
    }
  }
}, 20_000);
