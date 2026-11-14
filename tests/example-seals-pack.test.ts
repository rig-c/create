import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packExamples } from '../scripts/verify-example-seals.ts';

test('npm files allowlist ships the reader and verifier, which execute from staged and packed source', () => {
  const root = mkdtempSync(join(tmpdir(), 'create-packed-reader-'));
  try {
    const staged = join(root, 'staged');
    const tgz = packExamples(join(root, 'out'), staged);
    expect(existsSync(join(staged, 'scripts/npm-json.ts'))).toBe(true);
    const tar = spawnSync('tar', ['-xzf', tgz, '-C', root], { encoding: 'utf8', timeout: 5000 });
    expect(tar.status, tar.stderr).toBe(0);
    const packed = join(root, 'package');
    expect(readFileSync(join(packed, 'scripts/npm-json.ts')).equals(readFileSync(new URL('../scripts/npm-json.ts', import.meta.url)))).toBe(true);
    for (const source of [staged, packed]) {
      const reference = readFileSync(join(source, 'docs/AGENT-REFERENCE.md'));
      expect(reference).toEqual(readFileSync(new URL('../docs/AGENT-REFERENCE.md', import.meta.url)));
      const project = join(root, source === staged ? 'staged-project' : 'packed-project');
      const emitted = spawnSync(process.execPath, ['-e', `
        import { mkdirSync } from 'node:fs';
        import { writeAgentGuide } from ${JSON.stringify(join(source, 'src/agent-guide.ts'))};
        mkdirSync(${JSON.stringify(project)});
        console.log(JSON.stringify(writeAgentGuide(${JSON.stringify(project)})));
      `], { cwd: root, encoding: 'utf8', timeout: 5000 });
      expect(emitted.status, emitted.stderr).toBe(0);
      expect(JSON.parse(emitted.stdout)).toContain('AGENT-REFERENCE.md');
      expect(readFileSync(join(project, 'AGENT-REFERENCE.md'))).toEqual(reference);
      expect(readFileSync(join(project, 'AGENTS.md'), 'utf8')).toContain('](AGENT-REFERENCE.md)');
      // No dependency on the original cwd, tests or unlisted source modules.
      const verified = spawnSync(process.execPath, [join(source, 'scripts/verify-example-seals.ts'), '--tarball', tgz], {
        cwd: root, encoding: 'utf8', timeout: 10_000,
      });
      expect(verified.status, verified.stderr).toBe(0);
      expect(verified.stderr).toContain('checkpoint seals: 327 ok / 0 fail');
      expect(verified.stderr).toContain('planted deletion detected:');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 90_000);
