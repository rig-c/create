#!/usr/bin/env bun
import { OWNER_CHAT_FLAGS } from './owner-chat.ts';
import { packagesCommand } from './packages-upgrade.ts';
import { republishCommand } from './republish.ts';
import { DIFF_CLASSES_HELP, diffClassesCommand } from './diff-classes.ts';
import { CHECKPOINT_EVIDENCE_HELP, checkpointEvidenceCommand, checkpointTableCommand } from './checkpoint-evidence-writer.ts';
import { partsReviewCommand } from './parts-review.ts';
import { INTAKE_HELP, intakeCommand, intakeReportCommand } from './intake.ts';
import { DIRECTION_HELP, directionCommand } from './direction-writers.ts';
import { SCENE_HELP, sceneCommand } from './scene-writers.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CHOICE_HELP, interviewOptionsCommand, interviewAnswerCommand, interviewDecisionCommand } from './choice-writers.ts';
import { CORRECTION_HELP, correctionCommand } from './correction-writers.ts';
import { DRAFT_RIG_HELP, draftRigCommand } from './drafts.ts';
import { LEDGER_HELP, ledgerCommand } from './fix-ledger.ts';
import { RESTART_HELP, restartCommand } from './restart.ts';
import { STRUCTURE_SNAPSHOT_HELP, structureSnapshotCommand } from './structure-snapshot.ts';
import { collectionInitCommand } from './collection.ts';
import { COLLECTION_BINDING_HELP, collectionBindingCommand } from './collection-binding.ts';
import { describeInit, initProject } from './init.ts';
import { INTERVIEW_HELP, interviewCommand, type CommandResult } from './interview.ts';
import { COLLECTION_HELP, collectionCommand } from './pins-check.ts';
import { Refusal, formatRefusal, refuse, USAGE_EXIT } from './refusal.ts';
import { REVIEW_HELP, reviewCommand } from './feedback.ts';
import { PROGRESS_HELP, advanceCommand, stepStatusCommand } from './progress-writers.ts';
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
import { jobRuntimeCommand, takePublishedLines } from './job-writer.ts';
import { NEXT_HELP, nextCommand } from './next.ts';
import { parseOwnerLanguage } from './owner-language.ts';
import { ownerLanguageCommand } from './owner-language-writer.ts';

// Input registration is kept in its own CLI block.
import { INPUT_HELP, inputCommand } from './inputs.ts';

const INPUT_CLI = `  rig-create input add <path> [<dir>] --origin <words>
                                                    register immutable raw source bytes
`;

export const BOUND_WRITE_HELP = 'Keep the job host up across bound writes; if it stopped, run job open again, then job reconcile.';

