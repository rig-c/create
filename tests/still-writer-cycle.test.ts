import { expect, test, spyOn } from 'bun:test';
import { readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startJobHost } from '@rig-c/review/job-host';
import { fixture, arr, obj } from './fixtures.ts';
import { EXAMPLE_DRAFT } from './draft-fixture.ts';
import { EXAMPLE_VERDICT } from './parts-package.ts';
import { EXAMPLE_DIFF_REPORT } from './diff-fixture.ts';
import { EXAMPLE_ANCHOR } from '../scripts/example-time.ts';
import { JOB_BINDING_FILE, writePrivateJson, jobHash } from '../src/job-outbox.ts';
import { main } from '../src/cli.ts';
import { currentJobIdentity, partsEnumerator, prepareLiveManifest, readPublished } from '../src/job-publication.ts';
import type { JsonObject } from '../src/templates.ts';

// Initial interview/plan approvals are fixture inputs. Every record from the
// draft through the post-interview boundary below is written by main(argv, now).
test('writer-only draft, parts approval, new producer build and displayed-still acceptance reach post-interview', async () => {
  let draftAt = 0, partsAt = 0;
  let citations: JsonObject = {};
  const dir = fixture(project => {
    draftAt = Date.parse(String(obj(arr(project.drafts)[0]).at));
    partsAt = Date.parse(String(arr(project.signoffs).map(obj).find(s => s.stage === 'parts-review')!.at));
    citations = obj(obj(arr(project.versions)[1]).provenance).sections as JsonObject;
    project.drafts = [];
    project.versions = [];
    project.stage = 'rigging';
    project.signoffs = arr(project.signoffs).filter(s => !['parts-review', 'rig-review', 'post-interview', 'post', 'direction-review', 'accepted'].includes(String(obj(s).stage)));
    project.advances = arr(project.advances).filter(a => !['rig-review', 'post-interview', 'post', 'direction-review', 'accepted'].includes(String(obj(a).stage)));
    for (const step of arr(obj(project.plan).steps).map(obj)) if (step.phase === 'post') { step.status = 'pending'; delete step.status_history; }
    for (const item of arr(obj(obj(project.interview).post).items).map(obj)) item.guide = null;
    project.scenes = [];
    obj(project.direction_contract).grandfathered_posts = [];
  }, 'example-project.json', {}, true);
  // Drop the seed's output files before any writer runs; the cycle registers
  // only the fresh producer build below.
  rmSync(join(dir, 'outputs'), { recursive: true, force: true });
  rmSync(join(dir, 'derived/review'), { recursive: true, force: true });
  const scratch = mkdtempSync(join(tmpdir(), 'create-still-cycle-'));
  const output = spyOn(process.stdout, 'write').mockImplementation(() => true);
  const errors = spyOn(process.stderr, 'write').mockImplementation(() => true);
  const load = (): JsonObject => JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'));
  const put = (path: string, bytes: string | Uint8Array): void => { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), bytes); };
  const command = (args: string[], now: number): void => {
    errors.mockClear(); output.mockClear();
    const exit = main(args, now);
    if (exit !== 0 && args[0] === 'interview') throw Error(JSON.stringify(JSON.parse(output.mock.calls.map(call => String(call[0])).join('')).refusals));
    expect({ command: args[0], exit, stderr: errors.mock.calls.map(call => String(call[0])).join('') }).toEqual({ command: args[0], exit: 0, stderr: '' });
  };
  let host: Awaited<ReturnType<typeof startJobHost>> | undefined;
  try {
    put('approval.txt', 'Approve this synthetic geometric example.\n');
    command(['draft-rig', 'example', dir, '--config', `${EXAMPLE_DRAFT}/config.json`, '--from', `${EXAMPLE_DRAFT}/out`, '--parts', `${EXAMPLE_DRAFT}/input`], draftAt);
    command(['signoff', 'parts-review', dir, '--by', 'user', '--verbatim-file', join(dir, 'approval.txt'), '--evidence', EXAMPLE_VERDICT,
      '--diff-report', EXAMPLE_DIFF_REPORT, '--component', 'p10-n3=in-painting:the synthetic painting deliberately differs here',
      '--component', 'p1000-n3=in-painting:the synthetic painting deliberately differs here', '--draft', 'example', '--structure-file', 'evidence/structure-decisions.json'], partsAt);
    const now = EXAMPLE_ANCHOR + 300_000;
    const core = join(import.meta.dir, '../node_modules/@rig-c/core/bin/rigc.cjs');
    const producer = (args: string[]): void => {
      const result = Bun.spawnSync([process.execPath, core, ...args], { cwd: dir, env: { ...process.env, SOURCE_DATE_EPOCH: String(now / 1000) }, stdout: 'pipe', stderr: 'pipe', timeout: 120_000 });
      expect({ exit: result.exitCode, stderr: result.stderr.toString() }).toEqual({ exit: 0, stderr: '' });
    };
    producer(['build', '--rig', `${EXAMPLE_DRAFT}/out/rig.json`, '--motion', `${EXAMPLE_DRAFT}/out/motion.json`, '--out', 'new-build',
      '--profile', 'rig-play', '--pack', '--page-edges', 'free', '--pack-shape', 'polygon', '--report', 'new-compile.json']);
    producer(['render', '--candidate', 'new-build', '--out', 'new-idle', '--animation', 'idle', '--fps', '1', '--max', '32', '--poser', 'core']);
    put('adapter.json', '[]\n');
    put('citations.json', JSON.stringify(citations));
    put('toolchain.json', JSON.stringify({ lockfileVersion: 3, packages: Object.fromEntries(['@rig-c/parts', '@rig-c/core'].map(name => [`node_modules/${name}`, { version: JSON.parse(readFileSync(join(import.meta.dir, '../node_modules', name, 'package.json'), 'utf8')).version }])) }));
    command(['rig-version', '1', dir, '--parts', `${EXAMPLE_DRAFT}/input`, '--rig', `${EXAMPLE_DRAFT}/out`, '--build', 'new-build', '--idle', 'new-idle',
      '--config', `${EXAMPLE_DRAFT}/config.json`, '--path-adapter', 'adapter.json', '--compile-report', 'new-compile.json', '--toolchain-lock', 'toolchain.json',
      '--citations', 'citations.json', '--run-record', 'new-build/run.json', '--at-source', 'new-build/run.json', '--at-pointer', '/finished_at', '--by', 'synthetic registrant'], now + 1000);
    command(['advance', 'rig-review', dir, '--by', 'user', '--verbatim-file', join(dir, 'approval.txt')], now + 2000);
    const withoutStill = readFileSync(join(dir, 'project.json'));
    errors.mockClear();
    expect(main(['review', '1', dir, '--verdict', 'accepted', '--review', 'rig-review', '--by', 'user', '--verbatim', 'Approve', '--source', 'synthetic tool'], now + 3000)).toBe(1);
    expect(errors.mock.calls.map(call => String(call[0])).join('')).toContain('RIG_ACCEPTED_WITHOUT_STILL');
    expect(readFileSync(join(dir, 'project.json'))).toEqual(withoutStill);
    const identity = currentJobIdentity({ root: dir, stateDir: join(scratch, 'host'), fingerprint: 'rig-create/still-cycle/1', reviewer: { id: 'synthetic-reviewer', role: 'owner' } }, dir);
    host = await startJobHost({ ...identity, partsEnumerator, readPublished, installWriterBinding: grant => writePrivateJson(join(dir, JOB_BINDING_FILE), { schema: 'rig-create/job-binding@1', identity, ...grant }, true) });
    const project = load();
    project.review_job = { jobId: host.session.jobId, origin: host.origin };
    put('project.json', `${JSON.stringify(project, null, 2)}\n`);
    const path = prepareLiveManifest(dir, load(), 1);
    const agent = async (verb: string, fields: object): Promise<JsonObject> => {
      const response = await host!.ports.handleJobApi(new Request(`${host!.origin}/jobs/${host!.session.jobId}/api`, {
        method: 'POST', headers: { authorization: `Bearer ${host!.session.hostCredentials().agent}`, 'content-type': 'application/json' },
        body: JSON.stringify({ schema: 'rig-review/job-api@2', verb, jobId: host!.session.jobId, requestId: randomUUID(), expectedGeneration: host!.session.status().generation, idempotencyKey: randomUUID(), ...fields }),
      }));
      const result = await response.json() as { ok: boolean; value: JsonObject };
      expect(result.ok).toBe(true); return result.value;
    };
    const publication = await agent('publish', { result: { path, selector: { kind: 'rig', version: 1 } }, freeze: { kind: 'producer-held', holdId: 'cycle-freeze', record: { path: 'project.json', sha256: jobHash(readFileSync(join(dir, 'project.json'))) } } });
    const ask = await agent('ask', { publicationId: publication.publicationId, subject: { kind: 'review-verdict', stage: 'rig-review' } });
    const request = (route: string, value: object): Request => new Request(`${host!.origin}/jobs/${host!.session.jobId}/ui/${route}`, {
      method: 'POST', headers: { origin: host!.origin, 'X-Review-Capability': host!.session.hostCredentials().ui, 'content-type': 'application/json' }, body: JSON.stringify(value),
    });
    const displayed = await host.ports.ackDisplayed(host.session.jobId, request('displayed', { publicationId: publication.publicationId, pageId: 'cycle-page', sourceHash: obj(publication.source).sourceHash }));
    if (!displayed.ok) throw Error(displayed.error.code);
    const frames = JSON.parse(readFileSync(join(dir, 'new-idle/frames.json'), 'utf8')) as { sets: { animation: string; dir: string }[] };
    const idle = frames.sets.find(set => set.animation === 'idle')!;
    const firstFrame = readdirSync(join(dir, 'new-idle', idle.dir)).filter(name => /^f\d+\.png$/.test(name)).sort()[0]!;
    const pngPath = join('new-idle', idle.dir, firstFrame);
    const png = readFileSync(join(dir, pngPath));
    const submitted = await host.ports.commitUIAct(host.session.jobId, request('acts', {
      publicationId: publication.publicationId, askId: ask.askId, pageId: 'cycle-page', displayedNonce: displayed.value.displayedNonce,
      expectedGeneration: host.session.status().generation, submissionId: 'cycle-submission', kind: 'review-verdict', value: { stage: 'rig-review', verdict: 'approved', words: 'Approve' },
      capture: { png: `data:image/png;base64,${png.toString('base64')}`, width: png.readUInt32BE(16), height: png.readUInt32BE(20), camera: 'fixed', framing: 'default', view: 'whole-rig', frame: 0, animation: 'idle', playing: true,
        binding: { publicationId: publication.publicationId, instanceKey: publication.instanceKey, sourceHash: obj(publication.source).sourceHash, pageId: 'cycle-page', askId: ask.askId, drawGeneration: 1, playerGeneration: 0 } },
    }));
    if (!submitted.ok) throw Error(submitted.error.code);
    const act = submitted.value;
    if (act.schema !== 'rig-review/act@3') throw Error('expected displayed still');
    const reviewAt = Math.max(now + 4000, Date.parse(act.at));
    const consumer = Bun.spawn([process.execPath, join(import.meta.dir, '../src/cli.ts'), 'review', '1', dir, '--from-review', act.actId], { stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, exit] = await Promise.all([new Response(consumer.stdout).text(), new Response(consumer.stderr).text(), consumer.exited]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: '' });
    expect(stdout).toContain('recorded or replayed');
    const recordedStill = obj(arr(obj(arr(load().versions)[0]).evidence)[0]);
    expect(recordedStill.frame).toBe(0);
    expect(recordedStill.what).toBe('Review displayed animation \"idle\" at 0 seconds');
    const checkAt = (at: number, expectedExit: number): { refusals: { code: string; path: string }[]; warnings: { code: string; path: string }[] } => {
      output.mockClear(); errors.mockClear();
      expect(main(['interview', '--check', dir, '--json'], at)).toBe(expectedExit);
      return JSON.parse(output.mock.calls.map(call => String(call[0])).join(''));
    };
    const boundary = checkAt(reviewAt, 0);
    expect(boundary.refusals).toEqual([]);
    expect(boundary.warnings.map(({ code, path }) => ({ code, path }))).toEqual([]);
    // src/stage-progress.ts:42-58: signing authorizes the next stage, so the
    // only transient refusal before advance is STAGE_LAGGING. src/check.ts:550:
    // arrival opens step 4's questions; it does not answer that next interview.
    command(['signoff', 'rig-review', dir, '--version', '1', '--by', 'user', '--verbatim-file', join(dir, 'approval.txt')], reviewAt + 1000);
    expect(checkAt(reviewAt + 1000, 1).refusals.map(({ code, path }) => ({ code, path })))
      .toEqual([{ code: 'STAGE_LAGGING', path: 'stage' }]);
    command(['advance', 'post-interview', dir, '--by', 'user', '--verbatim-file', join(dir, 'approval.txt')], reviewAt + 2000);
    expect(checkAt(reviewAt + 2000, 1).refusals.map(({ code, path }) => ({ code, path }))).toEqual([
      { code: 'INTERVIEW_INCOMPLETE', path: 'interview.post.items[camera_depth].guide' },
      { code: 'INTERVIEW_INCOMPLETE', path: 'interview.post.items[post_timing].guide' },
      { code: 'INTERVIEW_INCOMPLETE', path: 'interview.post.items[post_composition].guide' },
    ]);
    expect(load().stage).toBe('post-interview');
  } finally { host?.stop(); output.mockRestore(); errors.mockRestore(); rmSync(scratch, { recursive: true, force: true }); rmSync(dirname(dir), { recursive: true, force: true }); }
}, 180_000);
