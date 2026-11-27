import { afterAll, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateExampleCurrent } from '../scripts/generate-example-current.ts';
import { jobHostStateRoot, jobPrivateRoot, pendingPublications, readWriterBinding } from '../src/job-outbox.ts';
import { jobRuntimeExecArgv } from '../src/job-writer.ts';
import type { NextReport } from '../src/next.ts';

const CLI = join(import.meta.dir, '../src/cli.ts');
const EXAMPLE = join(import.meta.dir, '../templates/example-current');
const TIMEOUT = 15_000;
const PUBLISHED = /^job: .+ published \(publication ([^\s)]+)\)$/m;
let fixtureScratch: string | undefined;
let cameraFixture: string | undefined;

function fixture(scratch: string, pendingCamera: boolean) {
  if (pendingCamera && !cameraFixture) {
    fixtureScratch = realpathSync(mkdtempSync(join(tmpdir(), 'create-publication-camera-fixture-')));
    cameraFixture = generateExampleCurrent(join(fixtureScratch, 'generated'), 'camera_depth');
  }
  const root = join(scratch, pendingCamera ? 'example-current' : 'accepted');
  cpSync(pendingCamera ? cameraFixture! : EXAMPLE, root, { recursive: true });
  return root;
}

afterAll(() => {
  if (fixtureScratch) rmSync(fixtureScratch, { recursive: true, force: true });
});

function startCli(root: string, args: string[]) {
  return Bun.spawn([process.execPath, ...jobRuntimeExecArgv(), CLI, ...args], {
    cwd: root, stdout: 'pipe', stderr: 'pipe',
  });
}

function openArgs(root: string, ...selector: string[]): string[] {
  return ['job', 'open', root, '--reviewer', 'synthetic-owner', '--role', 'owner', ...selector];
}

async function withProject(pendingCamera: boolean, exercise: (project: {
  root: string;
  record: () => Buffer;
  run: (...args: string[]) => Promise<{ exit: number; stdout: string; stderr: string }>;
  open: (...selector: string[]) => Promise<{ url: URL; stdout: string; stderr: string }>;
}) => Promise<void>): Promise<void> {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'create-publication-refusal-')));
  const children: Bun.Subprocess[] = [];
  const streams: Promise<void[]>[] = [];
  let root: string | undefined;
  try {
    const project = root = fixture(scratch, pendingCamera);
    const spawn = (args: string[]) => {
      const proc = startCli(project, args);
      children.push(proc);
      return proc;
    };
    await exercise({
      root: project,
      record: () => readFileSync(join(project, 'project.json')),
      async run(...args) {
        const proc = spawn(args);
        const timer = setTimeout(() => proc.kill('SIGTERM'), TIMEOUT);
        try {
          const [exit, stdout, stderr] = await Promise.all([
            proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text(),
          ]);
          return { exit, stdout, stderr };
        } finally { clearTimeout(timer); }
      },
      async open(...selector) {
        const proc = spawn(openArgs(project, ...selector));
        const output = { stdout: '', stderr: '' };
        const ready = Promise.withResolvers<void>();
        const read = async (stream: ReadableStream<Uint8Array>, channel: keyof typeof output) => {
          const reader = stream.getReader();
          const decoder = new TextDecoder();
          try {
            for (;;) {
              const chunk = await reader.read();
              if (chunk.done) break;
              output[channel] += decoder.decode(chunk.value, { stream: true });
              if (/^http:\/\/[^\n]+\n/m.test(output.stdout)
                && (PUBLISHED.test(output.stdout) || /^[A-Z][A-Z_]+: [^\n]+\n/m.test(output.stderr))) ready.resolve();
            }
          } finally { reader.releaseLock(); }
        };
        const drained = Promise.all([read(proc.stdout, 'stdout'), read(proc.stderr, 'stderr')]);
        streams.push(drained);
        const timer = setTimeout(() => ready.reject(new Error(`job open ${selector.join(' ')} timed out\n${output.stderr}`)), TIMEOUT);
        try {
          await Promise.race([ready.promise, drained]);
          const url = /^http:\/\/[^\n]+/m.exec(output.stdout)?.[0];
          if (url === undefined) throw new Error(`job open ${selector.join(' ')} did not start\n${output.stderr}`);
          return { url: new URL(url), ...output };
        } finally { clearTimeout(timer); }
      },
    });
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    }
    await Promise.allSettled([...children.map(child => child.exited), ...streams]);
    if (root && existsSync(root)) rmSync(jobHostStateRoot(root), { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
}

function published(output: { stdout: string; stderr: string }): string {
  const id = PUBLISHED.exec(output.stdout)?.[1];
  if (!id) throw new Error(`Expected a Review publication\n${output.stderr}`);
  return id;
}

function expectJobLocatorOnly(before: Buffer, after: Buffer, url: URL): void {
  const project = JSON.parse(before.toString('utf8'));
  project.review_job = { jobId: url.pathname.split('/')[2], origin: url.origin };
  expect(after.toString('utf8')).toBe(`${JSON.stringify(project, null, 2)}\n`);
}

async function expectPublishedEvents(owner: URL, publications: readonly { id: string; output: string }[]): Promise<void> {
  const response = await fetch(new URL('events', owner), {
    headers: { origin: owner.origin, 'X-Review-Capability': owner.hash.replace('#cap=', '') },
    signal: AbortSignal.timeout(5_000),
  });
  expect(response.status).toBe(200);
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  let count = 0;
  try {
    while (count < publications.length) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += chunk.value;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const event = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (event.type !== 'published') continue;
        const expected = publications[count++];
        expect(event.publication).toMatchObject({ publicationId: expected?.id,
          source: { selector: { kind: 'current', output: expected?.output } } });
      }
    }
    expect(count).toBe(publications.length);
  } finally {
    await reader.cancel();
  }
}

