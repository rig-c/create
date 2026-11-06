/** Tiny staged synthetic input, not a rendered or producer-checked rig. */
import { setSystemTime } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { correctionCommand } from '../src/correction-writers.ts';
import { directionCommand } from '../src/direction-writers.ts';
import { DIRECTION_SPEC, directionHash } from '../src/direction.ts';
import { signoffCommand } from '../src/signoff.ts';
import { readTemplate, type JsonObject } from '../src/templates.ts';

export const CAMERA_WORDS='Hold the centered rectangle, then tighten the view slightly.';
export const TIMING_WORDS='Use a four-second take without repeating it.';
export function directionFixture(dir:string):{doc:JsonObject;save:(p:JsonObject)=>void;load:()=>JsonObject} {
  mkdirSync(dir,{recursive:true});
  const save=(p:JsonObject):void=>writeFileSync(join(dir,'project.json'),`${JSON.stringify(p,null,2)}\n`);
  const load=():JsonObject=>JSON.parse(readFileSync(join(dir,'project.json'),'utf8'));
  const file=(path:string,text:string):JsonObject=>{mkdirSync(dirname(join(dir,path)),{recursive:true});writeFileSync(join(dir,path),text);return{path,sha256:directionHash(Buffer.from(text))};};
  const model=file('derived/review/v1/out/check/build/skeleton.model.json','{"synthetic":true}\n');
  const config=file('evidence/rig-config.json','{}\n');
  const template=readTemplate('project.json');
  const p:JsonObject={schema:template.schema as string,name:'synthetic-direction',stage:'post',stage_values:template.stage_values as string[],inputs:{},interview:{held:true,post:{held:true,items:[['camera_depth',CAMERA_WORDS,{camera:'push_in',depth:false}],['post_timing',TIMING_WORDS,{duration:4,loop:false}]].map(([id,words,value])=>({id:id as string,config:[],text:'Synthetic question',guide:{delegated:false,by:'user',at:'2026-11-04T08:00:00Z',verbatim:words as string,value:value as JsonObject,asks:[{id:id as string,state:'user'}]}}))}},plan:{steps:['camera','timing'].map((id,i)=>({id,phase:'post',order:i+1,does:'Author direction',produces:'direction document',rests_on:[id==='camera'?'camera_depth':'post_timing'],bar:'typed direction keys validate',checkpoint_proposed:false,checkpoint:{delegated:false,by:'user',at:'2026-11-04T08:00:00Z',verbatim:'No checkpoint',value:false}}))},signoffs:[{stage:'rig-review',checkpoint:null,by:'user',at:'2026-11-04T08:30:00Z',verbatim:'Accept the synthetic rig'}],versions:[{n:1,kind:'rig',rig_version:null,at:'2026-11-04T08:00:00Z',provenance:{config,sections:{}},review_package:{config,files:[{path:'out/check/build/skeleton.model.json',sha256:model.sha256 as string}]},evidence:[{kind:'still',path:'evidence/still.png',sha256:'a'.repeat(64),camera:'fixed',frame:'setup'}],verdicts:[{review:'rig-review',verdict:'accepted',by:'user',at:'2026-11-04T08:30:00Z',verbatim:'Accept the synthetic rig'}]}]};
  save(p);file('approval.txt','Approve the camera and timing steps.\n');file('words.txt','Tighten the final framing.\n');file('reasoning.txt','Validated the authored direction patch against its exact base.\n');
  setSystemTime(new Date('2026-11-04T09:00:00Z'));
  signoffCommand(['post-interview',dir,'--by','user','--steps','camera,timing','--verbatim-file',join(dir,'approval.txt')]);
  directionCommand(['--adopt',dir]);correctionCommand(['--adopt',dir]);
  const doc:JsonObject={schema:DIRECTION_SPEC,rig:{version:1,model},take:{duration:4,loop:false},camera:{space:'rig-world-y-up',keys:[{time:0,box:{x:-20,y:0,width:40,height:80},easing:'smoothstep'},{time:4,box:{x:-18,y:4,width:36,height:72},easing:'hold'}]},timing:{keys:[{time:0,source_time:0,easing:'linear'},{time:4,source_time:4,easing:'hold'}]},citations:{camera:{guide:'camera_depth',asks:['camera_depth'],quote:CAMERA_WORDS},timing:{guide:'post_timing',asks:['post_timing'],quote:TIMING_WORDS}}};
  file('evidence/input.json',`${JSON.stringify(doc,null,2)}\n`);
  return{doc,save,load};
}
