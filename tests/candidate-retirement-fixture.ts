import { expect, mock } from 'bun:test';
import { appendFileSync, cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { JobCommentOnlyAct, JobOwnerHost } from '@rig-c/review/job-host';
import * as candidateHost from '../src/candidate-host.ts';
import * as candidate from '../src/candidate.ts';
import { collectItems } from '../src/check.ts';
import { interviewOptionsCommand } from '../src/choice-writers.ts';
import { treeFiles } from '../src/current.ts';
import { objects } from '../src/direction.ts';
import { openCreateJob, openRecordPublication } from '../src/job-host.ts';
import { SOURCE_CONDITION_FLAG } from '../src/job-writer.ts';
import type { JsonObject } from '../src/templates.ts';
import { candidateFixture, CANDIDATE_NOW, CANDIDATE_QUESTION, CANDIDATE_SET, CANDIDATE_SET_PATH } from './candidate-fixture.ts';

export const TIMING = 'post_timing';
export const REVIEWER = { id: 'owner', role: 'owner' } as const;
export const NOW = CANDIDATE_NOW;
const OPEN = ['candidate', 'open'];
const MODE_ENV = 'RIG_CREATE_CANDIDATE_RETIREMENT_TEST';
const TRACE_ENV = 'RIG_CREATE_CANDIDATE_RETIREMENT_TRACE';

const json = (path: string): JsonObject => JSON.parse(readFileSync(path, 'utf8')) as JsonObject;
export const record = (root: string) => json(join(root, 'project.json'));
export const question = (root: string, id: string) => collectItems(record(root), { collection: null })
  .find(item => item.id === id)!.record;

export function retirementProject(addTimingCandidate = false) {
  const f = candidateFixture();
  const root = f.root;
  for (const item of collectItems(f.project, { collection: null }).filter(item => item.kind === 'post')) item.record.guide = null;
  f.write('project.json', f.project);
  const composition = f.read(CANDIDATE_SET_PATH);
  const timingPath = `evidence/interview/${TIMING}.json`;
  const timing = f.read(timingPath);
  if (addTimingCandidate) {
    // The timing set carries an optional framing preview for its four-second choice.
    const keep = objects(objects(timing.asks)[0]!.options)[0]!;
    keep.fragment = { ...(keep.fragment as JsonObject), ...(f.options[0]!.fragment as JsonObject) };
    f.write(timingPath, timing);
  }
  const binding = JSON.parse(interviewOptionsCommand([CANDIDATE_QUESTION, root, '--file', CANDIDATE_SET_PATH], NOW)) as {
    path: string; sha256: string;
  };
  interviewOptionsCommand([TIMING, root, '--file', timingPath], NOW);
  return { ...f, composition, timing, binding, timingPath };
}

export async function standingQuestion(root: string): Promise<JobOwnerHost> {
  const host = await openCreateJob(root, REVIEWER, NOW, undefined, true);
  try {
    await openRecordPublication(root, host, [CANDIDATE_QUESTION, TIMING], false, NOW);
    expect(host.session.status().publication?.source).toMatchObject({
      selection: { kind: 'option-set', questionId: CANDIDATE_QUESTION },
    });
    return host;
  } catch (error) {
    host.stop();
    throw error;
  }
}

type TestMode = 'prepared' | 'reject-second' | 'close-race';

export function startCli(root: string, args: string[], mode?: TestMode, trace?: string) {
  const env = mode ? {
    ...process.env,
    BUN_OPTIONS: `--preload=${import.meta.path}`,
    [MODE_ENV]: mode,
    [TRACE_ENV]: trace,
  } : process.env;
  return Bun.spawn([
    process.execPath, SOURCE_CONDITION_FLAG, join(import.meta.dir, 'cli-at.ts'), new Date(NOW).toISOString(), ...args,
  ], { cwd: root, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 10_000 });
}

export async function runCli(...args: Parameters<typeof startCli>) {
  const child = startCli(...args);
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { exit, stdout, stderr };
}

export function openArgs(root: string, question = CANDIDATE_QUESTION, set = CANDIDATE_SET) {
  return [...OPEN, root, '--question', question, '--set', set, '--reviewer', REVIEWER.id, '--role', REVIEWER.role];
}

type PreparedInput = ReturnType<typeof candidate.prepareCandidateScene>;

async function preparedCompose(root: string, project: JsonObject, from: string, input: PreparedInput, snapshots: Map<string, Buffer>) {
  // Reuse the worked-example model and atlas. Only the consumer receipts need binding to this staging path.
  const out = join(root, from);
  cpSync(join(root, 'outputs/direction/check'), join(out, 'check'), { recursive: true });
  const sealPaths = new Set(['check/check.json', 'parts.json', 'rig/rig.json', 'rig/motion.json']);
  const files = treeFiles(root, input.build, '').map(({ path, sha256 }) => ({ path: path.slice(1), sha256 }))
    .filter(file => sealPaths.has(file.path) || file.path.startsWith('rig/images/'));
  const scenePlates = objects(input.scene.plates);
  const bounds = [0, 0, input.canvas.width, input.canvas.height];
  const write = (path: string, value: JsonObject) => writeFileSync(join(out, path), JSON.stringify(value));
  write('compose-run.json', {
    spec: 'rig-compose-run/1', scene: input.source,
    characters: [{
      id: input.character.id!, build: input.character.build!, files,
      placement: { canvas_clip: true, bounds, clipped_bounds: bounds },
    }],
    plate: null, plates: scenePlates.map((plate, i) => ({ name: plate.name!, path: plate.image!, sha256: input.registered[i]!.sha256 })),
  });
  write('scene.json', {
    spec: 'spine-parts-scene-report/1', scene: input.source.path, canvas: input.scene.canvas!,
    characters: [{ ...input.character, clipped_bounds: bounds }],
    plates: scenePlates.map((plate, i) => ({ ...plate, sha256: input.registered[i]!.sha256 })),
  });
  mkdirSync(join(out, 'rig'));
  write('rig/motion.json', { animations: { idle: { duration: input.takeDuration, loop: input.loop } } });
  return { input, output: candidate.verifyCandidateOutput(root, project, from, input, snapshots) };
}

export async function finalizeComment(host: JobOwnerHost, text: string): Promise<JobCommentOnlyAct> {
  const { generation, publication } = host.session.status();
  if (!publication) throw Error('Expected a live Review publication');
  const pageId = crypto.randomUUID();
  const post = (route: string, body: object) => new Request(`${host.origin}/jobs/${host.session.jobId}/ui/${route}`, {
    method: 'POST', body: JSON.stringify(body),
    headers: { Origin: host.origin, 'Content-Type': 'application/json', 'X-Review-Capability': host.session.hostCredentials().ui },
  });
  const displayed = await host.ports.ackDisplayed(host.session.jobId, post('displayed', {
    publicationId: publication.publicationId, pageId, sourceHash: publication.source.sourceHash,
  }));
  if (!displayed.ok) throw Error(displayed.error.code);
  const finalized = await host.ports.commitUIAct(host.session.jobId, post('acts', {
    kind: 'comments', publicationId: publication.publicationId, pageId, displayedNonce: displayed.value.displayedNonce,
    expectedGeneration: generation, submissionId: crypto.randomUUID(),
    value: { comments: [{ text }] },
  }));
  if (!finalized.ok) throw Error(finalized.error.code);
  if (finalized.value.kind !== 'comments') throw Error('Expected a finalized comment');
  return finalized.value;
}

export interface TraceRow {
  event: 'compose' | 'opened' | 'publish' | 'close' | 'late-comment';
  jobId?: string;
  origin?: string;
  generation?: number;
  code?: string;
  act?: JobCommentOnlyAct;
}

function installChildControls(mode: TestMode, tracePath: string) {
  const trace = (row: TraceRow) => appendFileSync(tracePath, `${JSON.stringify(row)}\n`);
  // The temporary project has no repository. Keep the harness independent of Git.
  const spawnSync = Bun.spawnSync;
  Bun.spawnSync = ((...args: Parameters<typeof spawnSync>) => {
    const command: unknown = args[0];
    if (Array.isArray(command) && command[0] === 'git') {
      if (command.join(' ') !== 'git rev-parse --is-inside-work-tree') throw Error('Unexpected Git command');
      return { exitCode: 128 };
    }
    return spawnSync(...args);
  }) as typeof spawnSync;
  if (mode !== 'close-race') Date.now = () => NOW;
  mock.module('../src/candidate.ts', () => ({
    ...candidate,
    composeCandidate: (...args: Parameters<typeof preparedCompose>) => {
      trace({ event: 'compose' });
      return preparedCompose(...args);
    },
  }));

  const instrument = (host: JobOwnerHost, rejectPublish: boolean, raceClose: boolean): JobOwnerHost => {
    const handle = host.ports.handleJobApi;
    let submittedLate = false;
    return { ...host, ports: { ...host.ports, handleJobApi: async request => {
      const body = await request.clone().json() as { verb: string; expectedGeneration?: number; result?: { selector: { receipt: { sha256: string } } } };
      if (body.verb === 'publish' && rejectPublish) {
        body.result!.selector.receipt.sha256 = '0'.repeat(64);
        request = new Request(request.url, { method: 'POST', headers: request.headers, body: JSON.stringify(body) });
      }
      if (body.verb === 'close' && raceClose && !submittedLate) {
        submittedLate = true;
        const act = await finalizeComment(host, 'Late finalized framing note.');
        trace({ event: 'late-comment', jobId: host.session.jobId, act });
      }
      const response = await handle(request);
      if (body.verb === 'publish' || body.verb === 'close') {
        const reply = await response.clone().json() as { ok: boolean; error?: { code: string } };
        trace({ event: body.verb, jobId: host.session.jobId, generation: body.expectedGeneration,
          code: reply.ok ? 'ok' : reply.error?.code });
      }
      return response;
    } } };
  };
  const open = candidateHost.openCandidateHost;
  const attach = candidateHost.attachCandidateHost;
  let opened = 0;
  mock.module('../src/candidate-host.ts', () => ({
    ...candidateHost,
    openCandidateHost: async (...args: Parameters<typeof open>) => {
      const host = await open(...args);
      trace({ event: 'opened', jobId: host.session.jobId, origin: host.origin });
      return instrument(host, mode === 'reject-second' && ++opened === 2, false);
    },
    attachCandidateHost: async (...args: Parameters<typeof attach>) => {
      const host = await attach(...args);
      return host && mode === 'close-race' ? instrument(host, false, true) : host;
    },
  }));
}

const mode = process.env[MODE_ENV] as TestMode | undefined;
const tracePath = process.env[TRACE_ENV];
if (mode && tracePath && basename(process.argv[1] ?? '') === 'candidate-runtime.ts') installChildControls(mode, tracePath);
