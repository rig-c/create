/**
 * Test-only synthetic retained-record seeders for reader suites after
 * Create#986 step 4 removed the numbered build and seal writers.
 *
 * These helpers construct historical `drafts[]`, `versions[]` (`rig` with
 * `registration` / `review_package`, and `post` with `evidence/direction/v<N>.json`
 * or `outputs/v<N>/compose`), and `scenes[]` records directly on disk so
 * surviving readers and validators stay covered without production writers.
 */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { readPartsManifest, FIGURE_MASK_FILE, PAINTING_IN_RIG_FILE, partsFileReferences } from '@rig-c/parts/src/parts.ts';
import { asArray, isObject } from '../src/check.ts';
import { configInputBindings, configInputReferences, DIRECTORY_INPUT_RECEIPT, plateReceiptSpec, receiptSpec } from '../src/config-inputs.ts';
import { closed, DIRECTION_SPEC, directionHash } from '../src/direction.ts';
import { composeRoot, composeScenePath, DIRECTION_COMPOSE_SPEC, readComposeRun } from '../src/direction-compose.ts';
import { diffStackCandidates } from '../src/diff-map.ts';
import { ASSEMBLE_ONLY } from '../src/draft-layout.ts';
import { DRAFT_ID, relativeInventory } from '../src/draft-reuse.ts';
import { parseFeedbackPair } from '../src/feedback.ts';
import { draftLedgerFields } from '../src/fix-ledger.ts';
import { jobHash } from '../src/job-outbox.ts';
import { latestPartsReceipt } from '../src/parts-verdict-record.ts';
import { locateParts } from '../src/parts-sections.ts';
import { readOwnerChat } from '../src/owner-chat.ts';
import { readVerbatim } from '../src/record-input.ts';
import { decodeReviewAct, draftReviewStillEvidence, isDraftReviewVerdict, retainedActBy, reviewActVerdict } from '../src/review-act.ts';
import { parseRigCheckReport, RIG_CHECK_REPORT_FILE, SOURCE_EXPOSURE_ID } from '../src/rig-check-report.ts';
import { FROZEN_RUN_SPECS, validateRunRecord } from '../src/run-record.ts';
import { resolveAgentCitationSpec } from '../src/scene-authority.ts';
import { plateRegistration, pngDimensions, SCENE_SPEC, sceneEntries, scenePath, sceneRig } from '../src/scene.ts';
import { isScratchBindingPath } from '../src/scratch-bindings.ts';
import { approvedStructureDelta, rigPartsApproval } from '../src/structure.ts';
import type { Json, JsonObject } from '../src/templates.ts';
import { lockedPackage, type ToolchainKind } from '../src/toolchain-lock.ts';

const sha = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');

function readProjectJson(dir: string): { file: string; project: JsonObject } {
  const file = join(dir, 'project.json');
  return { file, project: JSON.parse(readFileSync(file, 'utf8')) as JsonObject };
}

function writeProjectJson(dir: string, project: JsonObject): void {
  writeFileSync(join(dir, 'project.json'), `${JSON.stringify(project, null, 2)}\n`);
}

function walkFiles(root: string, prefix = ''): { path: string; sha256: string; bytes: number }[] {
  const out: { path: string; sha256: string; bytes: number }[] = [];
  for (const name of readdirSync(join(root, prefix)).sort()) {
    const rel = prefix ? `${prefix}/${name}` : name;
    const full = join(root, rel);
    const stat = lstatSync(full);
    if (stat.isDirectory()) out.push(...walkFiles(root, rel));
    else if (stat.isFile()) {
      const content = readFileSync(full);
      out.push({ path: rel, sha256: sha(content), bytes: content.length });
    }
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Seed a retained `versions[n].review_package` and `derived/review/v<n>/` copy. */
export function seedRetainedReviewPackage(args: string[]): { stdout: string; exit: number } {
  const positional: string[] = [];
  const options: Record<string, string> = {};
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') json = true;
    else if (arg === '--config' || arg === '--from') options[arg] = args[++i]!;
    else positional.push(arg);
  }
  const n = Number(positional[0]!.replace(/^v/, ''));
  const dir = realpathSync(resolve(positional[1] ?? process.cwd()));
  const { project } = readProjectJson(dir);
  const version = asArray(project.versions).find((v): v is JsonObject => isObject(v) && v.n === n)!;
  const record = materializeReviewPackageOnVersion(dir, n, version, options['--config']!, options['--from']!);
  writeProjectJson(dir, project);
  const open = String(record.open);
  return { stdout: json ? JSON.stringify(record, null, 2) : `seeded-review-package: v${n}; ${open}`, exit: 0 };
}

export function materializeReviewPackageOnVersion(
  dir: string,
  n: number,
  version: JsonObject,
  configRelOpt: string,
  fromRelOpt: string,
  imagePaths?: readonly string[],
): JsonObject {
  const configAbs = realpathSync(resolve(dir, configRelOpt));
  const fromAbs = realpathSync(resolve(dir, fromRelOpt));
  const configBytes = readFileSync(configAbs);
  const configObj = JSON.parse(configBytes.toString('utf8')) as JsonObject;
  const named: { path: string; bytes: Buffer }[] = [];
  const directories = new Set<string>();
  for (const ref of configInputReferences(dir, configObj)) {
    const rel = relative(dirname(configAbs), resolve(dirname(configAbs), ref.value)).split(sep).join('/');
    const file = realpathSync(resolve(dirname(configAbs), ref.value));
    if (lstatSync(file).isDirectory()) {
      const receipt = join(file, DIRECTORY_INPUT_RECEIPT);
      const bytes = readFileSync(receipt);
      const spec = plateReceiptSpec(dir);
      if (receiptSpec(bytes) !== spec) throw new Error(`Invalid receipt spec at ${receipt}`);
      directories.add(rel);
      named.push({ path: `${rel}/${DIRECTORY_INPUT_RECEIPT}`, bytes });
    } else {
      named.push({ path: rel, bytes: readFileSync(file) });
    }
  }
  if (isObject(version.registration) && version.registration.kind === 'frozen-rig/1') {
    const configDir = relative(dir, dirname(configAbs)).split(sep).join('/');
    const prefix = `${configDir}/`;
    const runFiles = new Set(asArray(version.registration.runs).flatMap(r =>
      isObject(r) && isObject(r.source) && typeof r.source.path === 'string' ? [r.source.path] : []));
    const toolchain = version.registration.toolchain;
    const lockPath = isObject(toolchain) && isObject(toolchain.source) ? toolchain.source.path : undefined;
    const metadataNames = new Set([
      'at-source.json', 'compile-report.json', 'config-source.json', 'requirements-source.json',
      'config.json', 'package-lock.json', 'bun.lock', 'path-adapter.json', 'citations.json',
      'depth-manifest.json', 'depth-report.json', 'depth-source-parts.json', RIG_CHECK_REPORT_FILE,
    ]);
    for (const binding of asArray(version.registration.files)) {
      if (!isObject(binding) || typeof binding.path !== 'string' || !binding.path.startsWith(prefix)) continue;
      const rel = binding.path.slice(prefix.length);
      if (binding.path === lockPath || metadataNames.has(rel) || rel.startsWith('depth-map-bindings/') || runFiles.has(binding.path)) continue;
      if ([...directories].some(d => rel.startsWith(`${d}/`)) && !named.some(input => input.path === rel)) continue;
      const file = realpathSync(resolve(dir, binding.path));
      const path = relative(dirname(configAbs), file).split(sep).join('/');
      if (!named.some(input => input.path === path)) named.push({ path, bytes: readFileSync(file) });
    }
  }
  if (typeof configObj.requirements === 'string') {
    const reqRel = relative(dirname(configAbs), resolve(dirname(configAbs), configObj.requirements)).split(sep).join('/');
    const reqEntry = named.find(input => input.path === reqRel);
    if (reqEntry) {
      const reqDoc = JSON.parse(reqEntry.bytes.toString('utf8')) as JsonObject;
      const setup = isObject(reqDoc.setup_painting) ? reqDoc.setup_painting : {};
      const legacyUnadapted = isObject(version.registration) && version.registration.kind === 'frozen-rig/1'
        && version.registration.requirements_source === undefined;
      for (const key of ['figure_mask', 'backdrop'] as const) {
        if (key === 'backdrop' && legacyUnadapted) continue;
        const item = setup[key];
        if (!isObject(item) || typeof item.path !== 'string') continue;
        const assetAbs = resolve(dirname(configAbs), dirname(reqRel), item.path);
        const assetRel = relative(dirname(configAbs), assetAbs).split(sep).join('/');
        if (!named.some(input => input.path === assetRel)) {
          named.push({ path: assetRel, bytes: readFileSync(assetAbs) });
        }
      }
    }
  }

  const pkgRel = `derived/review/v${n}`;
  const pkgDir = join(dir, pkgRel);
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, 'config.json'), configBytes);
  for (const input of named) {
    const dest = join(pkgDir, input.path);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, input.bytes);
  }
  const required = ['parts.json', 'parts', 'rig', 'check/build'] as const;
  for (const entry of required) {
    const src = join(fromAbs, entry);
    const dst = join(pkgDir, 'out', entry);
    mkdirSync(dirname(dst), { recursive: true });
    cpSync(src, dst, { recursive: true });
  }
  const recordedFiles = isObject(version.review_package) ? asArray(version.review_package.files) : [];
  const namedSet = new Set(named.map(i => i.path));
  const retainedImages = imagePaths ?? recordedFiles.filter(isObject).flatMap(f =>
    typeof f.path === 'string' && f.path.startsWith('out/') && !namedSet.has(f.path) ? [f.path.slice(4)] : []);
  for (const imgRel of retainedImages) {
    if (required.some(entry => entry !== 'parts.json' && imgRel.startsWith(`${entry}/`))) continue;
    const src = join(fromAbs, imgRel);
    if (existsSync(src) && lstatSync(src).isFile()) {
      const dst = join(pkgDir, 'out', imgRel);
      mkdirSync(dirname(dst), { recursive: true });
      writeFileSync(dst, readFileSync(src));
    }
  }
  const files = walkFiles(pkgDir).map(({ path, sha256 }) => ({ path, sha256 }));
  const openWord = `'${`${pkgRel}/out`.replaceAll("'", "'\\''")}'`;
  const record: JsonObject = {
    config: { path: relative(dir, configAbs).split(sep).join('/'), sha256: sha(configBytes) },
    from: relative(dir, fromAbs).split(sep).join('/'),
    files,
    open: `rig-review open ${openWord}`,
  };
  version.review_package = record;
  return record;
}

