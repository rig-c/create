import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
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

test('#490 the temporary reopen exception preserves exported words and names its act', () => {
  const readme = readFileSync(join(REPO, 'README.md'), 'utf8');
  for (const text of [renderAgentGuide(), readme]) {
    for (const required of ['create#493', 'Review host raw export', '`act@4`', 'nonempty `value.words`',
      'byte-for-byte', 'verbatim', '`--source`', '`actId`', 'Empty/missing words', 'STOP',
      '`job fetch-act`', 'rejects']) expect(text).toContain(required);
    expect(text).toMatch(/(?:Never supply|the agent never supplies) words\./);
  }
  expect(Buffer.byteLength(renderAgentGuide())).toBeLessThan(GUIDE_MAX_BYTES);
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
    expect(agents.split('\n').filter((line) => /^#{1,6}\s/.test(line))).toEqual(GUIDE_HEADINGS);
  });

  test('the package links are exactly the data table', () => {
    const local = markdownLinks(agents).filter((href) => !/^[a-z]+:/.test(href));
    expect(local).toEqual(PACKAGE_DOCS.map(packageDocPath));
    for (const href of local) expect(href).toStartWith('node_modules/@rig-c/');
  });

  test('every link to rig-c/create points at a file (and heading) in this repository', () => {
    const remote = markdownLinks(agents).filter((href) => href.startsWith('https://'));
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
