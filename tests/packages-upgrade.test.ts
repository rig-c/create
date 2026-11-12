import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { packagesCommand, jsonSpans } from '../src/packages-upgrade.ts';
import { packageUpgradeFindings } from '../src/package-upgrades.ts';
import { PINNED_PACKAGES } from '../src/pins.ts';
import { readTemplate } from '../src/templates.ts';
import { checkProject } from '../src/check.ts';
import { Refusal } from '../src/refusal.ts';
import { tempDir } from './helpers.ts';
import { EXAMPLE_NOW } from '../scripts/example-time.ts';

const roots: string[] = [];
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const pins = { ...PINNED_PACKAGES, '@rig-c/review': '2.13.0' };
function fixture(dependencies: Record<string, string>) {
  const dir = tempDir(); roots.push(dir);
  const project = readTemplate('project.json');
  const bytes = JSON.stringify(project, null, '\t') + '\n';
  writeFileSync(join(dir, 'project.json'), bytes);
  writeFileSync(join(dir, 'package.json'), '{\n "name": "synthetic-project", "private": true, "description": "preserve  spaces",\n "dependencies": ' + JSON.stringify(dependencies) + '\n}\n');
  mkdirSync(join(dir, 'node_modules'));
  writeFileSync(join(dir, 'node_modules/sentinel'), 'original-install');
  writeFileSync(join(dir, 'bun.lock'), 'original-lock\n');
  return { dir, bytes };
}
function refusal(fn: () => unknown, code: string) {
  try { fn(); throw new Error('expected refusal'); } catch (error) { expect(error).toBeInstanceOf(Refusal); expect((error as Refusal).code).toBe(code); }
}
function snapshot(dir: string) {
  return ['project.json', 'package.json', 'bun.lock', 'node_modules/sentinel'].map(path => readFileSync(join(dir, path)).toString('base64'));
}

test('JSON spans preserve escaped keys, nested objects and unrelated whitespace', () => {
  const text = '{ "dependencies": {"@rig-c/parts": "2.23.4"}, "other": ["\\\"", {"a": true}]}\n';
  const span = jsonSpans(text).get(JSON.stringify(['dependencies', '@rig-c/parts']))!;
  expect(text.slice(...span)).toBe('"2.23.4"');
});

test('already-current and newer pins refuse without touching bytes or install', () => {
  for (const [dependencies, code] of [[pins, 'PACKAGE_UPGRADE_CURRENT'], [{ ...pins, '@rig-c/parts': '999.0.0' }, 'PACKAGE_UPGRADE_DOWNGRADE']] as const) {
    const { dir } = fixture(dependencies); const before = snapshot(dir);
    refusal(() => packagesCommand(['upgrade', dir, '--by', 'operator'], EXAMPLE_NOW), code);
    expect(snapshot(dir)).toEqual(before);
  }
});

test('malformed present history has the same named refusal in writer and project check', () => {
  const { dir } = fixture({ ...pins, '@rig-c/parts': '2.23.4' });
  const project = readTemplate('project.json'); project.package_upgrades = [{ by: 'operator' }];
  writeFileSync(join(dir, 'project.json'), JSON.stringify(project));
  expect(packageUpgradeFindings(project).map(f => f.code)).toEqual(['PACKAGE_UPGRADE_MALFORMED']);
  expect(checkProject(dir, project, { now: EXAMPLE_NOW, readOnly: true }).refusals.map(f => f.code)).toContain('PACKAGE_UPGRADE_MALFORMED');
  const before = snapshot(dir);
  refusal(() => packagesCommand(['upgrade', dir, '--by', 'operator'], EXAMPLE_NOW), 'PACKAGE_UPGRADE_MALFORMED');
  expect(snapshot(dir)).toEqual(before);
});

