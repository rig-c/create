/** Private stdin/stdout adapter for the synchronous review writer. */
import { readFileSync } from 'node:fs';
import { fetchReviewAct, type ReviewActTransport } from './review-act.ts';
import { Refusal } from './refusal.ts';

if (import.meta.main) {
  try {
    const input = JSON.parse(readFileSync(0, 'utf8')) as ReviewActTransport;
    const fetched = await fetchReviewAct(input);
    process.stdout.write(JSON.stringify({ ok: true, bytes: fetched.bytes, stillBytes: fetched.stillBytes }));
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, code: error instanceof Refusal ? error.code : 'REVIEW_ACT_FETCH_REFUSED',
      message: error instanceof Refusal ? error.message : 'project.json.review_acts: fetch failed; restore the live Review job' }));
    process.exitCode = 1;
  }
}
