/** Bind externally produced figure support without decoding or measuring it. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

import { asArray, asString, isObject, type Ctx } from './check.ts';
import { readObject } from './cg-gates.ts';

export const FIGURE_MASK_SINCE = '2026-11-06T00:00:00Z';

export function checkFigureMask(ctx: Ctx): void {
  asArray(ctx.project.versions).forEach((version, index) => {
    if (!isObject(version) || version.pre_interview === true) return;
    const provenance = isObject(version.provenance) ? version.provenance : {};
    const config = isObject(provenance.config) ? provenance.config : {};
    const configPath = asString(config.path);
    if (!configPath) return;
    const cfg = readObject(ctx.dir, resolve(ctx.dir, configPath), asString(config.sha256));
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
    const requirements = asString(cfg.value.requirements);
    const req = requirements ? readObject(ctx.dir, resolve(dirname(cfg.file), requirements), null) : null;
    const setup = req?.ok && isObject(req.value.setup_painting) ? req.value.setup_painting : {};
    const mask = isObject(setup.figure_mask) ? setup.figure_mask : {};
    if (!req?.ok || typeof mask.path !== 'string' || !mask.path.trim() || typeof mask.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(mask.sha256)) {
      finding('FIGURE_MASK_MISSING', `${configPath}: declare setup_painting.figure_mask {path, sha256} in its requirements file, naming the externally produced figure PNG`);
      return;
    }
    const file = resolve(dirname(req.file), mask.path);
    let actual: string;
    try { actual = createHash('sha256').update(readFileSync(file)).digest('hex'); }
    catch {
      finding('FIGURE_MASK_CHANGED', `${mask.path}: cannot read the declared PNG; restore the file relative to ${requirements}`);
      return;
    }
    if (actual !== mask.sha256) {
      finding('FIGURE_MASK_CHANGED', `${mask.path}: bytes differ from the declaration; restore the recorded PNG or update its declaration and derived record`);
      return;
    }
    const recorded = asArray(ctx.project.derived).some((entry) => {
      if (!isObject(entry) || entry.kind !== 'prepared-input' || typeof entry.path !== 'string'
        || resolve(ctx.dir, entry.path) !== file || typeof entry.sha256 !== 'string' || entry.sha256.toLowerCase() !== mask.sha256
        || typeof entry.operation !== 'string' || !entry.operation.trim()) return false;
      const sources = entry.sources === undefined ? [entry.source] : asArray(entry.sources);
      return sources.length > 0 && sources.every((source) => isObject(source)
        && typeof source.path === 'string' && source.path.trim() !== ''
        && typeof source.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(source.sha256));
    });
    if (!recorded) finding('FIGURE_MASK_UNRECORDED', `${relative(ctx.dir, file)}: record this PNG and hash with derived add and at least one source; operation names the matte model, alpha >= 128 threshold and foreground plane subtracted (or none)`);
  });
}
