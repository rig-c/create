import { isObject, type Finding } from './check.ts';
import { ownerChatAuthorityFinding } from './owner-chat.ts';
import type { Json, JsonObject } from './templates.ts';

export const RIG_CHECK_REPORT_SINCE = '2026-11-19T00:00:00Z';
export const RIG_CHECK_REPORT_FILE = 'check.json';
const CHECK_SPEC = 'rig-parts-check/1';
const PRODUCE = 'run rig-parts check --rig <rig dir> --parts <parts dir> --source <painting> --requirements <requirements file> --out <check dir> with the build’s original check inputs and options';
const RECORD_CURRENT_RIG = 'record current rig outputs with rig-create record rig --from <dir> --config <file>';

export interface RigCheckTarget {
  kind: 'bar' | 'line' | 'exposure';
  id: string;
}

/** Parts' top-level source-exposure line (Parts 2.53.0, #1473): not a `bar_outcomes` bar nor a requirements line. */
export const SOURCE_EXPOSURE_ID = 'SOURCE_EXPOSURE';
const EXPOSURE_STATUSES = ['REPORTED', 'PASS', 'FAIL'];

interface UnmetCheck extends RigCheckTarget {
  status: 'FAIL' | 'NOT MEASURABLE';
}

export function parseRigCheckReport(bytes: Buffer): JsonObject {
  const report = JSON.parse(bytes.toString('utf8')) as Json;
  if (!isObject(report)) throw Error('expected a Parts check report object');
  return report;
}

function unmetChecks(report: JsonObject): UnmetCheck[] {
  if (!isObject(report.bar_outcomes)) throw Error('expected a bar_outcomes object');
  const unmet: UnmetCheck[] = [];
  for (const [id, row] of Object.entries(report.bar_outcomes)) {
    if (!isObject(row) || (row.status !== 'PASS' && row.status !== 'FAIL' && row.status !== 'SKIP')) {
      throw Error(`invalid bar_outcomes[${JSON.stringify(id)}] status`);
    }
    if (row.status === 'FAIL') unmet.push({ kind: 'bar', id, status: row.status });
  }
  if (report.requirements !== undefined) {
    if (!isObject(report.requirements) || !isObject(report.requirements.lines)) throw Error('expected a requirements.lines object');
    for (const [id, row] of Object.entries(report.requirements.lines)) {
      if (!isObject(row) || (row.status !== 'PASS' && row.status !== 'FAIL' && row.status !== 'NOT MEASURABLE')) {
        throw Error(`invalid requirements.lines[${JSON.stringify(id)}] status`);
      }
      if (row.status !== 'PASS') unmet.push({ kind: 'line', id, status: row.status });
    }
  }
  // The producer's own status: FAIL when a declared max_px is exceeded or cannot be read; REPORTED (no limit) and absent are met.
  const exposure = report[SOURCE_EXPOSURE_ID];
  if (exposure !== undefined) {
    if (!isObject(exposure) || !EXPOSURE_STATUSES.includes(String(exposure.status))) throw Error(`invalid ${SOURCE_EXPOSURE_ID} status`);
    if (exposure.status === 'FAIL') unmet.push({ kind: 'exposure', id: SOURCE_EXPOSURE_ID, status: 'FAIL' });
  }
  return unmet;
}

/** Validate the report's declared input against the digest verified in the frozen output inventory. */
function modelFinding(report: JsonObject, frozenSha256: Json | undefined, path: string): Finding | undefined {
  const reported = isObject(report.build) ? report.build.model_sha256 : undefined;
  if (typeof reported !== 'string' || !/^[a-f0-9]{64}$/.test(reported)) {
    return { code: 'RIG_CHECK_REPORT_MODEL_HASH_INVALID', path,
      message: `${path}: ${CHECK_SPEC} requires build.model_sha256 as a lowercase SHA-256 digest (Parts #1378); numbered rig registrations are read-only — restore the retained report, or ${PRODUCE} with a Parts release carrying #1378 and ${RECORD_CURRENT_RIG}` };
  }
  if (reported !== frozenSha256) {
    return { code: 'RIG_CHECK_REPORT_MODEL_MISMATCH', path,
      message: `${path}: report build.model_sha256 ${reported} differs from frozen skeleton.model.json SHA-256 ${String(frozenSha256)}; numbered rig registrations are read-only — restore the matching retained check report and model, or ${RECORD_CURRENT_RIG}` };
  }
}