const HELP = `rig-create — create and run a rig project

Usage:
  rig-create republish <rig> [<dir>] --reason <words>
  rig-create job open [<dir>] --reviewer <id> --role owner|delegate [--draft <id> | --rig <n> | --question <question> | --plan]
  rig-create job acts [<dir>] [--json] [--wait [--timeout-ms N]]
                                              list finalized acts and their ingest commands
                                              wait 1–600000 ms (default 600000), timeout exit 3
  rig-create job reconcile [<dir>]
  rig-create job withdraw-act <actId> [<dir>] --by <owner> --owner-chat <file> --said-at <ISO> --relayed-by <operator>
  rig-create job close [<dir>] [--retire-refused]
  rig-create job close [<dir>] --discard-acts <reason> --by agent
  rig-create job close [<dir>] --discard-acts --by <owner> --owner-chat <file> --said-at <ISO> --relayed-by <operator>
${INPUT_CLI}  rig-create init <dir> [--no-install]              create a project folder, its repository and pinned packages
  rig-create owner-language set <tag> [<dir>]       declare the owner's language before live publication
  rig-create init <dir> --painting <file> --origin <words> [--projects-root <dir>] [--same-artwork-reason <file>]
                                                    also register the painting; refuse a second project for one artwork
  rig-create restart [<dir>] --by <human> --owner-chat <file> --said-at <ISO> --relayed-by <operator>
                                                    restart the record at v1, keeping inputs and the fix ledger
  rig-create ledger add|retire <id> [<dir>] --by <who> …
                                                    record or retire an owner fix every version inherits
  rig-create init --collection <dir> [--no-install] create a collection folder, its repository and pinned packages
  rig-create init --member <collection dir> <name> [--owner-language <tag>]
                                                    create members/<name>/ in a collection, inheriting its answers
  rig-create collection answer|pin|--check [<dir>]         pin member builds (--member name=version); refuse stale pins
  rig-create collection-binding [<member dir>] [--out <path>]
                                                    write and bind the member's collection interview snapshot
  rig-create scene write --rig <R> --background <path> --citations-file <file> [<dir>]
  rig-create derived add [<dir>] --source <file> --file <file> --operation <text>
                                                    record external preparation and both file hashes
  rig-create interview --check [<project dir>] [--json]
                                                    refuse by name every hole the interview and plan still have
  rig-create next [<project dir>] [--json]          derive the next moves and whose they are from project.json
  rig-create handoff [<project dir>] [--rig <n>] [--json]
                                                    name the accepted rig version post work runs on, or refuse
  rig-create review <version> --verdict <v> --by <who> --review <r> --verbatim <s> --source <s> [--item <id>[:<answer_was>]]... [<project dir>]
                                                    record what a person said about a shown version, word for word
  rig-create diff-classes [<dir>] --diff-report <path> [--triage-file <file> | --component '<id>=<status>:<why>'] [--by agent]
                                                    read measured component classes or record agent classification
  rig-create signoff <stage> --from-review <actId> [<project dir>]
  rig-create signoff <stage> --by <who> [--steps <id,id,...>] [--verbatim-file <file>] [<project dir>]
                                                    record a signature without moving the stage
  rig-create plan add|revise|remove <id> --by <drafter> [<project dir>]
                                                    draft steps and retain replaced definitions
  rig-create advance <stage> [<project dir>]
                                                    move to the next stage authorized by a live signoff
  rig-create step-status <step> <status> --by <who> [<project dir>] [--note-file <path>]
                                                    record an audited forward step status
  rig-create pause --by <who> [--verbatim-file <file>] [<project dir>]
                                                    stop work on a paused sign-off and record the stage it left
  rig-create resume <stage> --by <who> [--verbatim-file <file>] [<project dir>]
                                                    return a paused project to the stage it was paused from
  rig-create amend <stage> --kind <kind> --target <id> --change <file> --by <who> [<project dir>]
                                                    record a forward amendment and name lapsed approvals
  rig-create draft-rig <id> [<dir>] --config <path> --from <dir> [--parts <dir>]
                       [--reuse <draft-id> [--reuse-record <sha256>]]
                                                    record labelled draft artifacts without building or promoting
  rig-create parts-review [<dir>] --from-review <actId> [--json]
                                                    retain the parts verdict; approval also signs parts-review
  rig-create structure-snapshot [<dir>] --draft <id> [--out <path>]
                                                    prepare the parts-review structure snapshot before the verdict
  rig-create review-package <n> [<dir>] --config <path> --from <build out dir>
                                                    copy producer inputs and record the review open command
  rig-create rig-version <n> [<dir>] --parts <dir> --rig <dir> --build <dir> --idle <dir> …
                                                    register frozen producer output with declared source bindings
  rig-create split-captions [<project dir|project.json>] [--config <file>]
                                                    generate caption data from the config and split.parts
  rig-create version config-lost <n> --note <text> --source <text> [<dir>]
                                                    record a pre-interview version's lost build config
  rig-create version outputs-lost <n> --note <text> --source <text> [<dir>]
                                                    record a pre-interview version's lost frozen outputs
  rig-create packages upgrade [<dir>] --by <operator>  update release pins with checked history
  rig-create --help                                 show this help
  rig-create --version                              show the version

job open:
  --rig <n>      selects a registered rig OR post version; the flag name is shared
  ${BOUND_WRITE_HELP}

job reconcile:
  ${BOUND_WRITE_HELP}

bound writers:
  ${BOUND_WRITE_HELP}
  A stopped host leaves a committed publication pending (JOB_PUBLISH_PENDING) and refuses later bound writes until job reconcile runs against the live host.

init:
  <dir>          an empty or missing folder; a non-empty one is refused
  --no-install   do not run bun install (offline, tests); run it yourself afterwards
  --owner-language <tag>
                 record the owner's declared language (e.g. ko or en-US)
  --painting <file> --origin <words>
                 copy the painting into inputs/, register it and declare project.painting; refused (INIT_ARTWORK_EXISTS) when a
                 project directly under --projects-root (default: the parent folder) binds the same sha256.
                 Continue there as a new version; restart keeps its correction ledger.
                 A new project is for different artwork or a different rig kind only.
  --same-artwork-reason <file>
                 record why this artwork needs a second project (a different rig kind)

${RESTART_HELP}

${LEDGER_HELP}

${INPUT_HELP}

${INTERVIEW_HELP}

${NEXT_HELP}

${CHOICE_HELP}

${INTAKE_HELP}

${HANDOFF_HELP}
${COLLECTION_HELP}

${COLLECTION_BINDING_HELP}

${REVIEW_HELP}

${SIGNOFF_HELP}

${DIFF_CLASSES_HELP}

${PLAN_HELP}

${CHECKPOINT_EVIDENCE_HELP}

${PROGRESS_HELP}

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
  let ownerLanguage: string | undefined;
  const positional: string[] = [];
  const artwork: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--no-install') install = false;
    else if (arg === '--owner-language') {
      if (ownerLanguage !== undefined) refuse('OWNER_LANGUAGE_USAGE', 'project.json.owner.language: pass --owner-language once', USAGE_EXIT);
      ownerLanguage = parseOwnerLanguage(args[++i]);
    }
    else if (['--painting', '--origin', '--projects-root', '--same-artwork-reason'].includes(arg)) {
      const value = args[++i];
      if (value === undefined || value.startsWith('--') || value.trim() === '' || artwork[arg] !== undefined) refuse('INIT_ARTWORK_USAGE', `init: ${arg} needs one value`, USAGE_EXIT);
      artwork[arg] = value;
    } else if (arg.startsWith('-')) refuse('UNKNOWN_OPTION', `init does not take ${arg}`, USAGE_EXIT);
    else positional.push(arg);
  }
  if (Object.keys(artwork).length > 0 && (artwork['--painting'] === undefined || artwork['--origin'] === undefined)) {
    refuse('INIT_ARTWORK_USAGE', 'init: --origin, --projects-root and --same-artwork-reason go with --painting <file> --origin <words>', USAGE_EXIT);
  }
  if (positional.length === 0) refuse('INIT_DIR_MISSING', 'init needs a folder: rig-create init <dir>', USAGE_EXIT);
  if (positional.length > 1) {
    refuse('INIT_TOO_MANY_ARGUMENTS', `init takes one folder, got ${positional.join(' ')}`, USAGE_EXIT);
  }
  const painting = artwork['--painting'] === undefined ? undefined : {
    file: artwork['--painting'], origin: artwork['--origin']!, projectsRoot: artwork['--projects-root'], sameArtworkReason: artwork['--same-artwork-reason'],
  };
  const result = initProject(positional[0] as string, { install, now,
    ...(ownerLanguage === undefined ? {} : { ownerLanguage }), ...(painting === undefined ? {} : { painting }) });
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
  packages: packagesCommand,
  republish: republishCommand,
  input: inputCommand,
  init: initCommand,
  'owner-language': ownerLanguageCommand,
  intake: intakeCommand,
  'intake-report': intakeReportCommand,
  interview: interviewCommand,
  next: nextCommand,
  'interview-options': interviewOptionsCommand,
  'interview-answer': interviewAnswerCommand,
  'interview-decision': interviewDecisionCommand,
  handoff: handoffCommand,
  'review-package': reviewPackageCommand,
  'rig-version': rigVersionCommand,
  collection: collectionCommand,
  'collection-binding': collectionBindingCommand,
  review: reviewCommand,
  signoff: signoffCommand,
  'diff-classes': diffClassesCommand,
  plan: planCommand,
  'checkpoint-evidence': checkpointEvidenceCommand,
  'checkpoint-table': checkpointTableCommand,
  pause: pauseCommand,
  resume: resumeCommand,
  advance: advanceCommand,
  'step-status': stepStatusCommand,
  amend: amendCommand,
  'draft-rig': draftRigCommand,
  ledger: ledgerCommand,
  restart: restartCommand,
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
      if (!['open', 'acts', 'reconcile', 'withdraw-act', 'close'].includes(action ?? '')) refuse('JOB_BINDING_INVALID', 'project.json: use job open|acts|reconcile|withdraw-act|close', USAGE_EXIT);
      const positional: string[] = [];
      const options: Record<string, string> = {};
      for (let index = 0; index < args.length; index++) {
        const arg = args[index]!;
        if (action === 'open' && ['--reviewer', '--role', '--draft', '--rig', '--question'].includes(arg)) {
          const value = args[++index];
          if (!value || value.startsWith('-') || options[arg]) refuse('JOB_BINDING_INVALID', 'project.json: job open requires one value for each reviewer option', USAGE_EXIT);
          options[arg] = value;
        } else if (action === 'open' && arg === '--plan' && !options[arg]) options[arg] = 'true';
        else if (action === 'close' && arg === '--retire-refused' && !options[arg]) options[arg] = 'true';
        else if ((action === 'close' || action === 'withdraw-act') && ['--by', ...OWNER_CHAT_FLAGS].includes(arg) && options[arg] === undefined) {
          const value = args[++index];
          if (!value || value.startsWith('-') || !value.trim()) refuse('JOB_BINDING_INVALID', `project.json.review_acts: ${arg} requires a value; see job ${action} help`, USAGE_EXIT);
          options[arg] = value;
        }
        else if (action === 'close' && arg === '--discard-acts' && options[arg] === undefined) {
          const next = args[index + 1];
          if (next !== undefined && !next.startsWith('-')) {
            if (!next.trim()) refuse('JOB_BINDING_INVALID', 'project.json: job close --discard-acts requires a non-empty reason', USAGE_EXIT);
            options[arg] = next;
            index++;
          } else {
            options[arg] = '';
          }
        } else if (action === 'close' && arg === '--reason' && options[arg] === undefined) {
          const value = args[++index];
          if (!value || value.startsWith('-') || !value.trim()) refuse('JOB_BINDING_INVALID', 'project.json: job close --discard-acts requires a non-empty reason', USAGE_EXIT);
          options[arg] = value;
        }
        else if (action === 'acts' && ['--json', '--wait'].includes(arg) && !options[arg]) options[arg] = 'true';
        else if (action === 'acts' && arg === '--timeout-ms' && options[arg] === undefined) {
          const value = args[++index] ?? '';
          if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 600_000) {
            refuse('JOB_BINDING_INVALID', 'project.json: job acts --timeout-ms requires an integer from 1 to 600000', USAGE_EXIT);
          }
          options[arg] = value;
        }
        else if (arg.startsWith('-')) refuse('JOB_BINDING_INVALID', 'project.json: unsupported job option; see help', USAGE_EXIT);
        else positional.push(arg);
      }
      if (options['--timeout-ms'] !== undefined && !options['--wait']) {
        refuse('JOB_BINDING_INVALID', 'project.json: --timeout-ms requires job acts --wait', USAGE_EXIT);
      }
      const timeoutMs = options['--wait'] ? Number(options['--timeout-ms'] ?? '600000') : undefined;
      if (action === 'withdraw-act') {
        if (positional.length === 0 || positional.length > 2 || !positional[0]!.trim()) {
          refuse('JOB_BINDING_INVALID', 'project.json.review_acts: job withdraw-act needs <actId>, one optional project directory and --by <owner> --owner-chat <file> --said-at <ISO> --relayed-by <operator>', USAGE_EXIT);
        }
        if (!options['--by'] || OWNER_CHAT_FLAGS.some(flag => !options[flag])) {
          refuse('OWNER_CHAT_INVALID', 'project.json.review_acts: job withdraw-act requires --by <owner> --owner-chat <file> --said-at <ISO> --relayed-by <operator>', USAGE_EXIT);
        }
      }
      if (options['--reason'] !== undefined) {
        if (options['--discard-acts'] !== '') refuse('JOB_BINDING_INVALID', 'project.json: --reason goes with job close --discard-acts', USAGE_EXIT);
        options['--discard-acts'] = options['--reason'];
      }
      if (options['--discard-acts'] === '' && !OWNER_CHAT_FLAGS.some(flag => options[flag] !== undefined)) {
        refuse('JOB_BINDING_INVALID', 'project.json.review_acts: job close --discard-acts requires a reason or relayed owner words', USAGE_EXIT);
      }
      if (action !== 'withdraw-act' && options['--discard-acts'] === undefined && ['--by', ...OWNER_CHAT_FLAGS].some(flag => options[flag] !== undefined)) {
        refuse('JOB_BINDING_INVALID', 'project.json.review_acts: discard attribution flags require job close --discard-acts', USAGE_EXIT);
      }
      if ((action !== 'withdraw-act' && positional.length > 1) || action === 'open' && (!options['--reviewer'] || !['owner', 'delegate'].includes(options['--role'] ?? ''))) {
        refuse('JOB_BINDING_INVALID', 'project.json: job open needs --reviewer <id> --role owner|delegate and one optional directory', USAGE_EXIT);
      }
      if (['--draft', '--rig', '--question', '--plan'].filter(flag => options[flag] !== undefined).length > 1) {
        refuse('JOB_BINDING_INVALID', 'project.json: job open takes one of --draft, --rig, --question or --plan; choose one recorded result', USAGE_EXIT);
      }
      const rootArg = action === 'withdraw-act' ? (positional[1] ?? process.cwd()) : (positional[0] ?? process.cwd());
      const stdin = Buffer.from(JSON.stringify({ root: rootArg, actId: action === 'withdraw-act' ? positional[0] : undefined, reviewer: options['--reviewer'], role: options['--role'], draft: options['--draft'], rig: options['--rig'], question: options['--question'], plan: options['--plan'] === 'true', json: options['--json'] === 'true', timeoutMs, retireRefused: options['--retire-refused'] === 'true', discardActs: action === 'withdraw-act' || options['--discard-acts'] !== undefined ? options : undefined, now }));
      const runtime = join(import.meta.dir, 'job-runtime.ts');
      if (action === 'open' || timeoutMs !== undefined) {
        const child = Bun.spawn(jobRuntimeCommand(action, runtime), {
          stdin, stdout: 'inherit', stderr: 'inherit',
        });
        const forward = (signal: 'SIGINT' | 'SIGTERM') => {
          if (child.exitCode === null && child.signalCode === null) child.kill(signal);
        };
        const onSigint = () => forward('SIGINT');
        const onSigterm = () => forward('SIGTERM');
        process.on('SIGINT', onSigint);
        process.on('SIGTERM', onSigterm);
        void child.exited.then(code => {
          process.off('SIGINT', onSigint);
          process.off('SIGTERM', onSigterm);
          process.exitCode = code;
        });
        return 0;
      }
      const child = Bun.spawnSync(jobRuntimeCommand(action!, runtime), {
        stdin, stdout: 'inherit', stderr: 'inherit',
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
    takePublishedLines();
    const result = command(rest, now);
    const jobLines = takePublishedLines();
    const text = typeof result === 'string' ? result : result.stdout;
    const output = !rest.includes('--json') && jobLines.length ? `${text}\n${jobLines.join('\n')}` : text;
    process.stdout.write(`${output}\n`);
    return typeof result === 'string' ? 0 : result.exit;
  } catch (error) {
    const jobLines = takePublishedLines();
    if (error instanceof Refusal) {
      if (!rest.includes('--json') && jobLines.length) process.stdout.write(`${jobLines.join('\n')}\n`);
      process.stderr.write(`${formatRefusal(error)}\n`);
      return error.exitCode;
    }
    throw error;
  }
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2), Date.now());
}
