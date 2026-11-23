import { expect, spyOn, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startJobHost } from '@rig-c/review/job-host';
import { reportOwnerSubmitRefusal } from '../src/job-refusal.ts';
import { jobRuntimeExecArgv } from '../src/job-writer.ts';

const CREATE = join(import.meta.dir, '..');
const ROUTE = '/jobs/:jobId/ui/acts';
const BODY_MARKER = 'synthetic-submission-marker';

async function submit(ownerUrl: URL, body: string, origin = ownerUrl.origin) {
  const response = await fetch(new URL('ui/acts', ownerUrl), {
    method: 'POST', body, signal: AbortSignal.timeout(5_000),
    headers: { origin, 'content-type': 'application/json', 'X-Review-Capability': ownerUrl.hash.slice('#cap='.length) },
  });
  const reply = await response.json();
  return { status: response.status, reply };
}

test('#841 refused owner submissions write one safe stderr line each and preserve the CLI output', async () => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'create-job-owner-refusal-')));
  const root = join(scratch, 'project');
  const env = { ...process.env, CODEX_HOME: join(scratch, 'codex'), TMPDIR: join(scratch, 'tmp') };
  const spawn = (action: string, ...args: string[]) => Bun.spawn(
    [process.execPath, ...jobRuntimeExecArgv(), join(CREATE, 'src/cli.ts'), 'job', action, root, ...args],
    { cwd: root, env, stdout: 'pipe', stderr: 'pipe', timeout: 10_000 },
  );
  const run = async (action: string, ...args: string[]) => {
    const proc = spawn(action, ...args);
    const [exit, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { exit, stdout, stderr };
  };

  try {
    mkdirSync(env.CODEX_HOME);
    mkdirSync(env.TMPDIR);
    cpSync(join(CREATE, 'templates/example-chain/checkpoints/0a-interview-options'), root, { recursive: true });
    symlinkSync(join(CREATE, 'node_modules'), join(root, 'node_modules'));
    cpSync(join(CREATE, 'bun.lock'), join(root, 'bun.lock'));
    const host = spawn('open', '--reviewer', 'synthetic-owner', '--role', 'owner', '--question', 'rig_type');
    const stderr = new Response(host.stderr).text();
    const ready = Promise.withResolvers<string>();
    const stdout = (async () => {
      const reader = host.stdout.getReader();
      const decoder = new TextDecoder();
      let output = '';
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) return output + decoder.decode();
          output += decoder.decode(chunk.value, { stream: true });
          if (output.split('\n').length >= 4) ready.resolve(output);
        }
      } finally { reader.releaseLock(); }
    })();
    try {
      const startup = await Promise.race([stdout, ready.promise]);
      const lines = startup.split('\n');
      expect(lines).toHaveLength(4);
      const [url, published, asked, tail] = lines;
      expect(published).toMatch(/^job: option-set rig_type\/.+ published \(publication [A-Za-z0-9][A-Za-z0-9._-]{0,127}\)$/);
      expect(asked).toMatch(/^job: asked interview-picks rig_type\/.+$/);
      expect(tail).toBe('');
      const ownerUrl = new URL(url!);
      const record = readFileSync(join(root, 'project.json'));

      const malformed = `{${BODY_MARKER}é`;
      const limit = 256 * 1024; // Review's ordinary owner act byte ceiling.
      const oversized = JSON.stringify({ marker: BODY_MARKER, pad: 'x'.repeat(limit) });
      const cases = [
        { body: malformed, status: 400, code: 'JOB_REQUEST_INVALID', bytes: Buffer.byteLength(malformed) },
        { body: BODY_MARKER, origin: 'http://127.0.0.1:1', status: 403, code: 'JOB_SAME_ORIGIN_REQUIRED', bytes: 0 },
        { body: oversized, status: 413, code: 'JOB_BODY_LIMIT', bytes: Buffer.byteLength(oversized), limit },
      ];
      for (const { body, origin, status, code } of cases) {
        expect(await submit(ownerUrl, body, origin)).toMatchObject({ status, reply: { ok: false, error: { code } } });
      }

      const human = await run('acts');
      expect(human).toEqual({ exit: 0, stdout: 'job: no un-ingested acts; 0 already ingested for 1 current ask(s)\n', stderr: '' });
      const json = await run('acts', '--json');
      expect({ exit: json.exit, stderr: json.stderr }).toEqual({ exit: 0, stderr: '' });
      expect(JSON.parse(json.stdout)).toEqual({ jobId: ownerUrl.pathname.split('/')[2], acts: [], ingested: [], asked: 1 });
      expect(readFileSync(join(root, 'project.json'))).toEqual(record);

      expect(await run('close')).toEqual({ exit: 0, stdout: 'job: closed\n', stderr: '' });
      expect(await host.exited).toBe(0);
      expect(await stdout).toBe(startup);
      expect(await stderr).toBe(cases.map(({ code, bytes, limit: ceiling }) =>
        `WARN JOB_OWNER_SUBMIT_REFUSED: ${code} ${ROUTE} bytes=${bytes}${ceiling === undefined ? '' : ` limit=${ceiling}`}\n`).join(''));
    } finally {
      if (host.exitCode === null && host.signalCode === null) host.kill('SIGTERM');
      await Promise.all([host.exited, stdout, stderr]);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 20_000);

test('#841 a throwing stderr sink preserves the Review refusal and does not retry the write', async () => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'create-job-owner-refusal-sink-')));
  try {
    const root = join(scratch, 'project');
    mkdirSync(root);
    let writes = 0;
    const host = await startJobHost({
      root, stateDir: join(scratch, 'state'), fingerprint: 'synthetic-refusal-sink',
      reviewer: { id: 'synthetic-owner', role: 'owner' },
      onRefusal(event) {
        const sink = spyOn(process.stderr, 'write').mockImplementation(() => {
          writes++;
          throw new Error('synthetic stderr failure');
        });
        try { reportOwnerSubmitRefusal(event); }
        finally { sink.mockRestore(); }
      },
    });
    try {
      expect(await submit(new URL(host.ownerUrl), BODY_MARKER, 'http://127.0.0.1:1')).toMatchObject({
        status: 403, reply: { ok: false, error: { code: 'JOB_SAME_ORIGIN_REQUIRED' } },
      });
      expect(writes).toBe(1);
    } finally { host.stop(); }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
