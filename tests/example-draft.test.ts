import type { JsonObject } from '../src/templates.ts';
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { cpSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXAMPLE_ANCHOR, EXAMPLE_SOURCE_DATE_EPOCH, exampleTime, retimeExample } from '../scripts/example-time.ts';
import { EXAMPLE_DRAFT, exampleDraftFiles } from './draft-fixture.ts';
import { fixture } from './fixtures.ts';
import { tempDir } from './helpers.ts';
import { readTemplate } from '../src/templates.ts';
import { checkProject } from './clock.ts';

const sharedDraft = join(import.meta.dir, '../templates/example-draft');
const frozenDraft = join(import.meta.dir, '../templates/example-numbered', EXAMPLE_DRAFT);
const frozenAnchor = Date.parse('2026-11-27T00:00:00Z');
const runPackage = (root: string, path: string): { name: string; version: string } =>
  JSON.parse(readFileSync(join(root, path), 'utf8')).package;

test('shared run stamps match installed producers and signed builds retain the frozen run versions', () => {
  const installed = Object.fromEntries(['@rig-c/parts', '@rig-c/core'].map(name => [name,
    (JSON.parse(readFileSync(join(import.meta.dir, '../node_modules', name, 'package.json'), 'utf8')) as { version: string }).version,
  ]));
  expect(runPackage(sharedDraft, 'out/run.json')).toEqual({ name: '@rig-c/parts', version: installed['@rig-c/parts']! });
  expect(runPackage(sharedDraft, 'out/check/build/run.json')).toEqual({ name: '@rig-c/core', version: installed['@rig-c/core']! });
  const project = readTemplate('example-numbered/example-project.json');
  const draft = (project.drafts as { producer: { name: string; version: string } }[])[0]!;
  const versions = (project.versions as { kind: string; built_with: unknown }[]).filter(version => version.kind === 'rig');
  const frozenParts = runPackage(frozenDraft, 'out/run.json');
  const frozenCore = runPackage(frozenDraft, 'out/check/build/run.json');
  expect({ draft: draft.producer, versions: versions.map(version => version.built_with) }).toEqual({
    draft: frozenParts,
    versions: [
      { '@rig-c/parts': frozenParts.version, '@rig-c/core': frozenCore.version },
      { '@rig-c/parts': frozenParts.version, '@rig-c/core': frozenCore.version },
    ],
  });
});

test('signed post tools retain producer versions and identify the authored direction writer', () => {
  const posts = (readTemplate('example-numbered/example-project.json').versions as { kind: string; built_with: unknown }[]).filter(version => version.kind === 'post');
  expect(posts.map(version => version.built_with)).toEqual([{
    '@rig-c/parts': runPackage(frozenDraft, 'out/run.json').version,
    '@rig-c/core': runPackage(frozenDraft, 'out/check/build/run.json').version,
  }, { create: 'direction@2' }]);
});

test('retiming preserves event order and simultaneous instants from the frozen narrative', () => {
  const timestamps = [...JSON.stringify(readTemplate('legacy-example-project.json')).matchAll(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g)].map(match => match[0]);
  const instants = [...new Set(timestamps.map(value => Date.parse(value)))].sort((a, b) => a - b);
  const shifted = instants.map(value => Date.parse(exampleTime(new Date(value).toISOString())));
  for (let index = 1; index < shifted.length; index++) expect(shifted[index]!).toBeGreaterThan(shifted[index - 1]!);
  for (const value of timestamps) expect(exampleTime(value)).toBe(exampleTime(new Date(value).toISOString()));
});

