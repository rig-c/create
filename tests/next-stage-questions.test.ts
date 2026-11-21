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
  const picks = moves.filter(move => move.review_act?.kind === 'interview-picks');
  const chats = moves.filter(move => move.command?.includes('--owner-chat'));
  expect(open.map(move => move.command)).toEqual([`rig-create job open ${dir} --questions --reviewer '<reviewer>' --role owner`]);
  expect(open[0]!.act).toContain('rigging-interview question loop');
  expect(picks.map(move => move.review_act?.question_id)).toEqual(['bones', 'meshes']);
  expect(picks.map(move => move.review_act?.option_set_id)).toEqual(['chain-bones', 'chain-meshes']);
  expect(acts.map(move => move.command)).toEqual([`rig-create job acts ${dir} --json --wait`]);
  expect(ingest.map(move => move.command)).toEqual([
    `rig-create interview-answer --batch ${dir} --from-review '<actId for bones>' --from-review '<actId for meshes>'`,
  ]);
  expect(ingest[0]!.act).toContain('If partial ingest or owner chat changes project.json, refresh the exact remaining sets');
  expect(ingest[0]!.act).toContain('Unrelated asks still block publication with JOB_ASK_PENDING');
  expect(acts[0]!.act).toContain('wait for the remaining submissions before ingesting');
  expect(moves.indexOf(open[0]!)).toBeLessThan(moves.indexOf(picks[0]!));
  expect(moves.indexOf(picks[1]!)).toBeLessThan(moves.indexOf(acts[0]!));
  expect(moves.indexOf(acts[0]!)).toBeLessThan(moves.indexOf(ingest[0]!));
  expect(chats).toHaveLength(2);
  for (const [index, question] of ['bones', 'meshes'].entries()) {
    expect(chats[index]!.role).toBe('human');
    expect(chats[index]!.command).toStartWith(`rig-create interview-answer ${question} ${dir} --set evidence/interview/${question}.json --sha256 `);
    expect(chats[index]!.command).toContain('--pick');
    expect(chats[index]!.act).toContain('refresh the remaining sets before asking the owner to submit in Review');
  }
  expect(moves.some(move => move.command?.startsWith('rig-create interview-options constraints '))).toBe(true);
});

test('#558 next retains the single-set Review command chain for one pending set', () => {
  const { dir, moves } = riggingQuestions(false);
  expect(moves.flatMap(move => move.command && (move.command.startsWith('rig-create job ') || move.command.includes('--from-review')) ? [move.command] : [])).toEqual([
    `rig-create job open ${dir} --question bones --reviewer '<reviewer>' --role owner`,
    `rig-create job acts ${dir} --json --wait`,
    `rig-create interview-answer bones ${dir} --from-review '<actId>'`,
  ]);
});
