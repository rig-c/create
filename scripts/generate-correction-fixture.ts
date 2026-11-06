import { generatorArgs } from './generator-args.ts';
/** Consumer writer fixtures. Applied-and-checked is synthetic shape-only, never producer-gate proof. */
import { setSystemTime } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { correctionCommand } from '../src/correction-writers.ts';
import { correctionFixture } from '../tests/correction-fixture.ts';

export function generateCorrectionFixture(dir:string): Record<string,Buffer> {
  if(existsSync(dir))throw Error('generation requires a fresh directory');
  const result:Record<string,Buffer>={};
  try {
    for(const kind of ['post','rig','parts'] as const){
      const root=join(dir,kind);const f=correctionFixture(root,kind);
      setSystemTime(new Date('2026-11-04T09:10:00Z'));
      correctionCommand(['record',root,'--id','response','--path',kind==='rig'?'made':'described','--stage',kind==='post'?'direction-review':kind==='rig'?'rig-review':'parts-review','--by',kind==='rig'?'user':'reviewer',...f.args,...(kind==='rig'?['--feedback-file','evidence/feedback.json','--item','synthetic-apply']:['--verbatim-file',join(root,'words.txt')])]);
      setSystemTime(new Date('2026-11-04T10:00:00Z'));
      correctionCommand(['resolve','response',root,...f.outcome,'--by','agent','--reasoning-file',join(root,'reasoning.txt')]);
      const collect=(path:string,prefix:string):void=>{for(const name of readdirSync(path,{withFileTypes:true})){const key=`${prefix}/${name.name}`;if(name.isDirectory())collect(join(path,name.name),key);else result[key]=readFileSync(join(path,name.name));}};
      collect(root,kind);
    }
    return result;
  }finally{setSystemTime();}
}
if(import.meta.main){
  const { destination, check } = generatorArgs(import.meta.file, 'usage: generate-correction-fixture.ts <fresh directory> [--check]');
  const files=generateCorrectionFixture(resolve(destination));const root=join(import.meta.dir,'../tests/fixtures/correction-path');
  for(const[path,bytes]of Object.entries(files)){const file=join(root,path);if(check){if(!readFileSync(file).equals(bytes))throw Error(`${path}: correction fixture differs`);}else{mkdirSync(dirname(file),{recursive:true});writeFileSync(file,bytes);}}
  console.log('correction consumer records reproduce through writers; checked fixture is synthetic shape-only');
}