/** Seed a retained `drafts[]` entry from existing `derived/drafts/<id>/` files. */
export function seedRetainedDraft(args: string[], now = Date.UTC(2026, 10, 7)): { stdout: string; exit: number } {
  const opts: Record<string, string> = {};
  const positional: string[] = [];
  const known: [string, string][] = [];
  const accepted: [string, string][] = [];
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') json = true;
    else if (arg === '--known-regression' || arg === '--accepted-fail') {
      const value = args[++i]!;
      const split = value.indexOf('=');
      (arg === '--known-regression' ? known : accepted).push([value.slice(0, split), readVerbatim(value.slice(split + 1)).trim()]);
    } else if (['--config', '--from', '--parts', '--reuse', '--reuse-record', '--ledger-report'].includes(arg)) {
      opts[arg] = args[++i]!;
    } else {
      positional.push(arg);
    }
  }
  const id = positional[0]!;
  const dir = realpathSync(resolve(positional[1] ?? process.cwd()));
  const { project } = readProjectJson(dir);
  const from = opts['--from']!;
  const output = walkFiles(join(dir, from)).map(f => ({ path: `${from}/${f.path}`, sha256: f.sha256 }));
  const hasPartsAt = (base: string, requirePng = false) =>
    output.some(f => f.path === `${base}/parts.json`)
    && output.some(f => f.path.startsWith(`${base}/parts/`) && (!requirePng || f.path.endsWith('.png')));
  const build = hasPartsAt(from) && output.some(f => f.path === `${from}/rig/rig.json`);
  const standalone = output.some(f => f.path === `${from}/rig.json`);
  const rigArtifact = (p: string) => /\/(rig|motion|mesh_report|skeleton\.model)\.json$/.test(p);
  const assembled = !build && !standalone && !output.some(f => rigArtifact(f.path))
    ? [from, `${from}/rig`].find(p => hasPartsAt(p, true))
    : undefined;
  const assembleOnly = assembled !== undefined;
  const partsRel = opts['--parts'] ?? assembled ?? from;
  const allParts = walkFiles(join(dir, partsRel)).map(f => ({ path: `${partsRel}/${f.path}`, sha256: f.sha256 }));
  let declaredPaint: string | null = null;
  if (allParts.some(f => f.path === `${partsRel}/parts.json`)) {
    try {
      const m = JSON.parse(readFileSync(join(dir, partsRel, 'parts.json'), 'utf8')) as JsonObject;
      if (isObject(m.painting_in_rig) && typeof m.painting_in_rig.path === 'string') {
        declaredPaint = `${partsRel}/${m.painting_in_rig.path}`;
      }
    } catch { /* ignore */ }
  }
  const partsFiles = allParts.filter(f =>
    f.path === `${partsRel}/parts.json` || f.path.startsWith(`${partsRel}/parts/`) || f.path === declaredPaint);
  const stackCandidates = diffStackCandidates(resolve(dir, partsRel, 'parts.json')).filter(f => existsSync(f));
  if (stackCandidates[0]) {
    const stackRel = relative(dir, stackCandidates[0]).split(sep).join('/');
    if ((standalone || assembleOnly) && !output.some(f => f.path === stackRel)) {
      output.push({ path: stackRel, sha256: sha(readFileSync(stackCandidates[0])) });
    }
  }
  const installed = locateParts(dir)!;
  const pkg = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')) as { name: string; version: string };
  let producer: JsonObject = { name: pkg.name, version: pkg.version };
  let reuseObj: JsonObject | undefined;
  const reuseId = opts['--reuse'];
  const reuseRecord = opts['--reuse-record'];
  if (reuseId !== undefined) {
    let sourceProject = project;
    let previousBinding: JsonObject | undefined;
    if (reuseRecord !== undefined) {
      const git = (gArgs: string[]) => Bun.spawnSync(['git', '--no-replace-objects', '--literal-pathspecs', ...gArgs], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
      const prefix = git(['rev-parse', '--show-prefix']).stdout.toString('utf8').replace(/\n$/, '');
      const targetFile = `${prefix}project.json`;
      let snapBytes: Buffer | undefined;
      for (const line of git(['rev-list', '--objects', '--full-history', 'HEAD', '--', 'project.json']).stdout.toString('utf8').split('\n')) {
        const sp = line.indexOf(' ');
        if (sp < 0 || line.slice(sp + 1) !== targetFile) continue;
        const blob = git(['cat-file', 'blob', line.slice(0, sp)]);
        if (blob.exitCode === 0 && sha(blob.stdout) === reuseRecord) {
          snapBytes = Buffer.from(blob.stdout);
          break;
        }
      }
      if (!snapBytes) throw new Error(`Missing git blob for reuseRecord ${reuseRecord}`);
      const snapRel = `evidence/draft-reuse/${reuseRecord}.json`;
      mkdirSync(dirname(join(dir, snapRel)), { recursive: true });
      writeFileSync(join(dir, snapRel), snapBytes);
      previousBinding = { path: snapRel, sha256: reuseRecord };
      sourceProject = JSON.parse(snapBytes.toString('utf8')) as JsonObject;
    }
    const srcDraft = asArray(sourceProject.drafts).filter(isObject).find(d => d.id === reuseId)!;
    const srcProducer = srcDraft.producer as JsonObject;
    producer = { name: srcProducer.name, version: srcProducer.version };
    const receipt = latestPartsReceipt(sourceProject, reuseId)!;
    const reviewSha = String((receipt.evidence as JsonObject).sha256);
    const relParts = relativeInventory(srcDraft.parts as JsonObject, `drafts[${id}].reuse`);
    const manifestDoc = JSON.parse(readFileSync(join(dir, partsRel, 'parts.json'), 'utf8')) as JsonObject;
    const seethrough = asArray(manifestDoc.parts).filter(isObject).flatMap(part => {
      const fromStr = typeof part.from === 'string' && /^(full|head):[^:]+$/.test(part.from) ? part.from : undefined;
      const taken = asArray(part.taken_layers);
      return fromStr === undefined && taken.length === 0 ? [] : [{
        part: part.name, ...(fromStr !== undefined ? { from: fromStr } : {}), ...(taken.length ? { taken_layers: taken } : {}),
      }];
    });
    reuseObj = {
      draft_id: reuseId,
      review_sha256: reviewSha,
      parts: relParts,
      seethrough,
      ...(previousBinding ? { previous_record: previousBinding } : {}),
    };
  }
  const rigPrefix = build ? `${from}/rig` : from;
  const stampCandidates = assembleOnly
    ? [`${partsRel}/run.json`, ...(partsRel.endsWith('/rig') ? [`${partsRel.slice(0, -4)}/run.json`] : [])]
    : [`${rigPrefix}/run.json`];
  const stampHit = output.find(f => stampCandidates.includes(f.path));
  if (stampHit) {
    const { record: runRec } = validateRunRecord(readFileSync(join(dir, stampHit.path)), stampHit.path, { allowAssembleInputs: assembleOnly });
    const runPkg = runRec.package as JsonObject;
    producer = { name: runPkg.name as string, version: runPkg.version as string };
  }
  const configAbs = realpathSync(resolve(dir, opts['--config']!));
  const configRel = relative(dir, configAbs).split(sep).join('/');
  const configInputs = configInputBindings(dir, opts['--config']!);
  const record: JsonObject = {
    id,
    kind: 'draft-rig',
    ...(assembleOnly ? { layout: ASSEMBLE_ONLY } : {}),
    at: new Date(now).toISOString(),
    producer,
    config: { path: configRel, sha256: sha(readFileSync(configAbs)) },
    parts: { path: partsRel, files: partsFiles },
    files: output,
    ...(configInputs.length ? { config_inputs: configInputs } : {}),
    ...(reuseObj ? { reuse: reuseObj } : {}),
  };
  project.drafts = [...asArray(project.drafts), record];
  if (opts['--ledger-report']) {
    Object.assign(record, draftLedgerFields(dir, project, asArray(project.drafts).length - 1, opts['--ledger-report'], { known, accepted }, now));
  }
  writeProjectJson(dir, project);
  return { stdout: json ? JSON.stringify(record, null, 2) : `seeded-draft: ${id}`, exit: 0 };
}