test('an older synthetic project upgrades all release pins and preserves unrelated bytes', () => {
  const { dir, bytes } = fixture({ ...pins, '@rig-c/parts': '2.23.4' });
  const manifest = readFileSync(join(dir, 'package.json'), 'utf8');
  rmSync(join(dir, 'bun.lock'));
  const install = Bun.spawnSync([process.execPath, 'install', '--ignore-scripts'], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
  expect(install.exitCode).toBe(0);
  expect(JSON.parse(readFileSync(join(dir, 'node_modules/@rig-c/parts/package.json'), 'utf8')).version).toBe('2.23.4');
  const result = packagesCommand(['upgrade', dir, '--by', 'operator'], EXAMPLE_NOW);
  expect(result).toContain('package_upgrades[0]');
  const nextManifest = readFileSync(join(dir, 'package.json'), 'utf8');
  expect(nextManifest).toBe(manifest.replace('2.23.4', pins['@rig-c/parts']));
  const record = readFileSync(join(dir, 'project.json'), 'utf8');
  const project = JSON.parse(record);
  expect(record.slice(0, bytes.lastIndexOf('}'))).toBe(bytes.slice(0, bytes.lastIndexOf('}')));
  expect(project.package_upgrades[0]).toMatchObject({ by: 'operator', at: new Date(EXAMPLE_NOW).toISOString(), packages: [{ name: '@rig-c/core', from: pins['@rig-c/core'], to: pins['@rig-c/core'] }, { name: '@rig-c/parts', from: '2.23.4', to: pins['@rig-c/parts'] }, { name: '@rig-c/review', from: '2.13.0', to: '2.13.0' }] });
  expect(packageUpgradeFindings(project)).toEqual([]);
  expect(existsSync(join(dir, 'node_modules/sentinel'))).toBe(false);
}, 30000);


test('a newly derived waypoint refusal restores record, lock, manifest and the original install', () => {
  const { dir } = fixture({ ...pins, '@rig-c/parts': '2.23.4' });
  const parts = join(dir, 'node_modules/@rig-c/parts');
  mkdirSync(join(parts, 'src'), { recursive: true });
  writeFileSync(join(parts, 'package.json'), JSON.stringify({ name: '@rig-c/parts', version: '2.23.4', type: 'module' }));
  writeFileSync(join(parts, 'src/config.ts'), "export const CONFIG_SECTIONS = ['key'];\n");
  const project = readTemplate('project.json');
  const interview = project.interview as import('../src/templates.ts').JsonObject;
  interview.waypoints = [];
  writeFileSync(join(dir, 'project.json'), JSON.stringify(project));
  const before = snapshot(dir);
  try {
    packagesCommand(['upgrade', dir, '--by', 'operator'], EXAMPLE_NOW);
    throw new Error('expected refusal');
  } catch (error) {
    expect(error).toBeInstanceOf(Refusal);
    expect((error as Refusal).code).toBe('PACKAGE_UPGRADE_REFUSAL');
    expect((error as Error).message).toContain('WAYPOINT_MISSING');
    expect((error as Error).message).toContain('@rig-c/parts');
  }
  expect(snapshot(dir)).toEqual(before);
  expect(readFileSync(join(parts, 'src/config.ts'), 'utf8')).toBe("export const CONFIG_SECTIONS = ['key'];\n");
}, 30000);

test('job open --question publishes after upgrading an actual older synthetic install', async () => {
  const { fixture: example, retainSignoffs, arr, obj } = await import('./fixtures.ts');
  const { stageIndex } = await import('../src/stages.ts');
  const { collectItems } = await import('../src/check.ts');
  const { optionContext } = await import('../src/choices.ts');
  const { interviewOptionsCommand } = await import('../src/choice-writers.ts');
  const { jobRuntimeExecArgv } = await import('../src/job-writer.ts');
  const { jobPrivateRoot, jobHostStateRoot } = await import('../src/job-outbox.ts');
  const { closeCreateJob } = await import('../src/job-host.ts');
  const dir = example(project => {
    project.stage = 'rigging-interview'; project.versions = []; project.scenes = []; delete project.direction_contract;
    retainSignoffs(project, signature => stageIndex(String(obj(signature).stage)) < stageIndex('rigging-interview'));
    project.advances = arr(project.advances).filter(value => stageIndex(String(obj(value).stage)) <= stageIndex('rigging-interview'));
    for (const item of arr(obj(obj(project.interview).post).items).map(obj)) item.guide = null;
    for (const step of arr(obj(project.plan).steps).map(obj)) if (!['seethrough', 'assemble'].includes(String(step.id))) step.status = 'pending';
  }, 'example-project.json');
  roots.push(dir);
  let opening: Bun.Subprocess | undefined;
  try {
    const project = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'));
    const item = collectItems(project, { collection: null }).find(item => item.id === 'motion')!;
    const retained = obj(obj(item.raw).choice).set as import('../src/templates.ts').JsonObject;
    const set = JSON.parse(readFileSync(join(dir, String(retained.path)), 'utf8'));
    set.id = 'upgrade-motion'; set.drafted_at = new Date(EXAMPLE_NOW - 1000).toISOString();
    set.context = optionContext(project, 'rigging-interview', EXAMPLE_NOW - 1000, dir);
    const path = 'evidence/interview/upgrade-motion.json';
    writeFileSync(join(dir, path), JSON.stringify(set, null, 2) + '\n');
    interviewOptionsCommand(['motion', dir, '--file', path], EXAMPLE_NOW);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'synthetic-record-project', private: true, dependencies: { ...pins, '@rig-c/parts': '2.23.4' } }));
    const install = Bun.spawnSync([process.execPath, 'install', '--ignore-scripts'], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
    expect(install.exitCode).toBe(0);
    packagesCommand(['upgrade', dir, '--by', 'operator'], EXAMPLE_NOW);
    const { clockedCli } = await import('./helpers.ts');
    opening = Bun.spawn([process.execPath, ...jobRuntimeExecArgv(), ...clockedCli(), 'job', 'open', dir, '--reviewer', 'synthetic-owner', '--role', 'owner', '--question', 'motion'], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
    const reader = (opening.stdout as ReadableStream<Uint8Array>).getReader();
    let output = '';
    while (!output.includes('job: option-set motion/upgrade-motion published')) {
      const chunk = await reader.read(); if (chunk.done) break;
      output += new TextDecoder().decode(chunk.value);
    }
    reader.releaseLock();
    expect(output).toContain('job: option-set motion/upgrade-motion published');
    await closeCreateJob(dir);
    expect(await opening.exited).toBe(0);
  } finally {
    await closeCreateJob(dir).catch(() => {});
    if (opening && opening.exitCode === null) { opening.kill(); await opening.exited; }
    rmSync(jobPrivateRoot(dir), { recursive: true, force: true });
    rmSync(jobHostStateRoot(dir), { recursive: true, force: true });
  }
}, 30000);

