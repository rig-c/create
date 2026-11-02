#!/usr/bin/env bun
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describeInit, initProject } from './init.ts';
import { Refusal, formatRefusal, refuse, USAGE_EXIT } from './refusal.ts';

const HELP = `rig-create — create and run a rig project

Usage:
  rig-create init <dir> [--no-install]   create a project folder, its repository and pinned packages
  rig-create --help                      show this help
  rig-create --version                   show the version

init:
  <dir>          an empty or missing folder; a non-empty one is refused
  --no-install   do not run bun install (offline, tests); run it yourself afterwards
`;

type Command = (args: string[]) => string;

function version(): string {
  const pkg: unknown = JSON.parse(readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8'));
  if (pkg !== null && typeof pkg === 'object' && 'version' in pkg && typeof pkg.version === 'string') {
    return pkg.version;
  }
  return 'unknown';
}

function initCommand(args: string[]): string {
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

/** Subcommands by name. `interview` (#3) and init's collection options (#7) plug in here. */
const COMMANDS: Record<string, Command> = {
  init: initCommand,
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
    process.stdout.write(`${command(rest)}\n`);
    return 0;
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
