/**
 * `rig-create interview --check [<project dir>] [--json]`: the command around
 * src/check.ts. Prints every finding, exits 0 when clean, 1 when anything is
 * refused, 2 on a usage error. `--json` prints the report as one JSON object
 * for agents and later checks (#6, #8, #9) to read.
 */
import { checkProject, formatReport } from './check.ts';
import { refuse, USAGE_EXIT } from './refusal.ts';

export interface CommandResult {
  stdout: string;
  exit: number;
}

export const INTERVIEW_HELP = `interview:
  --check          check project.json: every waypoint has a guide or a delegation, every plan step rests on an answer,
                   every stage moved has its sign-off, every @rig-c/parts section has a place (docs/CHECKS.md)
  <project dir>    the project folder (default: the current directory)
  --json           print the report as JSON (ok, stage, parts, derived, refusals[], warnings[])`;

export function interviewCommand(args: string[]): CommandResult {
  let check = false;
  let json = false;
  const positional: string[] = [];
  for (const arg of args) {
    if (arg === '--check') check = true;
    else if (arg === '--json') json = true;
    else if (arg.startsWith('-')) refuse('UNKNOWN_OPTION', `interview does not take ${arg}`, USAGE_EXIT);
    else positional.push(arg);
  }
  if (!check) refuse('INTERVIEW_MODE_MISSING', 'interview needs --check: rig-create interview --check [<project dir>]', USAGE_EXIT);
  if (positional.length > 1) {
    refuse('INTERVIEW_TOO_MANY_ARGUMENTS', `interview --check takes one folder, got ${positional.join(' ')}`, USAGE_EXIT);
  }
  const report = checkProject(positional[0] ?? process.cwd());
  return {
    stdout: json ? JSON.stringify(report, null, 2) : formatReport(report),
    exit: report.ok ? 0 : 1,
  };
}