test('install failure preserves every original byte and install', () => {
  const { dir } = fixture({ ...pins, '@rig-c/parts': '2.23.4', 'invalid package name': '1.0.0' });
  const before = snapshot(dir);
  refusal(() => packagesCommand(['upgrade', dir, '--by', 'operator'], EXAMPLE_NOW), 'PACKAGE_UPGRADE_INSTALL');
  expect(snapshot(dir)).toEqual(before);
}, 30000);

test('a changed existing refusal message is refused even when its code and path match', async () => {
  const { readPartsSections } = await import('../src/parts-sections.ts');
  const { dir } = fixture({ ...pins, '@rig-c/parts': '2.23.4' });
  const parts = join(dir, 'node_modules/@rig-c/parts');
  mkdirSync(join(parts, 'src'), { recursive: true });
  writeFileSync(join(parts, 'package.json'), JSON.stringify({ name: '@rig-c/parts', version: '2.23.4', type: 'module' }));
  const sections = readPartsSections(join(import.meta.dir, '..')).sections.filter(section => section !== 'regions');
  writeFileSync(join(parts, 'src/config.ts'), `export const CONFIG_SECTIONS = ${JSON.stringify(sections)};\n`);
  const project = readTemplate('project.json');
  const interview = project.interview as import('../src/templates.ts').JsonObject;
  interview.waypoints = (interview.waypoints as import('../src/templates.ts').JsonObject[]).filter(row => row.id !== 'meshes');
  writeFileSync(join(dir, 'project.json'), JSON.stringify(project));
  const before = snapshot(dir);
  refusal(() => packagesCommand(['upgrade', dir, '--by', 'operator'], EXAMPLE_NOW), 'PACKAGE_UPGRADE_REFUSAL');
  expect(snapshot(dir)).toEqual(before);
}, 30000);

test('adds an absent review pin while preserving earlier history bytes', () => {
  const { dir } = fixture(PINNED_PACKAGES);
  const row = { by: 'earlier-operator', at: new Date(EXAMPLE_NOW - 1000).toISOString(), packages: Object.entries(pins).map(([name, to]) => ({ name, from: null, to })), lock_sha256: '0'.repeat(64) };
  const original = readFileSync(join(dir, 'project.json'), 'utf8').replace(/}\n$/, ', "package_upgrades": [\n' + JSON.stringify(row, null, '\t') + '\n] }\n');
  writeFileSync(join(dir, 'project.json'), original);
  packagesCommand(['upgrade', dir, '--by', 'operator'], EXAMPLE_NOW);
  const written = readFileSync(join(dir, 'project.json'), 'utf8');
  const rows = JSON.parse(written).package_upgrades;
  expect(rows[1].packages[2]).toEqual({ name: '@rig-c/review', from: null, to: pins['@rig-c/review'] });
  expect(written.replace(',' + JSON.stringify(rows[1]), '')).toBe(original);
}, 30000);