// Approval records from the pre-producer fixture. Only event dates and bound hashes may move.
const originalSignoffs = [
  {
    "stage": "interview",
    "checkpoint": null,
    "by": "user",
    "at": "2026-11-10T14:20:00Z",
    "verbatim": "that's everything"
  },
  {
    "stage": "plan-approved",
    "checkpoint": null,
    "by": "user",
    "at": "2026-11-10T16:05:00.000Z",
    "verbatim": "Approve the synthetic plan-approved record.\n",
    "steps": [
      "seethrough",
      "assemble"
    ],
    "step_hashes": {
      "seethrough": "6913f7c8b3fac3f5b88631115fab6fc352027ea15e0f44619f27fefcb9bd3c82",
      "assemble": "a92cff01f666bea33bfee23339185268f7e2277b710d3519c08ba0a7aa21c362"
    }
  },
  {
    "stage": "parts",
    "checkpoint": "assemble",
    "by": "user",
    "at": "2026-11-11T09:40:00Z",
    "verbatim": "the cut is fine"
  },
  {
    "stage": "parts-review",
    "checkpoint": null,
    "by": "user",
    "at": "2026-11-11T10:20:00.000Z",
    "verbatim": "Approve the synthetic parts-review record.\n",
    "evidence": {
      "kind": "parts-verdict",
      "path": "evidence/parts-review.json",
      "sha256": "03564ee11c8c4875b6c9fa8ed16ff32a59ee83b0ed559fd01b6551ed60156d83"
    },
    "draft_id": "example",
    "structure": {
      "path": "evidence/structure-example.json",
      "sha256": "regenerated structure binding"
    }
  },
  {
    "stage": "rigging-interview",
    "checkpoint": null,
    "by": "user",
    "at": "2026-11-11T11:10:00.000Z",
    "verbatim": "Approve the synthetic rigging-interview record.\n",
    "steps": [
      "bones",
      "meshes",
      "constraints",
      "motion"
    ],
    "step_hashes": {
      "bones": "457fdb23b2fba7eacaab9a54765d45b651d2059b070bfdafb10226f3cfba0e8d",
      "meshes": "a159b1bd45ba764819c10cbd2e5ad3116822d1cc584232a4b97dfe432a113da7",
      "constraints": "91690a465a7b4a9fd2fdbfd6a229ec07ddf521adcc1107dca97f7b2d90adb601",
      "motion": "eee1686a07951c92b3ee62abe7a7ff79865570f09f3c134d2b09fc2994e242d2"
    },
    "accepted_parts": {
      "signoff_at": "2026-11-11T10:20:00.000Z",
      "evidence": {
        "kind": "parts-verdict",
        "path": "evidence/parts-review.json",
        "sha256": "03564ee11c8c4875b6c9fa8ed16ff32a59ee83b0ed559fd01b6551ed60156d83"
      }
    },
    "structure": {
      "path": "evidence/structure-example.json",
      "sha256": "regenerated structure binding"
    }
  },
  {
    "stage": "rigging-interview",
    "checkpoint": null,
    "by": "user",
    "at": "2026-11-12T10:30:00.000Z",
    "verbatim": "Approve the synthetic rigging-interview record.\n",
    "steps": [
      "bones",
      "constraints"
    ],
    "step_hashes": {
      "bones": "457fdb23b2fba7eacaab9a54765d45b651d2059b070bfdafb10226f3cfba0e8d",
      "constraints": "91690a465a7b4a9fd2fdbfd6a229ec07ddf521adcc1107dca97f7b2d90adb601"
    },
    "accepted_parts": {
      "signoff_at": "2026-11-11T10:20:00.000Z",
      "evidence": {
        "kind": "parts-verdict",
        "path": "evidence/parts-review.json",
        "sha256": "03564ee11c8c4875b6c9fa8ed16ff32a59ee83b0ed559fd01b6551ed60156d83"
      }
    },
    "structure": {
      "path": "evidence/structure-example.json",
      "sha256": "regenerated structure binding"
    }
  },
  {
    "stage": "rigging",
    "checkpoint": "constraints",
    "by": "user",
    "at": "2026-11-11T13:10:00Z",
    "verbatim": "ok, the scarf looks right in the sketch"
  },
  {
    "stage": "rigging",
    "checkpoint": "constraints",
    "by": "user",
    "at": "2026-11-12T15:00:00Z",
    "verbatim": "better"
  },
  {
    "stage": "rig-review",
    "checkpoint": null,
    "by": "user",
    "at": "2026-11-13T09:15:00Z",
    "verbatim": "yes, that's her"
  },
  {
    "stage": "post-interview",
    "checkpoint": null,
    "by": "user",
    "at": "2026-11-13T10:30:00Z",
    "verbatim": "go",
    "step_hashes": {
      "camera": "99c0ca10adeecb036f9f966a7698134ea274562fe777e2af2b275fb409b46191",
      "timing": "12eca3ed1507b0ac4ec86665294e7ca391f4f93b50e13f8124b21dbe465f199e",
      "composition": "f4a1e6923ffd1c84a2108bd41831ceee68b340dcf3538b0180aae081d8028e07"
    }
  },
  {
    "stage": "direction-review",
    "checkpoint": null,
    "by": "user",
    "at": "2026-11-15T11:00:00Z",
    "verbatim": "done, I like it"
  }
];

