/** Immutable direction publication; project.json is the single commit point. */
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { asArray, checkProject, collectItems, loadCollection, isObject, type Finding } from './check.ts';
import { CURRENT_DIRECTION_PATH, prepareCurrentDirection } from './current-direction.ts';
import { DIRECTION_CONTRACT, DirectionError, checkDirections, directionBytes, directionContract, directionFail, directionHash, directionIdleBytes, directionIdlePath, directionJson, directionPath, directionVersion, objects, readDirection, requireDirectionScene, validateDirectionCitations, validateDirectionRig, validateDirectionScene, validateDirectionShape } from './direction.ts';
import { DIRECTION_COMPOSE_SPEC, validateComposeDirection } from './direction-compose.ts';
import { assembleOnlyDraftPath, assembleOnlyDraftTarget, assertDraftHasRig, readAssembleOnlyDraftTarget } from './draft-layout.ts';
import { freezeCompose, rollbackComposeDirectories } from './direction-compose-writer.ts';
import { writeDirectionSpec } from './direction-spec-write.ts';
import { sceneBytes, SceneError } from './scene.ts';
import { refuse, USAGE_EXIT } from './refusal.ts';
import { baselineOf, newFindings } from './refusal-baseline.ts';
import { parseFeedbackAnswers } from './feedback.ts';
import type { CommandResult } from './interview.ts';
import { commitProjectStep } from './project-step-commit.ts';
import { handoff } from './review.ts';
import { acquireBoundJobWrite, beginJobProgress } from './job-writer.ts';
import type { JsonObject } from './templates.ts';

export const DIRECTION_HELP = `direction --adopt [<dir>]
direction write <N> [<dir>] --file <retained JSON> --rig <R> [--compose-out <dir>] [--compose-scene <file>] [--answers <version>:<verdict>]
direction check <N> [<dir>] [--json]
  Documents are immutable evidence/direction/v<N>.json. No rendering or producer builds.
  --file is a retained, non-ignored project-relative path.
  A bounced predecessor needs --answers <version>:<verdict> on write.
direction write [<dir>] --file <retained intent JSON>
  Write specs/direction/direction.json with current rig and scene bindings and the cited take.
  The intent contains {take, citations}. Record the green compose output with record direction.`;
function usage(why:string):never {refuse('DIRECTION_USAGE',`direction: ${why}; ${DIRECTION_HELP}`,USAGE_EXIT);}
function ownValidation(dir:string,project:JsonObject,now:number):void {const refusals:Finding[]=[];checkDirections({dir,project,refusals},now);if(refusals[0]){const f=refusals[0];directionFail(f.code,f.path,f.message);}}
function prospective(dir:string,before:JsonObject,next:JsonObject,now:number):void {
  const f=newFindings(baselineOf(checkProject(dir,before,{now})),checkProject(dir,next,{now}).refusals)[0];if(f)directionFail(f.code,f.path,f.message);
}
/** A narrow seam for fault-injected transaction tests; CLI never supplies a hook. */
export interface DirectionWriteHooks { beforeCommit?:()=>void; }
export function directionCommand(args:string[],now:number,hooks:DirectionWriteHooks={}):CommandResult {
  try {
    if (args[0] === 'write' && !args.some(arg => ['--rig', '--compose-out', '--compose-scene', '--answers', '--patch-file'].includes(arg) || arg.startsWith('--patch-file='))
      && !/^[0-9]+$/.test(args[1] ?? '')) return writeCurrentDirection(args.slice(1), hooks);
    return command(args,now,hooks);
  } catch(e){if(e instanceof SceneError && e.code === 'DIRECTION_SOURCE_CHANGED') refuse(e.code,e.message);if(e instanceof DirectionError)refuse(e.code,e.code==='FEEDBACK_UNANSWERED'?`${e.message}; retry direction write with --answers <version>:<verdict> naming the bounced verdict`:e.message,e.code==='DIRECTION_USAGE'?USAGE_EXIT:1);throw e;}
}