/** Seed a retained `scenes[]` entry and `evidence/scene/s<N>.json` file. */
export function seedRetainedScene(args: string[], now = Date.UTC(2026, 10, 7)): { stdout: string; exit: number } {
  const opts: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    if (['--rig', '--background', '--foreground', '--background-rect', '--foreground-rect', '--citations-file', '--animation'].includes(arg)) {
      opts[arg] = args[++i]!;
    } else {
      positional.push(arg);
    }
  }
  const dir = resolve(positional[0] ?? process.cwd());
  const { project } = readProjectJson(dir);
  const entries = sceneEntries(project);
  const n = entries.length + 1;
  const binding = sceneRig(dir, project, Number(opts['--rig']!), undefined, opts['--animation']);
  const citations = JSON.parse(readFileSync(join(dir, opts['--citations-file']!), 'utf8')) as JsonObject;
  if (!closed(citations, ['background'], opts['--foreground'] ? ['foreground'] : [])) {
    throw new Error('Invalid citations map in seedRetainedScene');
  }
  const plates: JsonObject[] = [];
  for (const role of ['background', 'foreground'] as const) {
    const p = opts[`--${role}`];
    if (!p) continue;
    const bytes = readFileSync(join(dir, p));
    const size = pngDimensions(bytes, p);
    const identity = { path: p, sha256: directionHash(bytes) };
    const registered = plateRegistration(project, identity);
    let rect = binding.stage;
    const rectOpt = opts[`--${role}-rect`];
    if (rectOpt !== undefined) {
      const [x, y, width, height] = rectOpt.split(',').map(Number);
      rect = { x: x!, y: y!, width: width!, height: height! };
    } else {
      const spec = resolveAgentCitationSpec(dir, project, citations[role]!);
      rect = role === 'foreground' ? spec.foreground!.rect : spec.background.rect;
    }
    plates.push({ role, ...identity, ...size, rect, registered: registered!, citation: citations[role]! });
  }
  const doc: JsonObject = {
    schema: SCENE_SPEC,
    n,
    rig: binding.rig,
    frame: { space: 'rig-world-y-up', stage: binding.stage },
    plates,
    layers: opts['--foreground'] ? ['background', 'rig', 'foreground'] : ['background', 'rig'],
  };
  const docBytes = Buffer.from(`${JSON.stringify(doc, null, 2)}\n`);
  const relPath = scenePath(n);
  mkdirSync(dirname(join(dir, relPath)), { recursive: true });
  writeFileSync(join(dir, relPath), docBytes);
  const entry = { n, path: relPath, sha256: directionHash(docBytes), at: new Date(now).toISOString(), by: 'agent' };
  project.scenes = [...entries, entry];
  writeProjectJson(dir, project);
  return { stdout: `scene: s${n} recorded; stage unchanged`, exit: 0 };
}