test('#1119 next offers retirement of a refused current publication and camera_depth can recover', async () => {
  await withProject(true, async ({ root, record, open, run }) => {
    const beforeOpen = record();
    const refused = await open('--current', 'rig');
    expect(refused.stderr).toMatch(/^JOB_PUBLISH_PENDING: .*JOB_RECORD_INCOMPLETE/m);
    const initial = record();
    expectJobLocatorOnly(beforeOpen, initial, refused.url);

    for (const selector of [['--question', 'camera_depth'], ['--questions']]) {
      const result = await run(...openArgs(root, ...selector));
      expect(result).toMatchObject({ exit: 1, stderr: expect.stringMatching(/^JOB_RECORD_INCOMPLETE: .*JOB_PUBLISH_PENDING at project\.json/m) });
      expect(record()).toEqual(initial);
    }
    const close = await run('job', 'close', root);
    expect(close).toMatchObject({ exit: 1, stderr: expect.stringMatching(/^JOB_PUBLISH_PENDING: /m) });
    expect(record()).toEqual(initial);

    const next = await run('next', root, '--json');
    expect(next.exit).toBe(0);
    const blocked = JSON.parse(next.stdout) as NextReport;
    expect({ refusals: blocked.refusals, commands: blocked.moves.map(move => move.command) }).toMatchObject({
      refusals: expect.arrayContaining([expect.objectContaining({ code: 'JOB_PUBLISH_PENDING',
        message: expect.stringContaining('JOB_RECORD_INCOMPLETE') })]),
      commands: expect.arrayContaining([expect.stringMatching(/^rig-create job close\b.*--retire-refused\b/)]),
    });

    expect(await run('job', 'close', root, '--retire-refused')).toMatchObject({ exit: 0 });
    expect(pendingPublications(root)).toEqual([]);
    expect(readWriterBinding(root)).toBeNull();
    expect(record()).toEqual(initial);
    const opened = await open('--question', 'camera_depth');
    published(opened);
    expect(opened.stdout).toContain('job: option-set camera_depth/current-camera-depth published ');
    expectJobLocatorOnly(initial, record(), opened.url);
    expect(await run('job', 'close', root)).toMatchObject({ exit: 0 });

  });
}, 60_000);

