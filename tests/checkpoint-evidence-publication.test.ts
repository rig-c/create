/** Synthetic HTTP owner acts only. Each scoped host is stopped in finally. */
import { expect, test } from 'bun:test';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startJobHost, type JobOwnerHost } from '@rig-c/review/job-host';
import { JOB_BINDING_FILE, jobHash, writePrivateJson } from '../src/job-outbox.ts';
import { currentJobIdentity, partsEnumerator, prepareDraftManifest, readPublished, readRecordPublished } from '../src/job-publication.ts';
import { decodeReviewAct, fetchReviewAct, reviewActFindings, type CheckpointAct } from '../src/review-act.ts';
import { signoffCommand } from '../src/signoff.ts';
import type { JsonObject } from '../src/templates.ts';
import { TEST_NOW } from './clock.ts';
import { checkpointWorkspace } from './checkpoint-evidence-fixture.ts';
import { arr, obj } from './fixtures.ts';
import { tempDir } from './helpers.ts';

test('#395 sealed checkpoint record and package publications retain every asset and finalize owner routes', async () => {
  for (const mode of ['package-v2', 'package-v3', 'record-v3']) {
    const f = checkpointWorkspace();
    const state = tempDir();
    const now = Math.max(TEST_NOW, Date.now() + 60_000);
    let host: JobOwnerHost | undefined;
    try {
      f.attach();
      const identity = currentJobIdentity({ root: f.root, stateDir: state, fingerprint: 'synthetic-checkpoint', reviewer: { id: 'synthetic-owner', role: 'owner' } }, f.root);
      let fetchCapability = '';
      host = await startJobHost({ ...identity, readerId: identity.readerId, readPublished, partsEnumerator,
        installWriterBinding: async grant => { fetchCapability = grant.fetchCapability; },
        ...(mode === 'package-v2' ? {} : { publicationMode: 'record-and-package', recordReaderId: identity.readerId, readRecordPublished }) });
      const owner = host;
      const credentials = owner.session.hostCredentials();
      const recordFile = join(f.root, 'project.json');
      const project: JsonObject = JSON.parse(readFileSync(recordFile, 'utf8'));
      expect(Object.hasOwn(project, 'painting')).toBe(false);
      const painting = obj(arr(project.inputs)[0]);
      expect(painting.path).toBe('inputs/painting.png');
      const paintingBytes = readFileSync(join(f.root, String(painting.path)));
      expect(paintingBytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
      expect(jobHash(paintingBytes)).toBe(String(painting.sha256));
      project.review_job = { jobId: owner.session.jobId, origin: owner.origin };
      writeFileSync(recordFile, JSON.stringify(project, null, 2) + '\n');
      writePrivateJson(join(f.root, JOB_BINDING_FILE), { schema: 'rig-create/job-binding@1', identity,
        jobId: owner.session.jobId, origin: owner.origin, fetchCapability }, true);
      const packagePath = mode === 'record-v3' ? null : prepareDraftManifest(f.root, project, 'example');
      let sequence = 0;
      const schema = mode === 'package-v2' ? 'rig-review/job-api@2' : 'rig-review/job-api@3';
      async function api(verb: string, fields: object = {}): Promise<JsonObject> {
        const response = await owner.ports.handleJobApi(new Request(`${owner.origin}/jobs/${owner.session.jobId}/api`, {
          method: 'POST', headers: { authorization: `Bearer ${credentials.agent}`, 'content-type': 'application/json' },
          body: JSON.stringify({ schema, verb, jobId: owner.session.jobId, requestId: `request-${++sequence}`,
            idempotencyKey: `operation-${sequence}`, expectedGeneration: owner.session.status().generation, ...fields }),
        }));
        const body = await response.json() as JsonObject;
        expect(body.ok).toBe(true);
        return obj(body.value);
      }
      const result = packagePath ? { ...(mode === 'package-v3' ? { kind: 'package' } : {}), path: packagePath, selector: { kind: 'draft', id: 'example' } } : { kind: 'plan' };
      const publication = await api('publish', { result, freeze: { kind: 'producer-held', holdId: 'synthetic-freeze',
        record: { path: 'project.json', sha256: jobHash(readFileSync(recordFile)) } } });
      expect(owner.session.retainedSourceV3(String(publication.publicationId)).seals).toContainEqual({ path: String(painting.path), sha256: String(painting.sha256) });
      if (packagePath) expect(JSON.parse(readFileSync(join(f.root, packagePath), 'utf8')).producer.source).toBe(painting.path);
      expect(obj(publication.source).checkpointEvidence).toEqual([f.packet]);
      if (!packagePath) expect(obj(publication.source).model).toBeUndefined();
      const base = `${owner.origin}/jobs/${owner.session.jobId}/publications/${publication.publicationId}/instances/${publication.instanceKey}/`;
      const readAsset = (path: string, method = 'GET') => fetch(base + path, { method, headers: { 'X-Review-Capability': credentials.ui } });
      const metadataResponse = await readAsset('api/review');
      expect(metadataResponse.status).toBe(200);
      const metadata = await metadataResponse.json() as JsonObject;
      const projected = obj(arr(metadata.checkpointEvidence)[0]);
      expect(obj(projected.table).rows).toHaveLength(103);
      expect(obj(projected.table).rows).toEqual(JSON.parse(readFileSync(join(f.root, String(obj(f.packet.table).path)), 'utf8')).rows);
      expect(projected.routesText).toBe(f.packet.routesText);
      expect(projected.recommendationText).toBe(f.packet.recommendationText);
      const originalTable = readFileSync(join(f.root, String(obj(f.packet.table).path)));
      for (const [index, tile] of arr(projected.tiles).map(obj).entries()) {
        expect(tile.label).toBe(obj(arr(f.packet.tiles)[index]).label);
        const response = await readAsset(String(tile.url).slice(1));
        expect(response.status).toBe(200);
        expect(jobHash(Buffer.from(await response.arrayBuffer()))).toBe(String(tile.sha256));
      }
      const tableResponse = await readAsset(String(obj(projected.table).url).slice(1));
      expect(Buffer.from(await tableResponse.arrayBuffer())).toEqual(originalTable);
      expect((await readAsset(String(obj(projected.table).url).slice(1), 'HEAD')).status).toBe(200);
      expect((await readAsset('api/checkpoint-evidence/undeclared/table')).status).toBe(404);

      const uiRequest = (route: string, body: object) => new Request(`${owner.origin}/jobs/${owner.session.jobId}/${route}`, {
        method: 'POST', headers: { origin: owner.origin, 'X-Review-Capability': credentials.ui, 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      const displayed = await owner.ports.ackDisplayed(owner.session.jobId, uiRequest('ui/displayed', {
        publicationId: publication.publicationId, pageId: 'synthetic-page', sourceHash: obj(publication.source).sourceHash,
      }));
      expect(displayed.ok).toBe(true);
      if (!displayed.ok) throw Error('synthetic display refused');
      const acts: CheckpointAct[] = [];
      for (const [index, words] of ['(i) accept openings', '  (ii) repair\nverbatim 한글  ', '(iii) change source\nraw FAIL'].entries()) {
        const ask = await api('ask', { publicationId: publication.publicationId, subject: { kind: 'checkpoint', checkpointId: 'assemble' } });
        const value = { checkpointId: 'assemble', outcome: index === 0 ? 'pass' as const : 'fail' as const, words };
        const committed = await owner.ports.commitUIAct(owner.session.jobId, uiRequest('ui/acts', {
          publicationId: publication.publicationId, askId: ask.askId, pageId: 'synthetic-page', displayedNonce: displayed.value.displayedNonce,
          expectedGeneration: owner.session.status().generation, submissionId: `synthetic-route-${index}`, kind: 'checkpoint', value,
        }));
        expect(committed.ok).toBe(true);
        if (!committed.ok) throw Error('synthetic owner act refused');
        if (committed.value.kind !== 'checkpoint') throw Error('synthetic checkpoint kind changed');
        const act = committed.value;
        expect(act.value).toEqual(mode === 'record-v3' ? { ...value, planStepId: 'assemble' }
          : { checkpointId: value.checkpointId, outcome: value.outcome, planStepId: 'assemble',
            comments: [{ anchor: { checkpointId: 'assemble', planStepId: 'assemble' }, text: words }] });
        const fetched = await fetchReviewAct({ origin: owner.origin, jobId: owner.session.jobId, actId: String(act.actId),
          fetchCapability, kind: 'checkpoint' });
        const decoded = decodeReviewAct(fetched.bytes, 'checkpoint');
        expect<unknown>(decoded).toEqual(act);
        acts.push(decoded);
      }
      for (const act of acts.slice(1)) {
        const before = readFileSync(recordFile);
        expect(() => signoffCommand(['parts', f.root, '--checkpoint', 'assemble', '--from-review', String(act.actId)], now,
          { fetch: () => ({ bytes: JSON.stringify(act) }) })).toThrow(expect.objectContaining({ code: 'REVIEW_ACT_CHECKPOINT_FAILED' }));
        expect(readFileSync(recordFile)).toEqual(before);
      }
      const accepted = acts[0]!;
      const sign = () => signoffCommand(['parts', f.root, '--checkpoint', 'assemble', '--from-review', String(accepted.actId)], now,
        { fetch: () => ({ bytes: JSON.stringify(accepted) }) });
      // A metadata-only edit is a fresh source identity and cannot consume the old approval.
      f.packet.recommendationText = 'Changed recommendation, same raw assets';
      f.attach();
      const edited = readFileSync(recordFile);
      expect(sign).toThrow(expect.objectContaining({ code: 'REVIEW_ACT_SOURCE_STALE' }));
      expect(readFileSync(recordFile)).toEqual(edited);
      const changedPublication = await api('publish', { result, freeze: { kind: 'producer-held', holdId: 'synthetic-new-freeze',
        record: { path: 'project.json', sha256: jobHash(edited) } } });
      expect(obj(changedPublication.source).sourceHash).not.toBe(obj(publication.source).sourceHash);
      expect(changedPublication.instanceKey).not.toBe(publication.instanceKey);
      f.packet.recommendationText = 'HQ recommendation — (i), preserve raw FAIL';
      f.attach();
      expect(sign().exit).toBe(0);
      const signed = readFileSync(recordFile);
      expect(sign().exit).toBe(0);
      expect(readFileSync(recordFile)).toEqual(signed);
      expect(reviewActFindings(JSON.parse(signed.toString()))).toEqual([]);
      // Old pinned delivery survives raw live-file loss and metadata-only changes.
      rmSync(join(f.root, String(obj(f.packet.table).path)));
      for (const tile of arr(f.packet.tiles).map(obj)) rmSync(join(f.root, String(tile.path)));
      expect(Buffer.from(await (await readAsset(String(obj(projected.table).url).slice(1))).arrayBuffer())).toEqual(originalTable);
      for (const tile of arr(projected.tiles).map(obj)) {
        const retained = await readAsset(String(tile.url).slice(1));
        expect(jobHash(Buffer.from(await retained.arrayBuffer()))).toBe(String(tile.sha256));
      }
    } finally {
      host?.stop();
      rmSync(f.root, { recursive: true, force: true });
      rmSync(state, { recursive: true, force: true });
    }
  }
}, 120_000);

test('#395 SVG-backed package metadata retains sealed painting and checkpoint evidence', async () => {
  const f = checkpointWorkspace('svg');
  const state = tempDir();
  let host: JobOwnerHost | undefined;
  try {
    f.attach();
    const project: JsonObject = JSON.parse(readFileSync(join(f.root, 'project.json'), 'utf8'));
    const painting = obj(arr(project.inputs)[0]);
    expect(painting.path).toBe('inputs/preparation-source.svg');
    const manifestPath = prepareDraftManifest(f.root, project, 'example');
    const identity = currentJobIdentity({ root: f.root, stateDir: state, fingerprint: 'synthetic-svg-negative', reviewer: { id: 'synthetic-owner', role: 'owner' } }, f.root);
    host = await startJobHost({ root: f.root, stateDir: state, fingerprint: identity.fingerprint, reviewer: identity.reviewer,
      readerId: identity.readerId, readPublished, partsEnumeratorId: identity.partsEnumeratorId, partsEnumerator });
    const credentials = host.session.hostCredentials();
    const response = await host.ports.handleJobApi(new Request(`${host.origin}/jobs/${host.session.jobId}/api`, {
      method: 'POST', headers: { authorization: `Bearer ${credentials.agent}`, 'content-type': 'application/json' },
      body: JSON.stringify({ schema: 'rig-review/job-api@2', verb: 'publish', jobId: host.session.jobId, requestId: 'publish-svg',
        idempotencyKey: 'publish-svg', expectedGeneration: 0, result: { path: manifestPath, selector: { kind: 'draft', id: 'example' } },
        freeze: { kind: 'producer-held', holdId: 'synthetic-svg-freeze', record: { path: 'project.json', sha256: jobHash(readFileSync(join(f.root, 'project.json'))) } } }),
    }));
    const published = await response.json() as JsonObject;
    expect(published.ok).toBe(true);
    const publication = obj(published.value);
    expect(obj(publication.source).checkpointEvidence).toEqual([f.packet]);
    const retained = host.session.retainedSource(String(publication.publicationId));
    expect(retained.seals).toContainEqual({ path: String(painting.path), sha256: String(painting.sha256) });
    const metadataResponse = await fetch(`${host.origin}/jobs/${host.session.jobId}/publications/${publication.publicationId}/instances/${publication.instanceKey}/api/review`, {
      headers: { 'X-Review-Capability': credentials.ui },
    });
    expect(metadataResponse.status).toBe(200);
    const metadata = await metadataResponse.json() as JsonObject;
    const projected = obj(arr(metadata.checkpointEvidence)[0]);
    expect(obj(projected.table).rows).toEqual(JSON.parse(readFileSync(join(f.root, String(obj(f.packet.table).path)), 'utf8')).rows);
    expect(projected.routesText).toBe(f.packet.routesText);
    expect(projected.recommendationText).toBe(f.packet.recommendationText);
    expect(retained.seals).toContainEqual({ path: String(painting.path), sha256: String(painting.sha256) });
  } finally {
    host?.stop();
    rmSync(f.root, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
}, 120_000);
