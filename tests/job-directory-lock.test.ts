import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const worker = `
  import assert from 'node:assert/strict';
  import * as fs from 'node:fs';
  import { join } from 'node:path';
  import { mock } from 'bun:test';

  const [root, scenario] = JSON.parse(fs.readFileSync(0, 'utf8'));
  const lock = join(root, 'job.lock');
  const { lstatSync, readdirSync, rmdirSync } = fs;
  let beforeRead;
  let beforeRemove;
  mock.module('node:fs', () => ({
    ...fs,
    lstatSync(path, ...args) {
      if (path === lock && scenario === 'lstat') beforeRead?.();
      return lstatSync(path, ...args);
    },
    readdirSync(path, ...args) {
      if (path === lock && scenario === 'readdir') beforeRead?.();
      return readdirSync(path, ...args);
    },
    rmdirSync(path, ...args) {
      if (path === lock) beforeRemove?.();
      return rmdirSync(path, ...args);
    },
  }));
  const { tryJobDirectoryLock } = await import(${JSON.stringify(join(import.meta.dir, '../src/job-outbox.ts'))});
  const release = tryJobDirectoryLock(lock);
  assert.ok(release);
  const [oldToken] = readdirSync(lock);
  assert.ok(oldToken);

  let next;
  if (scenario === 'handoff' || scenario === 'completed handoff') {
    beforeRemove = () => {
      beforeRemove = undefined;
      assert.deepEqual(readdirSync(lock), []);
      next = tryJobDirectoryLock(lock);
      assert.ok(next);
      if (scenario === 'completed handoff') next();
    };
    release();
  } else {
    beforeRead = () => {
      beforeRead = undefined;
      release();
    };
    next = tryJobDirectoryLock(lock);
  }

  assert.ok(next);
  if (scenario !== 'completed handoff') {
    const tokens = readdirSync(lock);
    assert.equal(tokens.length, 1);
    assert.notEqual(tokens[0], oldToken);
    assert.equal(tryJobDirectoryLock(lock), null);
    assert.deepEqual(readdirSync(lock), tokens);
    next();
  }
  assert.deepEqual(readdirSync(root), []);
`;

test.each(['handoff', 'completed handoff', 'lstat', 'readdir'])('#897 job directory lock survives %s', (scenario) => {
  const root = mkdtempSync(join(tmpdir(), 'create-job-directory-lock-'));
  try {
    const child = Bun.spawnSync([process.execPath, '--eval', worker], {
      stdin: new Blob([JSON.stringify([root, scenario])]), stdout: 'pipe', stderr: 'pipe',
    });
    expect({ exit: child.exitCode, stderr: child.stderr.toString() }).toEqual({ exit: 0, stderr: '' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
