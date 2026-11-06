import { generatorArgs } from './generator-args.ts';
/** Exact producer: node node_modules/@rig-c/parts/bin/rig-parts.cjs head-crop-preflight
 * --full <fresh>/full --canvas 20x10 --head-box '[5,0,15,5]'
 * Synthetic bytes only; no producer build or model run. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { encodePngBytes } from '../node_modules/@rig-c/parts/src/raster/png.ts';

const { destination, check } = generatorArgs(import.meta.file, 'usage: generate-intake-fixture.ts <fresh> [--check]');
const dir = resolve(destination);
if (existsSync(dir)) throw Error('use a fresh directory');
const parts = resolve(import.meta.dir,'../node_modules/@rig-c/parts');
if (JSON.parse(readFileSync(join(parts,'package.json'),'utf8')).version !== '2.16.0') throw Error('fixture producer must be parts 2.16.0');
mkdirSync(join(dir,'full'),{recursive:true});
const pixels = new Uint8Array(10*10*4);
for (const [x,y] of [[1,3],[4,3],[4,6]]) { const i=(y!*10+x!)*4; pixels.set([20,40,60,255],i); }
writeFileSync(join(dir,'full/hair.png'),encodePngBytes({width:10,height:10,data:pixels}));
writeFileSync(join(dir,'full/layers.json'),JSON.stringify({width:10,height:10,layers:[{name:'front hair',filename:'hair.png',left:0,top:0,right:10,bottom:10,depth_median:0.5}]}));
const command = ['node',join(parts,'bin/rig-parts.cjs'),'head-crop-preflight','--full',join(dir,'full'),'--canvas','20x10','--head-box','[5,0,15,5]'];
const result = Bun.spawnSync(command);
writeFileSync(join(dir,'producer-command.json'),JSON.stringify(command,null,2)+'\n');
writeFileSync(join(dir,'producer.stderr'),result.stderr);
if(result.exitCode!==0)throw Error(result.stderr.toString());
writeFileSync(join(dir,'preflight.json'),result.stdout);
const target=resolve(import.meta.dir,'../tests/fixtures/intake/preflight.json');
if(check){if(!readFileSync(target).equals(result.stdout))throw Error('intake preflight bytes differ');}
else{mkdirSync(resolve(target,'..'),{recursive:true});writeFileSync(target,result.stdout);}
console.log('parts 2.16.0 CLI synthetic preflight reproduces byte for byte');
