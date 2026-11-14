import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  AGENT_REFERENCE,
  APPEARANCE_LINK,
  BUST_LINK,
  CG_GATES_LINK,
  GATES_LINK,
  PROJECTION_LINK,
  createDocUrl,
  writeAgentGuide,
  CLAUDE_MD,
  CREATE_DOCS,
  CREATE_DOCS_BASE,
  PACKAGE_DOCS,
  READ_FIRST,
  packageDocPath,
  renderAgentGuide,
} from '../src/agent-guide.ts';
import { renderCollectionGuide } from '../src/collection.ts';
import { PINNED_PACKAGES } from '../src/pins.ts';
import { cli, gitEnv, run, tempDir } from './helpers.ts';

const REPO = join(import.meta.dir, '..');
const reference = readFileSync(join(REPO, 'docs', AGENT_REFERENCE), 'utf8');

/** The guide's own headings, in order. A heading copied in from a package's docs would break this list. */
const GUIDE_HEADINGS = [
  '# Agent guide',
  '## Start here',
  '## The order, and what you may not do',
  "## The user's four steps",
  '## Before you ask, plan or show',
  '## Where things go',
  '## What to read, and why',
];

/**
 * The guide points at documentation; it does not carry it. Kept well under any one linked document.
 * Raised from 8 000 when it took on its own procedures (rig-c/create#23), which no linked document holds,
 * and from 9 000 for the ordered entry point (rig-c/create#24): its links to create's sections are
 * absolute, about 75 bytes of URL each, because create is not installed in a project.
 */
const GUIDE_MAX_BYTES = 10_000;

test('#493 reopen instructions ingest the exported human act', () => {
  const guide = renderAgentGuide();
  for (const text of ['`job open --plan`', '`job acts --json`', '`reopen <stage> --from-review <actId>`', '`job close`', 'verbatim words']) expect(guide).toContain(text);
  expect(guide).not.toContain('Until create#493');
  const readme = readFileSync(join(REPO, 'README.md'), 'utf8');
  expect(readme).not.toContain('Until create#493');
  expect(readme).toContain('reopen <stage> --from-review <actId>');
  expect(Buffer.byteLength(guide)).toBeLessThan(GUIDE_MAX_BYTES);
});

test('#467 the direction guide names verdict ingest before source-linked record-page sign-off', () => {
  const guide = renderAgentGuide();
  expect(guide).toContain('`job open --rig <post>`');
  expect(guide).toContain('asks the verdict only');
  expect(guide).toContain('Ingest `review <post> --from-review <actId>`');
  expect(guide).toContain('then `job open --plan`');
  expect(guide).toContain('record-page sign-off (source-linked Review)');
});

function markdownLinks(text: string): string[] {
  return [...text.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1] as string);
}

/** GitHub's heading anchor: lower case, punctuation dropped, spaces to hyphens. */
function anchorsOf(markdown: string): Set<string> {
  const anchors = new Set<string>();
  for (const line of markdown.split('\n')) {
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (!heading) continue;
    const slug = (heading[1] as string)
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .replace(/\s/g, '-');
    anchors.add(slug);
  }
  return anchors;
}

