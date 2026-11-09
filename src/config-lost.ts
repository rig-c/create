/** Record a pre-interview version's lost build config or frozen outputs (#171, #344, docs/PROJECT.md § Migrating work done before the interview). */
import { resolve } from 'node:path';

import { asArray, isObject, PROJECT_SCHEMA } from './check.ts';
import { save } from './choice-writers.ts';
import { readProject } from './feedback.ts';
import { inspectPreInterviewOutputs, OUTPUTS_LOST_MALFORMED_MESSAGE, validConfigLoss, validOutputsLoss } from './pre-interview.ts';
import { refuse, USAGE_EXIT } from './refusal.ts';
import type { JsonObject } from './templates.ts';

export const VERSION_HELP = `version config-lost <n> --note <text> --source <text> [<dir>] [--json]
  Record config_lost: { note, source } on a pre-interview version whose build config did not survive.
  Refuses when the version is not pre_interview: true, carries provenance.config, already declares config_lost, or adds a check refusal.
version outputs-lost <n> --note <text> --source <text> [<dir>] [--json]
  Record outputs_lost: { note, source, recorded } and outputs: [] on a pre-interview version whose frozen outputs did not survive.
  Refuses when the version is not pre_interview: true, has a readable output, already declares outputs_lost, or adds a check refusal.`;

type VersionSubcommand = 'config-lost' | 'outputs-lost';

function usage(sub: VersionSubcommand, why: string): never {
  const code = sub === 'outputs-lost' ? 'OUTPUTS_LOST_USAGE' : 'CONFIG_LOST_USAGE';
  refuse(code, `version ${sub}: ${why}; ${VERSION_HELP}`, USAGE_EXIT);
}

