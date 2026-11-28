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
  RETOUCH_HANDOFF_LINK,
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
import { RETIRED_NUMBERED_COMMANDS } from '../src/cli.ts';
import { PINNED_PACKAGES } from '../src/pins.ts';
import { STAGE_VALUES } from '../src/stages.ts';
import { cli, gitEnv, run, stagedCreateRegistry, tempDir } from './helpers.ts';

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

test('#543 the guide records an owner-accepted retouch through the current record writers', () => {
  const guide = renderAgentGuide();
  expect(guide).toContain('`assemble.edited_parts`');
  expect(guide).toContain('`rig-create record parts --from <dir> --config <file>`');
  expect(guide).toContain('`rig-create record rig --from <dir> --config <file>`');
  expect(guide).not.toContain('`draft-rig`');
  expect(guide).toContain(createDocUrl(RETOUCH_HANDOFF_LINK.path, RETOUCH_HANDOFF_LINK.anchor));
  expect(Buffer.byteLength(guide)).toBeLessThan(GUIDE_MAX_BYTES);
  expect(reference).toContain('`record rig --from <dir> --config <file>`');
  expect(reference).not.toContain('`rig-version --depth-manifest`');
});

test('#691 the editor rung documents the four retouch hand-off points and the guide links its anchor', () => {
  const source = readFileSync(join(REPO, RETOUCH_HANDOFF_LINK.path), 'utf8');
  expect(anchorsOf(source).has(RETOUCH_HANDOFF_LINK.anchor)).toBe(true);
  const heading = '#### Handing a retouch to an image editor';
  const start = source.indexOf(heading);
  expect(start).toBeGreaterThan(source.indexOf('### The editor rung'));
  const section = source.slice(start, source.indexOf('### Feather only continuous skin', start));
  for (const point of [
    'input 1 = the original painting crop, input 2 = the current part on a 1:1',
    'sheet, at its own pixels;',
    'several runs, picking the best run for each part;',
    'drift measured outside the fixed region;',
    'the result recorded with `assemble.edited_parts` receipts (part, file,',
    'from_sha256, sha256, editor).',
  ]) {
    expect(section).toContain(point);
  }
});

test('#674 the guide routes current direction corrections through the dependency rebuild', () => {
  const guide = renderAgentGuide();
  expect(guide).toContain("follow next to rebuild\n");
  expect(guide).not.toContain("amend direction-review");
  const readme = readFileSync(join(REPO, 'README.md'), 'utf8');
  for (const text of [guide, readme]) {
    expect(text).not.toContain('amend direction-review');
    expect(text).not.toContain('reopen direction-review --from-review');
  }
  expect(Buffer.byteLength(guide)).toBeLessThan(GUIDE_MAX_BYTES);
});

