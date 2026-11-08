#!/usr/bin/env bun
import { partsReviewCommand } from './parts-review.ts';
import { INTAKE_HELP, intakeCommand, intakeReportCommand } from './intake.ts';
import { DIRECTION_HELP, directionCommand } from './direction-writers.ts';
import { SCENE_HELP, sceneCommand } from './scene-writers.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CHOICE_HELP, interviewOptionsCommand, interviewAnswerCommand, interviewDecisionCommand } from './choice-writers.ts';
import { CORRECTION_HELP, correctionCommand } from './correction-writers.ts';
import { DRAFT_RIG_HELP, draftRigCommand } from './drafts.ts';
import { STRUCTURE_SNAPSHOT_HELP, structureSnapshotCommand } from './structure-snapshot.ts';
import { collectionInitCommand } from './collection.ts';
import { describeInit, initProject } from './init.ts';
import { INTERVIEW_HELP, interviewCommand, type CommandResult } from './interview.ts';
import { COLLECTION_HELP, collectionCommand } from './pins-check.ts';
import { Refusal, formatRefusal, refuse, USAGE_EXIT } from './refusal.ts';
import { REVIEW_HELP, reviewCommand } from './feedback.ts';
import { PROGRESS_HELP, advanceCommand, stepStatusCommand } from './progress-writers.ts';
import { REOPEN_HELP, reopenCommand } from './reopen.ts';
import { PAUSE_HELP, pauseCommand, resumeCommand } from './pause.ts';
import { AMEND_HELP, amendCommand } from './amend.ts';
import { SIGNOFF_HELP, signoffCommand } from './signoff.ts';
import { PLAN_HELP, planCommand } from './plan-writers.ts';
import { HANDOFF_HELP, handoffCommand } from './review.ts';
import { REVIEW_PACKAGE_HELP, reviewPackageCommand } from './review-package.ts';
import { RIG_VERSION_HELP, rigVersionCommand } from './rig-version.ts';
import { DERIVED_HELP, derivedCommand } from './prepared-inputs.ts';
import { SPLIT_CAPTIONS_HELP, splitCaptionsCommand } from './split-captions.ts';
import { VERSION_HELP, versionCommand } from './config-lost.ts';

// Input registration is kept in its own CLI block.
import { INPUT_HELP, inputCommand } from './inputs.ts';

const INPUT_CLI = `  rig-create input add <path> [<dir>] --origin <words>
                                                    register immutable raw source bytes
`;

const HELP = `rig-create — create and run a rig project

Usage:
  rig-create job open [<dir>] --reviewer <id> --role owner|delegate
  rig-create job reconcile|close [<dir>]
${INPUT_CLI}  rig-create init <dir> [--no-install]              create a project folder, its repository and pinned packages
  rig-create init --collection <dir> [--no-install] create a collection folder, its repository and pinned packages
  rig-create init --member <collection dir> <name>  create members/<name>/ in a collection, inheriting its answers
  rig-create collection answer|pin|--check [<dir>]         pin member builds (--member name=version); refuse stale pins
  rig-create scene write --rig <R> --background <path> --citations-file <file> --by <human> [<dir>]
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
  rig-create plan add|revise|remove <id> --by <drafter> [<project dir>]
                                                    draft steps and retain replaced definitions
  rig-create advance <stage> --by <who> [--verbatim-file <file>] [<project dir>]
                                                    move to the next stage authorized by a live signoff
  rig-create step-status <step> <status> --by <who> [<project dir>]
                                                    record an audited forward step status
  rig-create reopen <stage> --by <who> [--verbatim-file <file>] [--source <text>] [<project dir>]
                                                    record a human backward move without deleting history
  rig-create pause --by <who> [--verbatim-file <file>] [<project dir>]
                                                    stop work on a paused sign-off and record the stage it left
  rig-create resume <stage> --by <who> [--verbatim-file <file>] [<project dir>]
                                                    return a paused project to the stage it was paused from
  rig-create amend <stage> --kind <kind> --target <id> --change <file> --by <who> [<project dir>]
                                                    record a forward amendment and name lapsed approvals
  rig-create draft-rig <id> [<dir>] --config <path> --from <dir> [--parts <dir>]
                                                    record labelled draft artifacts without building or promoting
  rig-create parts-review [<dir>] --from-review <actId> [--json]
                                                    retain the semantic parts verdict as an independent write
  rig-create structure-snapshot [<dir>] --draft <id> --verdict <path> --out <path>
                                                    write the parts-review structure snapshot from the approved draft
  rig-create review-package <n> [<dir>] --config <path> --from <build out dir>
                                                    copy producer inputs and record the review open command
  rig-create rig-version <n> [<dir>] --parts <dir> --rig <dir> --build <dir> --idle <dir> …
                                                    register frozen producer output with declared source bindings
  rig-create split-captions [<project dir|project.json>] [--config <file>]
                                                    generate caption data from the config and split.parts
  rig-create version config-lost <n> --note <text> --source <text> [<dir>]
                                                    record a pre-interview version's lost build config
  rig-create --help                                 show this help
  rig-create --version                              show the version

init:
  <dir>          an empty or missing folder; a non-empty one is refused
  --no-install   do not run bun install (offline, tests); run it yourself afterwards

${INPUT_HELP}

${INTERVIEW_HELP}

${CHOICE_HELP}

${INTAKE_HELP}

${HANDOFF_HELP}
${COLLECTION_HELP}

${REVIEW_HELP}

${SIGNOFF_HELP}

${PLAN_HELP}

${PROGRESS_HELP}

${REOPEN_HELP}

${PAUSE_HELP}

${AMEND_HELP}

${DRAFT_RIG_HELP}

${STRUCTURE_SNAPSHOT_HELP}

${CORRECTION_HELP}

${SCENE_HELP}

${DIRECTION_HELP}

${DERIVED_HELP}

${REVIEW_PACKAGE_HELP}

${RIG_VERSION_HELP}

${SPLIT_CAPTIONS_HELP}

${VERSION_HELP}
`;

