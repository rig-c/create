import { afterEach, expect, test } from 'bun:test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderAgentGuide } from '../src/agent-guide.ts';
import { checkProject } from '../src/check.ts';
import { freshProjectRecord } from '../src/init.ts';
import { enqueuePublication, JOB_BINDING_FILE, JOB_OUTBOX_DIRECTORY, type WriterBinding } from '../src/job-outbox.ts';
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