test('#467 the direction guide names current motion, scene, direction and the chat relay', () => {
  const guide = renderAgentGuide();
  expect(guide).toContain('`rig-create record motion --from <dir>`');
  expect(guide).toContain('`rig-create scene write --compose-scene <file>`');
  expect(guide).toContain('`rig-create direction write --file <json>`');
  expect(guide).toContain('`rig-create record direction --from <dir> --direction specs/direction/direction.json`');
  expect(guide).toContain('`rig-create advance accepted`');
  expect(guide).toContain('Ask camera/depth, timing and');
  expect(guide).toContain('composition in chat');
  expect(guide).not.toContain('review <post> --from-review');
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
  const root = tempDir('rig-create-test-', { scope: 'suite' });
  const env = gitEnv(undefined, { scope: 'suite' });
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
    expect(Buffer.byteLength(agents)).toBeLessThan(GUIDE_MAX_BYTES);
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
  "- **Camera options.** Post decides fixed framing or camera-box moves. Timed\n  head-turn dials, plate parallax and take-wide gaze remain unavailable in direction.",
  "- **Upscale first** a painting smaller than the rig needs (SOURCE.md, “Upscale first”).",
  "- **The crux is a bar.** Before rigging, name every risk band, count background\n  or doubled pixels over every frame and both physics/breath extremes, and\n  report the maximum and its frame. Cover every band crossing another bone.",
  "- **Appearance needs a person**, not a step bar: [CHECKS.md § Appearance bar wording](https://github.com/rig-c/create/blob/main/docs/CHECKS.md#appearance-bar-wording).",
  "- **Nothing unnamed.** Add no unnamed motion, chain or physics. Read references\n  for what they show; ask about anything more.",
  "- **Re-run first, cut last**, never a polygon in code or config: the rerun ladder in\n  SOURCE.md.",
  "- **A full-screen scene is a CG build.** For `rig_type` `fullscreen.*`, each\n  checked rig declares the gates in [CHECKS.md § CG gates](https://github.com/rig-c/create/blob/main/docs/CHECKS.md#cg-gates). Refusals are the art's to fix.",
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
    for (const required of ['`rig-create next`', 'Feedback and approval never gate writes',
      '`rig-create interview --check`', '`rig-create comment --from-review <actId>`',
      '**Prior words.**', '**Readings.**', "## The user's four steps"]) expect(guide).toContain(required);
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
    const steps = ['Before the interview', 'Before splitting and assembling', 'Before rigging', 'Before showing the user'];
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
    const env = { ...gitEnv(), ...stagedCreateRegistry(), BUN_INSTALL_CACHE_DIR: join(root, 'bun-cache') };
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


test('parts instructions keep the check report and make owner signoff optional', () => {
  const guide = renderAgentGuide();
  expect(guide).toContain('`rig-create record parts --from <dir> --config <file>`');
  expect(guide).toContain('`rig-create structure-snapshot`');
  expect(guide).toContain('`rig-create advance parts-review --parts-check <report> --parts <assembled-dir>`');
  expect(guide).toContain('optional signoff in chat');
  expect(guide).not.toContain('parts-review --from-review');
  expect(guide).not.toContain('structure-snapshot --draft <id>');
});

test('rendered guide names both painting declarations and the current Review route', () => {
  const guide = renderAgentGuide();
  expect(guide).toContain('init <dir> --painting <file> --origin <words>');
  expect(guide).toContain('input add <path> --painting --origin <words>');
  expect(guide).toContain('project.json.painting');
  expect(guide).toContain('job open --reviewer <id> --role owner --current <parts|rig|direction>');
  expect(guide).toContain('job acts --json');
  expect(guide).toContain('`rig-create pause --by <who>`');
  expect(guide).toContain('Current-path pauses need no\nsignature.');
  expect(Buffer.byteLength(guide)).toBeLessThan(GUIDE_MAX_BYTES);
});

test('#1122 neither the rendered guide nor AGENT-REFERENCE.md names any retired numbered command', () => {
  const guide = renderAgentGuide();
  expect(Buffer.byteLength(guide)).toBeLessThan(GUIDE_MAX_BYTES);
  const stageArrowLine = '`interview` → `plan-approved` → `parts` → `parts-review` (parts, by eye) →';
  expect(guide).toContain(stageArrowLine);
  // Stage tokens in the stage-order arrow line name STAGES entries, not CLI commands.
  const guideWithoutStageLine = guide.replace(stageArrowLine, '');
  const codeSpans = (markdown: string): string[] => [...markdown.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
  const referenceSpans = codeSpans(reference);
  const guideSpans = codeSpans(guide);
  const guideSpansWithoutStageLine = codeSpans(guideWithoutStageLine);
  for (const name of Object.keys(RETIRED_NUMBERED_COMMANDS)) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rigCreateForm = new RegExp(`\\brig-create\\s+${escaped}(?![A-Za-z0-9_-])`);
    const spanNamesCommand = (span: string): boolean =>
      span === name || span.startsWith(`${name} `) || rigCreateForm.test(span);
    for (const [label, text] of [['renderAgentGuide()', guide], ['docs/AGENT-REFERENCE.md', reference]] as const) {
      expect(rigCreateForm.test(text), `${label} names rig-create ${name}`).toBe(false);
    }
    expect(referenceSpans.filter(spanNamesCommand), `docs/AGENT-REFERENCE.md names \`${name}\` in backticks`).toEqual([]);
    const targetSpans = STAGE_VALUES.includes(name) ? guideSpansWithoutStageLine : guideSpans;
    expect(targetSpans.filter(spanNamesCommand), `renderAgentGuide() names \`${name}\` in backticks`).toEqual([]);
  }
});

test('#1158 the rendered guide tells numbered projects with CREATE_PIN_MISMATCH to use Create 1.27.x or adopt instead of packages upgrade', () => {
  const guide = renderAgentGuide();
  expect(guide).toContain('for `CREATE_PIN_MISMATCH` on a numbered project, use Create 1.27.x or adopt, not `packages upgrade`');
  expect(Buffer.byteLength(guide)).toBeLessThan(GUIDE_MAX_BYTES);
});
