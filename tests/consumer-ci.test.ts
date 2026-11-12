import { test, expect } from 'bun:test';
import { consumerCases, guardConsumerCoverage, skippedTestNames } from '../scripts/consumer-ci.ts';
const entries=consumerCases;
const row=entries[0]!;
const registered=[{file:row.file,name:row.name}];

test('scripts/consumer-ci-tests.json exclusions must exist and execute in registry check; planted missing and unrun cases refuse',()=>{
 expect(()=>guardConsumerCoverage(entries,registered,new Set([row.displayName]),new Set(),'registry')).not.toThrow();
 for(const [label,registrations,passed] of [
  ['missing case',[],new Set([row.displayName])],
  ['registry not run',registered,new Set<string>()],
 ] as const){
  expect(()=>guardConsumerCoverage(entries,registrations,passed,new Set(),'registry')).toThrow('CONSUMER_CI_COVERAGE');
  try {guardConsumerCoverage(entries,registrations,passed,new Set(),'registry');}catch(error){console.log(`Planted ${label}: ${String(error)}`);}
 }
});
test('scripts/ci-suite.ts source permits only the exact consumer skip, never its pass or any other skip',()=>{
 expect(()=>guardConsumerCoverage(entries,registered,new Set(),new Set([row.displayName]),'source')).not.toThrow();
 expect(()=>guardConsumerCoverage(entries,registered,new Set([row.displayName]),new Set([row.displayName]),'source')).toThrow('must SKIP');
 expect(()=>guardConsumerCoverage(entries,registered,new Set(),new Set([row.displayName,'another test']),'source')).toThrow('unexpected source skip');
 expect(skippedTestNames(`(skip) ${row.displayName}\n(skip) ${row.displayName}`)).toEqual(new Set([row.displayName]));
});

test('registry check invokes the coverage-enforcing full-suite runner', async()=>{
 const workflow=await Bun.file(new URL('../.github/workflows/ci.yml',import.meta.url)).text();
 const check=workflow.slice(workflow.indexOf('  check:'),workflow.indexOf('  source-linked:'));
 expect(check).toContain('run: bun scripts/run-registry-ci.ts');
 const runner=await Bun.file(new URL('../scripts/run-registry-ci.ts',import.meta.url)).text();
 expect(runner).toContain("runCiSuite(resolve(import.meta.dir,'..'),'registry')");
});