describe('init --no-install writes the agent guide', () => {
  const root = tempDir();
  const env = gitEnv();
  const dir = join(root, 'guide-project');
  const result = cli(['init', dir, '--no-install'], root, env);
  const agents = readFileSync(join(dir, 'AGENTS.md'), 'utf8');

  test('init succeeds', () => {
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
  });

  test('AGENTS.md and CLAUDE.md are in the first commit and the tree is clean', () => {
    const tracked = run(['git', 'ls-files'], dir, env).stdout.trim().split('\n');
    expect(tracked).toContain('AGENTS.md');
    expect(tracked).toContain('CLAUDE.md');
    expect(tracked).toContain(AGENT_REFERENCE);
    expect(run(['git', 'rev-list', '--count', 'HEAD'], dir, env).stdout.trim()).toBe('1');
    expect(run(['git', 'status', '--porcelain', '--ignored=no'], dir, env).stdout).toBe('');
  });

  test('CLAUDE.md imports AGENTS.md and is a pointer, not a copy', () => {
    const claude = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    expect(claude).toBe(CLAUDE_MD);
    expect(claude.split('\n')[0]).toBe('@AGENTS.md');
    expect(claude.length).toBeLessThan(300);
  });

  test('AGENTS.md is the rendered template, with every marker filled', () => {
    expect(agents).toBe(renderAgentGuide());
    expect(agents).not.toContain('{{');
  });

  test('AGENTS.md carries no package documentation: size bound and only its own headings', () => {
    expect(statSync(join(dir, 'AGENTS.md')).size).toBeLessThan(GUIDE_MAX_BYTES);
    expect(Buffer.byteLength(agents)).toBeLessThan(8_000);
    expect(agents.split('\n').filter((line) => /^#{1,6}\s/.test(line))).toEqual(GUIDE_HEADINGS);
  });

  test('the package links are exactly the data table', () => {
    const local = markdownLinks(agents).filter((href) => href.startsWith('node_modules/'));
    expect(local).toEqual(PACKAGE_DOCS.map(packageDocPath));
    for (const href of local) expect(href).toStartWith('node_modules/@rig-c/');
  });

  test('every link to rig-c/create points at a file (and heading) in this repository', () => {
    const remote = markdownLinks(`${agents}\n${reference}`).filter((href) => href.startsWith('https://'));
    expect(remote.length).toBeGreaterThan(0);
    for (const href of remote) expect(href).toStartWith(CREATE_DOCS_BASE);
    for (const doc of CREATE_DOCS) expect(remote).toContain(`${CREATE_DOCS_BASE}${doc.path}`);
    for (const href of remote) {
      const [path, anchor] = href.slice(CREATE_DOCS_BASE.length).split('#') as [string, string | undefined];
      const file = join(REPO, path);
      expect(existsSync(file), `${path} exists in rig-c/create`).toBe(true);
      if (anchor !== undefined) {
        expect(anchorsOf(readFileSync(file, 'utf8')).has(anchor), `${path}#${anchor} is a heading`).toBe(true);
      }
    }
  });
});

const DEFERRED_RULES = [
  "- **Projection.** Ask and record it per [CHECKS.md § Projection and ground](https://github.com/rig-c/create/blob/main/docs/CHECKS.md#projection-and-ground).",
  "- **Camera options.** Offer fixed view or camera-box moves only. Head turn,\n  depth and plate parallax are unavailable: direction has no depth/turn fields.",
  "- **Upscale first** a painting smaller than the rig needs (SOURCE.md, step 2 below).",
  "- **The crux is a bar.** Before rigging, name every risk band, count background\n  or doubled pixels over every frame and both physics/breath extremes, and\n  report the maximum and its frame. Cover every band crossing another bone.",
  "- **Appearance needs a person**, not a step bar: [CHECKS.md § Appearance bar wording](https://github.com/rig-c/create/blob/main/docs/CHECKS.md#appearance-bar-wording).",
  "- **Nothing unnamed.** Add no unnamed motion, chain or physics. Read references\n  for what they show; ask about anything more.",
  "- **Re-run first, cut last**, never a polygon in code or config: the ladder in\n  SOURCE.md, step 2 below.",
  "- **A full-screen scene is a CG build.** For `rig_type` `fullscreen.*`, each\n  rig version declares the gates in [CHECKS.md § CG gates](https://github.com/rig-c/create/blob/main/docs/CHECKS.md#cg-gates). Refusals are the art's to fix.",
  "- **The bust is meshed** unless the `meshes` guide excludes it with a reason\n  ([CHECKS.md § The bust at meshes](https://github.com/rig-c/create/blob/main/docs/CHECKS.md#the-bust-at-meshes)).",
  "- **Overlaps.** A piece over a part with its own animation (glasses over\n  eyelids) holds none of that part's pixels, or the animation shows its copy.",
  "- **Pairs.** Measure left/right symmetry against the painting before calling a\n  pair uneven ([CRAFT.md G8](https://github.com/rig-c/create/blob/main/docs/CRAFT.md#for-the-gates-not-the-interview)).",
  "- **Look before the user does**, at native resolution and every crux boundary:\n  a whole-figure |composite − painting| map, each component by box/part and\n  status (in the painting / fixed / left, why). Use the true part stack; crop on\n  white and mid-grey to show light fringes. Check beyond reviewer-chosen boxes.",
];

describe('the shipped stage reference', () => {
  test('one relative link resolves without installing create as a project dependency', () => {
    const dir = tempDir();
    const written = writeAgentGuide(dir);
    const guide = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
    const local = markdownLinks(guide).filter(href => !/^[a-z]+:/.test(href) && !href.startsWith('node_modules/'));
    expect(local).toEqual([AGENT_REFERENCE]);
    expect(written).toContain(AGENT_REFERENCE);
    expect(readFileSync(join(dir, AGENT_REFERENCE))).toEqual(readFileSync(join(REPO, 'docs', AGENT_REFERENCE)));
    expect(reference).not.toContain('{{');
  });

  test.each(DEFERRED_RULES)('keeps the deferred rule verbatim: %s', rule => {
    expect(reference).toContain(rule);
    expect(renderAgentGuide()).not.toContain(rule);
  });

  test('keeps first-read authority and stage routing in the guide', () => {
    const guide = renderAgentGuide();
    for (const required of ['Human acts go through Review', 'rig-create next', 'Only human `signoffs[]`',
      '**Prior words.**', '**Bars before sign-off.**', "## The user's four steps"]) expect(guide).toContain(required);
    expect(reference).toContain(READ_FIRST);
    for (const link of [APPEARANCE_LINK, BUST_LINK, CG_GATES_LINK, GATES_LINK, PROJECTION_LINK]) {
      expect(markdownLinks(reference)).toContain(createDocUrl(link.path, link.anchor));
    }
  });
});

describe('the ordered entry point', () => {
  test('opens "What to read, and why" in the project guide and the collection guide', () => {
    for (const guide of [renderAgentGuide(), renderCollectionGuide()]) {
      const section = guide.slice(guide.indexOf('## What to read, and why'));
      expect(section).toContain(READ_FIRST);
      expect(section.indexOf(READ_FIRST)).toBeLessThan(section.indexOf('node_modules/'));
    }
  });

  test('names the four steps in order', () => {
    const steps = ['Before the interview', 'Before `seethrough` and `assemble`', 'Before rigging', 'Before showing the user'];
    const at = steps.map((step) => READ_FIRST.indexOf(`**${step}**`));
    for (const i of at) expect(i).toBeGreaterThanOrEqual(0);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });
});

/** rig-c/parts links in create's docs point at the pinned tag; each anchor is checked against the installed copy. */
const PARTS_BASE = `https://github.com/rig-c/parts/blob/v${PINNED_PACKAGES['@rig-c/parts']}/`;

describe.each(['docs/SOURCE.md', 'docs/LESSONS.md', 'docs/CRAFT.md'])('links in %s resolve', (doc) => {
  const text = readFileSync(join(REPO, doc), 'utf8');
  const links = markdownLinks(text);

  test('relative links point at a file and heading in this repository', () => {
    for (const href of links.filter((h) => !/^[a-z]+:/.test(h))) {
      const [path, anchor] = href.split('#') as [string, string | undefined];
      const file = path === '' ? join(REPO, doc) : join(REPO, 'docs', path);
      expect(existsSync(file), `${doc}: ${href} exists`).toBe(true);
      if (anchor !== undefined) expect(anchorsOf(readFileSync(file, 'utf8')).has(anchor), `${doc}: ${href} is a heading`).toBe(true);
    }
  });

  test('rig-c/parts links are at the pinned version and point at an installed heading', () => {
    for (const href of links.filter((h) => h.startsWith('https://github.com/rig-c/parts/blob/'))) {
      expect(href, `${doc}: ${href}`).toStartWith(PARTS_BASE);
      const [path, anchor] = href.slice(PARTS_BASE.length).split('#') as [string, string | undefined];
      const file = join(REPO, 'node_modules', '@rig-c', 'parts', path);
      expect(existsSync(file), `${doc}: ${path} is in the installed package`).toBe(true);
      if (anchor !== undefined) expect(anchorsOf(readFileSync(file, 'utf8')).has(anchor), `${doc}: ${href} is a heading`).toBe(true);
    }
  });
});

const MIN_COPIED_LINE = 40;

// Needs the network for the install, so it runs on request (same mechanism as init.test.ts).
test.skipIf(process.env.RIG_CREATE_NETWORK !== '1')(
  'every node_modules link in AGENTS.md resolves after init with install, and none of its lines is copied from them',
  () => {
    const root = tempDir();
    const env = { ...gitEnv(), BUN_INSTALL_CACHE_DIR: join(root, 'bun-cache') };
    const dir = join(root, 'installed');
    const result = cli(['init', dir], root, env);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);

    const agents = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
    const local = markdownLinks(agents).filter((href) => href.startsWith('node_modules/'));
    expect(local.length).toBe(PACKAGE_DOCS.length);
    const docs: string[] = [];
    for (const href of local) {
      const file = join(dir, href);
      expect(existsSync(file), `${href} is installed`).toBe(true);
      docs.push(readFileSync(file, 'utf8'));
    }
    const ownLines = agents
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length >= MIN_COPIED_LINE);
    for (const line of ownLines) {
      for (const [i, doc] of docs.entries()) {
        expect(doc.includes(line), `AGENTS.md line found in ${local[i]}: ${line}`).toBe(false);
      }
    }
    console.log(`checked ${local.length} installed links; ${ownLines.length} guide lines found in none of them`);
  },
  300_000,
);


test('parts approval instructions consume recorded API receipts', () => {
  const guide = renderAgentGuide();
  expect(guide).toContain('`parts-review` records its Review API response');
  expect(guide).toContain('structure-snapshot --draft <id> --out <f>');
  expect(guide).toContain('signoff parts-review --draft <id> --structure-file <f>');
  expect(guide).not.toContain('structure-snapshot --draft <id> --verdict');
});

test('rendered guide names both explicit painting declarations and their persistence', () => {
  const guide = renderAgentGuide();
  expect(guide).toContain('init --painting <file> --origin <words>');
  expect(guide).toContain('input add <path> --painting --origin <words>');
  expect(guide).toContain('project.json.painting');
  expect(guide).toContain('survives restart');
  expect(Buffer.byteLength(guide)).toBeLessThan(GUIDE_MAX_BYTES);
});
