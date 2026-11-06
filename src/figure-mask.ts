/** Bind externally produced figure support without decoding or measuring it. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { asArray, asString, isObject, type Ctx } from './check.ts';
import { readObject } from './cg-gates.ts';
import { checkReviewPackages, reviewConfigInputs } from './review-package.ts';
import { refuse } from './refusal.ts';
import type { JsonObject } from './templates.ts';

export const FIGURE_MASK_SINCE = '2026-11-06T00:00:00Z';

export const FIGURE_MASK_INPUTS_SINCE = '2026-11-06T00:00:00Z';

type MaskContext = Pick<Ctx, 'dir' | 'project' | 'refusals' | 'warnings'>;

export function checkFigureMask(ctx: MaskContext): void {
  asArray(ctx.project.versions).forEach((version, index) => {
    if (!isObject(version) || version.kind !== 'rig' || version.pre_interview === true) return;
    const record = version.review_package;
    if (!isObject(record)) return;
    const root = join(ctx.dir, 'derived/review', `v${String(version.n)}`);
    if (!existsSync(root)) return;
    const packagePath = `versions[v${String(version.n)}].review_package`;
    if (ctx.refusals.some(f => f.path.startsWith(packagePath)
      && ['REVIEW_PACKAGE_CHANGED', 'REVIEW_PACKAGE_MALFORMED', 'REVIEW_PACKAGE_INPUT_INVALID'].includes(f.code))) return;
    const files = asArray(record.files).filter(isObject);
    const configEntry = files.find(f => f.path === 'config.json');
    if (typeof configEntry?.sha256 !== 'string') return;
    const provenance = isObject(version.provenance) ? version.provenance : {};
    const config = isObject(provenance.config) ? provenance.config : {};
    const configPath = asString(config.path);
    if (!configPath) return;
    const cfg = readObject(ctx.dir, join(root, 'config.json'), configEntry.sha256);
    if (!cfg.ok) return;
    const assemble = isObject(cfg.value.assemble) ? cfg.value.assemble : {};
    if (assemble.project !== 'visible' || assemble.ground !== 'busy') return;
    const label = typeof version.n === 'number' ? `versions[v${version.n}]` : `versions[${index}]`;
    const path = `${label}.provenance.config requirements setup_painting.figure_mask`;
    const at = typeof version.at === 'string' ? Date.parse(version.at) : Number.NaN;
    const legacy = !Number.isFinite(at) || at < Date.parse(FIGURE_MASK_SINCE);
    const finding = (code: string, detail: string): void => {
      (legacy ? ctx.warnings : ctx.refusals).push({
        code: legacy ? 'FIGURE_MASK_LEGACY' : code, path,
        message: `${path}: ${detail}${legacy ? ` (${code}; record predates ${FIGURE_MASK_SINCE} or has no readable date).` : ''}`,
      });
    };
    const unbound = (detail: string): void => {
      const old = !Number.isFinite(at) || at < Date.parse(FIGURE_MASK_INPUTS_SINCE);
      (old ? ctx.warnings : ctx.refusals).push({
        code: old ? 'FIGURE_MASK_INPUTS_LEGACY' : 'FIGURE_MASK_INPUT_UNBOUND', path,
        message: `${path}: ${detail}; preserve this package and record a new build with review-package to bind the requirements and figure mask`,
      });
    };
    const requirements = asString(cfg.value.requirements);
    if (!requirements) {
      finding('FIGURE_MASK_MISSING', `${configPath}: declare requirements with setup_painting.figure_mask`);
      return;
    }
    let named: JsonObject[];
    let unavailable = false;
    try { named = reviewConfigInputs(record, ctx.dir, Number(version.n), () => {}, () => { unavailable = true; }); }
    catch { return; } // The package checker owns loader and config diagnostics.
    if (unavailable) return;
    const reqPath = relative(root, resolve(root, requirements)).split(sep).join('/');
    const reqEntry = named.find(f => f.path === reqPath);
    if (typeof reqEntry?.sha256 !== 'string') {
      unbound(`requirements ${requirements} has no frozen input binding`);
      return;
    }
    const req = readObject(ctx.dir, resolve(root, requirements), reqEntry.sha256);
    if (!req.ok) {
      finding('FIGURE_MASK_MISSING', `${requirements}: ${req.why}; retain readable requirements JSON with setup_painting.figure_mask`);
      return;
    }
    const setup = isObject(req.value.setup_painting) ? req.value.setup_painting : {};
    const mask = isObject(setup.figure_mask) ? setup.figure_mask : {};
    if (typeof mask.path !== 'string' || !mask.path.trim() || typeof mask.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(mask.sha256)) {
      finding('FIGURE_MASK_MISSING', `${configPath}: declare setup_painting.figure_mask {path, sha256} in its requirements file, naming the externally produced figure PNG`);
      return;
    }
    const file = resolve(dirname(req.file), mask.path);
    const maskPath = relative(root, file).split(sep).join('/');
    const maskEntry = files.find(f => f.path === maskPath);
    if (typeof maskEntry?.sha256 !== 'string') {
      unbound(`figure mask ${mask.path} has no frozen input binding`);
      return;
    }
    let actual: string;
    try { actual = createHash('sha256').update(readFileSync(file)).digest('hex'); }
    catch {
      finding('FIGURE_MASK_CHANGED', `${mask.path}: cannot read the declared PNG; restore the file relative to ${requirements}`);
      return;
    }
    if (actual !== maskEntry.sha256) {
      ctx.refusals.push({ code: 'REVIEW_PACKAGE_CHANGED', path: packagePath, message: `${packagePath}: ${maskPath} differs from its frozen inventory hash; restore the recorded package` });
      return;
    }
    if (actual !== mask.sha256) {
      finding('FIGURE_MASK_CHANGED', `${mask.path}: bytes differ from the declaration; restore the recorded PNG or update its declaration and derived record`);
      return;
    }
    const original = resolve(dirname(resolve(ctx.dir, configPath)), requirements);
    const originalMask = resolve(dirname(original), mask.path);
    const recorded = asArray(ctx.project.derived).some((entry) => {
      if (!isObject(entry) || entry.kind !== 'prepared-input' || typeof entry.path !== 'string'
        || resolve(ctx.dir, entry.path) !== originalMask || typeof entry.sha256 !== 'string' || entry.sha256.toLowerCase() !== mask.sha256
        || typeof entry.operation !== 'string' || !entry.operation.trim()) return false;
      const sources = entry.sources === undefined ? [entry.source] : asArray(entry.sources);
      return sources.length > 0 && sources.every((source) => isObject(source)
        && typeof source.path === 'string' && source.path.trim() !== ''
        && typeof source.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(source.sha256));
    });
    if (!recorded) finding('FIGURE_MASK_UNRECORDED', `${relative(ctx.dir, originalMask)}: record this PNG and hash with derived add and at least one source; operation names the matte model, alpha >= 128 threshold and foreground plane subtracted (or none)`);
  });
}

/** Apply the same packaged gates at review writer and handoff boundaries. */
export function assertFigureMaskApproval(dir: string, project: JsonObject, version: number): void {
  const selected = { ...project, versions: asArray(project.versions).filter(v => isObject(v) && v.n === version) };
  const ctx: MaskContext = { dir, project: selected, refusals: [], warnings: [] };
  checkReviewPackages(ctx);
  checkFigureMask(ctx);
  const first = ctx.refusals.find(f => f.code.startsWith('FIGURE_MASK_'));
  if (first) refuse(first.code, first.message);
}
