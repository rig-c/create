#!/usr/bin/env bun
import { INTAKE_HELP, intakeCommand, intakeReportCommand } from './intake.ts';
import { DIRECTION_HELP, directionCommand } from './direction-writers.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CHOICE_HELP, interviewOptionsCommand, interviewAnswerCommand, interviewDecisionCommand } from './choice-writers.ts';
import { CORRECTION_HELP, correctionCommand } from './correction-writers.ts';
import { DRAFT_RIG_HELP, draftRigCommand } from './drafts.ts';
import { collectionInitCommand } from './collection.ts';
import { describeInit, initProject } from './init.ts';
import { INTERVIEW_HELP, interviewCommand, type CommandResult } from './interview.ts';
import { COLLECTION_HELP, collectionCommand } from './pins-check.ts';
import { Refusal, formatRefusal, refuse, USAGE_EXIT } from './refusal.ts';
import { REVIEW_HELP, reviewCommand } from './feedback.ts';
import { REOPEN_HELP, reopenCommand } from './reopen.ts';
import { SIGNOFF_HELP, signoffCommand } from './signoff.ts';
import { HANDOFF_HELP, handoffCommand } from './review.ts';
import { REVIEW_PACKAGE_HELP, reviewPackageCommand } from './review-package.ts';
import { DERIVED_HELP, derivedCommand } from './prepared-inputs.ts';
import { SPLIT_CAPTIONS_HELP, splitCaptionsCommand } from './split-captions.ts';

const HELP = `rig-create — create and run a rig project

Usage:
  rig-create init <dir> [--no-install]              create a project folder, its repository and pinned packages
  rig-create init --collection <dir> [--no-install] create a collection folder, its repository and pinned packages
  rig-create init --member <collection dir> <name>  create members/<name>/ in a collection, inheriting its answers
  rig-create collection pin|--check [<dir>]         pin member builds (--member name=version); refuse stale pins
  rig-create derived add [<dir>] --source <file> --file <file> --operation <text>
                                                    record external preparation and both file hashes
  rig-create interview --check [<project dir>] [--json]
                                                    refuse by name every hole the interview and plan still have
  rig-create handoff [<project dir>] [--rig <n>] [--json]
                                                    name the accepted rig version post work runs on, or refuse
  rig-create review <version> --verdict <v> --by <who> --review <r> --verbatim <s> --source <s> [--item <id>[:<answer_was>]]... [<project dir>]
                                                    record what a person said about a shown version, word for word
  rig-create signoff <stage> --by <who> [--steps <id,id,...>] [--verbatim-file <file>] [<project dir>]
                                                    record a signature without moving the stage
  rig-create reopen <stage> --by <who> [--verbatim-file <file>] [--source <text>] [<project dir>]
                                                    record a human backward move without deleting history
  rig-create draft-rig <id> [<dir>] --config <path> --from <dir> [--parts <dir>]
                                                    record labelled draft artifacts without building or promoting
  rig-create review-package <n> [<dir>] --config <path> --from <build out dir>
                                                    copy producer inputs and record the review open command
  rig-create split-captions [<project dir|project.json>] [--config <file>]
                                                    generate caption data from the config and split.parts
  rig-create --help                                 show this help
  rig-create --version                              show the version

init:
  <dir>          an empty or missing folder; a non-empty one is refused
  --no-install   do not run bun install (offline, tests); run it yourself afterwards

${INTERVIEW_HELP}

${CHOICE_HELP}

${INTAKE_HELP}

${HANDOFF_HELP}
${COLLECTION_HELP}

${REVIEW_HELP}

${SIGNOFF_HELP}

${REOPEN_HELP}

${DRAFT_RIG_HELP}

${CORRECTION_HELP}

${DIRECTION_HELP}

${DERIVED_HELP}

${REVIEW_PACKAGE_HELP}

${SPLIT_CAPTIONS_HELP}
`;

/** A command prints what it returns; a string exits 0, a CommandResult chooses its exit code (a report with refusals exits 1). */
type Command = (args: string[]) => string | CommandResult;

function version(): string {
  const pkg: unknown = JSON.parse(readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8'));
  if (pkg !== null && typeof pkg === 'object' && 'version' in pkg && typeof pkg.version === 'string') {
    return pkg.version;
  }
  return 'unknown';
}

function initCommand(args: string[]): string {
  if (args.includes('--collection') || args.includes('--member')) {
    const made = collectionInitCommand(args);
    if (made.installError !== null) {
      process.stdout.write(`${made.stdout}\n`);
      refuse('INIT_INSTALL_FAILED', `bun install failed in ${made.dir}; the collection and its first commit are in place. Run bun install there, then commit bun.lock.\n${made.installError}`);
    }
    return made.stdout;
  }
  let install = true;
  const positional: string[] = [];
  for (const arg of args) {
    if (arg === '--no-install') install = false;
    else if (arg.startsWith('-')) refuse('UNKNOWN_OPTION', `init does not take ${arg}`, USAGE_EXIT);
    else positional.push(arg);
  }
  if (positional.length === 0) refuse('INIT_DIR_MISSING', 'init needs a folder: rig-create init <dir>', USAGE_EXIT);
  if (positional.length > 1) {
    refuse('INIT_TOO_MANY_ARGUMENTS', `init takes one folder, got ${positional.join(' ')}`, USAGE_EXIT);
  }
  const result = initProject(positional[0] as string, { install });
  if (result.installError !== null) {
    process.stdout.write(`${describeInit(result)}\n`);
    refuse(
      'INIT_INSTALL_FAILED',
      `bun install failed in ${result.dir}; the project and its first commit are in place. Run bun install there, then commit bun.lock.\n${result.installError}`,
    );
  }
  return describeInit(result);
}

/** Subcommands by name. */
const COMMANDS: Record<string, Command> = {
  init: initCommand,
  intake: intakeCommand,
  'intake-report': intakeReportCommand,
  interview: interviewCommand,
  'interview-options': interviewOptionsCommand,
  'interview-answer': interviewAnswerCommand,
  'interview-decision': interviewDecisionCommand,
  handoff: handoffCommand,
  'review-package': reviewPackageCommand,
  collection: collectionCommand,
  review: reviewCommand,
  signoff: signoffCommand,
  reopen: reopenCommand,
  'draft-rig': draftRigCommand,
  correction: correctionCommand,
  direction: directionCommand,

  derived: derivedCommand,
  'split-captions': splitCaptionsCommand,
};

export function main(argv: string[]): number {
  const [first, ...rest] = argv;
  try {
    if (first === undefined || first === '--help' || first === '-h' || first === 'help') {
      process.stdout.write(HELP);
      return 0;
    }
    if (first === '--version' || first === '-v') {
      process.stdout.write(`${version()}\n`);
      return 0;
    }
    const command = COMMANDS[first];
    if (command === undefined) {
      refuse('UNKNOWN_COMMAND', `no command named ${first} (see rig-create --help)`, USAGE_EXIT);
    }
    const result = command(rest);
    if (typeof result === 'string') {
      process.stdout.write(`${result}\n`);
      return 0;
    }
    process.stdout.write(`${result.stdout}\n`);
    return result.exit;
  } catch (error) {
    if (error instanceof Refusal) {
      process.stderr.write(`${formatRefusal(error)}\n`);
      return error.exitCode;
    }
    throw error;
  }
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
