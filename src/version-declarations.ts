/**
 * The declarations a rig version's config must carry before `rig-version`
 * registers it (create#750), read in one run: `rig-version --preflight` and
 * `next` show every missing one at once instead of one refusal per rebuild.
 *
 * The declaration rules cover provenance, CG gates, setup painting and the
 * figure-mask declaration for one candidate version. Preflight shows every
 * code for each path and names the producer for any measured value.
 */
import { resolve } from 'node:path';

import { checkCgGates, CG_DECLARATIONS, isCgBuild } from './cg-gates.ts';
import { collectItems, loadCollection, type Ctx, type Finding } from './check.ts';
import { checkSourceFigureMaskDeclaration } from './figure-mask.ts';
import { PartsUnreadable, readPartsSections, type PartsSections } from './parts-sections.ts';
import { checkProvenance, needsCitation } from './provenance.ts';
import { checkSetupPainting, SETUP_PAINTING_DECLARATION } from './setup-painting.ts';
import type { JsonObject } from './templates.ts';

export interface VersionDeclaration {
  /** The record path the check reports a missing declaration at. */
  readonly path: string;
  /** `missing`: a finding at this path; `unread`: a finding at the file that holds it; `carried`: none. */
  readonly status: 'carried' | 'missing' | 'unread';
  readonly codes: string[];
}

export interface DeclarationReport {
  readonly version: string;
  readonly cg: boolean;
  readonly declarations: VersionDeclaration[];
  /** Kept for existing JSON consumers. */
  readonly registration_only: readonly [];
  readonly refusals: Finding[];
  readonly warnings: Finding[];
}

/** Runs the declaration checks over `version` alone, the candidate `rig-version` would append. */
/** `held` are refusals the caller already found (an unreadable config); a declaration under one is `unread`. */
export function checkVersionDeclarations(projectDir: string, project: JsonObject, version: JsonObject, held: readonly Finding[] = []): DeclarationReport {
  const dir = resolve(projectDir);
  const refusals: Finding[] = [...held];
  const warnings: Finding[] = [];
  const candidate: JsonObject = { ...project, versions: [version] };
  const collection = loadCollection(dir, candidate);
  const stage = String(project.stage);
  const ctx: Ctx = {
    dir, project: candidate, refusals, warnings, items: collectItems(candidate, { collection }),
    signoffs: [], steps: [], stage, effectiveStage: stage, collection, predatesPartsReview: null,
  };
  let parts: PartsSections | null = null;
  try {
    parts = readPartsSections(dir);
  } catch (e) {
    if (!(e instanceof PartsUnreadable)) throw e;
    refusals.push({ code: e.code, path: '@rig-c/parts', message: e.message });
  }
  const label = `versions[v${String(version.n)}]`;
  const summary = checkProvenance(ctx, parts).find(s => s.version === label);
  checkCgGates(ctx);
  checkSetupPainting(ctx, false);
  const figureMask = checkSourceFigureMaskDeclaration(ctx, version, label);
  const cg = isCgBuild(ctx);
  const config = `${label}.provenance.config`;
  const paths = [
    ...(summary?.sections ?? []).filter(section => needsCitation('rig', section)).map(section => `${label}.provenance.sections[${section}]`),
    ...(cg ? CG_DECLARATIONS.map(field => `${config} ${field}`) : []),
    `${config} ${SETUP_PAINTING_DECLARATION}`,
    ...(figureMask === undefined ? [] : [figureMask]),
  ];
  const findings = [...refusals, ...warnings];
  const declarations = paths.map((path): VersionDeclaration => {
    const at = findings.filter(f => f.path === path || f.path.startsWith(`${path}[`));
    if (at.length) return { path, status: 'missing', codes: [...new Set(at.map(f => f.code))] };
    const holder = findings.filter(f => path.startsWith(`${f.path} `));
    if (holder.length) return { path, status: 'unread', codes: [...new Set(holder.map(f => f.code))] };
    return { path, status: 'carried', codes: [] };
  });
  return { version: label, cg, declarations, registration_only: [], refusals, warnings };
}
