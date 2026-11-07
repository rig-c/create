/**
 * The CLI at an injected instant, for tests that need a real process (stdin,
 * exit codes, piped output): `bun tests/cli-at.ts <ISO instant> <command> ...`.
 * It runs src/cli.ts main exactly as the bin entry does, with that `now`.
 */
import { main } from '../src/cli.ts';

const [at, ...argv] = process.argv.slice(2);
const now = Date.parse(at ?? '');
if (!Number.isFinite(now)) throw new Error('usage: bun tests/cli-at.ts <ISO instant> <command> ...');
process.exitCode = main(argv, now);
