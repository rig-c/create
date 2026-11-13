import { writeFileSync } from 'node:fs';
import { readFileSync } from './check-reads.ts';
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
    why: 'painting-to-rig pipeline and command order',
  },
  {
    package: '@rig-c/parts',
    path: 'docs/AUTHORING.md',
    why: 'config fields, interview waypoints and refusal remedies',
  },
  {
    package: '@rig-c/parts',
    path: 'docs/PAINTING.md',
    why: 'what makes a painting riggable, and the check to run on it before See-through',
  },
  {
    package: '@rig-c/parts',
    path: 'docs/DEPTH.md',
    why: 'depth reference; unavailable in current direction',
  },
  {
    package: '@rig-c/parts',
    path: 'docs/STABILITY.md',
    why: 'stable commands, fields and outputs',
  },
  {
    package: '@rig-c/parts',
    path: 'docs/MIGRATION.md',
    why: 'only when the pinned version is bumped',
  },
  {
    package: '@rig-c/core',
    path: 'README.md',
    why: 'rigc scope, commands and documentation',
  },
  {
    package: '@rig-c/core',
    path: 'docs/AUTHORING.md',
    why: 'rig/motion formats, build loop and failure remedies',
  },
  {
    package: '@rig-c/core',
    path: 'docs/RIGGING.md',
    why: 'bones and pivots at the bones waypoint',
  },
  {
    package: '@rig-c/core',
    path: 'docs/MOTION.md',
    why: 'key-pose motions at the motion waypoint',
  },
  {
    package: '@rig-c/core',
    path: 'docs/FACE.md',
    why: 'blink and gaze in the accepted rig',
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
export const DERIVED_LINK = { path: 'docs/INTERVIEW.md', anchor: 'derived-answers' } as const;
export const GATES_LINK = { path: 'docs/CRAFT.md', anchor: 'for-the-gates-not-the-interview' } as const;
export const DRAFTS_LINK = { path: 'docs/PROJECT.md', anchor: 'labelled-draft-rigs-and-structure-decisions' } as const;
export const STAGES_LINK = { path: 'docs/PROJECT.md', anchor: 'stages' } as const;
export const LIFETIME_LINK = { path: 'docs/PROJECT.md', anchor: 'data-is-split-by-lifetime' } as const;
export const INTAKE_LINK = { path: 'docs/PROJECT.md', anchor: 'advisory-intake-reports' } as const;
export const CG_GATES_LINK = { path: 'docs/CHECKS.md', anchor: 'cg-gates' } as const;
export const APPEARANCE_LINK = { path: 'docs/CHECKS.md', anchor: 'appearance-bar-wording' } as const;
export const BUST_LINK = { path: 'docs/CHECKS.md', anchor: 'the-bust-at-meshes' } as const;
export const PROJECTION_LINK = { path: 'docs/CHECKS.md', anchor: 'projection-and-ground' } as const;
/** The heading is "Parts-stage check at the parts → parts-review move": the arrow drops, leaving two hyphens. */
export const PARTS_CHECK_LINK = { path: 'docs/CHECKS.md', anchor: 'parts-stage-check-at-the-parts--parts-review-move' } as const;

/** The refusals `advance parts-review --parts-check` can give, all in one CHECKS.md table. */
export const PARTS_CHECK_CODES = ['MISSING', 'UNREAD', 'INVALID', 'CHANGED', 'FAILED', 'STALE'].map((c) => `PARTS_CHECK_${c}`);

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
 * The check an agent runs before asking for the interview sign-off: since
 * rig-c/create#3 it is `rig-create interview --check`, which refuses every
 * `null` answer by name, so the line names the command, not the doc reference.
 */
export const INTERVIEW_CHECK_LINE = 'Before asking the user to sign the interview, run `rig-create interview --check`: it names every `null` answer.';

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
    DRAFTS_LINK: `[PROJECT.md § Labelled draft rigs](${createDocUrl(DRAFTS_LINK.path, DRAFTS_LINK.anchor)})`,
    STAGES_LINK: `[PROJECT.md § Stages](${createDocUrl(STAGES_LINK.path, STAGES_LINK.anchor)})`,
    LIFETIME_LINK: `[PROJECT.md § Data is split by lifetime](${createDocUrl(LIFETIME_LINK.path, LIFETIME_LINK.anchor)})`,
    INTAKE_LINK: `[PROJECT.md § Advisory intake reports](${createDocUrl(INTAKE_LINK.path, INTAKE_LINK.anchor)})`,
    CG_GATES_LINK: `[CHECKS.md § CG gates](${createDocUrl(CG_GATES_LINK.path, CG_GATES_LINK.anchor)})`,
    APPEARANCE_LINK: `[CHECKS.md § Appearance bar wording](${createDocUrl(APPEARANCE_LINK.path, APPEARANCE_LINK.anchor)})`,
    BUST_LINK: `[CHECKS.md § The bust at meshes](${createDocUrl(BUST_LINK.path, BUST_LINK.anchor)})`,
    PROJECTION_LINK: `[CHECKS.md § Projection and ground](${createDocUrl(PROJECTION_LINK.path, PROJECTION_LINK.anchor)})`,
    PARTS_CHECK_LINK: `[${PARTS_CHECK_CODES.map((code) => `\`${code}\``).join(', ')}](${createDocUrl(PARTS_CHECK_LINK.path, PARTS_CHECK_LINK.anchor)})`,
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
