/**
 * The CLI at an injected instant, for tests that need a real process (stdin,
 * exit codes, piped output): `bun tests/cli-at.ts [--fetch-timeout-ms <ms>] <ISO instant> <command> ...`.
 * It runs src/cli.ts main as the bin entry does, with that `now` and a longer live Review fetch timeout.
 */
import { main } from '../src/cli.ts';
import { setReviewActFetchTimeoutMs } from '../src/review-act.ts';

export const TEST_REVIEW_ACT_FETCH_TIMEOUT_MS = 60_000;

if (import.meta.main) {
  let args = process.argv.slice(2);
  let fetchTimeoutMs = TEST_REVIEW_ACT_FETCH_TIMEOUT_MS;
  if (args[0] === '--fetch-timeout-ms') {
    fetchTimeoutMs = Number(args[1]);
    args = args.slice(2);
  }
  const [at, ...argv] = args;
  const now = Date.parse(at ?? '');
  if (!Number.isFinite(now)) throw new Error('usage: bun tests/cli-at.ts [--fetch-timeout-ms <ms>] <ISO instant> <command> ...');
  setReviewActFetchTimeoutMs(fetchTimeoutMs);
  process.exitCode = main(argv, now);
}
