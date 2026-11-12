import { exampleTime } from './example-time.ts';
/** Synthetic authoring inputs; public writers alone construct the selected answer records. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { collectItems, isObject, asArray } from '../src/check.ts';
import { OPTIONS_SPEC, applicableAsks, optionContext } from '../src/choices.ts';
import { interviewAnswerCommand, interviewDecisionCommand, interviewOptionsCommand } from '../src/choice-writers.ts';
import { interviewStageOfGuide } from '../src/stages.ts';
import type { Json, JsonObject } from '../src/templates.ts';

/** Each writer runs at its declared example instant; `clock.now` is left at the last one, as the next writer's start. */
export function writeExampleChoices(dir: string, stage: string, clock: { now: number }): Record<string,string> {
  const load = (): JsonObject => JSON.parse(readFileSync(join(dir,'project.json'),'utf8')) as JsonObject;
  const records = collectItems(load(),{collection:null}).filter(i=>interviewStageOfGuide(i.id,i.kind==='post',true)===stage);
  const day = stage === 'interview' ? '2026-11-10T14:' : stage === 'rigging-interview' ? '2026-11-11T11:' : '2026-11-13T10:';
  const files: Record<string,string> = {};
  mkdirSync(join(dir,'evidence/interview'),{recursive:true});
  for (const item of records) {
    const project = load();
    const original = isObject(item.raw) ? item.raw : {};
    let value = original.delegated === true && isObject(original.agent_decision) ? original.agent_decision.value : original.value;
    if (item.id === 'post_composition') value = { ...(isObject(value) ? value : {}), scene: { background: { path: 'evidence/scene-background.png', rect: (JSON.parse(readFileSync(join(dir, 'derived/review/v2/out/check/build/skeleton.model.json'), 'utf8')) as JsonObject).stage! } } };
    // Rigging guides above were drafted at 11:00, so show the tailored option only after those words existed.
    const drafted = exampleTime(`${day}01:00Z`);
    const seed: JsonObject = {asks:[]};
    let names = applicableAsks(project,item,seed);
    // Source assembly offers core and visible, so explicitly include and constrain ground.
    if(item.id==='assemble' && !names.includes('ground')) names = [names[0] as string,'ground',...names.slice(1)];
    const fragments = new Map<string,Json>();
    for(const name of names) fragments.set(name,item.kind !== 'waypoint' ? value ?? 'none' : {[name]:`synthetic ${name} on the approved parts`});
    if(item.id==='assemble') {fragments.set('projection',{project:'core'}); fragments.set('ground',{ground:'plain'});}
    const asks = names.map((name,index): JsonObject=>({id:name,prompt:item.kind==='waypoint'?`Choose ${name} for the synthetic parts.`:String(item.record.text),options:[
      {id:'keep',kind:'value',label:index===0 && typeof original.verbatim==='string' ? original.verbatim : `Keep the proposed ${name}`,effect:index===0 ? `As answered on ${String(original.at)} in ${String(original.source ?? 'the interview')}` : `Use the proposed ${name} on the named synthetic parts.`,fragment:fragments.get(name) as Json,recommended:true,reason:'Preserves the stated synthetic direction and the accepted structure.'},
      {id:'alternative',kind:'value',label:`Alternative ${name}`,effect:`Choose a different ${name}.`,fragment:item.id==='rig_type'?'fullscreen.minimal':item.kind!=='waypoint'?'none':item.id==='assemble'&&name==='projection'?{project:'visible'}:item.id==='assemble'&&name==='ground'?{ground:'busy'}:{[name]:`alternative ${name}`},recommended:false},
      {id:'other',kind:'other',label:'Other',effect:'Describe this decision.',recommended:false},
      {id:'auto',kind:'auto',label:'Let the agent decide',effect:'The agent must record this decision before approval.',recommended:false},
    ]}));
    const set: JsonObject = {schema:OPTIONS_SPEC,id:`example-${item.id.replaceAll('_','-')}`,question:item.id,stage,drafted_by:'agent',drafted_at:drafted,context:optionContext(project,stage,Date.parse(drafted)),asks,assembly:{rule:item.kind==='waypoint'?'merge':'single'}};
    if(item.id==='assemble') set.constraints=[{asks:['projection','ground'],allowed:[['keep','keep'],['alternative','keep'],['alternative','alternative']]}];
    const path = `evidence/interview/${String(set.id)}.json`;
    const bytes = `${JSON.stringify(set,null,2)}\n`; writeFileSync(join(dir,path),bytes);files[path]=bytes;
    clock.now = Date.parse(exampleTime(`${day}02:00Z`));
    interviewOptionsCommand([item.id,dir,'--file',path],clock.now);
    const binding = JSON.parse(readFileSync(join(dir,'project.json'),'utf8')) as JsonObject;
    const registered = collectItems(binding,{collection:null}).find(i=>i.id===item.id)?.record.pending_options as JsonObject;
    const flags = names.flatMap(name=>['--pick',`${name}=${item.id==='seethrough'&&name==='seed'?'auto':'keep'}`]);
    clock.now = Date.parse(exampleTime(`${day}03:00Z`));
    if(item.id==='reference') {
      const picksPath = 'evidence/interview/example-picks.json';
      const payload = `${JSON.stringify({schema:'rig-review/interview-picks@1',set:registered,picks:[{ask:item.id,option_id:'keep'}],by:'user',at:new Date(clock.now).toISOString()},null,2)}\n`;
      writeFileSync(join(dir,picksPath),payload); files[picksPath]=payload;
      interviewAnswerCommand([item.id,dir,'--set',path,'--sha256',String(registered.sha256),'--by','user',...flags],clock.now);
    } else interviewAnswerCommand([item.id,dir,'--set',path,'--sha256',String(registered.sha256),'--by','user',...flags],clock.now);
    if(item.id==='seethrough') {
      const fragment = join(dir,'seed-fragment.json'); const reasoning = join(dir,'reasoning.txt');
      writeFileSync(fragment,JSON.stringify(fragments.get('seed')));writeFileSync(reasoning,'Retain the declared synthetic seed direction.');
      clock.now = Date.parse(exampleTime(`${day}04:00Z`));
      interviewDecisionCommand([item.id,dir,'--by','agent','--fragment',`seed=${fragment}`,'--reasoning-file',reasoning],clock.now);
    }
  }
  return files;
}