test('#1119 mixed retirement keeps the unfailed parts publication in the same live job', async () => {
  await withProject(true, async ({ root, record, open, run }) => {
    const beforeOpen = record();
    const refused = await open('--current', 'rig');
    expect(refused.stderr).toMatch(/^JOB_PUBLISH_PENDING: .*JOB_RECORD_INCOMPLETE/m);
    const initial = record();
    expectJobLocatorOnly(beforeOpen, initial, refused.url);
    const binding = readWriterBinding(root);
    expect(binding).not.toBeNull();

    const parts = await run(...openArgs(root, '--current', 'parts'));
    expect(parts).toMatchObject({ exit: 1, stderr: expect.stringMatching(/^JOB_PUBLISH_PENDING: .*JOB_RECORD_INCOMPLETE/m) });
    const entries = pendingPublications(root);
    expect(entries).toHaveLength(2);
    const rigEntry = entries.find(entry => entry.result.selector?.kind === 'current' && entry.result.selector.output === 'rig')!;
    const partsEntry = entries.find(entry => entry.result.selector?.kind === 'current' && entry.result.selector.output === 'parts')!;
    expect(rigEntry).toMatchObject({ failure: { code: 'JOB_RECORD_INCOMPLETE' } });
    expect(partsEntry).toMatchObject({ jobId: binding?.jobId, failure: null });
    expect(record()).toEqual(initial);

    const retired = await run('job', 'close', root, '--retire-refused');
    expect(retired).toMatchObject({ exit: 0 });
    expect(pendingPublications(root)).toEqual([partsEntry]);
    expect(JSON.parse(readFileSync(join(jobPrivateRoot(root), 'retired-publications', `${rigEntry.id}.json`), 'utf8'))).toEqual(rigEntry);
    expect(readWriterBinding(root)).toEqual(binding);
    expect(record()).toEqual(initial);

    const reconciled = await run('job', 'reconcile', root);
    expect(reconciled).toMatchObject({ exit: 0, stdout: 'job: reconciled 1 publication(s)\n' });
    expect(pendingPublications(root)).toEqual([]);
    expect(readWriterBinding(root)).toEqual(binding);
    const partsHead = await run(...openArgs(root, '--current', 'parts'));
    const alreadyPublished = /^job: current parts already published \(publication ([^\s)]+)\)$/m.exec(partsHead.stdout);
    expect(partsHead).toMatchObject({ exit: 0, stdout: expect.stringContaining('job: current parts already published ') });
    await expectPublishedEvents(refused.url, [{ id: alreadyPublished![1]!, output: 'parts' }]);
    expect(record()).toEqual(initial);
    expect(await run('job', 'close', root)).toMatchObject({ exit: 0 });
  });
}, 60_000);

test('#1119 current rig → parts → rig publishes a new rig live head without a pending publication', async () => {
  await withProject(false, async ({ root, record, open, run }) => {
    const beforeOpen = record();
    const first = await open('--current', 'rig');
    const firstId = published(first);
    const initial = record();
    expectJobLocatorOnly(beforeOpen, initial, first.url);
    const repeat = await run(...openArgs(root, '--current', 'rig'));
    expect(repeat).toMatchObject({ exit: 0, stdout: expect.stringContaining(`job: current rig already published (publication ${firstId})`) });

    const parts = await run(...openArgs(root, '--current', 'parts'));
    expect(parts).toMatchObject({ exit: 0 });
    const partsId = published(parts);
    const again = await run(...openArgs(root, '--current', 'rig'));
    expect(again).toMatchObject({ exit: 0 });
    const againId = published(again);
    expect(new Set([firstId, partsId, againId]).size).toBe(3);
    await expectPublishedEvents(first.url, [
      { id: firstId, output: 'rig' }, { id: partsId, output: 'parts' }, { id: againId, output: 'rig' },
    ]);

    const last = await run(...openArgs(root, '--current', 'rig'));
    expect(last).toMatchObject({ exit: 0, stdout: expect.stringContaining(`job: current rig already published (publication ${againId})`) });
    const check = await run('check', root);
    expect(check).toMatchObject({ exit: 0 });
    expect(`${check.stdout}\n${check.stderr}`).not.toContain('JOB_PUBLISH_PENDING');
    expect(pendingPublications(root)).toEqual([]);
    expect(record()).toEqual(initial);
    expect(await run('job', 'close', root)).toMatchObject({ exit: 0 });
  });
}, 45_000);