export function checkRigReport(record: JsonObject, path: string, retainedPath: string, frozenSha256: Json | undefined,
  read: (binding: JsonObject) => Buffer, warnings: Finding[]): Finding[] {
  const binding = record.check_report;
  if (binding === undefined) {
    warnings.push({ code: 'RIG_CHECK_REPORT_MISSING', path, message: `${path}: no check report was registered; numbered rig registrations are read-only — ${PRODUCE} and ${RECORD_CURRENT_RIG}` });
    return [];
  }
  const legacy = Date.parse(String(record.at)) < Date.parse(RIG_CHECK_REPORT_SINCE);
  const findings: Finding[] = [];
  try {
    if (!isObject(binding) || binding.path !== retainedPath) throw Error(`expected retained report at ${retainedPath}`);
    const report = parseRigCheckReport(read(binding));
    if (binding.spec !== (report.spec ?? null)) throw Error('recorded spec differs from the retained report');
    if (report.spec === undefined) {
      const upgrade = legacy ? '' : 'upgrade to a Parts release carrying #1372 and ';
      warnings.push({ code: 'RIG_CHECK_REPORT_SPEC_MISSING', path,
        message: `${path}: retained report has no spec; numbered rig registrations are read-only — ${upgrade}${PRODUCE} and ${RECORD_CURRENT_RIG}` });
      if (binding.acceptances === undefined) return [];
      throw Error('per-item acceptances require a spec’d report');
    }
    if (report.spec !== CHECK_SPEC) throw Error(`unsupported report spec ${JSON.stringify(report.spec)}; expected ${CHECK_SPEC}`);
    const model = modelFinding(report, frozenSha256, `${path}.build.model_sha256`);
    if (model) return [model];
    const unmet = unmetChecks(report);
    const accepted = new Set<UnmetCheck>();
    if (binding.acceptances !== undefined) {
      if (!Array.isArray(binding.acceptances)) throw Error('expected an acceptances array');
      for (const [index, row] of binding.acceptances.entries()) {
        const acceptancePath = `${path}.acceptances[${index}]`;
        const target = isObject(row) && unmet.find(item => item.kind === row.kind && item.id === row.id);
        if (!isObject(row) || !target || accepted.has(target) || row.at !== record.at) {
          findings.push({ code: 'RIG_CHECK_ACCEPTANCE_INVALID', path: acceptancePath,
            message: `${acceptancePath}: numbered rig registrations are read-only — restore a valid check_report.acceptances entry naming a distinct failed bar, unmet line or failed ${SOURCE_EXPOSURE_ID} from this report at registration.at` });
          continue;
        }
        const authority = ownerChatAuthorityFinding(row, acceptancePath, row.owner_words ?? null);
        if (authority) findings.push(authority);
        else accepted.add(target);
      }
    }
    for (const item of unmet) {
      if (accepted.has(item)) continue;
      const itemPath = item.kind === 'exposure' ? `${path}.${SOURCE_EXPOSURE_ID}`
        : `${path}.${item.kind === 'bar' ? 'bar_outcomes' : 'requirements.lines'}[${JSON.stringify(item.id)}]`;
      const what = item.kind === 'exposure' ? 'shown source material within the declared source_exposure.max_px, or the unmeasured reading,' : `the ${item.kind}`;
      (legacy ? warnings : findings).push({ code: item.kind === 'bar' ? 'RIG_CHECK_BAR_FAILED' : 'RIG_CHECK_LINE_UNMET', path: itemPath,
        message: `${itemPath}: Parts reports ${item.status}; numbered rig registrations are read-only — restore any recorded owner acceptance in check_report.acceptances, or fix ${what}, ${PRODUCE}, and ${RECORD_CURRENT_RIG}` });
    }
  } catch (error) {
    findings.push({ code: 'RIG_CHECK_REPORT_INVALID', path, message: `${path}: ${String(error)}; numbered rig registrations are read-only — restore the bound Parts check report, or ${PRODUCE} and ${RECORD_CURRENT_RIG}` });
  }
  return findings;
}
