import { expect, test } from 'bun:test';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXAMPLE_NOW } from '../scripts/example-time.ts';
import { nextProject } from '../src/next.ts';
import { arr, obj } from './fixtures.ts';
import { tempDir } from './helpers.ts';

const chain = join(import.meta.dir, '../templates/example-chain');
const checkpoints = join(chain, 'checkpoints');

function riggingQuestions(grouped: boolean) {
  const dir = join(tempDir(), 'stage-questions');
  cpSync(chain, dir, { recursive: true });
  const file = join(dir, 'project.json');
  const project = obj(JSON.parse(readFileSync(join(checkpoints, '2-rigging-answers/project.json'), 'utf8')));
  if (grouped) {
    const answered = obj(JSON.parse(readFileSync(join(checkpoints, '3-rig-review/project.json'), 'utf8')));
    const meshes = arr(obj(project.interview).waypoints).map(obj).find(row => row.id === 'meshes')!;
    const answeredMeshes = arr(obj(answered.interview).waypoints).map(obj).find(row => row.id === 'meshes')!;
    meshes.pending_options = obj(obj(answeredMeshes.guide).choice).set!;
  }
  const bytes = JSON.stringify(project);
  writeFileSync(file, bytes);
  const report = nextProject(dir, EXAMPLE_NOW);
  expect(readFileSync(file, 'utf8')).toBe(bytes);
  expect(report.effective_stage).toBe('rigging-interview');
  expect(report.refusals.length).toBeGreaterThan(0);
  expect(report.refusals.every(finding => finding.code === 'INTERVIEW_INCOMPLETE')).toBe(true);
  return { dir, moves: report.moves };
}

test('#558 next groups the pending stage sets and retains one owner-chat route per set', () => {
  const { dir, moves } = riggingQuestions(true);
  const open = moves.filter(move => move.command?.startsWith('rig-create job open '));
  const acts = moves.filter(move => move.command?.startsWith('rig-create job acts '));
  const ingest = moves.filter(move => move.command?.includes('--from-review'));
  const prompts = moves.filter(move => move.role === 'human' && move.command === null);
  const chats = moves.filter(move => move.command?.includes('--owner-chat'));
  expect(open.map(move => move.command)).toEqual([`rig-create job open ${dir} --questions --reviewer '<reviewer>' --role owner`]);
  expect(open[0]!.act).toContain('optional: publish the pending sets for bones, meshes on one Review page to show their images for looking and commenting');
  expect(acts).toEqual([]);
  expect(ingest).toEqual([]);
  expect(moves.some(move => move.review_act !== undefined)).toBe(false);
  expect(prompts.map(move => move.act)).toEqual([
    'ask the owner in chat for interview.waypoints[bones] (option set chain-bones), then relay the answer with interview-answer --owner-chat',
    'ask the owner in chat for interview.waypoints[meshes] (option set chain-meshes), then relay the answer with interview-answer --owner-chat',
  ]);
  expect(chats).toHaveLength(2);
  for (const [index, question] of ['bones', 'meshes'].entries()) {
    expect(chats[index]!.role).toBe('human');
    expect(chats[index]!.command).toStartWith(`rig-create interview-answer ${question} ${dir} --set evidence/interview/${question}.json --sha256 `);
    expect(chats[index]!.command).toContain('--pick');
    expect(chats[index]!.act).toBe(`relay the owner chat answer for ${question} and explicit option ids from the displayed set`);
  }
  expect(moves.indexOf(prompts[0]!)).toBeLessThan(moves.indexOf(chats[0]!));
  expect(moves.indexOf(chats[0]!)).toBeLessThan(moves.indexOf(prompts[1]!));
  expect(moves.indexOf(chats[1]!)).toBeLessThan(moves.indexOf(open[0]!));
  expect(moves.some(move => move.command?.startsWith('rig-create interview-options constraints '))).toBe(true);
});

test('#558 next emits the chat question step, owner-chat relay, and optional Review display for one pending set', () => {
  const { dir, moves } = riggingQuestions(false);
  const prompts = moves.filter(move => move.role === 'human' && move.command === null);
  const chats = moves.filter(move => move.command?.includes('--owner-chat'));
  expect(prompts.map(move => move.act)).toEqual([
    'ask the owner in chat for interview.waypoints[bones] (option set chain-bones), then relay the answer with interview-answer --owner-chat',
  ]);
  expect(chats).toHaveLength(1);
  expect(chats[0]!.command).toStartWith(`rig-create interview-answer bones ${dir} --set evidence/interview/bones.json --sha256 `);
  expect(moves.flatMap(move => move.command && (move.command.startsWith('rig-create job ') || move.command.includes('--from-review')) ? [move.command] : [])).toEqual([
    `rig-create job open ${dir} --question bones --reviewer '<reviewer>' --role owner`,
  ]);
});
