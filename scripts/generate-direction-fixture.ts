import { buildDirectionProbe } from './direction-probe.ts';
import { generatorArgs } from './generator-args.ts';
/** Reproduce a tiny authored take and made correction using only public writers. */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { correctionCommand } from '../src/correction-writers.ts';
import { directionCommand } from '../src/direction-writers.ts';
import { DIRECTION_PATCH_SPEC } from '../src/direction.ts';
import { directionFixture } from '../tests/direction-fixture.ts';
import { testClock } from '../tests/clock.ts';

export function generateDirectionFixture(dir:string):Record<string,Buffer> {
  if(existsSync(dir))throw Error('direction generation needs fresh directory');
  // The fixture helper moves the suite clock to its setup instant; give the caller's back.
  const callerClock=testClock.now();const f=directionFixture(dir,buildDirectionProbe(dir));testClock.set(callerClock);
  directionCommand(['write','2',dir,'--file','evidence/input.json','--rig','1'], Date.parse('2026-11-04T09:10:00Z'));
  const p=f.load();const post=(p.versions as JsonObject[])[1] as JsonObject;const binding=(post.provenance as JsonObject).direction as JsonObject;
  const patch={schema:DIRECTION_PATCH_SPEC,source_post:2,rig_model_sha256:((f.doc.rig as JsonObject).model as JsonObject).sha256,direction_sha256:binding.sha256,replace:{camera:{space:'rig-world-y-up',keys:[{time:0,box:{x:-16,y:8,width:32,height:64},easing:'hold'}]}}};
  writeFileSync(join(dir,'evidence/patch.json'),`${JSON.stringify(patch,null,2)}\n`);
  correctionCommand(['record',dir,'--id','frame','--stage','direction-review','--path','made','--version','2','--direction-patch-file','evidence/patch.json','--by','user','--verbatim-file',join(dir,'words.txt')], Date.parse('2026-11-04T09:20:00Z'));
  directionCommand(['patch','3',dir,'--patch-file','evidence/patch.json'], Date.parse('2026-11-04T09:30:00Z'));
  correctionCommand(['resolve','frame',dir,'--version','3','--by','agent','--reasoning-file',join(dir,'reasoning.txt')], Date.parse('2026-11-04T09:40:00Z'));
  const files:Record<string,Buffer>={};const walk=(path:string,prefix=''):void=>{for(const e of readdirSync(path,{withFileTypes:true})){const name=prefix?`${prefix}/${e.name}`:e.name;if(e.isDirectory())walk(join(path,e.name),name);else files[name]=readFileSync(join(path,e.name));}};walk(dir);return files;
}
import type { JsonObject } from '../src/templates.ts';
if(import.meta.main){const { destination, check } = generatorArgs(import.meta.file, 'usage: generate-direction-fixture.ts <fresh dir> [--check]');const files=generateDirectionFixture(resolve(destination));const root=join(import.meta.dir,'../templates/example-direction');for(const[path,bytes]of Object.entries(files)){const file=join(root,path);if(check){if(!readFileSync(file).equals(bytes))throw Error(`${path}: direction fixture differs`);}else{mkdirSync(dirname(file),{recursive:true});writeFileSync(file,bytes);}}console.log('direction probe build and correction reproduce through writers');}
