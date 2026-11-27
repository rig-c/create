import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { packagesCommand } from '../src/packages-upgrade.ts';
import { packageUpgradeFindings, packageUpgradeWarnings } from '../src/package-upgrades.ts';
import { CREATE_PACKAGE, PINNED_PACKAGES, runningCreateVersion } from '../src/pins.ts';
import { readTemplate } from '../src/templates.ts';
import { checkProject } from '../src/check.ts';
import { Refusal } from '../src/refusal.ts';
import { tempDir } from './helpers.ts';
import { EXAMPLE_ANCHOR, EXAMPLE_NOW } from '../scripts/example-time.ts';

const roots: string[] = [];
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const pins = {
  '@rig-c/core': PINNED_PACKAGES['@rig-c/core'],
  [CREATE_PACKAGE]: runningCreateVersion(),
  '@rig-c/parts': PINNED_PACKAGES['@rig-c/parts'],
  '@rig-c/review': '4.22.0',
};
const legacyPins = { ...PINNED_PACKAGES, '@rig-c/review': '4.22.0' };
function fixture(dependencies: Record<string, string>) {
  const dir = tempDir(); roots.push(dir);
  const project = readTemplate('project.json');
  const bytes = `${JSON.stringify(project, null, 2)}\n`;
  writeFileSync(join(dir, 'project.json'), bytes);
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: 'synthetic-project', private: true, type: 'module', dependencies }, null, 2)}\n`);
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

test('duplicate JSON keys in package.json or project.json refuse without touching bytes', () => {
  const { dir } = fixture({ ...pins, '@rig-c/parts': '2.23.4' });
  writeFileSync(join(dir, 'package.json'), '{\n  "name": "a",\n  "name": "b",\n  "dependencies": { "@rig-c/parts": "2.23.4" }\n}\n');
  const before = snapshot(dir);
  refusal(() => packagesCommand(['upgrade', dir, '--by', 'operator'], EXAMPLE_NOW), 'PACKAGE_UPGRADE_INPUT');
  expect(snapshot(dir)).toEqual(before);
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

test('an older synthetic project upgrades all release pins and changes only the pin lines and package_upgrades on a formatted record', () => {
  const { dir, bytes } = fixture({ ...pins, '@rig-c/parts': '2.23.4', '@rig-c/review': '4.7.0' });
  const manifest = `${JSON.stringify({ name: 'synthetic-project', private: true, type: 'module', dependencies: { ...pins, '@rig-c/parts': '2.23.4', '@rig-c/review': '4.7.0' } }, null, 2)}\n`;
  writeFileSync(join(dir, 'package.json'), manifest);
  rmSync(join(dir, 'bun.lock'));
  const install = Bun.spawnSync([process.execPath, 'install', '--ignore-scripts'], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
  expect(install.exitCode).toBe(0);
  expect(JSON.parse(readFileSync(join(dir, 'node_modules/@rig-c/parts/package.json'), 'utf8')).version).toBe('2.23.4');
  const result = packagesCommand(['upgrade', dir, '--by', 'operator'], EXAMPLE_NOW);
  expect(result).toContain('package_upgrades[0]');
  const nextManifest = readFileSync(join(dir, 'package.json'), 'utf8');
  expect(nextManifest).toBe(manifest.replace('2.23.4', pins['@rig-c/parts']).replace('4.7.0', pins['@rig-c/review']));
  const beforeLines = manifest.split('\n');
  const afterLines = nextManifest.split('\n');
  expect(afterLines.length).toBe(beforeLines.length);
  expect(afterLines.filter((line, i) => line !== beforeLines[i])).toEqual([
    `    "@rig-c/parts": "${pins['@rig-c/parts']}",`,
    `    "@rig-c/review": "${pins['@rig-c/review']}"`,
  ]);
  const record = readFileSync(join(dir, 'project.json'), 'utf8');
  const project = JSON.parse(record);
  const expected = `${JSON.stringify({ ...readTemplate('project.json'), package_upgrades: project.package_upgrades }, null, 2)}\n`;
  expect(record).toBe(expected);
  expect(record.slice(0, bytes.lastIndexOf('\n}'))).toBe(bytes.slice(0, bytes.lastIndexOf('\n}')));
  expect(project.package_upgrades[0]).toMatchObject({ by: 'operator', at: new Date(EXAMPLE_NOW).toISOString(), packages: [{ name: '@rig-c/core', from: pins['@rig-c/core'], to: pins['@rig-c/core'] }, { name: CREATE_PACKAGE, from: pins[CREATE_PACKAGE], to: pins[CREATE_PACKAGE] }, { name: '@rig-c/parts', from: '2.23.4', to: pins['@rig-c/parts'] }, { name: '@rig-c/review', from: '4.7.0', to: pins['@rig-c/review'] }] });
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
  const dir = realpathSync(example(project => {
    project.stage = 'rigging-interview'; project.versions = []; project.scenes = []; delete project.direction_contract;
    retainSignoffs(project, signature => stageIndex(String(obj(signature).stage)) < stageIndex('rigging-interview'));
    project.advances = arr(project.advances).filter(value => stageIndex(String(obj(value).stage)) <= stageIndex('rigging-interview'));
    for (const item of arr(obj(obj(project.interview).post).items).map(obj)) item.guide = null;
    for (const step of arr(obj(project.plan).steps).map(obj)) if (!['seethrough', 'assemble'].includes(String(step.id))) step.status = 'pending';
  }, 'example-project.json'));
  roots.push(dir);
  let opening: Bun.Subprocess | undefined;
  try {
    const project = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'));
    const item = collectItems(project, { collection: null }).find(item => item.id === 'motion')!;
    const retained = obj(obj(item.raw).choice).set as import('../src/templates.ts').JsonObject;
    const set = JSON.parse(readFileSync(join(dir, String(retained.path)), 'utf8'));
    // The live host validates at its real clock; keep this pending set in the
    // completed synthetic narrative, rather than twelve hours after its anchor.
    const draftedAt = EXAMPLE_ANCHOR + 180_000;
    set.id = 'upgrade-motion'; set.drafted_at = new Date(draftedAt).toISOString();
    set.context = optionContext(project, 'rigging-interview', draftedAt, dir);
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
    const published = /\njob: option-set motion\/upgrade-motion published \(publication [A-Za-z0-9][A-Za-z0-9._-]{0,127}\)\n/;
    while (!published.test(output)) {
      const chunk = await reader.read(); if (chunk.done) break;
      output += new TextDecoder().decode(chunk.value);
    }
    reader.releaseLock();
    expect(output).toMatch(published);
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

test('adds absent create and review pins while preserving earlier 3-pin history rows, detected manifest indentation and trailing newline', () => {
  const { dir } = fixture(PINNED_PACKAGES);
  const row = { by: 'earlier-operator', at: new Date(EXAMPLE_NOW - 1000).toISOString(), packages: Object.entries(legacyPins).map(([name, to]) => ({ name, from: null, to })), lock_sha256: '0'.repeat(64) };
  const initialProject = { ...readTemplate('project.json'), package_upgrades: [row] };
  writeFileSync(join(dir, 'project.json'), `${JSON.stringify(initialProject, null, 2)}\n`);
  const pkg = { name: 'synthetic-project', private: true, dependencies: { ...PINNED_PACKAGES } };
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, '\t'));
  packagesCommand(['upgrade', dir, '--by', 'operator'], EXAMPLE_NOW);
  const written = readFileSync(join(dir, 'project.json'), 'utf8');
  const parsed = JSON.parse(written);
  const rows = parsed.package_upgrades;
  expect(rows[0]).toEqual(row);
  expect(rows[1].packages).toEqual([
    { name: '@rig-c/core', from: PINNED_PACKAGES['@rig-c/core'], to: pins['@rig-c/core'] },
    { name: CREATE_PACKAGE, from: null, to: pins[CREATE_PACKAGE] },
    { name: '@rig-c/parts', from: PINNED_PACKAGES['@rig-c/parts'], to: pins['@rig-c/parts'] },
    { name: '@rig-c/review', from: null, to: pins['@rig-c/review'] },
  ]);
  expect(packageUpgradeFindings(parsed)).toEqual([]);
  expect(written).toBe(`${JSON.stringify({ ...initialProject, package_upgrades: rows }, null, 2)}\n`);
  expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(
    JSON.stringify({ ...pkg, dependencies: { ...PINNED_PACKAGES, [CREATE_PACKAGE]: pins[CREATE_PACKAGE], '@rig-c/review': pins['@rig-c/review'] } }, null, '\t'),
  );
  const afterWarnings = checkProject(dir, undefined, { now: EXAMPLE_NOW, readOnly: true }).warnings.map(f => f.code);
  expect(afterWarnings).not.toContain('CREATE_PIN_MISSING');
  expect(afterWarnings).not.toContain('CREATE_PIN_MISMATCH');
}, 30000);

test('moves an older @rig-c/create pin and refuses a newer @rig-c/create pin byte-identically', () => {
  const { dir } = fixture({ ...pins, [CREATE_PACKAGE]: '1.24.0' });
  const result = packagesCommand(['upgrade', dir, '--by', 'operator'], EXAMPLE_NOW);
  expect(result).toContain(`${CREATE_PACKAGE} 1.24.0 → ${pins[CREATE_PACKAGE]}`);
  const project = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'));
  expect(project.package_upgrades[0].packages[1]).toEqual({ name: CREATE_PACKAGE, from: '1.24.0', to: pins[CREATE_PACKAGE] });
  expect(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).dependencies[CREATE_PACKAGE]).toBe(pins[CREATE_PACKAGE]);
  expect(checkProject(dir, undefined, { now: EXAMPLE_NOW, readOnly: true }).warnings.map(f => f.code)).not.toContain('CREATE_PIN_MISMATCH');

  const newer = fixture({ ...pins, [CREATE_PACKAGE]: '999.0.0' });
  const before = snapshot(newer.dir);
  refusal(() => packagesCommand(['upgrade', newer.dir, '--by', 'operator'], EXAMPLE_NOW), 'PACKAGE_UPGRADE_DOWNGRADE');
  expect(snapshot(newer.dir)).toEqual(before);
}, 30000);

test('an upgrade that moves parts also moves interview.question_set and records the move', () => {
  const { dir } = fixture({ ...pins, '@rig-c/parts': '2.23.4' });
  const original = readFileSync(join(dir, 'project.json'), 'utf8');
  const stale = original.replace(`@rig-c/parts ${pins['@rig-c/parts']}`, '@rig-c/parts 2.23.4');
  writeFileSync(join(dir, 'project.json'), stale);
  const result = packagesCommand(['upgrade', dir, '--by', 'operator'], EXAMPLE_NOW);
  expect(result).toContain('interview.question_set');
  const written = readFileSync(join(dir, 'project.json'), 'utf8');
  const project = JSON.parse(written);
  expect(project.package_upgrades[0].question_set).toEqual({ from: JSON.parse(stale).interview.question_set, to: JSON.parse(original).interview.question_set });
  // On the formatted record, only the question_set line changes before the appended package_upgrades.
  const beforeLines = stale.slice(0, stale.lastIndexOf('\n}')).split('\n');
  const afterLines = written.slice(0, stale.lastIndexOf('\n}')).split('\n');
  expect(afterLines.filter((line, i) => line !== beforeLines[i])).toEqual([`    "question_set": ${JSON.stringify(JSON.parse(original).interview.question_set)},`]);
  expect(written).toBe(`${JSON.stringify({ ...JSON.parse(original), package_upgrades: project.package_upgrades }, null, 2)}\n`);
  expect(packageUpgradeFindings(project)).toEqual([]);
  expect(checkProject(dir, undefined, { now: EXAMPLE_NOW, readOnly: true }).warnings.map(f => f.code)).not.toContain('QUESTION_SET_STALE');
}, 30000);

test('current pins with a stale question set or waypoint config record only those moves', () => {
  const { dir } = fixture(pins);
  const project = readTemplate('project.json');
  const interview = project.interview as import('../src/templates.ts').JsonObject;
  interview.question_set = String(interview.question_set).replace(`@rig-c/parts ${pins['@rig-c/parts']}`, '@rig-c/parts 2.23.4');
  const assemble = (interview.waypoints as import('../src/templates.ts').JsonObject[]).find(w => w.id === 'assemble')!;
  const placed = assemble.config;
  assemble.config = ['assemble'];
  writeFileSync(join(dir, 'project.json'), JSON.stringify(project, null, '\t') + '\n');
  expect(checkProject(dir, undefined, { now: EXAMPLE_NOW, readOnly: true }).warnings.map(f => f.code)).toEqual(expect.arrayContaining(['QUESTION_SET_STALE', 'WAYPOINT_CONFIG_STALE']));
  packagesCommand(['upgrade', dir, '--by', 'operator'], EXAMPLE_NOW);
  const written = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'));
  const row = written.package_upgrades[0];
  expect(row.packages.every((pin: { from: string; to: string }) => pin.from === pin.to)).toBe(true);
  expect(row.question_set.to).toContain(`@rig-c/parts ${pins['@rig-c/parts']}`);
  expect(row.waypoint_config).toEqual([{ id: 'assemble', from: ['assemble'], to: placed }]);
  expect(written.interview.waypoints.find((w: { id: string }) => w.id === 'assemble').config).toEqual(placed);
  const codes = checkProject(dir, undefined, { now: EXAMPLE_NOW, readOnly: true }).warnings.map(f => f.code);
  expect(codes).not.toContain('QUESTION_SET_STALE'); expect(codes).not.toContain('WAYPOINT_CONFIG_STALE');
  // Nothing left to move: the next run is already current.
  const bytes = () => ['project.json', 'package.json', 'bun.lock'].map(path => readFileSync(join(dir, path)).toString('base64'));
  const before = bytes();
  refusal(() => packagesCommand(['upgrade', dir, '--by', 'operator'], EXAMPLE_NOW), 'PACKAGE_UPGRADE_CURRENT');
  expect(bytes()).toEqual(before);
}, 60000);

test('a malformed recorded question_set or waypoint_config move is the same named refusal', () => {
  const project = readTemplate('project.json');
  const row = { by: 'operator', at: new Date(EXAMPLE_NOW).toISOString(), packages: Object.entries(pins).map(([name, to]) => ({ name, from: to, to })), lock_sha256: '0'.repeat(64) };
  project.package_upgrades = [{ ...row, question_set: { from: 'x' } }, { ...row, waypoint_config: [{ id: 'assemble', from: 'assemble', to: [] }] }, { ...row, question_set: { from: 'a @rig-c/parts 1.0.0', to: 'a @rig-c/parts 2.0.0' }, waypoint_config: [{ id: 'assemble', from: [], to: ['assemble'] }] }];
  expect(packageUpgradeFindings(project).map(f => `${f.code} ${f.path}`)).toEqual(['PACKAGE_UPGRADE_MALFORMED package_upgrades[0].question_set', 'PACKAGE_UPGRADE_MALFORMED package_upgrades[1].waypoint_config']);
});

test('a refused upgrade with a pending question_set move leaves the record byte-identical', () => {
  const { dir } = fixture({ ...pins, '@rig-c/parts': '2.23.4' });
  const parts = join(dir, 'node_modules/@rig-c/parts');
  mkdirSync(join(parts, 'src'), { recursive: true });
  writeFileSync(join(parts, 'package.json'), JSON.stringify({ name: '@rig-c/parts', version: '2.23.4', type: 'module' }));
  writeFileSync(join(parts, 'src/config.ts'), "export const CONFIG_SECTIONS = ['key'];\n");
  const project = readTemplate('project.json');
  const interview = project.interview as import('../src/templates.ts').JsonObject;
  interview.waypoints = [];
  interview.question_set = String(interview.question_set).replace(`@rig-c/parts ${pins['@rig-c/parts']}`, '@rig-c/parts 2.23.4');
  writeFileSync(join(dir, 'project.json'), JSON.stringify(project));
  const before = snapshot(dir);
  refusal(() => packagesCommand(['upgrade', dir, '--by', 'operator'], EXAMPLE_NOW), 'PACKAGE_UPGRADE_REFUSAL');
  expect(snapshot(dir)).toEqual(before);
}, 30000);

function packTinyPackage(): { pkgDir: string; tgz: string; sha256: string } {
  const root = tempDir(); roots.push(root);
  const pkgDir = join(root, 'tiny-rehearsal-pkg');
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, 'package.json'), `${JSON.stringify({ name: 'tiny-rehearsal-pkg', version: '0.0.1', type: 'module', main: 'index.js' }, null, 2)}\n`);
  writeFileSync(join(pkgDir, 'index.js'), 'export const rehearsed = true;\n');
  const packed = Bun.spawnSync([process.execPath, 'pm', 'pack'], { cwd: pkgDir, stdout: 'pipe', stderr: 'pipe' });
  expect(packed.exitCode).toBe(0);
  const tgz = join(pkgDir, 'tiny-rehearsal-pkg-0.0.1.tgz');
  const sha256 = createHash('sha256').update(readFileSync(tgz)).digest('hex');
  return { pkgDir, tgz, sha256 };
}

test('packages upgrade --rehearsal stages an absolute file:.tgz tarball, records rehearsal:true + sha256, and check WARNs PACKAGE_UPGRADE_REHEARSAL', () => {
  const { tgz, sha256 } = packTinyPackage();
  const { dir } = fixture({ ...pins, 'tiny-rehearsal-pkg': `file:${tgz}` });
  const original = readFileSync(join(dir, 'project.json'), 'utf8');
  const stale = original.replace(`@rig-c/parts ${pins['@rig-c/parts']}`, '@rig-c/parts 2.23.4');
  writeFileSync(join(dir, 'project.json'), stale);
  rmSync(join(dir, 'bun.lock'));

  const output = packagesCommand(['upgrade', dir, '--by', 'operator', '--rehearsal'], EXAMPLE_NOW);
  expect(output).toContain('(rehearsal)');
  expect(JSON.parse(readFileSync(join(dir, 'node_modules/tiny-rehearsal-pkg/package.json'), 'utf8')).version).toBe('0.0.1');

  const written = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'));
  expect(written.package_upgrades).toHaveLength(1);
  expect(written.package_upgrades[0]).toMatchObject({
    by: 'operator',
    at: new Date(EXAMPLE_NOW).toISOString(),
    rehearsal: true,
    local_dependencies: [{ name: 'tiny-rehearsal-pkg', sha256 }],
  });
  expect(packageUpgradeFindings(written)).toEqual([]);
  expect(packageUpgradeWarnings(written).map(f => `${f.code} ${f.path}`)).toEqual(['PACKAGE_UPGRADE_REHEARSAL package_upgrades[0]']);

  const report = checkProject(dir, undefined, { now: EXAMPLE_NOW, readOnly: true });
  expect(report.refusals.map(f => f.code)).not.toContain('PACKAGE_UPGRADE_REHEARSAL');
  expect(report.refusals.map(f => f.code)).not.toContain('PACKAGE_UPGRADE_MALFORMED');
  expect(report.warnings.map(f => f.code)).not.toContain('QUESTION_SET_STALE');
  const rehearsalWarn = report.warnings.find(f => f.code === 'PACKAGE_UPGRADE_REHEARSAL');
  expect(rehearsalWarn).toBeDefined();
  expect(rehearsalWarn!.path).toBe('package_upgrades[0]');
  expect(rehearsalWarn!.message).toContain('package_upgrades[0]');
  expect(rehearsalWarn!.message).toContain('rerun rig-create packages upgrade against the published release');
}, 30000);

test('a later published upgrade clears PACKAGE_UPGRADE_REHEARSAL on the earlier rehearsal row', () => {
  const lock = 'a'.repeat(64);
  const pins = ['@rig-c/core', '@rig-c/parts', '@rig-c/review'].map(name => ({ name, from: '1.0.0', to: '1.0.1' }));
  const rehearsal = { by: 'agent', at: '2026-01-02T00:00:00.000Z', packages: pins, lock_sha256: lock, rehearsal: true, local_dependencies: [{ name: '@rig-c/create', sha256: 'b'.repeat(64) }] };
  const published = { by: 'agent', at: '2026-01-03T00:00:00.000Z', packages: pins, lock_sha256: lock };
  expect(packageUpgradeWarnings({ package_upgrades: [rehearsal] }).map(f => f.path)).toEqual(['package_upgrades[0]']);
  expect(packageUpgradeWarnings({ package_upgrades: [rehearsal, published] })).toEqual([]);
  expect(packageUpgradeWarnings({ package_upgrades: [published, rehearsal] }).map(f => f.path)).toEqual(['package_upgrades[1]']);
  expect(packageUpgradeFindings({ package_upgrades: [rehearsal, published] })).toEqual([]);
});

test('local dependencies without --rehearsal, and non-absolute-tarball local specs with --rehearsal, refuse with PACKAGE_UPGRADE_INPUT and leave bytes untouched', () => {
  const { pkgDir, tgz } = packTinyPackage();
  const withoutFlag = fixture({ ...pins, 'tiny-rehearsal-pkg': `file:${tgz}` });
  writeFileSync(join(withoutFlag.dir, 'project.json'), readFileSync(join(withoutFlag.dir, 'project.json'), 'utf8').replace(`@rig-c/parts ${pins['@rig-c/parts']}`, '@rig-c/parts 2.23.4'));
  const beforeWithoutFlag = snapshot(withoutFlag.dir);
  refusal(() => packagesCommand(['upgrade', withoutFlag.dir, '--by', 'operator'], EXAMPLE_NOW), 'PACKAGE_UPGRADE_INPUT');
  expect(snapshot(withoutFlag.dir)).toEqual(beforeWithoutFlag);

  const cases: ((projectDir: string) => string)[] = [
    projectDir => `file:${relative(projectDir, tgz)}`,
    () => 'file:./local.tgz',
    () => `link:${pkgDir}`,
    () => `link:${tgz}`,
    () => 'workspace:*',
    () => tgz,
    () => `file:${pkgDir}`,
    () => `file:${join(pkgDir, 'missing.tgz')}`,
  ];
  for (const makeSpec of cases) {
    const { dir } = fixture(pins);
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    pkg.dependencies['tiny-rehearsal-pkg'] = makeSpec(dir);
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
    writeFileSync(join(dir, 'project.json'), readFileSync(join(dir, 'project.json'), 'utf8').replace(`@rig-c/parts ${pins['@rig-c/parts']}`, '@rig-c/parts 2.23.4'));
    const before = snapshot(dir);
    refusal(() => packagesCommand(['upgrade', dir, '--by', 'operator', '--rehearsal'], EXAMPLE_NOW), 'PACKAGE_UPGRADE_INPUT');
    expect(snapshot(dir)).toEqual(before);
  }
});

test('malformed rehearsal history rows refuse identically in check and writer', () => {
  const baseRow = { by: 'operator', at: new Date(EXAMPLE_NOW).toISOString(), packages: Object.entries(pins).map(([name, to]) => ({ name, from: to, to })), lock_sha256: '0'.repeat(64) };
  const malformedRows = [
    { ...baseRow, rehearsal: false },
    { ...baseRow, rehearsal: true },
    { ...baseRow, local_dependencies: [] },
    { ...baseRow, rehearsal: true, local_dependencies: [{ name: 'tiny-pkg', sha256: 'short' }] },
    { ...baseRow, rehearsal: true, local_dependencies: [{ name: 'tiny-pkg', sha256: 'a'.repeat(64), extra: true }] },
    { ...baseRow, rehearsal: true, local_dependencies: [{ name: 'tiny-pkg', sha256: 'a'.repeat(64) }, { name: 'tiny-pkg', sha256: 'b'.repeat(64) }] },
  ];
  for (const badRow of malformedRows) {
    const { dir } = fixture({ ...pins, '@rig-c/parts': '2.23.4' });
    const project = readTemplate('project.json');
    project.package_upgrades = [badRow];
    writeFileSync(join(dir, 'project.json'), `${JSON.stringify(project, null, 2)}\n`);
    expect(packageUpgradeFindings(project).map(f => f.code)).toContain('PACKAGE_UPGRADE_MALFORMED');
    expect(checkProject(dir, project, { now: EXAMPLE_NOW, readOnly: true }).refusals.map(f => f.code)).toContain('PACKAGE_UPGRADE_MALFORMED');
    const before = snapshot(dir);
    refusal(() => packagesCommand(['upgrade', dir, '--by', 'operator'], EXAMPLE_NOW), 'PACKAGE_UPGRADE_MALFORMED');
    expect(snapshot(dir)).toEqual(before);
  }
});

test('check warns by name when @rig-c/create is undeclared or differs from the running version, and stays silent when equal', () => {
  const running = runningCreateVersion();
  const undeclared = fixture(legacyPins);
  const missingReport = checkProject(undeclared.dir, undefined, { now: EXAMPLE_NOW, readOnly: true });
  expect(missingReport.warnings).toContainEqual(expect.objectContaining({
    code: 'CREATE_PIN_MISSING',
    path: `package.json.dependencies[${CREATE_PACKAGE}]`,
    message: expect.stringContaining('rig-create packages upgrade --by <operator>'),
  }));

  for (const declared of ['0.0.1', '999.0.0', `^${running}`]) {
    const mismatched = fixture({ ...pins, [CREATE_PACKAGE]: declared });
    const mismatchReport = checkProject(mismatched.dir, undefined, { now: EXAMPLE_NOW, readOnly: true });
    expect(mismatchReport.warnings).toContainEqual(expect.objectContaining({
      code: 'CREATE_PIN_MISMATCH',
      path: `package.json.dependencies[${CREATE_PACKAGE}]`,
      message: expect.stringContaining('rig-create packages upgrade --by <operator>'),
    }));
    expect(mismatchReport.warnings.map(f => f.code)).not.toContain('CREATE_PIN_MISSING');
  }

  const aligned = fixture({ ...pins, [CREATE_PACKAGE]: running });
  const alignedCodes = checkProject(aligned.dir, undefined, { now: EXAMPLE_NOW, readOnly: true }).warnings.map(f => f.code);
  expect(alignedCodes).not.toContain('CREATE_PIN_MISSING');
  expect(alignedCodes).not.toContain('CREATE_PIN_MISMATCH');
});
