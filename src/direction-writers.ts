/** Immutable direction publication; project.json is the single commit point. */
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { asArray, checkProject, collectItems, collectSignoffs, loadCollection, isObject, type Finding } from './check.ts';
import { DIRECTION_CONTRACT, DirectionError, checkDirections, directionBinding, directionBytes, directionContract, directionFail, directionHash, directionJson, directionPath, directionVersion, objects, patchDirection, readDirection, requireDirectionScene, validateDirectionCitations, validateDirectionRig, validateDirectionScene, validateDirectionShape } from './direction.ts';
import { collectReopens, liveSignoff } from './reopen.ts';
import { refuse, USAGE_EXIT } from './refusal.ts';
import { countFindings, newFindings } from './refusal-baseline.ts';
import { handoff } from './review.ts';
import type { JsonObject } from './templates.ts';

export const DIRECTION_HELP = `direction --adopt [<dir>]
direction write <N> [<dir>] --file <retained JSON> --rig <R>
direction patch <N> [<dir>] --patch-file <retained direction-patch/1>
direction check <N> [<dir>] [--json]
  Documents are immutable evidence/direction/v<N>.json. No rendering or producer builds.
  Capture a made correction with correction record --direction-patch-file before patch ingestion;
  resolve it against the result post. Review exports patches, never invokes this writer.`;
