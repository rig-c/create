import { afterEach, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('host parts discovery supports a hoisted dependency beside installed Create', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'create-install-shape-')));
  roots.push(root);
  const src = join(root, 'node_modules/@rig-c/create/src');
  const parts = join(root, 'node_modules/@rig-c/parts');
  mkdirSync(src, { recursive: true });
  mkdirSync(join(parts, 'src'), { recursive: true });
  for (const name of ['parts-sections.ts', 'check-reads.ts', 'config-inputs.ts', 'refusal.ts']) copyFileSync(join(import.meta.dir, '../src', name), join(src, name));
  writeFileSync(join(parts, 'package.json'), JSON.stringify({ name: '@rig-c/parts', version: '1.0.0' }));
  writeFileSync(join(parts, 'src/config.ts'), 'export const CONFIG_SECTIONS = ["synthetic"]; export function configFileReferences() { return [{ at: "source", value: "source.png" }]; }');
  const run = (project: string) => Bun.spawnSync([process.execPath, '-e', `import { locateParts } from ${JSON.stringify(join(src, 'parts-sections.ts'))}; console.log(JSON.stringify(locateParts(${JSON.stringify(project)})));`], { stdout: 'pipe', stderr: 'pipe' });
  // A retained closure has no node_modules of its own.
  const retained = join(root, 'retained');
  mkdirSync(retained);
  const host = run(retained);
  expect(host.exitCode).toBe(0);
  expect(JSON.parse(host.stdout.toString())).toBe(parts);
  // Project dependencies still take precedence over the hoisted host copy.
  const projectParts = join(retained, 'node_modules/@rig-c/parts');
  mkdirSync(join(projectParts, 'src'), { recursive: true });
  copyFileSync(join(parts, 'package.json'), join(projectParts, 'package.json'));
  copyFileSync(join(parts, 'src/config.ts'), join(projectParts, 'src/config.ts'));
  const project = run(retained);
  expect(project.exitCode).toBe(0);
  expect(JSON.parse(project.stdout.toString())).toBe(projectParts);
  // An older project's loader lacks file declarations; both host capability
  // checks must still load the hoisted pinned dependency.
  writeFileSync(join(projectParts, 'src/config.ts'), 'export const CONFIG_SECTIONS = ["synthetic"];');
  const config = Bun.spawnSync([process.execPath, '-e', `import { configInputReferences, inputsUndeclaredByInstall } from ${JSON.stringify(join(src, 'config-inputs.ts'))}; const warnings = []; const refs = configInputReferences(${JSON.stringify(retained)}, {}, e => warnings.push(e.message)); console.log(JSON.stringify({ refs, warnings, undeclared: inputsUndeclaredByInstall(${JSON.stringify(retained)}, {}) }));`], { stdout: 'pipe', stderr: 'pipe' });
  expect(config.exitCode).toBe(0);
  expect(JSON.parse(config.stdout.toString())).toEqual({ refs: [], warnings: ['@rig-c/parts 1.0.0 has no configFileReferences export; install a version providing the config file declarations before recording new named inputs'], undeclared: { version: '1.0.0', refs: [{ at: 'source', value: 'source.png' }] } });
});


test('host parts discovery keeps the checkout path for a linked source dependency', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'create-linked-shape-')));
  roots.push(root);
  const src = join(root, 'create/src');
  const target = join(root, 'parts');
  const ownModules = join(root, 'create/node_modules');
  const linked = join(ownModules, '@rig-c/parts');
  mkdirSync(src, { recursive: true });
  mkdirSync(join(target, 'src'), { recursive: true });
  mkdirSync(join(ownModules, '@rig-c'), { recursive: true });
  for (const name of ['parts-sections.ts', 'check-reads.ts', 'config-inputs.ts', 'refusal.ts']) copyFileSync(join(import.meta.dir, '../src', name), join(src, name));
  writeFileSync(join(target, 'package.json'), JSON.stringify({ name: '@rig-c/parts', version: '1.0.0' }));
  writeFileSync(join(target, 'src/config.ts'), 'export const CONFIG_SECTIONS = ["synthetic"]; export function configFileReferences() { return []; }');
  symlinkSync(target, linked);
  const child = Bun.spawnSync([process.execPath, '-e', `import { OWN_NODE_MODULES, locateParts } from ${JSON.stringify(join(src, 'parts-sections.ts'))}; import { inputsUndeclaredByInstall } from ${JSON.stringify(join(src, 'config-inputs.ts'))}; console.log(JSON.stringify({ own: OWN_NODE_MODULES, parts: locateParts(${JSON.stringify(join(root, 'retained'))}), inputs: inputsUndeclaredByInstall(${JSON.stringify(join(root, 'retained'))}, {}) }));`], { stdout: 'pipe', stderr: 'pipe' });
  expect(child.exitCode).toBe(0);
  expect(JSON.parse(child.stdout.toString())).toEqual({ own: ownModules, parts: linked, inputs: { version: '1.0.0', refs: [] } });
});