test('the installed producers reproduce every shared draft output from the retained inputs', () => {
  // Rebuild in a copy of the draft root with the generator's own relative layout, so the run records' relative paths match.
  const draft = join(tempDir(), 'draft');
  const source = sharedDraft;
  cpSync(source, draft, { recursive: true, filter: path => path !== join(source, 'out') && !path.startsWith(join(source, 'out') + '/') });
  const out = join(draft, 'out');
  const result = Bun.spawnSync([process.execPath, join(import.meta.dir, '../node_modules/@rig-c/parts/bin/rig-parts.cjs'),
    'rig', '--config', 'config.json', '--parts', 'input', '--out', 'out'],
  { cwd: draft, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, SOURCE_DATE_EPOCH: EXAMPLE_SOURCE_DATE_EPOCH } });
  expect(result.exitCode).toBe(0);
  const compiled = Bun.spawnSync([process.execPath, join(import.meta.dir, '../node_modules/@rig-c/core/bin/rigc.cjs'),
    'build', '--rig', 'out/rig.json', '--motion', 'out/motion.json', '--out', 'out/check/build',
    '--profile', 'rig-play', '--pack', '--page-edges', 'free', '--pack-shape', 'polygon'],
  { cwd: draft, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, SOURCE_DATE_EPOCH: EXAMPLE_SOURCE_DATE_EPOCH } });
  expect(compiled.exitCode).toBe(0);
  const outputPrefix = `${EXAMPLE_DRAFT}/out/`;
  const files = exampleDraftFiles();
  const outputs: string[] = [];
  const compare = (path: string): void => {
    for (const entry of readdirSync(join(out, path), { withFileTypes: true })) {
      const child = path ? `${path}/${entry.name}` : entry.name;
      if (entry.isDirectory()) compare(child);
      else {
        outputs.push(`${outputPrefix}${child}`);
        expect(readFileSync(join(out, child))).toEqual(files[`${outputPrefix}${child}`]);
      }
    }
  };
  compare('');
  expect(outputs.sort()).toEqual(Object.keys(files).filter(path => path.startsWith(outputPrefix)).sort());
}, 30_000);

test('the signed draft binds every retained output and its composite', () => {
  const dir = fixture(() => {}, 'example-numbered/example-project.json');
  const project = readTemplate('example-numbered/example-project.json');
  const files = (project.drafts as { files: { path: string; sha256: string }[] }[])[0]!.files;
  const outputPrefix = `${EXAMPLE_DRAFT}/out/`;
  const outputPaths = (path: string): string[] => readdirSync(join(dir, path), { withFileTypes: true }).flatMap(entry => {
    const child = `${path}/${entry.name}`;
    return entry.isDirectory() ? outputPaths(child) : [child];
  });
  const outputs = outputPaths(`${EXAMPLE_DRAFT}/out`);
  expect(outputs.sort()).toEqual(files.filter(file => file.path.startsWith(outputPrefix)).map(file => file.path).sort());
  const composite = `${EXAMPLE_DRAFT}/input/recomposite_rig.png`;
  expect(files.filter(file => !file.path.startsWith(outputPrefix))).toEqual([
    { path: composite, sha256: createHash('sha256').update(readFileSync(join(dir, composite))).digest('hex') },
  ]);
  for (const file of files) expect(createHash('sha256').update(readFileSync(join(dir, file.path))).digest('hex')).toBe(file.sha256);
  expect(checkProject(dir).refusals).toEqual([]);
  expect(checkProject(dir).warnings).toEqual([]);
});