function usage(why:string):never {refuse('DIRECTION_USAGE',`direction: ${why}; ${DIRECTION_HELP}`,USAGE_EXIT);}
function openReview(project:JsonObject):void {
  const reopens=collectReopens(project,[]);
  if(collectSignoffs(project,[]).some(s=>s.stage==='direction-review'&&s.checkpoint===null&&liveSignoff(reopens,s.stage,s.at)) || objects(project.versions).some(v=>objects(v.verdicts).some(d=>d.review==='direction-review'&&d.verdict==='accepted'&&liveSignoff(reopens,'direction-review',Date.parse(String(d.at))))))directionFail('DIRECTION_REVIEW_CLOSED','signoffs','reopen direction-review before authoring');
}
function ownValidation(dir:string,project:JsonObject,now:number):void {const refusals:Finding[]=[];checkDirections({dir,project,refusals},now);if(refusals[0]){const f=refusals[0];directionFail(f.code,f.path,f.message);}}
function prospective(dir:string,before:JsonObject,next:JsonObject,now:number):void {
  const f=newFindings(countFindings(checkProject(dir,before,{now}).refusals),checkProject(dir,next,{now}).refusals)[0];if(f)directionFail(f.code,f.path,f.message);
}
/** A narrow seam for fault-injected transaction tests; CLI never supplies a hook. */
export interface DirectionWriteHooks { beforeCommit?:()=>void; }
export function directionCommand(args:string[],now:number,hooks:DirectionWriteHooks={}):{stdout:string;exit:number} {
  try{return command(args,now,hooks);}catch(e){if(e instanceof DirectionError)refuse(e.code,e.message,e.code==='DIRECTION_USAGE'?USAGE_EXIT:1);throw e;}
}
function command(args:string[],now:number,hooks:DirectionWriteHooks):{stdout:string;exit:number} {
  const action=args[0];const positional:string[]=[];const opts:Record<string,string>={};let json=false;
  for(let i=1;i<args.length;i++){const arg=args[i] as string;if(arg==='--json'){if(json)usage('duplicate json');json=true;}else if(['--file','--rig','--patch-file'].includes(arg)){const value=args[++i];if(!value||value.startsWith('--')||opts[arg]!==undefined)usage(`invalid ${arg}`);opts[arg]=value;}else if(arg.startsWith('-'))usage(`unknown ${arg}`);else positional.push(arg);}
  if(!['--adopt','write','patch','check'].includes(action??'')||positional.length>(action==='--adopt'?1:2))usage('unknown action/directory count');
  const n=Number(positional[0]);if(action!=='--adopt'&&(!Number.isSafeInteger(n)||n<1))usage('N must be positive integer');
  if(action==='write' ? !opts['--file']||!opts['--rig']||Boolean(opts['--patch-file']) : action==='patch' ? !opts['--patch-file']||Boolean(opts['--file']||opts['--rig']) : Object.keys(opts).length>0)usage('flags do not match action');
  if(json&&action!=='check')usage('json is check-only');
  const dir=resolve(positional[action==='--adopt'?0:1]??process.cwd());
  // Root selected by the caller; record itself is still a literal regular file.
  const file=join(dir,'project.json');const original=directionBytes(dir,'project.json');const project=directionJson(original,'project.json');
  if(project.schema!=='rig-create/project@0')directionFail('DIRECTION_SCHEMA','project.json.schema','expected rig-create/project@0');
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
  try{
    const next=structuredClone(project);const contract=directionContract(project,now);
    let bytes:Buffer|undefined;let doc:JsonObject|undefined;const snapshots=new Map<string,Buffer>([['project.json',original]]);
    const snapshot=(path:string):Buffer=>{const value=directionBytes(dir,path);snapshots.set(path,value);return value;};
    if(action==='--adopt'){
      if(contract)return{stdout:'direction: already adopted; original adoption preserved',exit:0};
      next.direction_contract={schema:DIRECTION_CONTRACT,adopted_at:new Date(now).toISOString(),grandfathered_posts:objects(project.versions).filter(v=>v.kind==='post').map(v=>v.n as number).sort((a,b)=>a-b)};
    }else{
      if(!contract)directionFail('DIRECTION_CONTRACT_INVALID','direction_contract','adopt direction explicitly first');
      openReview(project);
      if(objects(project.versions).some(v=>Number(v.n)>=n))directionFail('DIRECTION_VERSION','versions','new post number must be unique and later than all versions');
      if(action==='write'){
        bytes=snapshot(opts['--file'] as string);doc=directionJson(bytes,opts['--file'] as string);validateDirectionShape(doc);
        if(!Number.isSafeInteger(Number(opts['--rig']))||Number(opts['--rig'])!==(doc.rig as JsonObject).version)directionFail('DIRECTION_RIG_UNKNOWN','direction.rig','--rig must name the document rig');
      }else{
        const patchBytes=snapshot(opts['--patch-file'] as string);const patch=directionJson(patchBytes,opts['--patch-file'] as string);
        const source=readDirection(dir,project,patch.source_post,true);const sourceVersion=directionVersion(project,patch.source_post);snapshot(String(((sourceVersion.provenance as JsonObject).direction as JsonObject).path));
        const latest=Math.max(0,...objects(project.versions).filter(v=>v.kind==='post').map(v=>Number(v.n)));
        if(patch.source_post!==latest)directionFail('DIRECTION_PATCH','direction.patch.source_post','patch must target current post');
        doc=patchDirection(project,source,patch);bytes=Buffer.from(`${JSON.stringify(doc,null,2)}\n`);
      }
      // Retain the option evidence read by the citation validator, not only the project bytes.
      for(const item of collectItems(project,{collection:loadCollection(dir)}).filter(i=>['camera_depth','post_timing'].includes(i.id))){
        const answers=[item.raw,...asArray(item.record.history)];
        if(item.state.state==='user'||item.state.state==='delegated')answers.push(item.state.answer);
        for(const answer of answers)if(isObject(answer)&&isObject(answer.choice)&&isObject(answer.choice.set)&&typeof answer.choice.set.path==='string')snapshot(answer.choice.set.path);
      }
      requireDirectionScene(doc, now, 'direction.schema');
      validateDirectionScene(dir, project, doc, true, snapshots);
      validateDirectionRig(dir,project,doc,true);validateDirectionCitations(dir,project,doc,true);
      handoff(dir,Number((doc.rig as JsonObject).version),now);
      snapshot(String(((doc.rig as JsonObject).model as JsonObject).path));

      const binding={path:directionPath(n),sha256:directionHash(bytes)};
      const version:JsonObject={n,kind:'post',rig_version:(doc.rig as JsonObject).version as number,at:new Date(now).toISOString(),built_by:'agent',built_with:{create:String(doc.schema).slice('rig-create/'.length)},changed:'Authored camera and timing direction',outputs:[binding],evidence:[],verdicts:[],answers_feedback:[],review_origin:null,provenance:{config:binding,direction:binding,sections:{camera:[{entry:'camera',...((doc.citations as JsonObject).camera as JsonObject)}],timing:[{entry:'timing',...((doc.citations as JsonObject).timing as JsonObject)}]}}};
      if(action==='patch'){const patch=directionJson(snapshots.get(opts['--patch-file'] as string) as Buffer,'direction.patch');version.direction_origin={source_post:patch.source_post as number,patch:directionBinding(dir,opts['--patch-file'] as string),result:binding};}
      next.versions=[...asArray(next.versions),version];
      // Validate using the exact staged bytes at their final immutable path, before committing the record.
      const parent=dirname(join(dir,binding.path));let current=dir;
      for(const part of ['evidence','direction']){current=join(current,part);if(existsSync(current)){if(!lstatSync(current).isDirectory()||lstatSync(current).isSymbolicLink())directionFail('DIRECTION_FILE',binding.path,'document parent must be a real directory');}else mkdirSync(current);}
      if(existsSync(join(dir,binding.path)))directionFail('DIRECTION_SOURCE_CHANGED',binding.path,'immutable document already exists');
      const temp=join(parent,`.direction-${crypto.randomUUID()}.tmp`);staged.push(temp);writeFileSync(temp,bytes,{flag:'wx'});renameSync(temp,join(dir,binding.path));published=join(dir,binding.path);
    }
    ownValidation(dir,next,now);prospective(dir,project,next,now);
    hooks.beforeCommit?.();
    if(collectionRoot && collectionBytes && !directionBytes(collectionRoot,'collection.json').equals(collectionBytes))directionFail('DIRECTION_SOURCE_CHANGED','collection.json','inherited answer context changed during publication');
    for(const[path,expected]of snapshots)if(!directionBytes(dir,path).equals(expected))directionFail('DIRECTION_SOURCE_CHANGED',path,'source bytes changed during publication');
    if(bytes&&doc){const target=directionPath(n);if(!directionBytes(dir,target).equals(bytes))directionFail('DIRECTION_SOURCE_CHANGED',target,'published document changed before commit');}
    const temp=join(dir,`.direction-${crypto.randomUUID()}.tmp`);staged.push(temp);writeFileSync(temp,`${JSON.stringify(next,null,2)}\n`,{flag:'wx'});renameSync(temp,file);published=null;
    return{stdout:action==='--adopt'?'direction: adopted; historical posts preserved':`direction: v${n} recorded; stage unchanged`,exit:0};
  }finally{if(published)rmSync(published,{force:true});for(const path of staged)rmSync(path,{force:true});closeSync(fd);rmSync(lock);}
}