/**
 * A command prints what it returns; a string exits 0, a CommandResult chooses its exit code (a report with refusals exits 1).
 * `now` is the instant the command runs at, which every written date and every "not in the future" check uses.
 */
type Command = (args: string[], now: number) => string | CommandResult;

function version(): string {
  const pkg: unknown = JSON.parse(readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8'));
  if (pkg !== null && typeof pkg === 'object' && 'version' in pkg && typeof pkg.version === 'string') {
    return pkg.version;
  }
  return 'unknown';
}

function initCommand(args: string[], now: number): string {
  if (args.includes('--collection') || args.includes('--member')) {
    const made = collectionInitCommand(args, now);
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
  const result = initProject(positional[0] as string, { install, now });
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
  input: inputCommand,
  init: initCommand,
  intake: intakeCommand,
  'intake-report': intakeReportCommand,
  interview: interviewCommand,
  'interview-options': interviewOptionsCommand,
  'interview-answer': interviewAnswerCommand,
  'interview-decision': interviewDecisionCommand,
  handoff: handoffCommand,
  'review-package': reviewPackageCommand,
  'rig-version': rigVersionCommand,
  collection: collectionCommand,
  review: reviewCommand,
  signoff: signoffCommand,
  plan: planCommand,
  reopen: reopenCommand,
  pause: pauseCommand,
  resume: resumeCommand,
  advance: advanceCommand,
  'step-status': stepStatusCommand,
  amend: amendCommand,
  'draft-rig': draftRigCommand,
  'parts-review': partsReviewCommand,
  'structure-snapshot': structureSnapshotCommand,
  correction: correctionCommand,
  scene: sceneCommand,
  direction: directionCommand,

  derived: derivedCommand,
  'split-captions': splitCaptionsCommand,
  version: versionCommand,
};

/**
 * Run one command at `now` (ms since the epoch). The process entry below is the
 * only place create reads the wall clock; tests and scripts pass a fixed instant
 * (README.md "The clock").
 */
export function main(argv: string[], now: number): number {
  const [first, ...rest] = argv;
  try {
    if (first === 'job') {
      const [action, ...args] = rest;
      if (!['open', 'reconcile', 'close'].includes(action ?? '')) refuse('JOB_BINDING_INVALID', 'project.json: use job open|reconcile|close', USAGE_EXIT);
      const positional: string[] = [];
      const options: Record<string, string> = {};
      for (let index = 0; index < args.length; index++) {
        const arg = args[index]!;
        if (action === 'open' && ['--reviewer', '--role'].includes(arg)) {
          const value = args[++index];
          if (!value || value.startsWith('-') || options[arg]) refuse('JOB_BINDING_INVALID', 'project.json: job open requires one value for each reviewer option', USAGE_EXIT);
          options[arg] = value;
        } else if (arg.startsWith('-')) refuse('JOB_BINDING_INVALID', 'project.json: unsupported job option; see help', USAGE_EXIT);
        else positional.push(arg);
      }
      if (positional.length > 1 || action === 'open' && (!options['--reviewer'] || !['owner', 'delegate'].includes(options['--role'] ?? ''))) {
        refuse('JOB_BINDING_INVALID', 'project.json: job open needs --reviewer <id> --role owner|delegate and one optional directory', USAGE_EXIT);
      }
      const child = Bun.spawnSync([process.execPath, join(import.meta.dir, 'job-runtime.ts'), action!], {
        stdin: Buffer.from(JSON.stringify({ root: positional[0] ?? process.cwd(), reviewer: options['--reviewer'], role: options['--role'], now })),
        stdout: 'inherit', stderr: 'inherit',
      });
      return child.exitCode;
    }
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
    const result = command(rest, now);
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
  process.exitCode = main(process.argv.slice(2), Date.now());
}
