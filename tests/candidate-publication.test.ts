import { expect } from 'bun:test';
import { copyFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openCandidateHost, closeCandidateHost } from '../src/candidate-host.ts';
import { candidateCommentSubject } from '../src/comment-record.ts';
import { sha256 } from '../src/current.ts';
import { agentCall, pendingJobActs } from '../src/job-acts.ts';
import { decodeReviewAct } from '../src/review-act.ts';
import { tempDir } from './helpers.ts';
import { sourceOnlyTest } from './source-only.ts';

sourceOnlyTest('#1163 publishes a camera-free candidate and routes its attested comment to the ordinary writer', async () => {
  const dir = realpathSync(tempDir());
  const pkg = join(dir, 'package');
  mkdirSync(pkg);
  const fixture = join(import.meta.dir, 'fixtures/rig-registration/build');
  for (const file of ['skeleton.model.json', 'rectangle.png']) copyFileSync(join(fixture, file), join(pkg, file));
  const model = { path: 'skeleton.model.json', sha256: sha256(readFileSync(join(pkg, 'skeleton.model.json'))) };
  const seal = (path: string, value: object) => {
    const bytes = Buffer.from(JSON.stringify(value));
    writeFileSync(join(pkg, path), bytes);
    return { path, sha256: sha256(bytes) };
  };
  const identity = { setSha256: 'a'.repeat(64), askId: 'composition', optionId: 'baseline' };
  const take = seal('take.json', {
    schema: 'rig-create/candidate-take@1', clip: 'idle', duration: 0.25, loop: true, model, sceneReport: null,
  });
  const receipt = seal('candidate.json', {
    schema: 'rig-create/candidate-preview@1', ...identity, camera: 'unkeyed', model, take, sceneReport: null,
  });
  seal('review.json', {
    schema: 'rig-review/1', id: 'candidate', revision: receipt.sha256,
    title: 'Baseline', model: model.path, direction: take.path,
  });
  seal('unreferenced-report.json', { spec: 'spine-parts-scene-report/1' });
  const host = await openCandidateHost(dir, { id: 'synthetic-owner', role: 'owner' });
  try {
    const published = await agentCall(host, {
      verb: 'publish', expectedGeneration: 0, idempotencyKey: 'candidate',
      freeze: { kind: 'producer-held', holdId: 'test', record: null },
      result: { path: 'review.json', selector: { kind: 'candidate', receipt, ...identity } },
    });
    expect(published.ok).toBe(true);
    const head = host.session.status().publication!;
    const metadata = host.session.displayPublication(head.publicationId).routes.apiBase + 'review';
    const response = await fetch(new URL(metadata, host.origin));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ capabilities: { playback: true }, manifest: { title: 'Baseline' } });
    const post = (path: string, body: object) => new Request(`${host.origin}/jobs/${host.session.jobId}/${path}`, {
      method: 'POST', body: JSON.stringify(body),
      headers: { Origin: host.origin, 'Content-Type': 'application/json', 'X-Review-Capability': host.session.hostCredentials().ui },
    });
    const pageId = 'candidate-page';
    const display = await host.ports.ackDisplayed(host.session.jobId, post('ui/displayed', {
      publicationId: head.publicationId, pageId, sourceHash: head.source.sourceHash,
    }));
    if (!display.ok) throw Error(display.error.code);
    const saved = await host.ports.commitUIAct(host.session.jobId, post('ui/acts', {
      kind: 'comments', publicationId: head.publicationId, pageId, displayedNonce: display.value.displayedNonce,
      expectedGeneration: host.session.status().generation, submissionId: 'candidate-comment',
      value: { comments: [{ text: 'Keep the baseline framing.' }] },
    }));
    if (!saved.ok) throw Error(saved.error.code);
    const act = decodeReviewAct(JSON.stringify(saved.value), 'comments');
    expect(candidateCommentSubject(act)).toEqual({
      kind: 'candidate', set_sha256: identity.setSha256, ask_id: identity.askId, option_id: identity.optionId,
      receipt_sha256: receipt.sha256,
    });
    expect(pendingJobActs({}, [saved.value], dir)[0]?.args)
      .toEqual(['comment', dir, '--candidate-job', host.session.jobId, '--from-review', act.actId]);
    await closeCandidateHost(host, async acts => expect(acts.map(act => act.actId)).toEqual([act.actId]));
  } finally { host.stop(); }
});
