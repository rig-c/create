import { basename, dirname, join, posix } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { readFileSync, realpathSync } from './check-reads.ts';
import { asArray, isObject, type Finding } from './check.ts';
import { literalFile } from './choices.ts';
import { CURRENT_KINDS, isRunRecordFile, outputRoot, sha256, type CurrentKind } from './current.ts';
import type { NextMove, NextReport } from './next.ts';
import { RunRecordError, validateRunRecord } from './run-record.ts';
import type { Json, JsonObject } from './templates.ts';

type ShellWord = (value: string) => string;

function inDirectory(dir: string, step: string, quote: ShellWord): string {
  const cwd = quote(dir);
  return `(cd -P ${cwd} && test "$PWD" = ${cwd} && ${step})`;
}

function hasStagedOut(argv: string[], spec: 'rig-run/2' | 'rigc-run/2'): boolean {
  if (spec === 'rigc-run/2') {
    // Core accepts both flag spellings and refuses a flag token as another flag's value.
    const outs = argv.flatMap((arg, i) => arg === '--out' ? [argv[i + 1]] : arg.startsWith('--out=') ? [arg.slice(6)] : []);
    return !argv.includes('--') && outs.length === 1 && outs[0] === '.';
  }

  // Parts only accepts separate flag/value pairs. Its check parser strips switches before reading the pairs.
  const check = argv[0] === 'check';
  const switches = new Set(['--seam-pairs', '--keep-stills', '--all-sets', '--no-extremes', check ? '--json' : '--loop']);
  const args = argv.slice(1).filter(arg => !check || !switches.has(arg));
  let out: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (switches.has(flag)) continue;
    const value = args[++i];
    if (!flag.startsWith('--') || flag === '--' || flag.includes('=') || value === undefined || value.startsWith('--')) return false;
    if (flag === '--out') {
      if (out !== undefined) return false;
      out = value;
    }
  }
  return out === '.';
}

function boundRun(dir: string, kind: CurrentKind, node: JsonObject, binding: Json | undefined): { path: string; bytes: Buffer } {
  const root = `${outputRoot(kind)}/`;
  if (!isObject(binding) || typeof binding.path !== 'string' || !binding.path.startsWith(root) || !isRunRecordFile(binding.path)
    || !asArray(node.files).some(file => isObject(file) && file.path === binding.path && file.sha256 === binding.sha256)) {
    throw new Error('the run is not bound to the recorded output inventory');
  }
  const { path } = binding;
  let bytes: Buffer;
  try { bytes = readFileSync(literalFile(dir, path)); }
  catch { throw new Error(`${path} is missing or is not a literal file`); }
  if (sha256(bytes) !== binding.sha256) throw new Error(`${path} no longer matches its recorded sha256`);
  return { path, bytes };
}

function recordConfig(dir: string, kind: CurrentKind, node: JsonObject): string | undefined {
  try {
    const { path, bytes } = boundRun(dir, kind, node, node.run);
    const { record } = validateRunRecord(bytes, path, { allowAssembleInputs: kind === 'parts' });
    if (!isObject(record.config)) return;
    const { path: config, sha256 } = record.config;
    const fromRun = posix.join(posix.dirname(path), String(config));
    const inputs = asArray(node.built_from).filter(isObject).filter(input => input.sha256 === sha256);
    // Old Parts receipts also used paths relative to the project working directory.
    const match = inputs.find(input => input.path === fromRun) ?? inputs.find(input => input.path === config);
    if (typeof match?.path === 'string') return match.path;
  } catch { /* The operator must name the config when its binding cannot be recovered. */ }
}

