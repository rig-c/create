/** Reproduce review's wire fixtures and negative controls through public record writers. */
import { setSystemTime } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { generateExampleOrder } from './generate-example-order.ts';
import { asArray, checkProject, collectItems, isObject } from '../src/check.ts';
import { sha256 } from '../src/choices.ts';
import { interviewAnswerCommand, interviewOptionsCommand } from '../src/choice-writers.ts';
import { signoffCommand } from '../src/signoff.ts';
import { Refusal } from '../src/refusal.ts';
import type { Json, JsonObject } from '../src/templates.ts';
const objects=(v:Json|undefined):JsonObject[]=>asArray(v).filter(isObject);
const obj=(v:Json|undefined):JsonObject=>v as JsonObject;

export function generateExampleChoices(dir:string): Record<string,string> {
  const generated=generateExampleOrder(dir);const p=generated.project;
  const entry:JsonObject={schema:'rig-create/interview-choice-fixture@1',project:'example-project.json',examples:collectItems(p,{collection:null}).map(i=>({question:i.id,answer:i.raw,options:obj(obj(i.raw).choice).set as Json})),scenarios:[]};
  const files:Record<string,string>={};
  for(const[path,bytes]of Object.entries(generated.files))if(path.startsWith('evidence/interview/') && typeof bytes === 'string')files[`example-interview-options/${path.slice('evidence/interview/'.length)}`]=bytes;
  const load=():JsonObject=>JSON.parse(readFileSync(join(dir,'project.json'),'utf8'));
  const item=(project:JsonObject,q:string)=>collectItems(project,{collection:null}).find(i=>i.id===q)!;
  const save=(project:JsonObject):void=>writeFileSync(join(dir,'project.json'),JSON.stringify(project,null,2)+'\n');
  const source=structuredClone(p);source.stage='interview';source.signoffs=[];source.versions=[];
  for(const s of objects(obj(source.plan).steps))s.status='pending';
  for(const i of collectItems(source,{collection:null}))if(i.kind==='post'||['bones','meshes','constraints','motion'].includes(i.id))i.record.guide=null;
  save(source);
  const keep=(q:string,id:string,minute:string):{path:string;sha256:string;set:JsonObject}=>{
    const old=obj(obj(item(p,q).raw).choice).set as JsonObject;
    const set=JSON.parse(readFileSync(join(dir,String(old.path)),'utf8')) as JsonObject;set.id=id;set.drafted_at=`2026-11-10T14:${minute}:00Z`;
    const path=`evidence/interview/${id}.json`;const bytes=JSON.stringify(set,null,2)+'\n';writeFileSync(join(dir,path),bytes);files[`example-interview-options/${id}.json`]=bytes;
    setSystemTime(new Date(`2026-11-10T14:${minute}:30Z`));interviewOptionsCommand([q,dir,'--file',path]);return{path,sha256:sha256(Buffer.from(bytes)),set};
  };
  const scenarios=entry.scenarios as Json[];
  try{
    const binding=keep('reference','other-pending','10');
    const picks={schema:'rig-review/interview-picks@1',set:{path:binding.path,sha256:binding.sha256},picks:[{ask:'reference',option_id:'other',other_text:'다른 방향\nKeep the final spaces.  \ne\u0301'}],by:'user',at:'2026-11-10T14:11:00.000Z'};
    const picksPath='evidence/interview/other-picks.json';const picksBytes=JSON.stringify(picks,null,2)+'\n';writeFileSync(join(dir,picksPath),picksBytes);files['example-interview-options/other-picks.json']=picksBytes;
    setSystemTime(new Date(picks.at));const pending=JSON.parse(interviewAnswerCommand(['reference',dir,'--picks-file',picksPath])) as JsonObject;
    writeFileSync(join(dir,'approval.txt'),'Approve');setSystemTime(new Date('2026-11-10T16:10:00Z'));
    const before=readFileSync(join(dir,'project.json'));let approval='';try{signoffCommand(['interview',dir,'--by','user','--verbatim-file',join(dir,'approval.txt')]);}catch(e){if(!(e instanceof Refusal))throw e;approval=e.code;}
    if(approval!=='INTERVIEW_CHOICE_REQUIRED'||!before.equals(readFileSync(join(dir,'project.json'))))throw Error('pending Other approval control failed');
    scenarios.push({name:'other-pending-picks-file',picks_file:'example-interview-options/other-picks.json',answer:pending,approval_refusal:approval});
    const explicit=keep('reference','other-explicit','12');writeFileSync(join(dir,'other.txt'),String(picks.picks[0]?.other_text));writeFileSync(join(dir,'other-fragment.json'),JSON.stringify('custom reference'));
    const answered=JSON.parse(interviewAnswerCommand(['reference',dir,'--set',explicit.path,'--sha256',explicit.sha256,'--by','user','--pick','reference=other','--other',`reference=${join(dir,'other.txt')}`,'--other-fragment',`reference=${join(dir,'other-fragment.json')}`])) as JsonObject;
    scenarios.push({name:'other-explicit-multiline',answer:answered});
    const assembly=keep('assemble','constraint','13');const asks=objects(assembly.set.asks);const flags=asks.flatMap(a=>['--pick',`${String(a.id)}=${a.id==='ground'?'alternative':'keep'}`]);const sealed=readFileSync(join(dir,'project.json'));let constraint='';
    try{interviewAnswerCommand(['assemble',dir,'--set',assembly.path,'--sha256',assembly.sha256,'--by','user',...flags]);}catch(e){if(!(e instanceof Refusal))throw e;constraint=e.code;}
    if(constraint!=='INTERVIEW_CHOICE_CONSTRAINT'||!sealed.equals(readFileSync(join(dir,'project.json'))))throw Error('constraint control failed');
    const allowed=JSON.parse(interviewAnswerCommand(['assemble',dir,'--set',assembly.path,'--sha256',assembly.sha256,'--by','user',...asks.flatMap(a=>['--pick',`${String(a.id)}=alternative`])])) as JsonObject;
    scenarios.push({name:'constraint',refused:constraint,allowed});
    const rig=keep('rig_type','fullscreen','14');const full=JSON.parse(interviewAnswerCommand(['rig_type',dir,'--set',rig.path,'--sha256',rig.sha256,'--by','user','--pick','rig_type=alternative'])) as JsonObject;
    const cg=load();cg.versions=structuredClone(p.versions as Json);save(cg);const cgCodes=checkProject(dir).refusals.filter(f=>f.code.startsWith('CG_')).map(f=>f.code);
    if(!cgCodes.length)throw Error('fullscreen choice did not reach CG gates');
    scenarios.push({name:'fullscreen-gates',answer:full,refusals:cgCodes});
    scenarios.push({name:'character-gates',answer:item(p,'rig_type').raw,cg_refusals:checkProject(dir,p).refusals.filter(f=>f.code.startsWith('CG_')).map(f=>f.code)});
    files['example-interview-choice.json']=JSON.stringify(entry,null,2)+'\n';
    return files;
  }finally{save(p);setSystemTime();}
}
if(import.meta.main){
  const[destination,flag]=process.argv.slice(2);if(!destination||(flag!==undefined&&flag!=='--check'))throw Error('usage: generate-example-choices.ts <fresh dir> [--check]');
  const files=generateExampleChoices(resolve(destination));const root=join(import.meta.dir,'../templates');
  for(const[path,bytes]of Object.entries(files)){const file=join(root,path);if(flag==='--check'){if(readFileSync(file,'utf8')!==bytes)throw Error(`${path}: choice fixture differs`);}else{mkdirSync(dirname(file),{recursive:true});writeFileSync(file,bytes);}}
  console.log('choice snapshots, public-writer answers and negative controls reproduce');
}
