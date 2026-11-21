import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { decodeReviewAct, decodeReviewResponse } from '../src/review-act.ts';

const schema = 'rig-review/act@8';
const jobId = 'synthetic-job';
const actId = 'synthetic-verdict';
const act = { schema, jobId, actId, kind: 'review-verdict' };
const refusal = { code: 'REVIEW_ACT_INVALID' };

test('malformed act@8 refuses in raw and enveloped verdict decoding', () => {
  expect(() => decodeReviewAct(JSON.stringify(act))).toThrow(expect.objectContaining(refusal));

  const requestId = 'synthetic-request';
  const response = JSON.stringify({ schema: 'rig-review/job-api@2', verb: 'fetch-act', jobId, requestId, ok: true, value: act });
  expect(() => decodeReviewResponse(response, jobId, actId, requestId)).toThrow(expect.objectContaining(refusal));
});

test('other unsupported act schemas keep the generic refusal', () => {
  for (const unsupported of ['rig-review/act@1', 'rig-review/act@10']) {
    expect(() => decodeReviewAct(JSON.stringify({ ...act, schema: unsupported })))
      .toThrow(expect.objectContaining({ code: 'REVIEW_ACT_SCHEMA_UNSUPPORTED' }));
  }
});

test('the synchronous verdict fetch surfaces malformed act@8 through the runtime', async () => {
  const accepts: (string | null)[] = [];
  const mediaType = 'application/vnd.rig-review.act+json';
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    accepts.push(request.headers.get('accept'));
    return Response.json(act, { headers: { 'content-type': mediaType } });
  } });
  try {
    const transport = { origin: server.url.origin, jobId, actId, fetchCapability: 'synthetic-grant' };
    // Run the synchronous caller off the loopback server's event loop.
    const child = Bun.spawn([process.execPath, '-e', `
      import { fetchReviewActRuntime } from './src/review-act.ts';
      import { Refusal } from './src/refusal.ts';
      try { fetchReviewActRuntime(${JSON.stringify(transport)}); }
      catch (error) {
        if (!(error instanceof Refusal)) throw error;
        process.stdout.write(JSON.stringify({ code: error.code, message: error.message }));
        process.exitCode = error.exitCode;
      }
    `], { cwd: join(import.meta.dir, '..'), stdout: 'pipe', stderr: 'pipe' });
    const [exit, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect(stderr).toBe('');
    expect(exit).toBe(1);
    expect(JSON.parse(stdout)).toMatchObject({ ...refusal, message: expect.stringContaining('project.json.review_acts') });
    expect(accepts).toEqual([mediaType]);
  } finally {
    server.stop(true);
  }
});
