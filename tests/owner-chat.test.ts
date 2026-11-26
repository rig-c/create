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
  const finding=ownerChatFinding(broken,'project.json.signoffs[0]');
  expect(finding?.code).toBe('OWNER_CHAT_INVALID');
  expect(finding?.message).toStartWith('project.json.signoffs[0]: ');
  expect(finding?.message).toContain(`\`${field}\``);
});
test.each([
  ['source not relay source', {...valid, source: 'manual'}, '`source`', ['`relayed_by`', '`said_at`', '`actId`']],
  ['words blank (verbatim)', {...valid, verbatim: '  \r\n'}, '`verbatim`', ['`by`', '`said_at`', '`relayed_by`']],
  ['words blank (owner_words)', {by:'user',at,said_at:'2026-11-15T00:59:59Z',relayed_by:'operator',source:'owner chat, relayed',owner_words:' \n'}, '`owner_words`', ['`by`', '`said_at`', '`relayed_by`']],
  ['by blank', {...valid, by: '   '}, '`by`', ['`verbatim`', '`said_at`', '`relayed_by`']],
  ['by is agent', {...valid, by: 'Agent'}, '`by` is agent', ['`verbatim`', '`said_at`', '`relayed_by`']],
  ['relayed_by blank', {...valid, relayed_by: ''}, '`relayed_by`', ['`by`', '`said_at`', '`verbatim`']],
  ['said_at not ISO', {...valid, said_at: '2026-11-15 00:59:59'}, '`said_at`', ['after the write time', '`relayed_by`', '`by`']],
  ['said_at not a calendar date', {...valid, said_at: '2026-13-40T00:59:59Z'}, '`said_at`', ['after the write time', '`relayed_by`', '`by`']],
  ['at not a date', {...valid, at: 'not-a-date'}, '`at`', ['after the write time', '`said_at`', '`relayed_by`']],
  ['said_at after at', {...valid, at: '2026-11-26T09:41:15.000Z', said_at: '2026-11-26T09:42:00Z'}, '`said_at` 2026-11-26T09:42:00Z is after the write time `at` 2026-11-26T09:41:15.000Z', ['`relayed_by`', '`verbatim`', '`actId`']],
  ['actId present', {...valid, actId: 'act-1'}, '`actId`', ['`act_id`', '`said_at`', '`relayed_by`']],
  ['act_id present', {...valid, act_id: 'act-1'}, '`act_id`', ['`actId`', '`said_at`', '`relayed_by`']],
] as const)('OWNER_CHAT_INVALID names the failed condition: %s', (_label, broken, expectedText, absentTexts) => {
  const path = 'project.json.signoffs[0]';
  const finding = ownerChatFinding(broken, path);
  expect(finding?.code).toBe('OWNER_CHAT_INVALID');
  expect(finding?.path).toBe(path);
  expect(finding?.message).toStartWith(`${path}: `);
  expect(finding?.message).toContain(expectedText);
  for (const absent of absentTexts) expect(finding?.message).not.toContain(absent);
});
test('OWNER_CHAT_INVALID names multiple failed conditions in a fixed order and readOwnerChat surfaces the message', () => {
  const path = 'project.json.signoffs';
  const broken: JsonObject = {
    ...valid,
    by: 'agent',
    at: '2026-11-26T09:41:15.000Z',
    said_at: '2026-11-26T09:42:00Z',
  };
  const finding = ownerChatFinding(broken, path);
  expect(finding?.code).toBe('OWNER_CHAT_INVALID');
  expect(finding?.message).toStartWith(`${path}: `);
  expect(finding?.message).toContain('`by` is agent');
  expect(finding?.message).toContain('`said_at` 2026-11-26T09:42:00Z is after the write time `at` 2026-11-26T09:41:15.000Z');
  expect(finding!.message.indexOf('`by`')).toBeLessThan(finding!.message.indexOf('`said_at`'));
  expect(finding?.message).not.toContain('`relayed_by`');

  const dir = fixture();
  const file = join(dir, 'words');
  writeFileSync(file, 'Yes.');
  expect(() => readOwnerChat({
    '--owner-chat': file,
    '--said-at': '2026-11-26T09:42:00Z',
    '--relayed-by': 'operator',
  }, 'user', Date.parse('2026-11-26T09:41:15.000Z'), path)).toThrow(expect.objectContaining({
    code: 'OWNER_CHAT_INVALID',
    message: expect.stringContaining('`said_at` 2026-11-26T09:42:00Z is after the write time `at` 2026-11-26T09:41:15.000Z'),
  }));
});
test('a required words file and explicit clock cannot fall back to stdin or write time',()=>{
  const dir=fixture();const file=join(dir,'words');writeFileSync(file,'Yes.');
  const before=readFileSync(join(dir,'project.json'));
  try{readOwnerChat({'--owner-chat':file,'--relayed-by':'operator'},'user',Date.parse(at),'project.json.signoffs');throw Error('accepted');}
  catch(error){expect((error as Refusal).code).toBe('OWNER_CHAT_INVALID');}
  expect(readFileSync(join(dir,'project.json'))).toEqual(before);
});