/** Seed a retained `versions[]` post entry (`direction@1`, `direction@2`, or `direction@3`). */
export function seedRetainedDirectionPost(args: string[], now = Date.UTC(2026, 10, 7)): { stdout: string; exit: number } {
  const positional: string[] = [];
  const opts: Record<string, string> = {};
  const answerValues: string[] = [];
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--answers') answerValues.push(args[++i]!);
    else if (['--file', '--rig', '--compose-out', '--compose-scene'].includes(arg)) opts[arg] = args[++i]!;
    else positional.push(arg);
  }
  const n = Number(positional[0]);
  const dir = resolve(positional[1] ?? process.cwd());
  const { project } = readProjectJson(dir);
  const answersFeedback = answerValues.map(v => parseFeedbackPair(v)!);
  let bytes = readFileSync(join(dir, opts['--file']!));
  let doc = JSON.parse(bytes.toString('utf8')) as JsonObject;
  let inventoryRows: JsonObject[] = [];
  if (doc.schema === DIRECTION_COMPOSE_SPEC) {
    const rigN = Number(opts['--rig']!);
    const rigBinding = sceneRig(dir, project, rigN);
    const outRoot = composeRoot(n);
    const srcOut = resolve(dir, opts['--compose-out']!);
    const dstOut = join(dir, outRoot);
    mkdirSync(dirname(dstOut), { recursive: true });
    cpSync(srcOut, dstOut, { recursive: true });
    inventoryRows = walkFiles(dstOut).map(({ path, sha256 }) => ({ path: `${outRoot}/${path}`, sha256 }));
    const sceneSrcBytes = readFileSync(resolve(dir, opts['--compose-scene']!));
    const dstSceneRel = composeScenePath(n);
    mkdirSync(dirname(join(dir, dstSceneRel)), { recursive: true });
    writeFileSync(join(dir, dstSceneRel), sceneSrcBytes);
    const sceneBinding = { path: dstSceneRel, sha256: directionHash(sceneSrcBytes) };
    const findRow = (suffix: string) => {
      const row = inventoryRows.find(r => r.path === `${outRoot}/${suffix}`);
      if (!row) throw new Error(`Missing compose output ${suffix}`);
      return row;
    };
    const runBinding = findRow('compose-run.json');
    const parsedRun = readComposeRun(readFileSync(join(dir, String(runBinding.path))), String(runBinding.path));
    const clipped = parsedRun.characters.find(c => c.placement !== undefined)?.placement?.clipped_bounds;
    doc = {
      ...doc,
      rig: { version: rigN, acceptance: (rigBinding.rig as JsonObject).acceptance! },
      compose: {
        scene: sceneBinding,
        out: outRoot,
        report: findRow('scene.json'),
        check: findRow('check/check.json'),
        run: runBinding,
        ...(clipped ? { clipped_bounds: [...clipped] } : {}),
      },
      model: findRow('check/build/skeleton.model.json'),
    };
    bytes = Buffer.from(`${JSON.stringify(doc, null, 2)}\n`);
  }
  const dirRel = `evidence/direction/v${n}.json`;
  mkdirSync(dirname(join(dir, dirRel)), { recursive: true });
  writeFileSync(join(dir, dirRel), bytes);
  const binding = { path: dirRel, sha256: directionHash(bytes) };
  const citations = (doc.citations ?? {}) as JsonObject;
  const version: JsonObject = {
    n,
    kind: 'post',
    rig_version: Number((doc.rig as JsonObject).version),
    at: new Date(now).toISOString(),
    built_by: 'agent',
    built_with: { create: String(doc.schema ?? DIRECTION_SPEC).slice('rig-create/'.length) },
    changed: doc.schema === DIRECTION_COMPOSE_SPEC ? 'Composed idle direction' : 'Authored camera and timing direction',
    outputs: doc.schema === DIRECTION_COMPOSE_SPEC
      ? [binding, ...inventoryRows, (doc.compose as JsonObject).scene!]
      : [binding],
    evidence: [],
    verdicts: [],
    answers_feedback: answersFeedback,
    review_origin: null,
    provenance: {
      config: binding,
      direction: binding,
      sections: {
        camera: [{ entry: 'camera', ...(isObject(citations.camera) ? citations.camera : {}) }],
        timing: [{ entry: 'timing', ...(isObject(citations.timing) ? citations.timing : {}) }],
      },
    },
  };
  project.versions = [...asArray(project.versions), version];
  writeProjectJson(dir, project);
  return { stdout: `direction: v${n} committed without publishing; stage unchanged`, exit: 0 };
}

function escapePointer(token: string): string {
  return token.replaceAll('~', '~0').replaceAll('/', '~1');
}

