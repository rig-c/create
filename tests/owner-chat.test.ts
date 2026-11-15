import { expect, test } from 'bun:test';
import { ownerChatFinding, readOwnerChat } from '../src/owner-chat.ts';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from './fixtures.ts';
import { checkProject } from './clock.ts';
import { Refusal } from '../src/refusal.ts';
import type { JsonObject } from '../src/templates.ts';

const at='2026-11-15T01:00:00.000Z';
const valid: JsonObject={by:'user',at,said_at:'2026-11-15T09:59:59+09:00',relayed_by:'operator',source:'owner chat, relayed',verbatim:'Yes.\r\n'};
test('relayed owner metadata is checked by the same validator on stored records',()=>{
  expect(ownerChatFinding(valid,'signoffs[0]')).toBeUndefined();
  const dir=fixture(p=>{p.signoffs=[{...valid,stage:'interview',said_at:null}];});
  expect(checkProject(dir).refusals.some(f=>f.code==='OWNER_CHAT_INVALID')).toBe(true);
});
test.each(['said_at','relayed_by','verbatim','source','by','actId','act_id'])('malformed owner chat field %s is refused',field=>{
  const broken={...valid,[field]:field.startsWith('act')?'invented':field==='by'?'agent':''};
  expect(ownerChatFinding(broken,'project.json.signoffs[0]')?.code).toBe('OWNER_CHAT_INVALID');
});
test('a required words file and explicit clock cannot fall back to stdin or write time',()=>{
  const dir=fixture();const file=join(dir,'words');writeFileSync(file,'Yes.');
  const before=readFileSync(join(dir,'project.json'));
  try{readOwnerChat({'--owner-chat':file,'--relayed-by':'operator'},'user',Date.parse(at),'project.json.signoffs');throw Error('accepted');}
  catch(error){expect((error as Refusal).code).toBe('OWNER_CHAT_INVALID');}
  expect(readFileSync(join(dir,'project.json'))).toEqual(before);
});
