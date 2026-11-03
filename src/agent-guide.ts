import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { PINNED_PACKAGES } from './pins.ts';
import { TEMPLATES_DIR } from './templates.ts';

/**
 * create's own docs are linked on GitHub at `main`: create is not installed in
 * a project, it has no published version or tag to pin to, and init already
 * points at `main` for the interview (init.ts). A commit pin would send every
 * new project to docs that were already stale when it was made.
 */
export const CREATE_DOCS_BASE = 'https://github.com/rig-c/create/blob/main/';

export type PinnedPackage = keyof typeof PINNED_PACKAGES;

export interface PackageDoc {
  package: PinnedPackage;
  /** Path inside the installed package, as `npm pack --dry-run` lists it. */
  path: string;
  /** Why and when to read it. Says what the document is for, never what it says. */
  why: string;
}

/**
 * The installed packages' documents the guide links, checked against the files
 * each pinned version ships (`npm pack --dry-run`). A pin bump is an edit here,
 * and the network test fails if a listed path is not in the installed package.
 *
 * Shipped but left out on purpose:
 * - core `docs/PROMPTING.md`: written for the person operating an agent; it
 *   says the agent should read AUTHORING.md instead.
 * - core `docs/SPEC_COVERAGE.md`: core's AUTHORING.md calls it not an
 *   authoring input and leaves it unlinked.
 */
export const PACKAGE_DOCS: readonly PackageDoc[] = [
  {
    package: '@rig-c/parts',
    path: 'README.md',
    why: 'the pipeline from painting to parts to rig, and the command order an agent follows',
  },
  {
    package: '@rig-c/parts',
    path: 'docs/AUTHORING.md',
    why: 'the guide you author from: `config.json` field by field (its sections are the interview waypoints), and which field or input each refusal rule points at',
  },
  {
    package: '@rig-c/parts',
    path: 'docs/PAINTING.md',
    why: 'what makes a painting riggable, and the check to run on it before See-through',
  },
  {
    package: '@rig-c/parts',
    path: 'docs/DEPTH.md',
    why: 'when the plan has a head turn driven by depth',
  },
  {
    package: '@rig-c/parts',
    path: 'docs/STABILITY.md',
    why: 'which commands, config fields and written files you can rely on across versions',
  },
  {
    package: '@rig-c/parts',
    path: 'docs/MIGRATION.md',
    why: 'only when the pinned version is bumped',
  },
  {
    package: '@rig-c/core',
    path: 'README.md',
    why: 'what rigc does and does not do, its commands, and its documentation table',
  },
  {
    package: '@rig-c/core',
    path: 'docs/AUTHORING.md',
    why: 'before writing a rig or motion spec by hand: the two formats, the build loop, and the map from each named failure to the file that has to change',
  },
  {
    package: '@rig-c/core',
    path: 'docs/RIGGING.md',
    why: 'at the bones waypoint: placing bones and pivots, and how a misplaced pivot shows up',
  },
  {
    package: '@rig-c/core',
    path: 'docs/MOTION.md',
    why: 'at the motion waypoint: motions from key poses',
  },
  {
    package: '@rig-c/core',
    path: 'docs/FACE.md',
    why: 'when the plan has a blink, a gaze or a head turn',
  },
  {
    package: '@rig-c/core',
    path: 'docs/INGEST.md',
    why: 'only when you were handed a skeleton this project did not author',
  },
];

export interface CreateDoc {
  /** Path in the rig-c/create repository. */
  path: string;
  why: string;
}

export const CREATE_DOCS: readonly CreateDoc[] = [
  {
    path: 'docs/PROJECT.md',
    why: 'the folder, stages and sign-offs, the plan, versions, and `project.json` field by field',
  },
  {
    path: 'docs/INTERVIEW.md',
    why: 'how to ask, and the shape every answer, delegation and piece of feedback takes',
  },
  {
    path: 'docs/CRAFT.md',
    why: 'the default to propose at each waypoint',
  },
  {
    path: 'docs/COLLECTIONS.md',
    why: 'when this project is a member of a collection',
  },
];

/** Links into create's docs that carry an anchor; the tests check each anchor is a heading. */
export const RESUME_LINK = { path: 'docs/PROJECT.md', anchor: 'how-an-agent-resumes-a-project' } as const;
export const OWNER_LINK = { path: 'docs/INTERVIEW.md', anchor: 'every-item-has-an-owner' } as const;
export const DERIVED_LINK = { path: 'docs/INTERVIEW.md', anchor: 'derived-answers' } as const;
export const GATES_LINK = { path: 'docs/CRAFT.md', anchor: 'for-the-gates-not-the-interview' } as const;

export function createDocUrl(path: string, anchor?: string): string {
  return `${CREATE_DOCS_BASE}${path}${anchor === undefined ? '' : `#${anchor}`}`;
}