function replayRuns(dir: string, kind: CurrentKind, node: JsonObject, stage: string, quote: ShellWord) {
  const rebuild = isObject(node.rebuild) ? node.rebuild : undefined;
  const listed = rebuild?.recorded === true;
  const entries = listed ? asArray(rebuild.runs) : [node.run];
  const missing: string[] = [];
  const runs: { command: string; step: string }[] = [];
  if (rebuild?.recorded === false && typeof rebuild.note === 'string') missing.push(rebuild.note);
  for (const entry of entries) {
    try {
      const { path, bytes } = boundRun(dir, kind, node, entry);
      const { spec, record } = validateRunRecord(bytes, path, { allowAssembleInputs: kind === 'parts' });
      if (spec !== 'rig-run/2' && spec !== 'rigc-run/2') {
        throw new Error(`${path} has no recorded argv (${spec})`);
      }
      if (listed && (!isObject(entry) || entry.spec !== spec || !isDeepStrictEqual(entry.argv, record.argv))) {
        throw new Error(`${path} disagrees with the recorded rebuild spec or argv`);
      }
      const argv = record.argv as string[];
      if (!hasStagedOut(argv, spec)) throw new Error(`${path} has no single effective --out . for safe staged replay`);

      const command = String(record.command);
      const producer = spec === 'rig-run/2' ? ['rig-parts', ...argv] : ['rigc', command, ...argv];
      const suffix = posix.dirname(path).slice(outputRoot(kind).length + 1);
      const dirs = suffix ? suffix.split('/').map((_, i, segments) => `${stage}/${segments.slice(0, i + 1).join('/')}`) : [];
      const prepare = dirs.map(path => {
        const name = quote(basename(path));
        return inDirectory(dirname(path), `test ! -L ${name} && mkdir -p -- ${name}`, quote);
      });
      const run = inDirectory(dirs.at(-1) ?? stage, producer.map(quote).join(' '), quote);
      runs.push({ command, step: [...prepare, run].join(' && ') });
    } catch (error) {
      missing.push(error instanceof RunRecordError ? `${error.path}: ${error.why}` : error instanceof Error ? error.message : String(error));
    }
  }
  // `rebuild.runs` sorts by path. Parts build/check must produce the model before any Core render.
  runs.sort((a, b) => Number(a.command === 'render') - Number(b.command === 'render'));
  return { runs, missing };
}

function rebuildMove(dir: string, kind: CurrentKind, node: JsonObject, finding: Finding, quote: ShellWord): NextMove {
  const field = finding.path;
  const why = finding.message.replace(`; rebuild it upstream-first and record it with rig-create record ${kind}`, '');
  const target = `${outputRoot(kind)}.next`;
  const stage = join(realpathSync(dir), target);
  const { runs, missing } = replayRuns(dir, kind, node, stage, quote);
  const canBindWriterConfig = kind === 'parts' || kind === 'rig';
  const config = canBindWriterConfig ? recordConfig(dir, kind, node) : undefined;
  const record = `rig-create record ${kind} ${quote(dir)} --from ${target}${config === undefined ? '' : ` --config ${quote(config)}`}`;
  const producer = runs.map(run => run.step).join(' && ');
  const staged = `${inDirectory(dirname(stage), `mkdir -- ${quote(basename(stage))}`, quote)} && ${producer}`;
  const hasBuild = kind === 'rig' && runs.some(run => run.command === 'build');
  const complete = hasBuild || (kind === 'motion' && runs.some(run => run.command === 'render'));
  // `rig-parts build` assembles from source. It cannot replay a direct dependency on the once-recorded Parts tree.
  const needsParts = hasBuild && asArray(node.built_from).some(input => isObject(input) && typeof input.path === 'string'
    && (input.path === outputRoot('parts') || input.path.startsWith(`${outputRoot('parts')}/`)));
  if (complete && !needsParts && missing.length === 0 && config !== undefined) {
    return { role: 'producer', field, awaits: field, command: `${staged} && ${record}`,
      act: `${why}. Use the current upstream inputs. Rebuild in ${target}, then record the green output.` };
  }

  const tasks = [`${why}.`];
  if (missing.length > 0) tasks.push(`Rebuild arguments need operator review (${missing.join('; ')}).`);
  if (needsParts) tasks.push('The recorded rig-parts build assembles from source. Have the operator incorporate the current parts into the assembly inputs or supply a rig build that reads those parts before recording.');
  if (kind === 'parts') tasks.push(`Obtain the assemble and parts-check arguments from the operator and prepare green output in a fresh ${target}.`);
  else if (kind === 'rig' && !hasBuild) tasks.push(`Obtain the missing rig build arguments from the operator and build the rig into a fresh ${target} before running any recorded check or render.`);
  else if (kind === 'direction') tasks.push(`Update the scene binding with rig-create scene write, then obtain the compose arguments from the operator and compose into a fresh ${target}.`);
  else if (!complete) tasks.push(`Obtain the render arguments from the operator and render into a fresh ${target}.`);
  if (producer) tasks.push(`Recorded producer ${runs.length === 1 ? 'step' : 'steps'}: ${complete ? staged : producer}.`);
  if (canBindWriterConfig) {
    tasks.push(config === undefined
      ? `After rebuilding, run ${record} with --config set to the exact producer config supplied by the operator.`
      : `After rebuilding, run ${record}.`);
  } else tasks.push(`After rebuilding, use rig-create record ${kind} when the installed version provides it. Retain the rebuilt output in ${target} until then.`);
  return { role: complete && !needsParts && missing.length === 0 ? 'producer' : 'agent', field, awaits: field, command: null, act: tasks.join(' ') };
}

const STAGE_OUTPUT: Readonly<Partial<Record<string, CurrentKind>>> = {
  parts: 'parts', 'parts-review': 'parts', 'rigging-interview': 'parts', rigging: 'rig', 'rig-review': 'rig',
  'post-interview': 'rig', post: 'direction', 'direction-review': 'direction',
};

