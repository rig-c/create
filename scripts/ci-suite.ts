import { appendFileSync, closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { consumerCases, guardConsumerCoverage, skippedTestNames } from './consumer-ci.ts';
import { parsePassedTestNames } from '../tests/source-only.ts';

/** File-backed output keeps the full suite's coverage evidence beyond pipe buffer limits. */
export function runCiSuite(root: string, mode: 'source' | 'registry', extraEnv: Record<string,string | undefined> = {}): { output: string; exitCode: number } {
  const scratch = mkdtempSync(join(tmpdir(), 'create-ci-suite-'));
  const stdout = openSync(join(scratch,'stdout'), 'w');
  const stderr = openSync(join(scratch,'stderr'), 'w');
  const registrations = join(scratch,'registrations');
  symlinkSync(scratch, join(scratch,'alias'), 'dir');
  try {
    const result = Bun.spawnSync([process.execPath, ...(mode === 'source' ? ['--conditions=@rig-c/source'] : []), 'test'], {
      cwd: root,
      env: { ...process.env, ...extraEnv, RIG_CREATE_CONSUMER_REGISTRATIONS: registrations,
        ...(mode === 'source' ? { RIG_CREATE_SOURCE_CI: '1', RIG_CREATE_NETWORK: '1', TMPDIR: join(scratch,'alias') } : {}) },
      stdout, stderr,
    });
    closeSync(stdout); closeSync(stderr);
    const output = `${readFileSync(join(scratch,'stdout'),'utf8')}\n${readFileSync(join(scratch,'stderr'),'utf8')}`;
    process.stdout.write(output);
    const skipped = skippedTestNames(output);
    const summary = `### ${mode} suite\nSkipped cases: ${skipped.size}\n${[...skipped].map(name => `- SKIP ${name}${consumerCases.find(e=>e.displayName===name)?.reason ? `: ${consumerCases.find(e=>e.displayName===name)!.reason}` : ''}`).join('\n')}\n`;
    console.log(summary);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,summary);
    if (result.exitCode !== 0) return { output, exitCode: result.exitCode ?? 1 };
    const registered = existsSync(registrations) ? readFileSync(registrations,'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as {file:string;name:string}) : [];
    guardConsumerCoverage(consumerCases,registered,parsePassedTestNames(output),skipped,mode);
    return { output, exitCode: 0 };
  } finally { rmSync(scratch,{recursive:true,force:true}); }
}
