/** The setup-painting declaration on retained build configs (create#32). */
import { dirname, resolve } from 'node:path';

import { asArray, asString, isObject, type Ctx } from './check.ts';
import { readObject } from './cg-gates.ts';

export const SETUP_PAINTING_SINCE = '2026-11-06T00:00:00Z';

/** Unread retained configs keep their existing provenance owner. */
export function checkSetupPainting(ctx: Ctx): void {
  asArray(ctx.project.versions).forEach((version, index) => {
    if (!isObject(version) || version.pre_interview === true) return;
    const provenance = isObject(version.provenance) ? version.provenance : {};
    // Authored direction is consumer camera/timing, not a parts build config.
    // Its closed schema and hash are checked by checkDirections. Legacy post configs keep their contract.
    if (version.kind === 'post' && isObject(provenance.direction)) return;
    const config = isObject(provenance.config) ? provenance.config : {};
    const configPath = asString(config.path);
    if (configPath === null || configPath === '') return;
    const cfg = readObject(ctx.dir, resolve(ctx.dir, configPath), asString(config.sha256));
    if (!cfg.ok) return;
    const label = typeof version.n === 'number' ? `versions[v${version.n}]` : `versions[${index}]`;
    const path = `${label}.provenance.config requirements`;
    // CG already owns an absent or unread requirements file at this path.
    if (ctx.refusals.some((finding) => finding.path === path
      && (finding.code === 'CG_GATE_UNDECLARED' || finding.code === 'CG_GATES_UNREAD'))) return;
    const requirements = asString(cfg.value.requirements);
    const req = requirements === null || requirements === '' ? null
      : readObject(ctx.dir, resolve(dirname(cfg.file), requirements), null);
    const setup = req?.ok && isObject(req.value.setup_painting) ? req.value.setup_painting : {};
    if (req?.ok && setup.required === true) return;
    const at = typeof version.at === 'string' ? Date.parse(version.at) : Number.NaN;
    const legacy = !Number.isFinite(at) || at < Date.parse(SETUP_PAINTING_SINCE);
    const missing = req === null || !req.ok;
    const code = missing ? 'SETUP_PAINTING_REQUIREMENTS_MISSING' : 'SETUP_PAINTING_REQUIRED_MISSING';
    const detail = req === null ? `${configPath} names no requirements file. Write requirements in that config naming the checks file`
      : !req.ok ? `${configPath} names ${requirements}, but ${req.why}. Retain a readable requirements file at that config-relative path`
        : `${requirements} lacks setup_painting.required: true. Write that declaration in the requirements file named by ${configPath}`;
    const finding = {
      code: legacy ? 'SETUP_PAINTING_LEGACY' : code,
      path: missing ? path : `${path} setup_painting.required`,
      message: `${label}: ${detail}. Measure limits with parts' own pixel_count per region on the accepted split build and record their source.${legacy ? ` This record predates ${SETUP_PAINTING_SINCE} or has no readable date (${code}).` : ''}`,
    };
    (legacy ? ctx.warnings : ctx.refusals).push(finding);
  });
}
