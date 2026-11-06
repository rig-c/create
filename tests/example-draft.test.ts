import type { JsonObject } from '../src/templates.ts';
import { expect, test } from 'bun:test';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { exampleTime, retimeExample } from '../scripts/example-time.ts';
import { generateExampleOrder } from '../scripts/generate-example-order.ts';
import { checkProject } from '../src/check.ts';
import { EXAMPLE_DRAFT } from './draft-fixture.ts';
import { fixture } from './fixtures.ts';
import { tempDir } from './helpers.ts';
import { readTemplate } from '../src/templates.ts';

test('signed build tools match the installed draft producers', () => {
  const installed = Object.fromEntries(['@rig-c/parts', '@rig-c/core'].map(name => [name,
    (JSON.parse(readFileSync(join(import.meta.dir, '../node_modules', name, 'package.json'), 'utf8')) as { version: string }).version,
  ]));
  const project = readTemplate('example-project.json');
  const draft = (project.drafts as { producer: { name: string; version: string } }[])[0]!;
  const versions = (project.versions as { kind: string; built_with: unknown }[]).filter(version => version.kind === 'rig');
  expect({ draft: draft.producer, versions: versions.map(version => version.built_with) }).toEqual({
    draft: { name: '@rig-c/parts', version: installed['@rig-c/parts'] },
    versions: versions.map(() => installed),
  });
});

test('signed post build tools come from the installed producers', () => {
  const installed = Object.fromEntries(['@rig-c/parts', '@rig-c/core'].map(name => [name,
    (JSON.parse(readFileSync(join(import.meta.dir, '../node_modules', name, 'package.json'), 'utf8')) as { version: string }).version,
  ]));
  const posts = (readTemplate('example-project.json').versions as { kind: string; built_with: unknown }[]).filter(version => version.kind === 'post');
  expect(posts.map(version => version.built_with)).toEqual(posts.map(() => installed));
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
    "diff_map": {
      "report": {
        "path": "evidence/diff-components.json",
        "sha256": "6b26d802dd85b30a00aa714f643ff5238badf4b1124e44068dc9d93c90a61df3"
      },
      "components": [
        {
          "id": "p10-n3",
          "status": "in-painting",
          "why": "the synthetic painting deliberately differs here"
        },
        {
          "id": "p1000-n3",
          "status": "in-painting",
          "why": "the synthetic painting deliberately differs here"
        }
      ]
    },
    "draft_id": "example",
    "structure": {
      "path": "evidence/structure-decisions.json",
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
      "path": "evidence/structure-decisions.json",
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
      "path": "evidence/structure-decisions.json",
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

test('the installed producer reproduces every bound draft output from the retained inputs', () => {
  const dir = fixture(() => {}, 'example-project.json');
  const out = join(tempDir(), 'fresh');
  const result = Bun.spawnSync([process.execPath, join(import.meta.dir, '../node_modules/@rig-c/parts/bin/rig-parts.cjs'),
    'rig', '--config', `${EXAMPLE_DRAFT}/config.json`, '--parts', `${EXAMPLE_DRAFT}/input`, '--out', out],
  { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
  expect(result.exitCode).toBe(0);
  const compiled = Bun.spawnSync([process.execPath, join(import.meta.dir, '../node_modules/@rig-c/core/bin/rigc.cjs'),
    'build', '--rig', join(out, 'rig.json'), '--motion', join(out, 'motion.json'), '--out', join(out, 'check/build'),
    '--profile', 'rig-play', '--pack', '--page-edges', 'free', '--pack-shape', 'polygon'],
  { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
  expect(compiled.exitCode).toBe(0);
  const project = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'));
  const outputs: string[] = [];
  const compare = (path: string): void => {
    for (const entry of readdirSync(join(out, path), { withFileTypes: true })) {
      const child = path ? `${path}/${entry.name}` : entry.name;
      if (entry.isDirectory()) compare(child);
      else {
        outputs.push(`${EXAMPLE_DRAFT}/out/${child}`);
        expect(readFileSync(join(dir, EXAMPLE_DRAFT, 'out', child))).toEqual(readFileSync(join(out, child)));
      }
    }
  };
  compare('');
  expect(outputs.sort()).toEqual(project.drafts[0].files.map((file: { path: string }) => file.path).sort());
  expect(checkProject(dir).refusals).toEqual([]);
  expect(checkProject(dir).warnings).toEqual([]);
}, 30_000);

test('generation preserves historical approval fields and writes answer and review bindings', () => {
  const generated = generateExampleOrder(join(tempDir(), 'generated'));
  const maskHashes = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (key, item: unknown) => {
    if (key === 'sha256') return 'regenerated binding';
    if (key === 'step_hashes') return Object.fromEntries(Object.keys(item as object).map(id => [id, 'regenerated step binding']));
    return item;
  }));
  const signatures = (generated.project.signoffs as JsonObject[]).map(({ target: _target, answer_hashes: _answers, ...signature }) => {
    if (signature.stage === 'post-interview') { const { steps: _steps, ...historical } = signature; return historical; }
    return signature;
  });
  expect(maskHashes(signatures)).toEqual(maskHashes(retimeExample(originalSignoffs)));
  expect((generated.project.signoffs as JsonObject[]).filter(s => s.target).map(s => (s.target as JsonObject).version)).toEqual([2, 4]);
}, 30_000);

test('one byte changed in any retained draft output is refused by code and path', () => {
  const template = JSON.parse(readFileSync(join(import.meta.dir, '../templates/example-project.json'), 'utf8'));
  for (const file of template.drafts[0].files as { path: string }[]) {
    const dir = fixture(() => {}, 'example-project.json');
    const bytes = readFileSync(join(dir, file.path));
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
    writeFileSync(join(dir, file.path), bytes);
    expect(checkProject(dir).refusals.some(finding => finding.code === 'DRAFT_RIG_FILE' && finding.message.includes(file.path))).toBe(true);
  }
});

test('the fixture declares synthetic pixels, approvals, producer version and regeneration', () => {
  const text = readFileSync(join(import.meta.dir, '../templates/example-draft/README.md'), 'utf8');
  for (const phrase of ['Every pixel is generated', 'fixture sign-offs', '@rig-c/parts` 2.16.0',
    'generate-example-order.ts', 'generate-example-draft.ts', 'empty track set fails rigc']) expect(text).toContain(phrase);
});
