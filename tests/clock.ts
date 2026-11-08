/**
 * The suite's clock (README.md "The clock"). create's commands, writers and
 * check take the instant they run at as an explicit `now`; the wrappers below
 * pass them `testClock.now()`, so no test depends on the date it runs on.
 * Nothing replaces Date: `set` only changes the instant the next call is given.
 * The one test that reads the real clock is in tests/contract-dates.test.ts.
 */
import * as check from '../src/check.ts';
import * as choiceWriters from '../src/choice-writers.ts';
import * as collectionWriters from '../src/collection.ts';
import * as correctionWriters from '../src/correction-writers.ts';
import * as corrections from '../src/corrections.ts';
import * as direction from '../src/direction.ts';
import * as directionWriters from '../src/direction-writers.ts';
import * as drafts from '../src/drafts.ts';
import * as feedback from '../src/feedback.ts';
import * as intake from '../src/intake.ts';
import * as interview from '../src/interview.ts';
import * as inputs from '../src/inputs.ts';
import * as amend from '../src/amend.ts';
import * as pins from '../src/pins-check.ts';
import * as plan from '../src/plan-writers.ts';
import * as progress from '../src/progress-writers.ts';
import * as reopen from '../src/reopen.ts';
import * as review from '../src/review.ts';
import * as rigVersion from '../src/rig-version.ts';
import * as signoff from '../src/signoff.ts';
import * as cli from '../src/cli.ts';
import { EXAMPLE_NOW } from '../scripts/example-time.ts';
import type { JsonObject } from '../src/templates.ts';

/** Twelve hours after the latest `*_SINCE` contract date: after every synthetic example event. */
export const TEST_NOW = EXAMPLE_NOW;

let current = TEST_NOW;
export const testClock = {
  now: (): number => current,
  iso: (): string => new Date(current).toISOString(),
  set: (at: string | number | Date): void => {
    const next = new Date(at).getTime();
    if (!Number.isFinite(next)) throw new Error(`test clock needs a readable instant, got ${String(at)}`);
    current = next;
  },
  reset: (): void => { current = TEST_NOW; },
};

export const checkProject = (dir: string, candidate?: JsonObject, options: { forwardWrite?: boolean } = {}): check.CheckReport =>
  check.checkProject(dir, candidate, { ...options, now: current });
export const checkCorrections = (ctx: Parameters<typeof corrections.checkCorrections>[0]): void => corrections.checkCorrections(ctx, current);
export const checkDirections = (ctx: Parameters<typeof direction.checkDirections>[0], selected?: number, currentOverride?: boolean): void =>
  direction.checkDirections(ctx, current, selected, currentOverride);
export const assertDirectionApproval = (dir: string, project: JsonObject, stage: string, n?: number): void =>
  direction.assertDirectionApproval(dir, project, stage, current, n);
export const assertCorrectionApproval = (dir: string, project: JsonObject, stage: string, signature?: JsonObject): void =>
  correctionWriters.assertCorrectionApproval(dir, project, stage, current, signature);
export const recordVerdict = (dir: string, input: feedback.ReviewInput): ReturnType<typeof feedback.recordVerdict> => feedback.recordVerdict(dir, input, current);
export const handoff = (dir: string, rig: number | null): ReturnType<typeof review.handoff> => review.handoff(dir, rig, current);
export const directionCommand = (args: string[], hooks?: directionWriters.DirectionWriteHooks): ReturnType<typeof directionWriters.directionCommand> =>
  directionWriters.directionCommand(args, current, hooks);

const at = <R>(command: (args: string[], now: number) => R) => (args: string[]): R => command(args, current);
export const advanceCommand = at(progress.advanceCommand);
export const amendCommand = at(amend.amendCommand);
export const collectionCommand = at(pins.collectionCommand);
export const collectionInitCommand = at(collectionWriters.collectionInitCommand);
export const correctionCommand = at(correctionWriters.correctionCommand);
export const draftRigCommand = at(drafts.draftRigCommand);
export const handoffCommand = at(review.handoffCommand);
export const intakeReportCommand = at(intake.intakeReportCommand);
export const interviewAnswerCommand = at(choiceWriters.interviewAnswerCommand);
export const interviewCommand = at(interview.interviewCommand);
export const interviewDecisionCommand = at(choiceWriters.interviewDecisionCommand);
export const interviewOptionsCommand = at(choiceWriters.interviewOptionsCommand);
export const inputCommand = at(inputs.inputCommand);
export const main = at(cli.main);
export const planCommand = at(plan.planCommand);
export const reopenCommand = at(reopen.reopenCommand);
export const reviewCommand = at(feedback.reviewCommand);
export const rigVersionCommand = at(rigVersion.rigVersionCommand);
export const signoffCommand = at(signoff.signoffCommand);
export const stepStatusCommand = at(progress.stepStatusCommand);
