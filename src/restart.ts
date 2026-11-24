/**
 * `restart`: start a project's record again at v1 through a writer (create#285). The fresh record is
 * the one init writes. It keeps the inputs, re-validated by the input writer's checks, and the fix
 * ledger, because owner feedback belongs to the project, not to a version. create does not keep the
 * earlier project.json; git history holds it, and restarts[] names its sha256. That holds only when
 * project.json is committed, so restart refuses before it writes unless project.json is tracked and
 * byte-identical to its HEAD version (create#304).
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { asArray, checkProject, collectItems, isObject, PROJECT_SCHEMA, type Finding } from './check.ts';
import { ledgerRows } from './fix-ledger.ts';
import { freshProjectRecord, run } from './init.ts';
import { checkInputs } from './inputs.ts';
import { acquireBoundJobWrite } from './job-writer.ts';
import { OWNER_CHAT_FLAGS, REOPEN_RESTART_OWNER_CHAT_SINCE, ownerChatAuthorityFinding, readOwnerChat } from './owner-chat.ts';
import { readVerbatim, writeRecord } from './record-input.ts';
import { refuse, USAGE_EXIT } from './refusal.ts';
import { baselineOf, newFindings } from './refusal-baseline.ts';
import type { Json, JsonObject } from './templates.ts';

export const RESTART_HELP = `restart:
  [<dir>] --by <human> --owner-chat <file> --said-at <ISO> --relayed-by <operator> [--json]
  Replace project.json with the record init writes: the template's stage, no versions, drafts,
  signoffs, plan, answers or review acts. Keeps name, title, owner, painting, same_artwork, inputs[] (each file must
  still match its sha256) and fix_ledger with every row, and appends restarts[] with the owner's exact
  words as reason, the relay and write times, and previous_record_sha256. Reports dropped answer
  additions by path, source and text hash in restarts[].dropped_additions. Git history holds the
  earlier record, so restart requires project.json to be tracked and byte-identical to HEAD. A kept part set (inputs under
  <set>/parts/*.png or <set>/parts.json) keeps <set>/parts.json and its rig: rig.json and
  mesh_report.json, at <set>/rig/ or <set>/.`;

/**
 * The bytes of `<dir>/project.json` at HEAD, refusing unless the folder is in a git work tree and the
 * file is committed there byte for byte: restart drops the earlier record, so git history must hold it.
 */