function writeCurrentDirection(args: string[], hooks: DirectionWriteHooks): CommandResult {
  let input: string | undefined;
  let root: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--file' && input === undefined) {
      input = args[++i];
      if (!input || input.startsWith('-')) return usage('--file requires a retained intent JSON');
    } else if (arg.startsWith('-') || root !== undefined) return usage(`unexpected argument ${arg}`);
    else root = arg;
  }
  if (!input) return usage('write requires --file <retained intent JSON>');
  const dir = resolve(root ?? process.cwd());
  writeDirectionSpec(dir, CURRENT_DIRECTION_PATH, 'DIRECTION_SOURCE_CHANGED', snapshots => {
    const project = directionJson(sceneBytes(dir, 'project.json', 'DIRECTION_SOURCE_CHANGED', snapshots), 'project.json');
    if (project.schema !== 'rig-create/project@0') directionFail('DIRECTION_SCHEMA', 'project.json.schema', 'expected rig-create/project@0');
    const bytes = directionBytes(dir, input);
    snapshots.set(input, bytes);
    return prepareCurrentDirection(dir, project, directionJson(bytes, input), snapshots);
  }, hooks.beforeCommit);
  const stderr = commitProjectStep(dir, 'direction', ['direction', 'write', ...args].join(' '), CURRENT_DIRECTION_PATH);
  return { stdout: `direction: ${CURRENT_DIRECTION_PATH} written`, exit: 0, ...(stderr ? { stderr } : {}) };
}
function command(args:string[],now:number,hooks:DirectionWriteHooks):{stdout:string;exit:number} {
  if(args[0]==='patch'||args.some(arg=>arg==='--patch-file'||arg.startsWith('--patch-file=')))refuse('DIRECTION_PATCH_FILE_REMOVED','project.json.versions: direction patch and --patch-file were removed; record direction feedback as a review verdict and publish the revised post with direction write <N> --file <direction.json> --rig <R> --answers <version>:<verdict>',USAGE_EXIT);
  const action=args[0];const positional:string[]=[];const opts:Record<string,string>={};const answerValues:string[]=[];let json=false;
  for(let i=1;i<args.length;i++){const arg=args[i] as string;if(arg==='--answers'){const value=args[++i];if(!value||value.startsWith('--'))usage('--answers needs version:verdict');answerValues.push(value);}else if(arg==='--json'){if(json)usage('duplicate json');json=true;}else if(['--file','--rig','--compose-out','--compose-scene'].includes(arg)){const value=args[++i];if(!value||value.startsWith('--')||opts[arg]!==undefined)usage(`invalid ${arg}`);opts[arg]=value;}else if(arg.startsWith('-'))usage(`unknown ${arg}`);else positional.push(arg);}
  if(!['--adopt','write','check'].includes(action??'')||positional.length>(action==='--adopt'?1:2))usage('unknown action/directory count');
  const dir=resolve(positional[action==='--adopt'?0:1]??process.cwd());
  const n=Number(positional[0]);
  if(action!=='--adopt'&&(!Number.isSafeInteger(n)||n<1)){
    if(action==='check') assertDraftHasRig(readAssembleOnlyDraftTarget(dir, positional[0]), 'project.json.versions');
    usage('N must be positive integer');
  }
  if(action==='write' ? !opts['--file']||!opts['--rig'] : Object.keys(opts).length>0)usage('flags do not match action');
  if(answerValues.length && action!=='write')usage('--answers is write-only');
  if(json&&action!=='check')usage('json is check-only');
  // Root selected by the caller; record itself is still a literal regular file.
  const rollbackCompose: string[] = []; let verifyCompose: (() => void) | undefined; let composeInventory: JsonObject[] = [];
  const file=join(dir,'project.json');const original=directionBytes(dir,'project.json');const project=directionJson(original,'project.json');
  if(project.schema!=='rig-create/project@0')directionFail('DIRECTION_SCHEMA','project.json.schema','expected rig-create/project@0');
  if (action === 'write') {
    const source = assembleOnlyDraftTarget(project, opts['--rig']) ?? assembleOnlyDraftPath(dir, project, opts['--rig'])
      ?? assembleOnlyDraftPath(dir, project, opts['--compose-out']);
    assertDraftHasRig(source, 'direction.rig');
  }
  const collectionRoot=basename(dirname(dir))==='members'?dirname(dirname(dir)):null;
  const collectionBytes=collectionRoot&&existsSync(join(collectionRoot,'collection.json'))?directionBytes(collectionRoot,'collection.json'):null;
  if(action==='check'){
    const v=directionVersion(project,n);if(v.kind!=='post')directionFail('DIRECTION_VERSION','versions','direction check needs a post');
    const errors:Finding[]=[];checkDirections({dir,project,refusals:errors},now,n);if(errors[0])directionFail(errors[0].code,errors[0].path,errors[0].message);
    const doc=readDirection(dir,project,n,false);
    return{stdout:json?JSON.stringify({schema:'rig-create/direction-check@1',post:n,direction:(v.provenance as JsonObject).direction,document:doc}):`direction: v${n} valid`,exit:0};
  }
  const lock=join(dir,'.direction.lock');let fd:number;
  try{fd=openSync(lock,'wx');}catch{directionFail('DIRECTION_SOURCE_CHANGED','project.json','another direction writer holds the lock');}
  let published:string|null=null;const staged:string[]=[];
  let releasePublication = () => {};
  let progress: ReturnType<typeof beginJobProgress>;
  try{
    releasePublication = acquireBoundJobWrite(dir);
    // The first milestone waits for the job gate: a refused write leaves the project untouched.
    if (action === 'write') progress = beginJobProgress(dir, 'build', 'Preparing the direction post');
    const next=structuredClone(project);const contract=directionContract(project,now);
    let bytes:Buffer|undefined;let doc:JsonObject|undefined;const snapshots=new Map<string,Buffer>([['project.json',original]]);
    const snapshot=(path:string):Buffer=>{const value=directionBytes(dir,path);snapshots.set(path,value);return value;};
    if(action==='--adopt'){
      if(contract)return{stdout:'direction: already adopted; original adoption preserved',exit:0};
      next.direction_contract={schema:DIRECTION_CONTRACT,adopted_at:new Date(now).toISOString(),grandfathered_posts:objects(project.versions).filter(v=>v.kind==='post').map(v=>v.n as number).sort((a,b)=>a-b)};
    }else{
      if(!contract)directionFail('DIRECTION_CONTRACT_INVALID','direction_contract','adopt direction explicitly first');
      if(objects(project.versions).some(v=>Number(v.n)>=n))directionFail('DIRECTION_VERSION','versions','new post number must be unique and later than all versions');
      const answersFeedback=parseFeedbackAnswers(project,n,answerValues);
      bytes=snapshot(opts['--file'] as string);doc=directionJson(bytes,opts['--file'] as string);
      if (doc.schema === DIRECTION_COMPOSE_SPEC) {
        if (!isObject(doc.rig) || doc.rig.version !== Number(opts['--rig'])) directionFail('DIRECTION_RIG_UNKNOWN', 'direction.rig', '--rig must name the document rig');
        const frozen = freezeCompose(dir, project, doc, n, Number(opts['--rig']), opts, rollbackCompose);
        doc = frozen.doc; composeInventory = frozen.inventory; verifyCompose = frozen.verify;
        bytes = Buffer.from(`${JSON.stringify(doc, null, 2)}\n`);
      } else if (opts['--compose-out'] || opts['--compose-scene']) usage('compose flags require direction@3');
      validateDirectionShape(doc);
      if(!Number.isSafeInteger(Number(opts['--rig']))||Number(opts['--rig'])!==(doc.rig as JsonObject).version)directionFail('DIRECTION_RIG_UNKNOWN','direction.rig','--rig must name the document rig');
      // Retain the option evidence read by the citation validator, not only the project bytes.
      const citationGuides = ['camera_depth','post_timing', ...(doc.schema === DIRECTION_COMPOSE_SPEC ? ['post_composition'] : [])];
      for(const item of collectItems(project,{collection:loadCollection(dir)}).filter(i=>citationGuides.includes(i.id))){
        const answers=[item.raw,...asArray(item.record.history)];
        if(item.state.state==='user'||item.state.state==='delegated')answers.push(item.state.answer);
        for(const answer of answers)if(isObject(answer)&&isObject(answer.choice)&&isObject(answer.choice.set)&&typeof answer.choice.set.path==='string')snapshot(answer.choice.set.path);
      }
      requireDirectionScene(doc, now, 'direction.schema');
      validateDirectionScene(dir, project, doc, true, snapshots);
      if (doc.schema === DIRECTION_COMPOSE_SPEC) validateComposeDirection(dir, project, doc, { current: true, snapshots, pendingInventory: composeInventory });
      else validateDirectionRig(dir,project,doc,true);
      validateDirectionCitations(dir,project,doc,true);
      handoff(dir,Number((doc.rig as JsonObject).version),now);
      if (doc.schema !== DIRECTION_COMPOSE_SPEC) snapshot(String(((doc.rig as JsonObject).model as JsonObject).path));

      const binding={path:directionPath(n),sha256:directionHash(bytes)};
      const version:JsonObject={n,kind:'post',rig_version:(doc.rig as JsonObject).version as number,at:new Date(now).toISOString(),built_by:'agent',built_with:{create:String(doc.schema).slice('rig-create/'.length)},changed:'Authored camera and timing direction',outputs:[binding],evidence:[],verdicts:[],answers_feedback:answersFeedback,review_origin:null,provenance:{config:binding,direction:binding,sections:{camera:[{entry:'camera',...((doc.citations as JsonObject).camera as JsonObject)}],timing:[{entry:'timing',...((doc.citations as JsonObject).timing as JsonObject)}]}}};
      if (doc.schema === DIRECTION_COMPOSE_SPEC) { version.changed = 'Composed idle direction'; version.outputs = [binding, ...composeInventory, (doc.compose as JsonObject).scene!]; }
      next.versions=[...asArray(next.versions),version];
      // Validate using the exact staged bytes at their final immutable path, before committing the record.
      const parent=dirname(join(dir,binding.path));let current=dir;
      for(const part of ['evidence','direction']){current=join(current,part);if(existsSync(current)){if(!lstatSync(current).isDirectory()||lstatSync(current).isSymbolicLink())directionFail('DIRECTION_FILE',binding.path,'document parent must be a real directory');}else{mkdirSync(current);if(doc.schema===DIRECTION_COMPOSE_SPEC)rollbackCompose.push(current);}}
      if(existsSync(join(dir,binding.path)))directionFail('DIRECTION_SOURCE_CHANGED',binding.path,'immutable document already exists');
      const temp=join(parent,`.direction-${crypto.randomUUID()}.tmp`);staged.push(temp);writeFileSync(temp,bytes,{flag:'wx'});renameSync(temp,join(dir,binding.path));published=join(dir,binding.path);
    }
    progress?.('Validating the direction post', { i: 1, n: 2 });
    ownValidation(dir,next,now);prospective(dir,project,next,now);
    hooks.beforeCommit?.();
    verifyCompose?.();
    if(collectionRoot && collectionBytes && !directionBytes(collectionRoot,'collection.json').equals(collectionBytes))directionFail('DIRECTION_SOURCE_CHANGED','collection.json','inherited answer context changed during publication');
    // The scene's idle frames are re-read through the record binding that admitted them, not as a retained path.
    for(const[path,expected]of snapshots)if(!(doc?.schema === DIRECTION_COMPOSE_SPEC ? sceneBytes(dir,path,'DIRECTION_SOURCE_CHANGED') : doc&&directionIdlePath(path)?directionIdleBytes(dir,project,Number((doc.rig as JsonObject).version),{path,sha256:directionHash(expected)}):directionBytes(dir,path)).equals(expected))directionFail('DIRECTION_SOURCE_CHANGED',path,'source bytes changed during publication');
    if(bytes&&doc){const target=directionPath(n);if(!directionBytes(dir,target).equals(bytes))directionFail('DIRECTION_SOURCE_CHANGED',target,'published document changed before commit');}
    const recordBytes = Buffer.from(`${JSON.stringify(next,null,2)}\n`);
    const temp=join(dir,`.direction-${crypto.randomUUID()}.tmp`);staged.push(temp);writeFileSync(temp,recordBytes,{flag:'wx'});renameSync(temp,file);published=null;rollbackCompose.length=0;
    progress?.('Direction post committed without publishing', { i: 2, n: 2 });
    return{stdout:action==='--adopt'?'direction: adopted; historical posts preserved':`direction: v${n} committed without publishing; stage unchanged`,exit:0};
  }finally{if(published)rmSync(published,{force:true});for(const path of staged)rmSync(path,{force:true});rollbackComposeDirectories(dir,n,rollbackCompose);closeSync(fd);rmSync(lock);releasePublication();}
}
