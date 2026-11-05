/** Reproduce a tiny authored take and made correction using only public writers. */
import { setSystemTime } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { correctionCommand } from '../src/correction-writers.ts';
import { directionCommand } from '../src/direction-writers.ts';
import { DIRECTION_PATCH_SPEC } from '../src/direction.ts';
import { directionFixture } from '../tests/direction-fixture.ts';

export function generateDirectionFixture(dir:string):Record<string,Buffer> {
  if(existsSync(dir))throw Error('direction generation needs fresh directory');
  try {
    const f=directionFixture(dir);
    setSystemTime(new Date('2026-11-04T09:10:00Z'));
    directionCommand(['write','2',dir,'--file','evidence/input.json','--rig','1']);
    const p=f.load();const post=(p.versions as JsonObject[])[1] as JsonObject;const binding=(post.provenance as JsonObject).direction as JsonObject;
    const patch={schema:DIRECTION_PATCH_SPEC,source_post:2,rig_model_sha256:((f.doc.rig as JsonObject).model as JsonObject).sha256,direction_sha256:binding.sha256,replace:{camera:{space:'rig-world-y-up',keys:[{time:0,box:{x:-16,y:8,width:32,height:64},easing:'hold'}]}}};
    writeFileSync(join(dir,'evidence/patch.json'),`${JSON.stringify(patch,null,2)}\n`);
    setSystemTime(new Date('2026-11-04T09:20:00Z'));
    correctionCommand(['record',dir,'--id','frame','--stage','direction-review','--path','made','--version','2','--direction-patch-file','evidence/patch.json','--by','user','--verbatim-file',join(dir,'words.txt')]);
    setSystemTime(new Date('2026-11-04T09:30:00Z'));
    directionCommand(['patch','3',dir,'--patch-file','evidence/patch.json']);
    setSystemTime(new Date('2026-11-04T09:40:00Z'));
    correctionCommand(['resolve','frame',dir,'--version','3','--by','agent','--reasoning-file',join(dir,'reasoning.txt')]);
    const files:Record<string,Buffer>={};const walk=(path:string,prefix=''):void=>{for(const e of readdirSync(path,{withFileTypes:true})){const name=prefix?`${prefix}/${e.name}`:e.name;if(e.isDirectory())walk(join(path,e.name),name);else files[name]=readFileSync(join(path,e.name));}};walk(dir);return files;
  }finally{setSystemTime();}
}
import type { JsonObject } from '../src/templates.ts';
if(import.meta.main){const[destination,flag]=process.argv.slice(2);if(!destination||(flag!==undefined&&flag!=='--check'))throw Error('usage: generate-direction-fixture.ts <fresh dir> [--check]');const files=generateDirectionFixture(resolve(destination));const root=join(import.meta.dir,'../templates/example-direction');for(const[path,bytes]of Object.entries(files)){const file=join(root,path);if(flag==='--check'){if(!readFileSync(file).equals(bytes))throw Error(`${path}: direction fixture differs`);}else{mkdirSync(dirname(file),{recursive:true});writeFileSync(file,bytes);}}console.log('synthetic direction and correction reproduce through writers');}
