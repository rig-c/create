import {expect,test} from 'bun:test';
import {chmodSync,existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

type Step={id?:string;name?:string;uses?:string;if?:string;env?:Record<string,string>;with?:Record<string,unknown>;run?:string;'working-directory'?:string};
type Job={'runs-on':string;'timeout-minutes':number;permissions:unknown;steps:Step[];outputs?:Record<string,string>;needs?:string;if?:string};
type Workflow={on:unknown;permissions:unknown;concurrency:unknown;jobs:{release:Job;publish:Job}};
const workflow=Bun.YAML.parse(readFileSync(new URL('../.github/workflows/release.yml',import.meta.url),'utf8')) as Workflow;
const steps=workflow.jobs.release.steps;
const target=steps.find(step=>step.id==='target')!;
const aliasGate='bun scripts/verify-example-seals.ts --tarball "$alias_tgz"';
const tag='v0.11.1',commitSha='a'.repeat(40),oldSha='b'.repeat(40);
type Fixture={
 event?:string;ref?:string;inputTag?:string;runSha?:string;repo?:string;
 commitSha?:string;localTagSha?:string;apiResponses?:Record<string,ApiResponse>;apiExit?:number;
 tagExit?:number;mainExit?:number;ancestorExit?:number;packageJson?:string;packageExit?:number;served?:string;
};
type Call={command:string;args:string[]};
type ApiResponse={status:number;body:string};
type ApiCall={endpoint:string;status:number;bodySha256:string};
// Only these stubs and node exist on PATH. The extracted workflow runs with no repository,
// inherited credentials, real gh/git/npm, network client, publish or dispatch command.
const stub=String.raw`
import {appendFileSync,readFileSync} from 'node:fs';
import {basename} from 'node:path';
import {createHash} from 'node:crypto';
const f=JSON.parse(readFileSync(process.env.FIXTURE,'utf8'));
const command=basename(process.argv[1]),args=process.argv.slice(2);
appendFileSync(process.env.TRACE,JSON.stringify({command,args})+'\n');
const is=(...expected)=>JSON.stringify(args)===JSON.stringify(expected);
const reply=(value,code=0)=>{if(value!==undefined)console.log(value);process.exit(code);};
if(command==='gh'){
 if(args.length===4&&args[0]==='api'&&args[2]==='--jq'&&args[3]==='.sha'&&Object.hasOwn(f.apiResponses,args[1])){
  // Route by the exact requested endpoint, never by the desired fixture kind.
  const response=f.apiResponses[args[1]],data=JSON.parse(response.body);
  appendFileSync(process.env.API_TRACE,JSON.stringify({endpoint:args[1],status:response.status,
   bodySha256:createHash('sha256').update(response.body).digest('hex')})+'\n');
  if(response.status>=400){console.error('gh: '+data.message+' (HTTP '+response.status+')');process.exit(1);}
  // gh api --jq .sha: parse the actual JSON body and emit its top-level .sha.
  // apiExit is a deliberate transport-failure injection, not recorded API behavior.
  reply(data.sha??null,f.apiExit);
 }
}
const activeTag=f.event==='push'?String(f.ref).replace(/^refs\/tags\//,''):f.inputTag;
if(command==='git'){
 if(is('rev-parse','--verify','--quiet','refs/tags/'+activeTag+'^{commit}'))reply(f.localTagSha,f.tagExit);
 if(is('rev-parse','--verify','--quiet','refs/remotes/origin/main'))reply(f.commitSha,f.mainExit);
 if(is('merge-base','--is-ancestor',f.commitSha,'refs/remotes/origin/main'))reply(undefined,f.ancestorExit);
 if(is('show',f.commitSha+':package.json'))reply(f.packageJson,f.packageExit);
}
if(command==='npm'&&is('view','@rig-c/create@'+activeTag.slice(1),'version'))reply(f.served,f.served?0:1);
console.error('UNEXPECTED_STUB_COMMAND',command,JSON.stringify(args));process.exit(97);
`;

function resolveTag(_name:string,overrides:Fixture={}){
 const root=mkdtempSync(join(tmpdir(),'create-release-provenance-'));
 try{
  const bin=join(root,'bin');mkdirSync(bin);
  const effectiveInputTag=overrides.inputTag??tag;
  const effectiveRef=overrides.ref??`refs/tags/${effectiveInputTag}`;
  const effectiveCommit=overrides.commitSha??commitSha;
  const effectiveTag= (overrides.event??'push')==='push'?effectiveRef.replace(/^refs\/tags\//,''):effectiveInputTag;
  // Synthetic endpoint responses exercise the extracted selector without network access.
  const fixture={event:'push',ref:effectiveRef,inputTag:effectiveInputTag,runSha:effectiveCommit,repo:'rig-c/create',
   commitSha:effectiveCommit,localTagSha:effectiveCommit,
   packageJson:JSON.stringify({name:'@rig-c/create',version:effectiveTag.replace(/^v/,'')}),
   apiResponses:{[`repos/rig-c/create/commits/refs%2Ftags%2F${effectiveTag}`]:{status:200,body:JSON.stringify({sha:effectiveCommit})}},
   ...overrides};
  writeFileSync(join(root,'fixture.json'),JSON.stringify(fixture));
  // Plant a distractor working-tree package.json to prove the selector reads from git show $tag_sha:package.json, not cwd.
  writeFileSync(join(root,'package.json'),JSON.stringify({name:'@rig-c/wrong-cwd',version:'0.0.0-cwd'}));
  const output=join(root,'output'),trace=join(root,'trace'),apiTrace=join(root,'api-trace');
  writeFileSync(output,'');writeFileSync(trace,'');writeFileSync(apiTrace,'');
  for(const command of ['gh','git','npm']){
   const path=join(bin,command);writeFileSync(path,`#!${process.execPath}\n${stub}`);chmodSync(path,0o755);
  }
  symlinkSync(process.execPath,join(bin,'node'));
  expect(existsSync(join(root,'.git'))).toBe(false);
  const result=Bun.spawnSync(['/bin/bash','--noprofile','--norc','-c',target.run!],{
   cwd:root,timeout:10000,
   env:{PATH:bin,HOME:root,EVENT:fixture.event,REF:fixture.ref,
    INPUT_TAG:fixture.inputTag,GITHUB_SHA:fixture.runSha,GITHUB_OUTPUT:output,REPO:fixture.repo,
    FIXTURE:join(root,'fixture.json'),TRACE:trace,API_TRACE:apiTrace},
  });
  const stdout=result.stdout.toString(),stderr=result.stderr.toString();
  const outputText=readFileSync(output,'utf8');
  const traceText=readFileSync(trace,'utf8');
  const calls:Call[]=traceText.trim()?traceText.trim().split('\n').map(line=>JSON.parse(line)):[];
  const apiCalls:ApiCall[]=readFileSync(apiTrace,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
  expect(stdout+stderr).not.toContain('UNEXPECTED_STUB_COMMAND');
  return {exitCode:result.exitCode,text:stdout+stderr,output:outputText,calls,apiCalls,
   outputs:Object.fromEntries(outputText.trim().split('\n').filter(Boolean).map(line=>line.split('=')))};
 }finally{rmSync(root,{recursive:true,force:true});}
}
function refused(result:ReturnType<typeof resolveTag>,code:string){
 expect(result.exitCode).toBe(1);
 expect(result.text).toContain(`::error::${code}:`);
 expect(result.output).not.toContain('publish=true');
 expect(result.outputs.sha).toBeUndefined();
}
function onlyCommitLookup(calls:Call[],repo='rig-c/create',cutTag=tag){
 expect(calls).toEqual([{command:'gh',args:['api',`repos/${repo}/commits/refs%2Ftags%2F${cutTag}`,'--jq','.sha']}]);
}
function expectedResolutionCalls(repo='rig-c/create',releaseTag=tag,sha=commitSha):Call[]{
 return [
  {command:'gh',args:['api',`repos/${repo}/commits/refs%2Ftags%2F${releaseTag}`,'--jq','.sha']},
  {command:'git',args:['rev-parse','--verify','--quiet',`refs/tags/${releaseTag}^{commit}`]},
  {command:'git',args:['rev-parse','--verify','--quiet','refs/remotes/origin/main']},
  {command:'git',args:['merge-base','--is-ancestor',sha,'refs/remotes/origin/main']},
  {command:'git',args:['show',`${sha}:package.json`]},
  {command:'npm',args:['view',`@rig-c/create@${releaseTag.slice(1)}`,'version']},
 ];
}

function checkWorkflowPolicy(wf:Workflow){
 expect(wf.on).toEqual({push:{tags:['v*']},workflow_dispatch:{inputs:{tag:{description:'An existing release tag to publish, e.g. v0.7.1',required:true,type:'string'}}}});
 expect(wf.permissions).toEqual({});
 expect(wf.concurrency).toEqual({group:'release-${{ github.ref }}','cancel-in-progress':false});
 expect(wf.jobs.release['runs-on']).toBe('ubuntu-latest');
 expect(wf.jobs.release.permissions).toEqual({contents:'read'});
 expect(wf.jobs.release.outputs).toEqual({
  publish:'${{ steps.target.outputs.publish }}',tag:'${{ steps.target.outputs.tag }}',sha:'${{ steps.target.outputs.sha }}',
 });
 const releaseSteps=wf.jobs.release.steps;
 expect(releaseSteps.some(step=>step.uses?.includes('release-please'))).toBe(false);
 expect(releaseSteps).toHaveLength(2);
 expect(releaseSteps[0]).toEqual({
  uses:'actions/checkout@v4',
  with:{ref:'main','fetch-depth':0,'persist-credentials':false},
 });
 const targetStep=releaseSteps.find(step=>step.id==='target')!;
 expect(targetStep.env).toEqual({
  EVENT:'${{ github.event_name }}',REF:'${{ github.ref }}',INPUT_TAG:'${{ inputs.tag }}',
  GH_TOKEN:'${{ github.token }}',REPO:'${{ github.repository }}',
 });
 expect(targetStep.run).not.toContain('release-please');
 expect(targetStep.run).not.toContain('RELEASE_NOT_RELEASE_PLEASE');
 expect(targetStep.run).not.toContain('RELEASE_TAG_UNRELEASED');
 expect(releaseSteps.at(-1)).toBe(targetStep);
 const pub=wf.jobs.publish;
 expect(pub).toMatchObject({
  needs:'release',if:"${{ needs.release.outputs.publish == 'true' }}",'runs-on':'ubuntu-latest','timeout-minutes':20,
 });
 const serialized=JSON.stringify(wf);
 expect(serialized).not.toContain('NODE_AUTH_TOKEN');
 expect(serialized).not.toContain('secrets.');
 expect(serialized).not.toContain('--otp');
 expect(pub.steps.find(step=>step.uses==='actions/setup-node@v4')?.with).toEqual({'node-version':22,'registry-url':'https://registry.npmjs.org'});
 expect(pub.steps.some(step=>step.run?.includes('npm install -g npm@latest'))).toBe(true);
 expect(pub.steps.some(step=>step.run==='bun install --frozen-lockfile')).toBe(true);
 expect(pub.permissions).toEqual({contents:'read','id-token':'write'});
 expect(pub.steps[0]).toMatchObject({uses:'actions/checkout@v4',with:{ref:'${{ needs.release.outputs.sha }}'}});
 expect(pub.steps.find(step=>step.env?.TAG_NAME)?.env?.TAG_NAME).toBe('${{ needs.release.outputs.tag }}');
 expect(pub.steps.filter(step=>step.run?.includes('npm publish')).map(step=>step.name)).toEqual(['Publish @rig-c/create','Publish the alias rig-create']);
 expect(pub.steps.find(step=>step.name==='Publish @rig-c/create')!.run!.trim()).toBe(
  'set -euo pipefail\nx="$(npm pack . --pack-destination .)"\nbun scripts/verify-example-seals.ts --tarball "$x"\nnpm publish "$x" --provenance --access public\necho "tarball=$PWD/$x" >> "$GITHUB_OUTPUT"',
 );
 const alias=pub.steps.find(step=>step.name==='Publish the alias rig-create')!;
 expect(alias.run).toContain(aliasGate);
 expect(alias.run!.indexOf(aliasGate)).toBeLessThan(alias.run!.indexOf('npm publish '));
 expect(alias.run).toContain('npm publish "$alias_tgz" --provenance --access public');
}

test('parsed YAML removes release-please, triggers on version tags, preserves least privilege and gates, and checks out only the validated commit',()=>{
 expect(existsSync(new URL('../release-please-config.json',import.meta.url))).toBe(false);
 expect(existsSync(new URL('../.release-please-manifest.json',import.meta.url))).toBe(false);
 checkWorkflowPolicy(workflow);
});

test('registry smoke stages, packs and verifies the exact tarball before a publish dry-run',()=>{
 const ci=Bun.YAML.parse(readFileSync(new URL('../.github/workflows/ci.yml',import.meta.url),'utf8')) as {jobs:{check:{steps:Step[]}}};
 const smokeSteps=ci.jobs.check.steps;
 const stage=smokeSteps.findIndex(step=>step.run?.includes('scripts/verify-example-seals.ts --stage'));
 const pack=smokeSteps.findIndex(step=>step.run?.includes('x="$(npm pack . --pack-destination .)"'));
 expect(stage).toBeGreaterThan(-1);
 expect(pack).toBeGreaterThan(stage);
 expect(smokeSteps[stage]!.run).toContain('--stage "$RUNNER_TEMP/create-example-source"');
 expect(smokeSteps[pack]!['working-directory']).toBe('${{ runner.temp }}/create-example-source');
 expect(smokeSteps[pack]!.run).toContain('x="$(npm pack . --pack-destination .)"\nbun scripts/verify-example-seals.ts --tarball "$x"\nnpm publish "$x" --dry-run --provenance --access public');
});

for(const [label,mutate] of Object.entries<(copy:Workflow)=>void>({
 'alias gate checks the scoped tarball instead of its own output':copy=>{const alias=copy.jobs.publish.steps.find(step=>step.name==='Publish the alias rig-create')!;alias.run=alias.run!.replace(aliasGate,'bun scripts/verify-example-seals.ts --tarball "$SCOPED_TARBALL"');},
 'alias gate follows publication':copy=>{const alias=copy.jobs.publish.steps.find(step=>step.name==='Publish the alias rig-create')!;alias.run=alias.run!.replace(aliasGate+'\n','')+aliasGate+'\n';},
 'stored npm token':copy=>{copy.jobs.publish.steps.push({env:{NODE_AUTH_TOKEN:'${{ secrets.NPM_TOKEN }}'}});},
 'self-hosted publisher':copy=>{copy.jobs.publish['runs-on']='self-hosted';},
 'branch push trigger':copy=>{(copy.on as {push:unknown}).push={branches:['main']};},
 'reintroduced release-please step':copy=>{copy.jobs.release.steps.unshift({id:'release',uses:'googleapis/release-please-action@v4'});},
 'write permissions on selector job':copy=>{copy.jobs.release.permissions={contents:'write'};},
 'checkout restricted to workflow_dispatch':copy=>{copy.jobs.release.steps[0]!.if="${{ github.event_name == 'workflow_dispatch' }}";},
 'publish checks out mutable tag instead of validated SHA':copy=>{copy.jobs.publish.steps[0]!.with={ref:'${{ needs.release.outputs.tag }}'};},
})){
 test(`policy check rejects planted ${label}`,()=>{
  const copy=structuredClone(workflow);
  mutate(copy);
  expect(()=>checkWorkflowPolicy(copy)).toThrow();
 });
}

test('manual version tag push resolves commit, verifies main ancestry, exact tagged package version and registry check',()=>{
 const result=resolveTag('push-normal');
 expect(result.exitCode).toBe(0);expect(result.outputs).toEqual({publish:'true',tag,sha:commitSha});
 expect(result.calls).toEqual(expectedResolutionCalls());
});

test('push tag resolution error fails closed even if an API error emits a plausible SHA',()=>{
 const result=resolveTag('api-error',{apiExit:1});
 refused(result,'RELEASE_TAG_UNRESOLVED');expect(result.output).toBe('');onlyCommitLookup(result.calls);
});

for(const [name,apiOutput] of [['empty',''],['null','null'],['short',commitSha.slice(0,7)],['multiline',`${commitSha}\n${oldSha}`],['object','{"sha":"bad"}']]){
 test(`push refuses ${name} commit resolution`,()=>{
  const result=resolveTag(`invalid-sha-${name}`,{apiResponses:{
   [`repos/rig-c/create/commits/refs%2Ftags%2F${tag}`]:{status:200,body:JSON.stringify({sha:name==='null'?null:apiOutput})},
  }});
  refused(result,'RELEASE_TAG_UNRESOLVED');expect(result.output).toBe('');onlyCommitLookup(result.calls);
 });
}

for(const [name,fixture,code,callCount] of [
 ['non-tag-ref',{ref:'refs/heads/main'},'RELEASE_REF_NOT_TAG',0],
 ['unsupported-event',{event:'pull_request'},'RELEASE_REF_NOT_TAG',0],
 ['traversal-tag',{ref:'refs/tags/../heads/main'},'RELEASE_TAG_FORM',0],
 ['prerelease-tag',{ref:'refs/tags/v0.11.1-rc.1'},'RELEASE_TAG_FORM',0],
 ['leading-zero-tag',{ref:'refs/tags/v01.11.1'},'RELEASE_TAG_FORM',0],
 ['unprefixed-tag',{ref:'refs/tags/0.11.1'},'RELEASE_TAG_FORM',0],
 ['run-sha-mismatch',{runSha:oldSha},'PROVENANCE_SHA_MISMATCH',1],
 ['tag-not-commit',{tagExit:1},'RELEASE_TAG_NOT_ON_MAIN',2],
 ['local-tag-sha-mismatch',{localTagSha:oldSha},'PROVENANCE_SHA_MISMATCH',2],
 ['missing-main',{mainExit:1},'RELEASE_TAG_NOT_ON_MAIN',3],
 ['not-on-main',{ancestorExit:1},'RELEASE_TAG_NOT_ON_MAIN',4],
 ['missing-package-json',{packageExit:1},'RELEASE_TAG_VERSION_MISMATCH',5],
 ['invalid-package-json',{packageJson:'{not-json'},'RELEASE_TAG_VERSION_MISMATCH',5],
 ['wrong-package-name',{packageJson:JSON.stringify({name:'@rig-c/other',version:'0.11.1'})},'RELEASE_TAG_VERSION_MISMATCH',5],
 ['version-mismatch',{packageJson:JSON.stringify({name:'@rig-c/create',version:'0.11.0'})},'RELEASE_TAG_VERSION_MISMATCH',5],
 ['already-published',{served:'0.11.1'},'RELEASE_ALREADY_PUBLISHED',6],
] as const){
 test(`push refuses ${name} before publish=true`,()=>{
  const result=resolveTag(`push-${name}`,fixture);
  refused(result,code);expect(result.calls).toHaveLength(callCount);
 });
}

test('dispatch on the tag resolves commit, main ancestry, tagged package version and registry check without requiring a GitHub release',()=>{
 const result=resolveTag('dispatch-success',{event:'workflow_dispatch'});
 expect(result.exitCode).toBe(0);expect(result.outputs).toEqual({publish:'true',tag,sha:commitSha});
 expect(result.calls).toEqual(expectedResolutionCalls());
});

for(const [name,fixture,code,callCount] of [
 ['invalid-tag',{inputTag:'main'},'RELEASE_TAG_FORM',0],
 ['prerelease-tag',{inputTag:'v0.11.1-rc.1'},'RELEASE_TAG_FORM',0],
 ['leading-zero-tag',{inputTag:'v01.11.1'},'RELEASE_TAG_FORM',0],
 ['branch-dispatch-ref',{ref:'refs/heads/main'},'RELEASE_REF_NOT_TAG',0],
 ['other-tag-dispatch-ref',{ref:'refs/tags/v0.11.0'},'RELEASE_REF_NOT_TAG',0],
 ['api-unresolved',{apiExit:1},'RELEASE_TAG_UNRESOLVED',1],
 ['run-sha-mismatch',{runSha:oldSha},'PROVENANCE_SHA_MISMATCH',1],
 ['tag-not-commit',{tagExit:1},'RELEASE_TAG_NOT_ON_MAIN',2],
 ['local-tag-sha-mismatch',{localTagSha:oldSha},'PROVENANCE_SHA_MISMATCH',2],
 ['missing-main',{mainExit:1},'RELEASE_TAG_NOT_ON_MAIN',3],
 ['not-on-main',{ancestorExit:1},'RELEASE_TAG_NOT_ON_MAIN',4],
 ['missing-package-json',{packageExit:1},'RELEASE_TAG_VERSION_MISMATCH',5],
 ['invalid-package-json',{packageJson:'{not-json'},'RELEASE_TAG_VERSION_MISMATCH',5],
 ['wrong-package-name',{packageJson:JSON.stringify({name:'@rig-c/other',version:'0.11.1'})},'RELEASE_TAG_VERSION_MISMATCH',5],
 ['version-mismatch',{packageJson:JSON.stringify({name:'@rig-c/create',version:'0.11.0'})},'RELEASE_TAG_VERSION_MISMATCH',5],
 ['already-published',{served:'0.11.1'},'RELEASE_ALREADY_PUBLISHED',6],
] as const){
 test(`dispatch refuses ${name} before publish=true`,()=>{
  const result=resolveTag(`dispatch-${name}`,{event:'workflow_dispatch',...fixture});
  refused(result,code);expect(result.calls).toHaveLength(callCount);
  if(name==='run-sha-mismatch'){
   expect(result.text).toContain(oldSha);expect(result.text).toContain(commitSha);expect(result.text).toContain(`--ref ${tag}`);
   expect(result.calls.some(call=>call.command==='npm')).toBe(false);
  }
 });
}