test('the frozen approval records preserve historical fields and bind answers and reviews', () => {
  const project = readTemplate('example-numbered/example-project.json');
  const signoffs = project.signoffs as JsonObject[];
  const maskHashes = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (key, item: unknown) => {
    if (key === 'sha256') return 'regenerated binding';
    if (key === 'evidence' && item && typeof item === 'object' && (item as JsonObject).kind === 'parts-verdict') return { kind: 'parts-verdict', sha256: 'regenerated binding' };
    if (key === 'step_hashes') return Object.fromEntries(Object.keys(item as object).map(id => [id, 'regenerated step binding']));
    return item;
  }));
  const signatures = signoffs.map(({ target: _target, answer_hashes: _answers, ...signature }) => {
    if (signature.stage === 'post-interview') { const { steps: _steps, ...historical } = signature; return historical; }
    return signature;
  });
  const historical = JSON.parse(JSON.stringify(retimeExample(originalSignoffs))
    .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z/g, value =>
      new Date(Date.parse(value) - EXAMPLE_ANCHOR + frozenAnchor).toISOString()));
  expect(maskHashes(signatures)).toEqual(maskHashes(historical));
  for (const [index, keys] of [
    [0, ['assemble', 'reference', 'rig_type', 'seethrough']],
    [1, ['assemble', 'seethrough']],
    [4, ['assemble', 'bones', 'constraints', 'meshes', 'motion', 'rig_type']],
    [5, ['bones', 'constraints']],
    [9, ['camera_depth', 'motion', 'post_composition', 'post_timing']],
  ] as const) {
    const hashes = signoffs[index]!.answer_hashes as JsonObject;
    expect(Object.keys(hashes).sort()).toEqual([...keys]);
    for (const hash of Object.values(hashes)) expect(hash).toMatch(/^[a-f0-9]{64}$/);
  }
  const partsApproval = signoffs.find(signature => signature.stage === 'parts-review')!;
  const partsReceipt = (project.review_acts as JsonObject[]).find(receipt => receipt.kind === 'parts-verdict')!;
  expect(partsApproval.evidence).toEqual({ ...(partsReceipt.evidence as JsonObject), spec: 'rig-create/parts-verdict-cli@1' });
  expect(signoffs.filter(s => s.target).map(s => (s.target as JsonObject).version)).toEqual([2, 4]);
});

test('one byte changed in any bound draft file is refused by code and path', () => {
  const project = readTemplate('example-numbered/example-project.json');
  for (const file of (project.drafts as { files: { path: string }[] }[])[0]!.files) {
    const dir = fixture(() => {}, 'example-numbered/example-project.json');
    const bytes = readFileSync(join(dir, file.path));
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
    writeFileSync(join(dir, file.path), bytes);
    expect(checkProject(dir).refusals.some(finding => finding.code === 'DRAFT_RIG_FILE' && finding.message.includes(file.path))).toBe(true);
  }
});

test('the fixture declares synthetic pixels, approvals and verification commands', () => {
  const text = readFileSync(join(import.meta.dir, '../templates/example-draft/README.md'), 'utf8');
  for (const phrase of ['Every pixel is generated', 'fixture sign-offs', '@rig-c/parts` 2.62.0',
    'check-example-numbered.ts', 'generate-example-draft.ts', 'empty track set fails rigc']) expect(text).toContain(phrase);
});
