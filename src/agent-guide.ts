import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const PROJECT_DOC_URL = 'https://github.com/rig-c/create/blob/main/docs/PROJECT.md';

/**
 * Writes the guide an agent reads first in a project, and returns the paths
 * written (relative to the project) so init can add exactly those to git.
 *
 * Placeholder until rig-c/create#4 writes the real guide (AGENTS.md pointing
 * into the installed packages' docs, plus CLAUDE.md pointing at it). It is a
 * stub rather than nothing because an agent opening a fresh project would
 * otherwise find no instruction at all, and the one rule that must hold from
 * the first minute fits in two lines.
 */
export function writeAgentGuide(dir: string): string[] {
  const text = [
    '# Agent guide',
    '',
    'Read `project.json` first: it is the only record of decisions. Do not rig before the plan is signed.',
    `The full guide is not written yet; until it is, see ${PROJECT_DOC_URL}.`,
    '',
  ].join('\n');
  writeFileSync(join(dir, 'AGENTS.md'), text);
  return ['AGENTS.md'];
}
