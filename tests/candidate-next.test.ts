import { expect, test } from 'bun:test';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openCandidateHost } from '../src/candidate-host.ts';
import { candidateBatchPath, candidateStorage, CANDIDATE_STORAGE_PATH } from '../src/candidate-storage.ts';
import { interviewAnswerCommand } from '../src/choice-writers.ts';
import { agentCall } from '../src/job-acts.ts';
import { writePrivateJson } from '../src/job-outbox.ts';
import { SOURCE_CONDITION_FLAG } from '../src/job-writer.ts';
import { nextProject, type NextReport } from '../src/next.ts';
import { candidateFixture, CANDIDATE_NOW, CANDIDATE_QUESTION, CANDIDATE_SET, literalDigest } from './candidate-fixture.ts';
import { sourceOnlyTest } from './source-only.ts';

const CANDIDATE_FIELD = 'interview.post.items[post_composition].pending_options';
const ANSWER_FIELD = 'interview.post.items[post_composition].guide';

test('#1171 candidate next offers preview beside the independent owner chat route', () => {
  const f = candidateFixture();
  const set = f.save();
  const projectPath = join(f.root, 'project.json');
  const before = readFileSync(projectPath);
  expect(existsSync(join(f.root, CANDIDATE_STORAGE_PATH))).toBe(false);

  const report = nextProject(f.root, CANDIDATE_NOW);
  expect(report.effective_stage).toBe('post-interview');
  const moves = report.moves.filter(move => move.field === CANDIDATE_FIELD);
  const open = `rig-create candidate open ${f.root} --question ${CANDIDATE_QUESTION} --set ${CANDIDATE_SET} --reviewer '<reviewer>' --role owner`;
  const relay = `rig-create interview-answer ${CANDIDATE_QUESTION} ${f.root} --set ${set.path} --sha256 ${set.sha256}`
    + " --by '<owner>' --owner-chat '<words file>' --said-at '<ISO date>' --relayed-by '<operator>'"
    + " --pick 'post_composition=<option-id>'";
  expect(moves).toEqual(expect.arrayContaining([
    expect.objectContaining({ role: 'human', awaits: ANSWER_FIELD, command: null, act: expect.stringContaining('ask the owner in chat') }),
    expect.objectContaining({ role: 'human', awaits: ANSWER_FIELD, command: relay }),
    expect.objectContaining({ role: 'agent', awaits: ANSWER_FIELD, command: open }),
  ]));
  expect(report.awaits).toContain(ANSWER_FIELD);
  expect(existsSync(join(f.root, CANDIDATE_STORAGE_PATH))).toBe(false);
  expect(readFileSync(projectPath)).toEqual(before);

  const words = 'Keep the proposed synthetic composition.\n';
  const wordsPath = join(f.root, 'owner-words.txt');
  writeFileSync(wordsPath, words);
  const answer = JSON.parse(interviewAnswerCommand([CANDIDATE_QUESTION, f.root,
    '--set', set.path, '--sha256', set.sha256, '--pick', 'post_composition=keep',
    '--by', 'owner', '--owner-chat', wordsPath, '--said-at', new Date(CANDIDATE_NOW).toISOString(), '--relayed-by', 'agent',
  ], CANDIDATE_NOW));
  expect(answer).toMatchObject({ owner_words: words, choice: { set, picks: [{ ask: CANDIDATE_QUESTION, option_id: 'keep' }] } });
  expect(existsSync(join(f.root, CANDIDATE_STORAGE_PATH))).toBe(false);
  expect(nextProject(f.root, CANDIDATE_NOW).moves.some(move => move.command === open)).toBe(false);
});

async function nextWhileServing(root: string): Promise<NextReport> {
  // The subprocess leaves this process free to serve Review's strict attach probe.
  const cli = join(import.meta.dir, '../src/cli.ts');
  const script = `import { main } from ${JSON.stringify(cli)};
    process.exitCode = main(['next', ${JSON.stringify(root)}, '--json'], ${CANDIDATE_NOW});`;
  const child = Bun.spawn([process.execPath, SOURCE_CONDITION_FLAG, '-e', script], { stdout: 'pipe', stderr: 'pipe' });
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: '' });
  return JSON.parse(stdout) as NextReport;
}