export function versionCommand(args: string[], now: number): { stdout: string; exit: number } {
  const rawSub = args[0];
  if (rawSub !== 'config-lost' && rawSub !== 'outputs-lost') {
    usage('config-lost', 'expected subcommand config-lost or outputs-lost');
  }
  const sub: VersionSubcommand = rawSub;
  const positional: string[] = [];
  const opts: Record<string, string> = {};
  let json = false;
  for (let i = 1; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === '--json') {
      if (json) usage(sub, 'duplicate --json');
      json = true;
    } else if (arg === '--note' || arg === '--source') {
      const value = args[++i];
      if (value === undefined || value.startsWith('--') || arg in opts) usage(sub, `${arg} needs one value`);
      opts[arg] = value;
    } else if (arg.startsWith('-')) {
      usage(sub, `unsupported flag ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  const rawN = positional[0];
  const n = rawN === undefined || !/^v?[1-9]\d*$/.test(rawN) ? Number.NaN : Number(rawN.replace(/^v/, ''));
  if (!Number.isSafeInteger(n) || n < 1 || positional.length > 2 || !('--note' in opts) || !('--source' in opts)) {
    usage(sub, 'supply version <n>, --note <text>, --source <text> and at most one project folder');
  }
  const note = opts['--note'] as string;
  const source = opts['--source'] as string;
  const dir = resolve(positional[1] ?? process.cwd());
  const { file, project } = readProject(dir);
  if (project.schema !== PROJECT_SCHEMA) {
    refuse('SCHEMA_UNKNOWN', `schema is ${JSON.stringify(project.schema ?? null)}; version ${sub} reads ${PROJECT_SCHEMA}`);
  }
  const label = `versions[v${n}]`;
  if (sub === 'outputs-lost') {
    if (note.trim() === '' || source.trim() === '') {
      refuse('OUTPUTS_LOST_EMPTY', `${label}.outputs_lost: --note and --source must be non-empty strings; explain the output loss and name its source record`);
    }
    const current = asArray(project.versions).find((v): v is JsonObject => isObject(v) && v.n === n);
    if (current === undefined) {
      refuse('OUTPUTS_LOST_VERSION_UNKNOWN', `${label}: versions[] has no version ${n}; name an existing pre-interview version`);
    }
    if (current.pre_interview !== true) {
      refuse('OUTPUTS_LOST_NOT_PRE_INTERVIEW', `${label}.pre_interview: version ${n} is not pre_interview: true; record outputs_lost only on a migrated pre-interview version, or keep outputs[] on a create-built version`);
    }
    if (Object.hasOwn(current, 'outputs_lost')) {
      refuse('OUTPUTS_LOST_ALREADY_SET', `${label}.outputs_lost: outputs_lost is already recorded on version ${n}; preserve the existing loss declaration`);
    }
    const inspected = inspectPreInterviewOutputs(dir, current, label);
    const malformed = inspected.malformed[0];
    if (malformed !== undefined) {
      refuse(malformed.code, malformed.message);
    }
    if (inspected.readable.length > 0) {
      refuse('OUTPUTS_LOST_HAS_OUTPUTS', `${label}.outputs: version ${n} has readable frozen output(s) (${inspected.readable.join(', ')}); keep surviving outputs instead of declaring outputs_lost`);
    }
    const other = inspected.otherRefusals[0];
    if (other !== undefined) {
      refuse(other.code, other.message);
    }
    const next = structuredClone(project);
    const target = asArray(next.versions).find((v): v is JsonObject => isObject(v) && v.n === n)!;
    const loss: JsonObject = {
      note,
      source,
      recorded: inspected.bindings.map((b) => ({ path: b.path, sha256: b.sha256 })),
    };
    target.outputs = [];
    target.outputs_lost = loss;
    if (!validOutputsLoss(target, dir)) {
      refuse('PRE_INTERVIEW_OUTPUTS_LOST_MALFORMED', `${label}.outputs_lost: ${OUTPUTS_LOST_MALFORMED_MESSAGE}`);
    }
    save(file, dir, project, next, now);
    return {
      stdout: json ? JSON.stringify(loss, null, 2) : `version outputs-lost: recorded ${label}.outputs_lost (${source}); stage unchanged`,
      exit: 0,
    };
  }
  if (note.trim() === '' || source.trim() === '') {
    refuse('CONFIG_LOST_EMPTY', `${label}.config_lost: --note and --source must be non-empty strings; explain the config loss and name its source record`);
  }
  const current = asArray(project.versions).find((v): v is JsonObject => isObject(v) && v.n === n);
  if (current === undefined) {
    refuse('CONFIG_LOST_VERSION_UNKNOWN', `${label}: versions[] has no version ${n}; name an existing pre-interview version`);
  }
  if (current.pre_interview !== true) {
    refuse('CONFIG_LOST_NOT_PRE_INTERVIEW', `${label}.pre_interview: version ${n} is not pre_interview: true; record config_lost only on a migrated pre-interview version, or keep provenance.config on a create-built version`);
  }
  if (Object.hasOwn(current, 'config_lost')) {
    refuse('CONFIG_LOST_ALREADY_SET', `${label}.config_lost: config_lost is already recorded on version ${n}; preserve the existing loss declaration`);
  }
  if (isObject(current.provenance) && current.provenance.config !== null && current.provenance.config !== undefined) {
    refuse('CONFIG_LOST_HAS_CONFIG', `${label}.provenance.config: version ${n} has provenance.config; keep the surviving build config instead of declaring config_lost`);
  }
  const next = structuredClone(project);
  const target = asArray(next.versions).find((v): v is JsonObject => isObject(v) && v.n === n)!;
  const loss: JsonObject = { note, source };
  target.config_lost = loss;
  if (!validConfigLoss(target)) {
    refuse('PRE_INTERVIEW_CONFIG_LOST_MALFORMED', `${label}.config_lost: record { note, source } with nonempty strings only on a pre-interview version without provenance.config; restore a surviving config instead`);
  }
  save(file, dir, project, next, now);
  return {
    stdout: json ? JSON.stringify(loss, null, 2) : `version config-lost: recorded ${label}.config_lost (${source}); stage unchanged`,
    exit: 0,
  };
}