export function committedRecord(dir: string, file: string): Buffer {
  const remedy = 'commit project.json, then restart';
  const inside = run(['git', 'rev-parse', '--is-inside-work-tree'], dir);
  if (!inside.ok || inside.out !== 'true') {
    refuse('RESTART_NOT_IN_GIT', `${file}: the folder is not inside a git work tree, so git history cannot hold the record restart replaces; put the project under git, ${remedy}`);
  }
  const prefix = run(['git', 'rev-parse', '--show-prefix'], dir);
  if (!prefix.ok) refuse('RESTART_NOT_IN_GIT', `${file}: git cannot resolve the folder's path in its work tree (${prefix.out}); ${remedy}`);
  const path = `${prefix.out}project.json`;
  const head = Bun.spawnSync(['git', 'show', `HEAD:${path}`], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
  if (head.exitCode !== 0) {
    const tracked = run(['git', 'ls-files', '--error-unmatch', '--', 'project.json'], dir).ok;
    refuse('RESTART_RECORD_UNCOMMITTED', `${file}: ${tracked ? 'is staged but was never committed' : 'is untracked'}, so git history does not hold the record restart replaces; ${remedy}`);
  }
  const bytes = Buffer.from(head.stdout);
  if (!readFileSync(file).equals(bytes)) {
    refuse('RESTART_RECORD_UNCOMMITTED', `${file}: differs from HEAD:${path} (uncommitted changes), so git history does not hold the record restart replaces; ${remedy}`);
  }
  return bytes;
}

/** Kept part sets missing their manifest, their rig or their PNGs, by set root. */
export function partSetGaps(inputs: Json | undefined): string[] {
  const paths = new Set(asArray(inputs).filter(isObject).map(input => input.path).filter((path): path is string => typeof path === 'string'));
  const roots = new Set<string>();
  for (const path of paths) {
    const set = /^(?:(.*)\/)?parts\/[^/]+\.png$/i.exec(path) ?? /^(?:(.*)\/)?parts\.json$/.exec(path);
    if (set) roots.add(set[1] ?? '');
  }
  const gaps: string[] = [];
  for (const root of [...roots].sort()) {
    const at = (name: string): string => (root === '' ? name : `${root}/${name}`);
    const missing: string[] = [];
    if (!paths.has(at('parts.json'))) missing.push(at('parts.json'));
    if (![...paths].some(path => path.startsWith(at('parts/')) && /\.png$/i.test(path))) missing.push(at('parts/*.png'));
    const rig = ['rig/', ''].find(prefix => paths.has(at(`${prefix}rig.json`)) && paths.has(at(`${prefix}mesh_report.json`)));
    if (rig === undefined) missing.push(`${at('rig/rig.json')} and ${at('rig/mesh_report.json')} (or ${at('rig.json')} and ${at('mesh_report.json')})`);
    if (missing.length) gaps.push(`${root === '' ? '(project root)' : root}: ${missing.join(', ')}`);
  }
  return gaps;
}

/** Inventory only the answers in the record restart replaces, including their history. */
function droppedAdditions(project: JsonObject): JsonObject[] {
  const rows: JsonObject[] = [];
  for (const item of collectItems(project, { collection: null })) {
    const recordPath = item.path.slice(0, item.path.lastIndexOf('.'));
    const answers = [
      { answer: item.raw, path: item.path },
      ...asArray(item.record.history).map((answer, index) => ({ answer, path: `${recordPath}.history[${index}]` })),
    ];
    for (const { answer, path } of answers) {
      if (!isObject(answer) || answer.additions === undefined) continue;
      if (!Array.isArray(answer.additions)) {
        refuse('RESTART_MALFORMED', `${path}.additions: restore the additions list from the source record before restarting`);
      }
      for (const [index, addition] of answer.additions.entries()) {
        const additionPath = `${path}.additions[${index}]`;
        if (!isObject(addition) || typeof addition.verbatim !== 'string') {
          refuse('RESTART_MALFORMED', `${additionPath}: restore the exact verbatim text from the source record before restarting`);
        }
        rows.push({
          item: item.id,
          path: additionPath,
          source: addition.source ?? null,
          by: addition.by ?? null,
          at: addition.at ?? null,
          ...(addition.review_act === undefined ? {} : { review_act: addition.review_act }),
          verbatim_sha256: createHash('sha256').update(addition.verbatim, 'utf8').digest('hex'),
        });
      }
    }
  }
  return rows;
}

export function restartCommand(args: string[], now: number): { stdout: string; exit: number } {
  const opts: Record<string, string> = {};
  const positional: string[] = [];
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') json = true;
    else if (['--by', '--reason-file', ...OWNER_CHAT_FLAGS].includes(arg)) {
      const value = args[++i];
      if (value === undefined || value.startsWith('--') || value.trim() === '' || opts[arg] !== undefined) refuse('RESTART_USAGE', `restart: ${arg} needs one value; see restart help`, USAGE_EXIT);
      opts[arg] = value;
    } else if (arg.startsWith('-')) refuse('RESTART_USAGE', `restart: unsupported ${arg}; see restart help`, USAGE_EXIT);
    else positional.push(arg);
  }
  const by = opts['--by'];
  if (positional.length > 1 || by === undefined) refuse('RESTART_USAGE', RESTART_HELP, USAGE_EXIT);
  if (by.trim().toLowerCase() === 'agent') refuse('SIGNOFF_NOT_HUMAN', 'restarts[].by: restart by agent; record the human who ordered the restart');
  if (opts['--reason-file'] !== undefined && OWNER_CHAT_FLAGS.some(flag => opts[flag] !== undefined)) {
    refuse('OWNER_CHAT_INVALID', 'restarts[].reason: --owner-chat supplies the reason; use the owner-chat flags without --reason-file', USAGE_EXIT);
  }
  const chat = readOwnerChat(opts, by, now, 'restarts[]');
  const authority = ownerChatAuthorityFinding(chat ?? {}, 'restarts[]', chat?.owner_words ?? '');
  if (authority && now >= Date.parse(REOPEN_RESTART_OWNER_CHAT_SINCE)) refuse(authority.code, authority.message);
  const reason = chat ? chat.owner_words as string : opts['--reason-file'] === undefined ? '' : readVerbatim(opts['--reason-file']).trim();
  if (!reason) refuse('RESTART_USAGE', 'restarts[].reason: the reason file is empty; say why the record restarts', USAGE_EXIT);
  const dir = resolve(positional[0] ?? process.cwd());
  const file = join(dir, 'project.json');
  const notProject = (why: string): never => refuse('RESTART_NOT_A_PROJECT', `${file}: ${why}; restart runs on a create project folder`);
  if (!existsSync(file)) notProject('does not exist');
  const committed = committedRecord(dir, file);
  const release = acquireBoundJobWrite(dir);
  try {
    const original = readFileSync(file);
    if (!original.equals(committed)) refuse('RESTART_SOURCE_CHANGED', 'project.json: changed while restart was validating; retry against the current record');
    let project: JsonObject;
    try {
      const parsed: unknown = JSON.parse(original.toString('utf8'));
      if (!isObject(parsed as Json) || (parsed as JsonObject).schema !== PROJECT_SCHEMA) throw new Error('schema');
      project = parsed as JsonObject;
    } catch { return notProject(`is not a ${PROJECT_SCHEMA} record`); }
    const inputs = { dir, project, refusals: [] as Finding[], warnings: [] as Finding[] };
    checkInputs(inputs);
    const invalidInput = (finding: Finding): never => refuse('RESTART_INPUT_INVALID', `${finding.path}: ${finding.code}: ${finding.message}; a restart keeps only inputs the input writer would record, so restore the file or register it again with input add`);
    const firstRefusal = inputs.refusals[0] ?? inputs.warnings.find(finding => finding.code !== 'INPUT_WRITER_MISSING');
    if (firstRefusal !== undefined) invalidInput(firstRefusal);
    const legacyPaths = new Set(inputs.warnings.filter(finding => finding.code === 'INPUT_WRITER_MISSING').map(finding => finding.path));
    const keptInputs: Json[] = [];
    const leftOut: { index: number; entry: JsonObject }[] = [];
    asArray(project.inputs).forEach((raw, index) => {
      if (legacyPaths.has(`inputs[${index}]`)) leftOut.push({ index, entry: isObject(raw) ? raw : {} });
      else keptInputs.push(raw);
    });
    let painting = project.painting;
    if (typeof painting === 'string' && !keptInputs.some(entry => isObject(entry) && entry.path === painting)) {
      const legacyPainting = leftOut.find(({ entry }) => entry.path === painting)?.entry;
      const twin = legacyPainting !== undefined && typeof legacyPainting.sha256 === 'string' && typeof legacyPainting.bytes === 'number'
        ? keptInputs.filter(isObject).find(entry => entry.sha256 === legacyPainting.sha256 && entry.bytes === legacyPainting.bytes && typeof entry.path === 'string')
        : undefined;
      if (twin !== undefined) painting = twin.path;
    }
    const keptCheck = { dir, project: { ...project, ...(painting !== undefined ? { painting } : {}), inputs: keptInputs }, refusals: [] as Finding[], warnings: [] as Finding[] };
    checkInputs(keptCheck);
    const keptFinding = keptCheck.refusals[0] ?? keptCheck.warnings[0];
    if (keptFinding !== undefined) invalidInput(keptFinding);
    const gaps = partSetGaps(keptInputs);
    if (gaps.length) refuse('RESTART_PART_SET_INCOMPLETE', `inputs: a kept part set needs its parts.json and its rig with its PNGs, missing ${gaps.join('; ')}; register the missing files with input add, or stop keeping the set`);
    const candidate = freshProjectRecord(typeof project.name === 'string' ? project.name : '', now);
    if (project.name !== undefined) candidate.name = project.name;
    if (project.title !== undefined) candidate.title = project.title;
    if (project.owner !== undefined) candidate.owner = project.owner;
    if (painting !== undefined) candidate.painting = painting;
    if (project.same_artwork !== undefined) candidate.same_artwork = project.same_artwork;
    candidate.inputs = keptInputs;
    candidate.fix_ledger = project.fix_ledger ?? [];
    const dropped = droppedAdditions(project);
    const entry: JsonObject = { at: new Date(now).toISOString(), by, reason, previous_record_sha256: createHash('sha256').update(original).digest('hex'),
      dropped_additions: dropped };
    if (chat) {
      entry.source = chat.source!;
      entry.said_at = chat.said_at!;
      entry.relayed_by = chat.relayed_by!;
    }
    candidate.restarts = [...asArray(project.restarts), entry];
    const ledger: Finding[] = [];
    ledgerRows(candidate, ledger, now);
    if (ledger[0] !== undefined) refuse(ledger[0].code, `${ledger[0].message}; a restart keeps every ledger row as written`);
    // The restarted record carries exactly what a fresh init record carries (its open interview) and nothing from the retired one.
    const fresh = checkProject(dir, freshProjectRecord(String(candidate.name ?? ''), now), { now });
    const rejected = newFindings(baselineOf(fresh), checkProject(dir, structuredClone(candidate), { now }).refusals)[0];
    if (rejected !== undefined) refuse(rejected.code, rejected.message);
    writeRecord(file, original, candidate, 'restart', 'RESTART_SOURCE_CHANGED');
    const rows = asArray(candidate.fix_ledger).length;
    const droppedText = dropped.map(row => `  ${String(row.path)} (source: ${JSON.stringify(row.source)})`);
    const leftOutText = leftOut.length
      ? `; left out legacy input(s) ${leftOut.map(({ index, entry: item }) => typeof item.path === 'string' && item.path.trim() !== '' ? `inputs[${index}] (${item.path})` : `inputs[${index}]`).join(', ')}`
      : '';
    return {
      stdout: json ? JSON.stringify(entry, null, 2)
        : [`restart: project record restarted at stage ${String(candidate.stage)}; kept ${asArray(candidate.inputs).length} input(s) and ${rows} ledger row(s)${leftOutText}; the earlier record (sha256 ${String(entry.previous_record_sha256)}) is in git history`,
          `Dropped ${dropped.length} answer addition(s)`, ...droppedText].join('\n'),
      exit: 0,
    };
  } finally { release(); }
}