function createLink(label: string, path: string, anchor?: string): string {
  return `[${label}](${createDocUrl(path, anchor)})`;
}

/**
 * The one ordered entry point (rig-c/create#24): what to read before each step,
 * naming the page and the section. create's pages are absolute links (create is
 * not installed in a project); the parts and core sections are named, not
 * linked, because the package links below are exactly PACKAGE_DOCS.
 */
export const READ_FIRST = [
  '1. **Before the interview**: INTERVIEW.md, and CRAFT.md for the default at each',
  '   waypoint (both linked below); parts AUTHORING §3, *`config.json`, field by',
  `   field*; ${createLink('CHECKS.md', 'docs/CHECKS.md')} before a sign-off.`,
  '2. **Before `seethrough` and `assemble`**: SOURCE.md, the order of the split and',
  `   the cut: ${createLink('re-running a bad split', 'docs/SOURCE.md', 're-run-first')},`,
  `   ${createLink('where a cut is allowed', 'docs/SOURCE.md', 'where-a-cut-is-allowed')};`,
  '   then parts AUTHORING *See-through head-run source reading*, *Source before',
  '   scissors* and *Limbs: cut at their joints*.',
  `3. **Before rigging**: ${createLink('CRAFT.md § For the gates', 'docs/CRAFT.md', 'for-the-gates-not-the-interview')}`,
  '   (G1–G9); core RIGGING and MOTION; parts AUTHORING §7, the bars `check` enforces.',
  `4. **Before showing the user**: ${createLink('LESSONS.md § The self-check', 'docs/LESSONS.md', 'the-self-check')},`,
  `   the ${createLink('per-frame seam count', 'docs/LESSONS.md', 'count-the-seam-bar-over-every-frame')},`,
  `   ${createLink('what to show first', 'docs/LESSONS.md', 'what-to-show-the-user-first')}.`,
].join('\n');

/**
 * The check an agent runs before asking for the interview sign-off.
 * After rig-c/create#3 (`rig-create interview --check`) lands, this line names
 * that command, in the form a project runs it, instead of the doc reference.
 */
export const INTERVIEW_CHECK_LINE = `Before asking the user to sign the interview, check that no framing answer and no guide of a waypoint the plan passes is \`null\` ([INTERVIEW.md § Every item has an owner](${createDocUrl(OWNER_LINK.path, OWNER_LINK.anchor)})).`;

export const GUIDE_TEMPLATE = 'agent-guide.md';

/** CLAUDE.md is a pointer: Claude Code reads CLAUDE.md, and an `@path` line imports that file into it. */
export const CLAUDE_MD = [
  '@AGENTS.md',
  '',
  'The agent guide for this project is AGENTS.md, imported above. It is the only copy: change it there, not here.',
  '',
].join('\n');

export function packageDocPath(doc: PackageDoc): string {
  return `node_modules/${doc.package}/${doc.path}`;
}

function linkLine(label: string, href: string, why: string): string {
  return `- [${label}](${href}): ${why}.`;
}

/** The text of AGENTS.md, from the template and the tables above. */
export function renderAgentGuide(): string {
  const fills: Record<string, string> = {
    RESUME_LINK: `[PROJECT.md § How an agent resumes a project](${createDocUrl(RESUME_LINK.path, RESUME_LINK.anchor)})`,
    INTERVIEW_CHECK: INTERVIEW_CHECK_LINE,
    DERIVED_LINK: `[INTERVIEW.md § Derived answers](${createDocUrl(DERIVED_LINK.path, DERIVED_LINK.anchor)})`,
    GATES_LINK: `[CRAFT.md G8](${createDocUrl(GATES_LINK.path, GATES_LINK.anchor)})`,
    READ_FIRST,
    PACKAGE_DOCS: PACKAGE_DOCS.map((doc) =>
      linkLine(`${doc.package} ${doc.path}`, packageDocPath(doc), doc.why),
    ).join('\n'),
    CREATE_DOCS: CREATE_DOCS.map((doc) => linkLine(doc.path, createDocUrl(doc.path), doc.why)).join('\n'),
  };
  const template = readFileSync(join(TEMPLATES_DIR, GUIDE_TEMPLATE), 'utf8');
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (marker, key: string) => {
    const fill = fills[key];
    if (fill === undefined) throw new Error(`${GUIDE_TEMPLATE}: unknown marker ${marker}`);
    return fill;
  });
}

/**
 * Writes the guide an agent reads first in a project — AGENTS.md, and a
 * CLAUDE.md that imports it — and returns the paths written (relative to the
 * project) so init can add exactly those to git.
 */
export function writeAgentGuide(dir: string): string[] {
  writeFileSync(join(dir, 'AGENTS.md'), renderAgentGuide());
  writeFileSync(join(dir, 'CLAUDE.md'), CLAUDE_MD);
  return ['AGENTS.md', 'CLAUDE.md'];
}