sourceOnlyTest('#1171 candidate next prints the finalized comment command with both IDs', async () => {
  const f = candidateFixture();
  const set = f.save();
  const before = readFileSync(join(f.root, 'project.json'));
  const baseline = nextProject(f.root, CANDIDATE_NOW);
  const identity = { setSha256: set.sha256, askId: CANDIDATE_QUESTION, optionId: 'keep' };
  const batch = candidateBatchPath(candidateStorage(f.root), {
    question: CANDIDATE_QUESTION, setId: CANDIDATE_SET, setSha256: set.sha256,
  });
  const row = join(batch, `option-${literalDigest(JSON.stringify([identity.askId, identity.optionId]))}`);
  const pkg = join(row, 'package');
  mkdirSync(pkg, { recursive: true, mode: 0o700 });
  const modelPath = 'skeleton.model.json';
  const build = join(import.meta.dir, 'fixtures/rig-registration/build');
  for (const file of [modelPath, 'rectangle.png']) copyFileSync(join(build, file), join(pkg, file));
  const model = { path: modelPath, sha256: literalDigest(readFileSync(join(pkg, modelPath))) };
  const packagePath = pkg.slice(f.root.length + 1);
  const take = f.write(`${packagePath}/take.json`, {
    schema: 'rig-create/candidate-take@1', clip: 'idle', duration: 0.25, loop: true, model, sceneReport: null,
  });
  const receipt = f.write(`${packagePath}/candidate.json`, {
    schema: 'rig-create/candidate-preview@1', ...identity, camera: 'unkeyed', model,
    take: { ...take, path: 'take.json' }, sceneReport: null,
  });
  f.write(`${packagePath}/review.json`, {
    schema: 'rig-review/1', id: 'candidate', revision: receipt.sha256, title: 'Synthetic candidate',
    model: model.path, direction: 'take.json',
  });
  const selector = { kind: 'candidate', ...identity, receipt: { ...receipt, path: 'candidate.json' } };
  const host = await openCandidateHost(row, { id: 'synthetic-owner', role: 'owner' });
  try {
    expect((await agentCall(host, {
      verb: 'publish', expectedGeneration: 0, idempotencyKey: 'synthetic-candidate',
      freeze: { kind: 'producer-held', holdId: 'test', record: null }, result: { path: 'review.json', selector },
    })).ok).toBe(true);
    const head = host.session.status().publication!;
    const { jobId } = host.session;
    const { publicationId, source: { sourceHash } } = head;
    writePrivateJson(join(row, 'link.json'), { url: host.ownerUrl, selector, publicationId, sourceHash });
    writePrivateJson(join(batch, 'ready.json'), { count: 1 });
    expect(await nextWhileServing(f.root)).toEqual(baseline);

    const pageId = 'candidate-page';
    const post = (path: string, body: object) => new Request(`${host.origin}/jobs/${jobId}/${path}`, {
      method: 'POST', body: JSON.stringify(body),
      headers: { Origin: host.origin, 'Content-Type': 'application/json', 'X-Review-Capability': host.session.hostCredentials().ui },
    });
    const displayed = await host.ports.ackDisplayed(jobId, post('ui/displayed', { publicationId, pageId, sourceHash }));
    if (!displayed.ok) throw Error(displayed.error.code);
    const saved = await host.ports.commitUIAct(jobId, post('ui/acts', {
      kind: 'comments', publicationId, pageId, displayedNonce: displayed.value.displayedNonce,
      expectedGeneration: host.session.status().generation, submissionId: 'candidate-comment',
      value: { comments: [{ text: 'Keep the synthetic framing.' }] },
    }));
    if (!saved.ok) throw Error(saved.error.code);

    const report = await nextWhileServing(f.root);
    expect(report.moves.filter(move => move.field === 'comments')).toEqual([{
      role: 'agent', field: 'comments', awaits: 'comments', act: 'Record the Review comment.',
      command: `rig-create comment ${f.root} --candidate-job ${jobId} --from-review ${saved.value.actId}`,
    }]);
    expect(report.moves.filter(move => move.field !== 'comments')).toEqual(baseline.moves);
    expect(report.awaits).toEqual(baseline.awaits);
    expect(readFileSync(join(f.root, 'project.json'))).toEqual(before);
  } finally { host.stop(); }
});
