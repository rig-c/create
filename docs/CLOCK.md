# Clock

## The clock

Every command, writer and check takes the instant it runs at as an explicit
`now` (milliseconds since the epoch). That one value dates what a writer records
and bounds every "not in the future" refusal. The process entry in `src/cli.ts`
is the only place create reads the wall clock; it passes `Date.now()` to `main`.

Tests and generators never read or replace the global clock. Generators pass
their declared example instants. Tests call create through
[tests/clock.ts](https://github.com/rig-c/create/blob/main/tests/clock.ts), which passes the suite's instant, by default
twelve hours after the latest `*_SINCE` date; `testClock.set` moves it for the
next call. A test that needs a real process spawns
[tests/cli-at.ts](https://github.com/rig-c/create/blob/main/tests/cli-at.ts) with that instant. The only test that reads
the real clock is [tests/contract-dates.test.ts](https://github.com/rig-c/create/blob/main/tests/contract-dates.test.ts):
it fails, naming the constant, when a `*_SINCE` date is still in the future.