/** Generate a synthetic path-adapter array for reader tests that setup adapted configs. */
export function seedPathAdapter(dir: string, configRelOrAbs: string, outRelOrAbs?: string): JsonObject[] {
  const root = realpathSync(resolve(dir));
  const configAbs = resolve(root, configRelOrAbs);
  const configDir = dirname(realpathSync(configAbs));
  const config = JSON.parse(readFileSync(configAbs, 'utf8')) as JsonObject;
  const rows: JsonObject[] = [];
  const seen = new Set<string>();
  const addRow = (doc: 'config' | 'requirements', pointer: string, before: string, after: string) => {
    const key = `${doc}:${pointer}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push({ doc, pointer, before, after });
  };
  const addLegacyAbs = (dotPath: string, value: string) => {
    rows.push({ at: `.${dotPath}`, before: value, after: value });
  };
  for (const ref of configInputReferences(root, config)) {
    const dotPath = ref.at.replace(/\[(\d+)\]/g, '.$1');
    const pointer = `/${dotPath.split('.').map(escapePointer).join('/')}`;
    if (isAbsolute(ref.value)) addLegacyAbs(dotPath, ref.value);
    else addRow('config', pointer, ref.value, `inputs/${dotPath.split('.').join('/')}`);
  }
  const assemble = isObject(config.assemble) ? config.assemble : undefined;
  if (isObject(assemble)) {
    if (Array.isArray(assemble.take)) {
      assemble.take.forEach((entry, i) => {
        if (!isObject(entry)) return;
        for (const k of ['run_dir', 'st_input'] as const) {
          if (typeof entry[k] === 'string' && entry[k]) {
            if (isAbsolute(entry[k])) addLegacyAbs(`assemble.take.${i}.${k}`, entry[k]);
            else addRow('config', `/assemble/take/${i}/${k}`, entry[k], `inputs/assemble/take/${i}/${k}`);
          }
        }
        if (isObject(entry.reference) && typeof entry.reference.painting === 'string' && entry.reference.painting) {
          const v = entry.reference.painting;
          if (isAbsolute(v)) addLegacyAbs(`assemble.take.${i}.reference.painting`, v);
          else addRow('config', `/assemble/take/${i}/reference/painting`, v, `inputs/assemble/take/${i}/reference/painting`);
        }
      });
    }
    if (isObject(assemble.editor_receipts) && Array.isArray(assemble.editor_receipts.receipts)) {
      assemble.editor_receipts.receipts.forEach((entry, i) => {
        if (isObject(entry) && typeof entry.file === 'string' && entry.file) {
          if (isAbsolute(entry.file)) addLegacyAbs(`assemble.editor_receipts.receipts.${i}.file`, entry.file);
          else addRow('config', `/assemble/editor_receipts/receipts/${i}/file`, entry.file, `inputs/assemble/editor_receipts/receipts/${i}/file`);
        }
      });
    }
    if (Array.isArray(assemble.cuts)) {
      assemble.cuts.forEach((entry, i) => {
        if (!isObject(entry)) return;
        if (typeof entry.under === 'string' && entry.under) {
          addRow('config', `/assemble/cuts/${i}/under`, entry.under, `inputs/assemble/cuts/${i}/under`);
        } else if (isObject(entry.under) && typeof entry.under.plate === 'string' && entry.under.plate) {
          addRow('config', `/assemble/cuts/${i}/under/plate`, entry.under.plate, `inputs/assemble/cuts/${i}/under/plate`);
        }
      });
    }
  }
  if (isObject(config.limbs)) {
    for (const [limbName, limb] of Object.entries(config.limbs)) {
      if (!isObject(limb) || !Array.isArray(limb.segments)) continue;
      limb.segments.forEach((seg, i) => {
        if (isObject(seg) && typeof seg.cap === 'string' && seg.cap) {
          addRow('config', `/limbs/${escapePointer(limbName)}/segments/${i}/cap`, seg.cap, `inputs/limbs/${limbName}/segments/${i}/cap`);
        }
      });
    }
  }
  if (isObject(config.depth)) {
    for (const run of ['full', 'head'] as const) {
      const block = config.depth[run];
      if (!isObject(block)) continue;
      if (isObject(block.atlas) && typeof block.atlas.image === 'string' && block.atlas.image) {
        addRow('config', `/depth/${run}/atlas/image`, block.atlas.image, `inputs/depth/${run}/atlas/image`);
      }
      if (isObject(block.layers)) {
        for (const [layer, spec] of Object.entries(block.layers)) {
          if (isObject(spec) && typeof spec.image === 'string' && spec.image) {
            addRow('config', `/depth/${run}/layers/${escapePointer(layer)}/image`, spec.image, `inputs/depth/${run}/layers/${layer}/image`);
          }
        }
      }
    }
  }
  const scanAbs = (val: Json, ptr: string, dot: string) => {
    if (typeof val === 'string' && isAbsolute(val)) {
      if (!rows.some(r => r.at === `.${dot}` || r.pointer === ptr)) addLegacyAbs(dot, val);
      return;
    }
    if (Array.isArray(val)) val.forEach((v, idx) => scanAbs(v, `${ptr}/${idx}`, dot ? `${dot}.${idx}` : String(idx)));
    else if (isObject(val)) {
      for (const [k, v] of Object.entries(val)) scanAbs(v, `${ptr}/${escapePointer(k)}`, dot ? `${dot}.${k}` : k);
    }
  };
  scanAbs(config, '', '');

  if (typeof config.requirements === 'string') {
    const reqAbs = resolve(configDir, config.requirements);
    const reqObj = JSON.parse(readFileSync(reqAbs, 'utf8')) as JsonObject;
    const setup = isObject(reqObj.setup_painting) ? reqObj.setup_painting : {};
    for (const key of ['figure_mask', 'backdrop'] as const) {
      const item = setup[key];
      if (isObject(item) && typeof item.path === 'string' && item.path.trim()) {
        addRow('requirements', `/setup_painting/${key}/path`, item.path, `setup_painting/${key}/path`);
      }
    }
  }
  if (outRelOrAbs) {
    const outAbs = resolve(root, outRelOrAbs);
    mkdirSync(dirname(outAbs), { recursive: true });
    writeFileSync(outAbs, `${JSON.stringify(rows, null, 2)}\n`);
  }
  return rows;
}

function setJsonPointer(doc: Json, pointer: string, nextVal: string): void {
  const tokens = pointer.slice(1).split('/').map(t => t.replaceAll('~1', '/').replaceAll('~0', '~'));
  let cur: Json = doc;
  for (let i = 0; i < tokens.length - 1; i++) {
    const k = tokens[i]!;
    cur = Array.isArray(cur) ? cur[Number(k)]! : (cur as JsonObject)[k]!;
  }
  const last = tokens.at(-1)!;
  if (Array.isArray(cur)) cur[Number(last)] = nextVal;
  else (cur as JsonObject)[last] = nextVal;
}

function getJsonPointer(doc: Json, pointer: string): Json | undefined {
  let cur: Json | undefined = doc;
  for (const k of pointer.slice(1).split('/').map(t => t.replaceAll('~1', '/').replaceAll('~0', '~'))) {
    if (!isObject(cur) && !Array.isArray(cur)) return undefined;
    cur = (cur as JsonObject)[k];
  }
  return cur;
}

/** Seed a retained `versions[]` rig entry with `frozen-rig/1` registration and `review_package`. */
export function seedRetainedRigVersion(args: string[], now = Date.UTC(2026, 10, 7)): { stdout: string; exit: number } {
  if (args[0] === 'adapter') {
    const pos: string[] = [];
    const opts: Record<string, string> = {};
    for (let i = 1; i < args.length; i++) {
      const a = args[i]!;
      if (a === '--config' || a === '--out') opts[a] = args[++i]!;
      else pos.push(a);
    }
    const dir = pos[0] ?? process.cwd();
    const rows = seedPathAdapter(dir, opts['--config']!, opts['--out']);
    return { stdout: JSON.stringify(rows, null, 2), exit: 0 };
  }

  const positional: string[] = [];
  const options: Record<string, string> = {};
  const runRecords: string[] = [];
  const depthMapBindings: string[] = [];
  const answerValues: string[] = [];
  const acceptedBars: string[] = [];
  const acceptedLines: string[] = [];
  let acceptExposure = false;
  let carryDraftVerdict = true;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') json = true;
    else if (arg === '--no-draft-verdict') carryDraftVerdict = false;
    else if (arg === '--accept-check-exposure') acceptExposure = true;
    else if (arg === '--run-record') runRecords.push(args[++i]!);
    else if (arg === '--depth-map-binding') depthMapBindings.push(args[++i]!);
    else if (arg === '--answers') answerValues.push(args[++i]!);
    else if (arg === '--accept-check-bar') acceptedBars.push(args[++i]!);
    else if (arg === '--accept-check-line') acceptedLines.push(args[++i]!);
    else if ([
      '--parts', '--rig', '--build', '--idle', '--config', '--path-adapter', '--compile-report',
      '--toolchain-lock', '--at-source', '--at-pointer', '--by', '--citations', '--depth-manifest',
      '--check-report', '--check-accepted-by', '--owner-chat', '--said-at', '--relayed-by',
    ].includes(arg)) {
      options[arg] = args[++i]!;
    } else {
      positional.push(arg);
    }
  }
  const n = Number(positional[0]);
  const dir = realpathSync(resolve(positional[1] ?? process.cwd()));
  const { project } = readProjectJson(dir);
  const answersFeedback = answerValues.map(v => parseFeedbackPair(v)!);
  const regAt = new Date(now).toISOString();
  const checkAccepted = acceptedBars.length > 0 || acceptedLines.length > 0 || acceptExposure
    ? readOwnerChat(
        {
          ...(options['--owner-chat'] !== undefined ? { '--owner-chat': options['--owner-chat'] } : {}),
          ...(options['--said-at'] !== undefined ? { '--said-at': options['--said-at'] } : {}),
          ...(options['--relayed-by'] !== undefined ? { '--relayed-by': options['--relayed-by'] } : {}),
        },
        options['--check-accepted-by'] ?? '',
        now,
        `versions[v${n}].registration.check_report`,
        true,
      )!
    : undefined;

  const out = `outputs/v${n}`;
  const evidence = `evidence/v${n}/registration`;
  const existingVersions = asArray(project.versions).filter(isObject);
  const prevMax = Math.max(0, ...existingVersions.map(v => typeof v.n === 'number' ? v.n : 0));
  const skipped: JsonObject[] = [];
  for (let k = prevMax + 1; k < n; k++) {
    const dests = [`outputs/v${k}`, `evidence/v${k}/registration`, `derived/review/v${k}`].filter(d => existsSync(join(dir, d)));
    if (dests.length) skipped.push({ n: k, destinations: dests });
  }

  const evidenceFiles: JsonObject[] = [];
  const retain = (targetRel: string, bytes: Buffer): JsonObject => {
    const full = join(dir, targetRel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, bytes);
    const entry = { path: targetRel, sha256: sha(bytes), bytes: bytes.length };
    if (!evidenceFiles.some(e => e.path === targetRel)) evidenceFiles.push(entry);
    return { path: targetRel, sha256: entry.sha256 };
  };

  cpSync(resolve(dir, options['--parts']!), join(dir, out, 'out'), { recursive: true });
  cpSync(resolve(dir, options['--rig']!), join(dir, out, 'out/rig'), { recursive: true });
  cpSync(resolve(dir, options['--build']!), join(dir, out, 'out/check/build'), { recursive: true });
  cpSync(resolve(dir, options['--idle']!), join(dir, out, 'idle'), { recursive: true });

  // Optional plate assembly sources from draft if matching.
  const partsAbs = realpathSync(resolve(dir, options['--parts']!));
  const matchingDraft = asArray(project.drafts).filter(isObject).find(d =>
    typeof d.id === 'string' && DRAFT_ID.test(d.id) && isObject(d.parts) && typeof d.parts.path === 'string'
    && d.parts.path.endsWith('/rig') && existsSync(join(dir, d.parts.path))
    && realpathSync(join(dir, d.parts.path)) === partsAbs);
  if (matchingDraft && isObject(matchingDraft.parts)) {
    const assemblyRel = posix.dirname(String(matchingDraft.parts.path));
    const runPath = join(dir, assemblyRel, 'run.json');
    if (existsSync(runPath)) {
      try {
        const runBytes = readFileSync(runPath);
        const { spec, record } = validateRunRecord(runBytes, `${assemblyRel}/run.json`, { allowAssembleInputs: true });
        const manifest = readPartsManifest(join(dir, out, 'out/parts.json'));
        if (spec === 'rig-run/1' && record.command === 'assemble' && manifest.scene?.figure_mask === FIGURE_MASK_FILE) {
          const plateDir = join(dir, out, 'plate-assemble');
          mkdirSync(plateDir, { recursive: true });
          writeFileSync(join(plateDir, 'run.json'), runBytes);
          for (const o of asArray(record.outputs).filter(isObject)) {
            const p = String(o.path);
            const src = join(dir, assemblyRel, p);
            const dst = join(plateDir, p);
            if (existsSync(src)) {
              mkdirSync(dirname(dst), { recursive: true });
              writeFileSync(dst, readFileSync(src));
            }
          }
        }
      } catch { /* optional */ }
    }
  }

  const lockAbs = resolve(dir, options['--toolchain-lock']!);
  const lockBytes = readFileSync(lockAbs);
  let lockRaw: Json;
  let strictJson = false;
  try { lockRaw = JSON.parse(lockBytes.toString('utf8')) as Json; strictJson = true; }
  catch { lockRaw = Bun.JSONC.parse(lockBytes.toString('utf8')) as Json; }
  const lockKind: ToolchainKind = strictJson && isObject(lockRaw) && lockRaw.lockfileVersion === 3 ? 'npm-lock-v3' : 'bun-lock';
  const builtWith: JsonObject = {
    '@rig-c/parts': String(lockedPackage(lockRaw as JsonObject, lockKind, '@rig-c/parts').version),
    '@rig-c/core': String(lockedPackage(lockRaw as JsonObject, lockKind, '@rig-c/core').version),
  };
  const lockTarget = `${evidence}/${lockKind === 'bun-lock' ? 'bun.lock' : 'package-lock.json'}`;
  const lockBinding = retain(lockTarget, lockBytes);

  const runs: JsonObject[] = [];
  for (let idx = 0; idx < runRecords.length; idx++) {
    const rrAbs = resolve(dir, runRecords[idx]!);
    const rrBytes = readFileSync(rrAbs);
    const { spec } = validateRunRecord(rrBytes, runRecords[idx]!);
    const slug = FROZEN_RUN_SPECS.includes(spec as typeof FROZEN_RUN_SPECS[number])
      ? spec.replace('/', '-')
      : `extra-run-${idx + 1}`;
    const binding = retain(`${evidence}/${slug}.json`, rrBytes);
    runs.push({ spec, source: binding });
  }

  const compileBytes = readFileSync(resolve(dir, options['--compile-report']!));
  const compileBinding = retain(`${evidence}/compile-report.json`, compileBytes);

  const atBytes = readFileSync(resolve(dir, options['--at-source']!));
  const atDoc = JSON.parse(atBytes.toString('utf8')) as Json;
  const at = String(getJsonPointer(atDoc, options['--at-pointer']!));
  const atBinding = retain(`${evidence}/at-source.json`, atBytes);

  const configAbs = resolve(dir, options['--config']!);
  const configDir = dirname(realpathSync(configAbs));
  const configBytes = readFileSync(configAbs);
  const configObj = JSON.parse(configBytes.toString('utf8')) as JsonObject;
  const adapterBytes = readFileSync(resolve(dir, options['--path-adapter']!));
  const adapterRaw = JSON.parse(adapterBytes.toString('utf8')) as JsonObject[];
  const portable = structuredClone(configObj);
  const configInputSources = new Map<string, string>();
  const copySourceIntoEvidence = (srcAbs: string, relTarget: string) => {
    const stat = lstatSync(srcAbs);
    if (stat.isDirectory()) {
      for (const f of walkFiles(srcAbs)) {
        const fileAbs = join(srcAbs, f.path);
        const target = `${evidence}/${relTarget}/${f.path}`;
        retain(target, readFileSync(fileAbs));
        configInputSources.set(target, fileAbs);
      }
    } else {
      const target = `${evidence}/${relTarget}`;
      retain(target, readFileSync(srcAbs));
      configInputSources.set(target, srcAbs);
    }
  };

  // Apply adapter rows to config and copy referenced assets.
  const configRefs = configInputReferences(dir, portable);
  let reqSourcePath: string | undefined;
  let portableReqRel: string | undefined;
  for (const row of adapterRaw) {
    if (typeof row.at === 'string' && typeof row.before === 'string' && typeof row.after === 'string') {
      const parts = row.at.slice(1).split('.');
      const pointer = `/${parts.map(escapePointer).join('/')}`;
      const adapted = `inputs/${parts.join('/')}`;
      const srcAbs = resolve(dir, row.before);
      setJsonPointer(portable, pointer, adapted);
      if (pointer === '/requirements') { reqSourcePath = srcAbs; portableReqRel = adapted; }
      else copySourceIntoEvidence(srcAbs, adapted);
    } else if (row.doc === 'config' && typeof row.pointer === 'string' && typeof row.before === 'string' && typeof row.after === 'string') {
      const srcAbs = resolve(configDir, row.before);
      const ref = configRefs.find(r => `/${r.at.replace(/\[(\d+)\]/g, '.$1').split('.').map(escapePointer).join('/')}` === row.pointer);
      if (ref?.set) ref.set(row.after);
      else setJsonPointer(portable, row.pointer, row.after);
      if (row.pointer === '/requirements') { reqSourcePath = srcAbs; portableReqRel = row.after; }
      else copySourceIntoEvidence(srcAbs, row.after);
    }
  }
  // Any remaining unadapted relative config refs (e.g., requirements or named inputs already literal).
  for (const ref of configInputReferences(dir, configObj)) {
    const dotPath = ref.at.replace(/\[(\d+)\]/g, '.$1');
    const pointer = `/${dotPath.split('.').map(escapePointer).join('/')}`;
    if (adapterRaw.some(r => r.pointer === pointer || r.at === `.${dotPath}`)) continue;
    const srcAbs = resolve(configDir, ref.value);
    if (pointer === '/requirements') {
      reqSourcePath = srcAbs;
      portableReqRel = ref.value;
    } else if (existsSync(srcAbs)) {
      copySourceIntoEvidence(srcAbs, ref.value);
    }
  }

  let requirementsSourceBinding: JsonObject | undefined;
  let requirementsRuntimeBinding: JsonObject | undefined;
  const usesPointerFormat = adapterRaw.some(r => r.pointer !== undefined);
  if (typeof configObj.requirements === 'string' && reqSourcePath && portableReqRel) {
    const reqBytes = readFileSync(reqSourcePath);
    const reqObj = JSON.parse(reqBytes.toString('utf8')) as JsonObject;
    const portableReq = structuredClone(reqObj);
    const reqDir = dirname(reqSourcePath);
    const reqParent = dirname(portableReqRel);
    const setup = isObject(reqObj.setup_painting) ? reqObj.setup_painting : {};
    for (const key of ['figure_mask', 'backdrop'] as const) {
      const entry = setup[key];
      if (!isObject(entry) || typeof entry.path !== 'string') continue;
      const pointer = `/setup_painting/${key}/path`;
      const row = adapterRaw.find(r => r.doc === 'requirements' && r.pointer === pointer);
      const assetAbs = resolve(reqDir, entry.path);
      const adaptedVal = row ? String(row.after) : (key === 'backdrop' ? `setup_painting/${key}/path` : entry.path);
      const relInEv = reqParent === '.' ? adaptedVal : `${reqParent}/${adaptedVal}`;
      retain(`${evidence}/${relInEv}`, readFileSync(assetAbs));
      if (adaptedVal !== entry.path) setJsonPointer(portableReq, pointer, adaptedVal);
    }
    if (usesPointerFormat || setup.backdrop !== undefined) {
      const reqSourceRel = relative(dir, reqSourcePath).split(sep).join('/');
      requirementsSourceBinding = {
        ...retain(`${evidence}/requirements-source.json`, reqBytes),
        ...(!reqSourceRel.startsWith('..') && !isScratchBindingPath(reqSourceRel) ? { source_path: reqSourceRel } : {}),
      };
      const runtimeReqBytes = isDeepStrictEqual(reqObj, portableReq)
        ? reqBytes
        : Buffer.from(`${JSON.stringify(portableReq, null, 2)}\n`);
      requirementsRuntimeBinding = retain(`${evidence}/${portableReqRel}`, runtimeReqBytes);
    } else {
      retain(`${evidence}/${portableReqRel}`, reqBytes);
    }
  }

  const configSourceRel = relative(dir, realpathSync(configAbs)).split(sep).join('/');
  const configSourceBinding: JsonObject = {
    ...retain(`${evidence}/config-source.json`, configBytes),
    ...(!configSourceRel.startsWith('..') && !isScratchBindingPath(configSourceRel) ? { source_path: configSourceRel } : {}),
  };
  const adapterBinding: JsonObject = {
    ...retain(`${evidence}/path-adapter.json`, adapterBytes),
    ...(usesPointerFormat ? { format: 'json-pointer/1' } : {}),
  };
  const runtimeConfigBytes = isDeepStrictEqual(configObj, portable)
    ? configBytes
    : Buffer.from(`${JSON.stringify(portable, null, 2)}\n`);
  const configBinding = retain(`${evidence}/config.json`, runtimeConfigBytes);

  let sections: JsonObject = {};
  let citationsBinding: JsonObject | undefined;
  if (options['--citations']) {
    const citBytes = readFileSync(resolve(dir, options['--citations']));
    sections = JSON.parse(citBytes.toString('utf8')) as JsonObject;
    citationsBinding = retain(`${evidence}/citations.json`, citBytes);
  }

  const outputs = walkFiles(join(dir, out)).map(f => ({ path: `${out}/${f.path}`, sha256: f.sha256, bytes: f.bytes }));
  const idleBinding = outputs.find(f => f.path === `${out}/idle/frames.json`)!;

  let depthRecord: JsonObject | undefined;
  const drPath = join(partsAbs, 'depth-report.json');
  const sheetsOutput = outputs.find(f => f.path === `${out}/out/rig/depth_sheets.json`);
  const usesConfigDepth = isObject(configObj.depth) || (isObject(configObj.turn) && Object.values(configObj.turn).some(g =>
    isObject(g) && isObject(g.roles) && Object.values(g.roles).some(r => isObject(r) && typeof r.depth === 'number')));
  if (usesConfigDepth || sheetsOutput || options['--depth-manifest'] || existsSync(drPath) || depthMapBindings.length > 0) {
    const perPart = options['--depth-manifest'] !== undefined || existsSync(drPath) || !isObject(configObj.depth);
    const sheets = sheetsOutput ? { path: sheetsOutput.path, sha256: sheetsOutput.sha256 } : undefined;
    if (perPart) {
      depthRecord = { route: 'per-part' };
      const approval = rigPartsApproval(project, { at });
      const approvedDraft = asArray(project.drafts).filter(isObject).find(d => d.id === approval?.draft_id);
      if (approval && isObject(approvedDraft?.parts) && typeof approvedDraft.parts.path === 'string') {
        const originalParts = resolve(dir, approvedDraft.parts.path, 'parts.json');
        if (existsSync(originalParts)) {
          depthRecord.source_parts = retain(`${evidence}/depth-source-parts.json`, readFileSync(originalParts));
          if (realpathSync(resolve(dir, approvedDraft.parts.path)) === partsAbs && existsSync(drPath)) {
            depthRecord.source_parts_applied = true;
          }
        }
      }
      if (sheets) depthRecord.sheets = sheets;
      if (options['--depth-manifest']) {
        depthRecord.manifest = retain(`${evidence}/depth-manifest.json`, readFileSync(resolve(dir, options['--depth-manifest'])));
      }
      if (existsSync(drPath)) {
        depthRecord.report = retain(`${evidence}/depth-report.json`, readFileSync(drPath));
      }
      if (depthMapBindings.length) {
        depthRecord.map_bindings = depthMapBindings.map((p, idx) => {
          const bBytes = readFileSync(resolve(dir, p));
          const bDoc = JSON.parse(bBytes.toString('utf8')) as JsonObject;
          const retained = retain(`${evidence}/depth-map-bindings/${idx}.json`, bBytes);
          return { ...retained, spec: bDoc.spec!, part: bDoc.part! };
        });
      }
    } else if (sheets) {
      depthRecord = { route: 'per-layer', sheets };
    }
  }

  let checkReportBinding: JsonObject | undefined;
  if (options['--check-report']) {
    const crBytes = readFileSync(resolve(dir, options['--check-report']));
    const target = `${evidence}/${RIG_CHECK_REPORT_FILE}`;
    const retained = retain(target, crBytes);
    const parsed = parseRigCheckReport(crBytes);
    const acceptances: JsonObject[] = checkAccepted
      ? [
          ...acceptedBars.map(id => ({ kind: 'bar', id, ...checkAccepted, at: regAt })),
          ...acceptedLines.map(id => ({ kind: 'line', id, ...checkAccepted, at: regAt })),
          ...(acceptExposure ? [{ kind: 'exposure', id: SOURCE_EXPOSURE_ID, ...checkAccepted, at: regAt }] : []),
        ]
      : [];
    checkReportBinding = {
      ...retained,
      spec: parsed.spec ?? null,
      ...(acceptances.length ? { acceptances } : {}),
    };
  }

  const registration: JsonObject = {
    kind: 'frozen-rig/1',
    at: regAt,
    by: options['--by']!,
    ...(skipped.length ? { skipped } : {}),
    toolchain: { kind: lockKind, source: lockBinding },
    ...(runs.length ? { runs } : {}),
    compile: compileBinding,
    config_source: configSourceBinding,
    ...(requirementsSourceBinding ? { requirements_source: requirementsSourceBinding } : {}),
    ...(requirementsRuntimeBinding ? { requirements: requirementsRuntimeBinding } : {}),
    path_adapter: adapterBinding,
    ...(citationsBinding ? { citations: citationsBinding } : {}),
    ...(depthRecord ? { depth: depthRecord } : {}),
    ...(checkReportBinding ? { check_report: checkReportBinding } : {}),
    idle: { path: idleBinding.path, sha256: idleBinding.sha256 },
    files: evidenceFiles.sort((a, b) => String(a.path).localeCompare(String(b.path), 'en')),
    copied: { files: outputs.length, bytes: outputs.reduce((s, o) => s + o.bytes, 0) },
  };

  const version: JsonObject = {
    n,
    kind: 'rig',
    at,
    at_basis: 'not-after',
    at_source: { ...atBinding, pointer: options['--at-pointer']! },
    built_by: options['--by']!,
    built_with: builtWith,
    changed: `Frozen producer outputs registered at ${out}`,
    outputs,
    evidence: [],
    verdicts: [],
    answers_feedback: answersFeedback,
    review_origin: null,
    provenance: { config: configBinding, sections },
    registration,
  };
  const delta = approvedStructureDelta(dir, project, version, configObj);
  if (delta.length) (version.provenance as JsonObject).structure_delta = delta;

  const manifestDoc = readPartsManifest(join(dir, out, 'out/parts.json'));
  const partRefs = partsFileReferences(join(dir, out, 'out')).map(r => r.path);
  if (manifestDoc.painting_in_rig && !partRefs.includes(PAINTING_IN_RIG_FILE)) {
    partRefs.push(PAINTING_IN_RIG_FILE);
  }
  materializeReviewPackageOnVersion(dir, n, version, String(configBinding.path), `${out}/out`, partRefs);

  if (carryDraftVerdict) {
    const carried = findCarriedDraftVerdict(dir, project, version, configAbs, configInputSources, now);
    if (carried) {
      version.verdicts = [carried.verdict];
      if (carried.evidence) version.evidence = [carried.evidence];
    }
  }

  project.versions = [...asArray(project.versions), version];
  writeProjectJson(dir, project);
  return {
    stdout: json
      ? JSON.stringify(version, null, 2)
      : `seeded-rig-version: v${n}; ${String((version.review_package as JsonObject).open)}`,
    exit: 0,
  };
}

function findCarriedDraftVerdict(
  root: string,
  project: JsonObject,
  version: JsonObject,
  configAbs: string,
  copiedInputs: ReadonlyMap<string, string>,
  now: number,
): { verdict: JsonObject; evidence?: JsonObject } | undefined {
  const bySource = [...copiedInputs].map(([target, source]) => ({ target, relativePath: relative(dirname(configAbs), source) }));
  for (const receipt of asArray(project.review_acts).filter(isObject)) {
    if (receipt.kind !== 'review-verdict' || typeof receipt.bytes !== 'string' || typeof receipt.draft_id !== 'string') continue;
    let act;
    try { act = decodeReviewAct(receipt.bytes); } catch { continue; }
    if (!isDraftReviewVerdict(act) || Date.parse(act.at) > now || act.value.verdict !== 'approved') continue;
    const draft = asArray(project.drafts).filter(isObject).find(d => d.id === receipt.draft_id);
    if (!draft || !isObject(draft.config)) continue;
    const configured = asArray(draft.config_inputs).filter(isObject);
    const draftConfigDir = dirname(resolve(root, String(draft.config.path)));
    const relIn = (p: unknown) => relative(draftConfigDir, resolve(root, String(p)));
    const mapped = configured.map(inp => bySource.find(r => r.relativePath === relIn(inp.path))?.target);
    if (mapped.some(m => m === undefined)) continue;
    const inputs = mapped as string[];
    const by = retainedActBy(act, isObject(receipt.verdict) ? receipt.verdict.by : undefined);
    const verdict: JsonObject = {
      ...reviewActVerdict(act, by),
      source: `carried from draft review act ${act.jobId}/${act.actId}`,
      carried_from_draft: { draft_id: act.source.selector.id, job_id: act.jobId, act_id: act.actId, config_inputs: inputs },
    };
    const still = receipt.evidence !== undefined ? draftReviewStillEvidence(act) : undefined;
    const actFile = join(root, `evidence/drafts/${act.source.selector.id}/${String(receipt.sha256)}.act.json`);
    if (!existsSync(actFile) || jobHash(readFileSync(actFile)) !== receipt.sha256) continue;
    return { verdict, ...(still ? { evidence: still } : {}) };
  }
}
