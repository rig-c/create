/** Synthetic shape-only checked Apply: no producer gate was run for these bytes. */
import { setSystemTime } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { correctionCommand } from '../src/correction-writers.ts';
import { correctionHash } from '../src/corrections.ts';
import { readTemplate, type JsonObject } from '../src/templates.ts';
import { PINNED_PACKAGES } from '../src/pins.ts';

export function correctionFixture(dir:string,kind:'post'|'rig'|'parts'='post'): {project:JsonObject;files:Record<string,string>;args:string[];outcome:string[]} {
  const files:Record<string,string>={
    'evidence/source-config.json':'{"note":"synthetic source"}\n',
    'evidence/outcome-config.json':'{"note":"synthetic outcome"}\n',
    'evidence/source.model.json':'{"synthetic":0}\n',
    'evidence/outcome.model.json':'{"synthetic":1}\n',
    'words.txt':'Keep the precise words.  \r\n', 'reasoning.txt':'Agent declaration of the recorded response.\n',
  };
  const bytes=(path:string):Buffer=>Buffer.from(files[path] as string,path.endsWith('.png')?'base64':'utf8');
  const binding=(path:string):JsonObject=>({path,sha256:correctionHash(bytes(path))});
  const template=readTemplate('project.json');
  const p:JsonObject={schema:template.schema as string, name:'synthetic-correction', stage_values:template.stage_values as string[],interview:template.interview as JsonObject,plan:{steps:[]},inputs:{},signoffs:[],versions:[]};p.name='synthetic-correction';p.stage=kind==='parts'?'parts-review':`${kind==='rig'?'rig':'direction'}-review`;p.signoffs=[];p.reopens=[];
  p.versions=kind==='parts'?[]:[1,2].map(n=>{
    const arm=n===1?'source':'outcome';const config=binding(`evidence/${arm}-config.json`);const model=binding(`evidence/${arm}.model.json`);
    const v:JsonObject={n,kind,at:`2026-11-04T0${n===1?'8':'9'}:30:00.000Z`,built_by:'agent',built_with:{},rig_version:null,changed:'synthetic bytes',outputs:[model],evidence:[],verdicts:[],answers_feedback:[],review_origin:null,provenance:{config,sections:{}}};
    if(kind==='rig'){
      const target=`derived/review/v${n}/out/check/build/skeleton.model.json`;files[target]=files[`evidence/${arm}.model.json`] as string;
      v.review_package={config,files:[{path:'config.json',sha256:config.sha256 as string},{path:'out/check/build/skeleton.model.json',sha256:model.sha256 as string}]};
    }return v;
  });
  let args=kind==='post'?['--version','1','--model-file','evidence/source.model.json']:['--version','1'];
  let outcome=kind==='post'?['--version','2','--model-file','evidence/outcome.model.json']:['--version','2'];
  if(kind==='parts'){
    for(const arm of ['source','outcome']){
      files[`evidence/${arm}/parts.json`]=`{"synthetic":"${arm}"}\n`;
      // A retained valid 1x1 PNG; this is a synthetic asset, not a rendering.
      files[`evidence/${arm}/parts/piece.png`]='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zb1sAAAAASUVORK5CYII=';
      const manifest=binding(`evidence/${arm}/parts.json`);const part=binding(`evidence/${arm}/parts/piece.png`);
      files[`evidence/${arm}/inventory.json`]=JSON.stringify({kind:'parts',manifest,files:[manifest,part]});
    }
    args=['--parts-file','evidence/source/inventory.json'];outcome=['--parts-file','evidence/outcome/inventory.json'];
  }
  if(kind==='rig'){
    const source=(p.versions as JsonObject[])[0] as JsonObject;const target=(p.versions as JsonObject[])[1] as JsonObject;const config=(source.provenance as JsonObject).config as JsonObject;
    const patch={schema:'rig-review-config-patch/1',config_sha256:config.sha256,ops:[{op:'replace',path:'/note',value:'synthetic outcome'}],producer:{name:'@rig-c/parts',version:PINNED_PACKAGES['@rig-c/parts']},op:{cmd:'rig',args:[]}};
    files['evidence/preview.json']=JSON.stringify(patch,null,2)+'\n';
    // patchSha256 is a retained review claim over synthetic review-format bytes. Create never recomputes it.
    const applied={schema:'rig-review-applied/2',buildId:correctionHash(Buffer.from('synthetic-build-id')),patch,patchSha256:correctionHash(Buffer.from(JSON.stringify(patch))),configHash:config.sha256,producer:{package:'@rig-c/parts',version:PINNED_PACKAGES['@rig-c/parts']},compiler:{package:'@rig-c/core',version:'0.0.0-synthetic'},line:'synthetic shape-only, not measured',check:{schema:'rig-review-check-summary/1',pass:true,exitCode:0,line:'check: synthetic shape-only',bars:{SYNTHETIC:'PASS'},gate:true},diff:{count:1,paths:['/synthetic']},modelHash:binding('evidence/outcome.model.json').sha256};
    const session={schema:'rig-review-session/1',reviewedSource:{rig:{path:'build/skeleton.model.json',sha256:binding('evidence/source.model.json').sha256},motion:null,handoff:{config,files:[{path:'../../config.json',sha256:config.sha256}],missing:[]}},feedback:[{id:'synthetic-apply',summary:files['words.txt'],context:{applied}}]};
    files['evidence/feedback.json']=JSON.stringify(session,null,2)+'\n';
    target.review_origin={feedback:binding('evidence/feedback.json'),source_version:1,feedback_id:'synthetic-apply',applied};
  }
  mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'project.json'),JSON.stringify(p,null,2)+'\n');
  for(const[path,bytes]of Object.entries(files)){mkdirSync(dirname(join(dir,path)),{recursive:true});writeFileSync(join(dir,path),path.endsWith('.png')?Buffer.from(bytes,'base64'):bytes);}
  setSystemTime(new Date('2026-11-04T09:00:00.000Z'));
  correctionCommand(['--adopt',dir]);
  return{project:JSON.parse(readFileSync(join(dir,'project.json'),'utf8')),files,args,outcome};
}