const POST_GUIDE = /^interview\.post\.items\[[^\]]+\]\.guide$/;

function readsPostOptionContext(move: NextMove): boolean {
  if (move.review_act?.kind === 'interview-picks' && move.review_act.stage === 'post-interview') return true;
  // The grouped Review commands await a comma-separated list of the guides they publish and ingest.
  if (move.field === 'interview') return move.awaits.split(', ').every(field => POST_GUIDE.test(field));
  if (!POST_GUIDE.test(move.awaits)) return false;
  // Single-set Review commands and the owner-chat route carry the same targets as the human pick.
  return move.field === move.awaits.replace(/\.guide$/, '.pending_options')
    || (move.field === move.awaits && move.command?.startsWith('rig-create interview-options ') === true);
}

/** Maps product consumers by their targets, which also groups the publish/wait/ingest moves for one Review act. */
function forwardOutput(move: NextMove, next: NextReport): CurrentKind | undefined {
  for (const target of [move.field, move.awaits]) {
    const kind = CURRENT_KINDS.find(kind => target === `current.${kind}` || target.startsWith(`current.${kind}.`)
      || target === outputRoot(kind) || target.startsWith(`${outputRoot(kind)}/`));
    if (kind !== undefined) return kind;
  }
  if (move.field === 'stage') return STAGE_OUTPUT[next.stage];
  if (move.field === 'scenes' || move.awaits.startsWith('scenes[') || move.command?.startsWith('rig-create scene write ')) return 'motion';
  if (move.awaits.startsWith('review_acts[kind=parts-verdict,')) return 'parts';
  const review = /\[review=(rig-review|direction-review)\]/.exec(move.awaits)?.[1];
  if (review) return STAGE_OUTPUT[review];
  const approval = /^signoffs\[stage=(parts-review|rig-review|direction-review)\]$/.exec(move.awaits)?.[1];
  if (approval) return STAGE_OUTPUT[approval];
  if (move.review_act?.kind === 'review-verdict') return STAGE_OUTPUT[move.review_act.stage];
  if (move.command?.startsWith('rig-create rig-version ')) return 'rig';
  if (move.command?.startsWith('rig-create direction write ')) return 'direction';
  const record = CURRENT_KINDS.find(kind => move.command?.startsWith(`rig-create record ${kind} `));
  if (record !== undefined) return record;
  if (move.field === 'versions') return STAGE_OUTPUT[next.effective_stage];
}

export function withStaleOutputs(dir: string, project: JsonObject, warnings: Finding[], next: NextReport, quote: ShellWord): NextReport {
  if (!isObject(project.current)) return next;
  const current = project.current;
  const stale = CURRENT_KINDS.flatMap(kind => {
    const finding = warnings.find(w => w.code === 'OUTPUT_STALE' && w.path === `current.${kind}`);
    const node = current[kind];
    return finding && isObject(node) ? [{ kind, move: rebuildMove(dir, kind, node, finding, quote) }] : [];
  });
  if (stale.length === 0) return next;

  const earliest = CURRENT_KINDS.indexOf(stale[0]!.kind);
  const blocked = (kind: CurrentKind | undefined): boolean => kind !== undefined && CURRENT_KINDS.indexOf(kind) >= earliest;
  const blockPostOptions = blocked('rig');
  const blockedReviews = new Set(next.moves.filter(move => move.review_act?.kind === 'review-verdict'
    && blocked(STAGE_OUTPUT[move.review_act.stage])).map(move => move.awaits));
  const removed = new Set<string>();
  const forward = next.moves.filter(move => {
    const reviewCommand = blockedReviews.has(move.awaits) && /^rig-create (?:job (?:open|acts)|review) /.test(move.command ?? '');
    if (!reviewCommand && !blocked(forwardOutput(move, next)) && !(blockPostOptions && readsPostOptionContext(move))) return true;
    removed.add(move.awaits);
    return false;
  });
  const retained = new Set(forward.map(move => move.awaits));
  const rebuilds = stale.map(({ move }) => move);
  const awaits = next.awaits.filter(target => !removed.has(target) || retained.has(target));
  // The answer view can also offer option preparation for already recorded picks.
  const answerView = blockPostOptions && next.effective_stage === 'post-interview' && next.answers
    ? { answers: next.answers.map(answer => {
        if (!POST_GUIDE.test(answer.field)) return answer;
        const { command: _command, ...recorded } = answer;
        return recorded;
      }) }
    : {};
  return { ...next, ...answerView, moves: [...rebuilds, ...forward], awaits: [...new Set([...rebuilds.map(move => move.awaits), ...awaits])] };
}
