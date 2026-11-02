/**
 * A named refusal: a stable code a caller (or a test) can match on, a message
 * naming the object refused, and the exit code the CLI leaves with.
 *
 * Every command refuses through this, so `interview --check` and later
 * commands print and exit the same way `init` does.
 */
export class Refusal extends Error {
  readonly code: string;
  readonly exitCode: number;

  constructor(code: string, message: string, exitCode = 1) {
    super(message);
    this.name = 'Refusal';
    this.code = code;
    this.exitCode = exitCode;
  }
}

export function refuse(code: string, message: string, exitCode = 1): never {
  throw new Refusal(code, message, exitCode);
}

/** The one-line form printed to stderr: `rig-create: CODE: message`. */
export function formatRefusal(refusal: Refusal): string {
  return `rig-create: ${refusal.code}: ${refusal.message}`;
}

/** Exit code for a usage error (unknown command, unknown option, missing argument). */
export const USAGE_EXIT = 2;
