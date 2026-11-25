/** Private stdin/stdout adapter for the synchronous review writer. */
import { readFileSync } from 'node:fs';
import { fetchReviewAct, type BustPublicationQuery, type ReviewActTransport } from './review-act.ts';
import { Refusal, refuse } from './refusal.ts';

async function bustPublicationSeeds(query: BustPublicationQuery) {
  const { attachCreateJobForClose } = await import('./job-close.ts');
  const { jobEvents } = await import('./job-acts.ts');
  const { readWriterBinding } = await import('./job-outbox.ts');
  const binding = readWriterBinding(query.root);
  if (!binding || binding.jobId !== query.jobId) {
    refuse('JOB_BINDING_INVALID', 'project.json.review_acts: the writer binding no longer names the act’s job; restore the live job before ingesting the act');
  }
  const host = await attachCreateJobForClose(query.root, binding);
  try {
    for await (const event of jobEvents(host, true)) {
      if (event.type === 'published' && event.publication.publicationId === query.publicationId
        && event.publication.source.sourceHash === query.sourceHash) {
        return { seeds: event.publication.chestLandmarks ?? [] };
      }
    }
    return { seeds: [] };
  } finally { host.stop(); }
}

async function fetchAct(transport: ReviewActTransport) {
  const fetched = await fetchReviewAct(transport);
  return { bytes: fetched.bytes };
}

if (import.meta.main) {
  try {
    const input = JSON.parse(readFileSync(0, 'utf8'));
    const result = process.argv[2] === 'bust-publication'
      ? await bustPublicationSeeds(input as BustPublicationQuery)
      : await fetchAct(input as ReviewActTransport);
    process.stdout.write(JSON.stringify({ ok: true, ...result }));
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, code: error instanceof Refusal ? error.code : 'REVIEW_ACT_FETCH_REFUSED',
      message: error instanceof Refusal ? error.message : 'project.json.review_acts: fetch failed; restore the live Review job' }));
    process.exitCode = 1;
  }
}
