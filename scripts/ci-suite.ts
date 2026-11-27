import { appendFileSync, closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { consumerCases, guardConsumerCoverage, skippedTestNames } from './consumer-ci.ts';
import { listMatchingTmpEntries } from './tmp-leak-check.ts';
import { parsePassedTestNames } from '../tests/source-only.ts';

/** File-backed output keeps the full suite's coverage evidence beyond pipe buffer limits. */
export function runCiSuite(root: string, mode: 'source' | 'registry', extraEnv: Record<string,string | undefined> = {}): { output: string; exitCode: number } {
  const scratch = mkdtempSync(join(tmpdir(), 'create-ci-suite-'));
  const stdout = openSync(join(scratch,'stdout'), 'w');
  const stderr = openSync(join(scratch,'stderr'), 'w');
  const registrations = join(scratch,'registrations');
  try {
    const beforeTmp = listMatchingTmpEntries();
    const beforeSet = new Set(beforeTmp);
    const result = Bun.spawnSync([process.execPath, ...(mode === 'source' ? ['--conditions=@rig-c/source'] : []), 'test', '--timeout', '30000'], {
      cwd: root,
      env: { ...process.env, ...extraEnv, RIG_CREATE_CONSUMER_REGISTRATIONS: registrations,
        ...(mode === 'source' ? { RIG_CREATE_SOURCE_CI: '1', RIG_CREATE_NETWORK: '1' } : {}) },
      stdout, stderr,
    });
    closeSync(stdout); closeSync(stderr);
    const afterTmp = listMatchingTmpEntries();
    const leakedTmp = afterTmp.filter((name) => !beforeSet.has(name));
    const output = `${readFileSync(join(scratch,'stdout'),'utf8')}\n${readFileSync(join(scratch,'stderr'),'utf8')}`;
    writeSync(1, output);
    console.log(`tmp-leak-check: rig-create-test-* in ${tmpdir()}: before=${beforeTmp.length}, after=${afterTmp.length}, delta=${afterTmp.length - beforeTmp.length}`);
    const skipped = skippedTestNames(output);
    const summary = `### ${mode} suite\nSkipped cases: ${skipped.size}\n${[...skipped].map(name => `- SKIP ${name}${consumerCases.find(e=>e.displayName===name)?.reason ? `: ${consumerCases.find(e=>e.displayName===name)!.reason}` : ''}`).join('\n')}\n`;
    console.log(summary);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,summary);
    if (result.exitCode !== 0) return { output, exitCode: result.exitCode ?? 1 };
    if (afterTmp.length > beforeTmp.length) {
      throw new Error(
        `TMP_LEAK_CHECK: rig-create-test-* count in ${tmpdir()} grew from ${beforeTmp.length} to ${afterTmp.length} (+${afterTmp.length - beforeTmp.length}): ${leakedTmp.slice(0, 20).join(', ')}; find the test that created these folders, have it use tempDir() from tests/helpers.ts (or remove them in afterEach/finally), or set RIG_CREATE_KEEP_TMP=1 when keeping temp folders on purpose for inspection`,
      );
    }
    const registered = existsSync(registrations) ? readFileSync(registrations,'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as {file:string;name:string}) : [];
    guardConsumerCoverage(consumerCases,registered,parsePassedTestNames(output),skipped,mode);
    return { output, exitCode: 0 };
  } finally { rmSync(scratch,{recursive:true,force:true}); }
}
