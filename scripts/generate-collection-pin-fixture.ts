import { generatorArgs } from './generator-args.ts';
/** Reproduce synthetic version selections through the collection pin writer. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pinCollection, sha256File } from '../src/pins-check.ts';
import { readTemplate, type Json, type JsonObject } from '../src/templates.ts';

export function generateCollectionPinFixture(dir: string): string {
  if (existsSync(dir)) throw Error('collection pin fixture needs a fresh directory');
  mkdirSync(dir, { recursive: true });
  const write = (path: string, bytes: string): void => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), bytes);
  };
  const collection = readTemplate('collection.json');
  collection.name = 'synthetic';
  collection.members = ['first', 'second'].map(name => ({ name, project: `members/${name}/project.json` }));
  const interview = collection.interview as JsonObject;
  for (const [list, field] of [[interview.questions, 'answer'], [interview.framing, 'answer'], [interview.waypoints, 'guide']] as const) {
    for (const raw of list as JsonObject[]) raw[field] = { delegated: false, by: 'user', at: '2026-11-07T00:00:00Z', verbatim: 'Synthetic direction.', value: 'Synthetic direction.' };
  }
  const members: JsonObject = {};
  for (const name of ['first', 'second']) {
    const versions: Json[] = [];
    for (const n of [1, 2]) {
      const outputs: Json[] = [];
      for (const variant of ['default', 'alternate']) {
        for (const [role, file] of [['model', 'model.json'], ['atlas', 'sheet.atlas'], ['atlas', 'sheet.png']]) {
          const path = `outputs/v${n}/${variant}/${file}`;
          const bytes = `synthetic ${name} v${n} ${variant} ${file}\n`;
          write(`members/${name}/${path}`, bytes);
          outputs.push({ role: role!, path, variant, sha256: sha256File(join(dir, 'members', name, path)) });
        }
      }
      const path = `derived/v${n}/config.json`;
      write(`members/${name}/${path}`, `{"synthetic":"${name}","version":${n}}\n`);
      versions.push({ n, kind: 'rig', outputs, provenance: { config: { path, sha256: sha256File(join(dir, 'members', name, path)) } } });
    }
    members[name] = { versions };
    write(`members/${name}/project.json`, JSON.stringify(members[name], null, 2) + '\n');
  }
  write('collection.json', JSON.stringify(collection, null, 2) + '\n');
  write('outputs/v1/lineup.png', 'synthetic collection output\n');
  const result = pinCollection(dir, 'One earlier build and one latest build.', new Date('2026-11-07T01:00:00Z'), ['first=1']);
  if (result.result === null) throw Error(JSON.stringify(result.refusals));
  return JSON.stringify({ schema: 'rig-create/collection-pin-fixture@1', members, collection: JSON.parse(readFileSync(join(dir, 'collection.json'), 'utf8')) }, null, 2) + '\n';
}

if (import.meta.main) {
  const { destination, check } = generatorArgs(import.meta.file, 'usage: generate-collection-pin-fixture.ts <fresh directory> [--check]');
  const bytes = generateCollectionPinFixture(resolve(destination));
  const target = join(import.meta.dir, '../tests/fixtures/collection-pin.json');
  if (check) {
    if (readFileSync(target, 'utf8') !== bytes) throw Error('collection pin fixture differs');
  } else {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }
  console.log('collection pin fixture reproduces through the writer');
}
