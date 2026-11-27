import { asArray, isObject } from './check.ts';
import type { CurrentKind } from './current.ts';
import { humanReviewVerdicts, readVersions } from './review.ts';
import type { Json, JsonObject } from './templates.ts';

type Binding = { path: string; sha256: string };
type LegacyFile = Binding & { bytes?: number };
type SourceProblem = {
  ok: false;
  code: 'RECORD_ADOPT_CURRENT_EXISTS' | 'RECORD_ADOPT_SOURCE_MISSING' | 'RECORD_ADOPT_SOURCE_INVALID';
  path: string;
  why: string;
};

function binding(value: Json | undefined): Binding | undefined {
  if (!isObject(value) || typeof value.path !== 'string' || value.path.startsWith('/')
    || /^[A-Za-z]:/.test(value.path) || /[\\\0]/.test(value.path)
    || value.path.split('/').some(part => !part || part === '.' || part === '..')
    || typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.sha256)) return undefined;
  return { path: value.path, sha256: value.sha256 };
}

const role = (kind: CurrentKind): 'post' | 'rig' => kind === 'direction' ? 'post' : 'rig';
const byPath = (a: Binding, b: Binding): number => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

export function adoptedRigConfigBinding(source: JsonObject): Binding | undefined {
  const { registration, provenance } = source;
  return binding(isObject(registration) ? registration.config_source : isObject(provenance) ? provenance.config : undefined);
}

/** The numbered writers retain distinct trees, except for the parts manifest and its sidecars under out/. */
function ownsOutput(root: string, kind: CurrentKind, path: string): boolean {
  if (kind === 'parts') {
    return path.startsWith(`${root}/out/parts/`) || path.startsWith(`${root}/plate-assemble/`)
      || ['parts.json', 'recomposite_rig.png', 'figure_rig.png', 'painting_in_rig.png'].some(name => path === `${root}/out/${name}`);
  }
  if (kind === 'rig') return path.startsWith(`${root}/out/rig/`) || path.startsWith(`${root}/out/check/`);
  return path.startsWith(`${root}/${kind === 'motion' ? 'idle' : 'compose'}/`);
}

/** Read the exact numbered inventory cited by an adopted node, even after that version lapses. */
export function adoptedOutputBindings(project: JsonObject, kind: CurrentKind, version: number):
  SourceProblem | { ok: true; source: JsonObject; files: LegacyFile[] } {
  const path = `versions[v${version}].outputs`;
  const rows = asArray(project.versions).filter(isObject).filter(row => row.n === version);
  const source = rows[0];
  if (rows.length > 1) return { ok: false, code: 'RECORD_ADOPT_SOURCE_INVALID', path, why: 'the version number is ambiguous' };
  if (!source || source.kind !== role(kind)) {
    return { ok: false, code: 'RECORD_ADOPT_SOURCE_MISSING', path, why: `no ${role(kind)} version binds ${kind} here` };
  }
  const root = `outputs/v${version}`;
  const files = new Map<string, LegacyFile>();
  for (const row of asArray(source.outputs)) {
    if (!isObject(row) || typeof row.path !== 'string' || !ownsOutput(root, kind, row.path)) continue;
    const file = binding(row);
    const bytes = row.bytes;
    if (!file || files.has(file.path) || (bytes !== undefined && (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 0))) {
      return { ok: false, code: 'RECORD_ADOPT_SOURCE_INVALID', path, why: 'a kind-owned output has a malformed or duplicate binding' };
    }
    files.set(file.path, { ...file, ...(typeof bytes === 'number' ? { bytes } : {}) });
  }
  if (!files.size) return { ok: false, code: 'RECORD_ADOPT_SOURCE_MISSING', path, why: `the version has no bound ${kind} output` };
  return { ok: true, source, files: [...files.values()].sort(byPath) };
}

/** Acceptance is a historical fact of the numbered version and survives a reopen. */
export function wasNumberedRigAccepted(project: JsonObject, version: number): boolean {
  const rigs = readVersions(project).rigs.filter(rig => rig.n === version);
  return rigs.length === 1 && !rigs[0]!.preInterview && rigs[0]!.accepted !== null;
}

/** Resolve the particular co-registration edges that attest a numbered idle render. */
export function legacyMotionRegistration(project: JsonObject, version: number): { model: Binding; frames: Binding } | undefined {
  const rig = adoptedOutputBindings(project, 'rig', version);
  const motion = adoptedOutputBindings(project, 'motion', version);
  if (!rig.ok || !motion.ok || !wasNumberedRigAccepted(project, version)) return undefined;
  const registration = rig.source.registration;
  if (!isObject(registration) || registration.kind !== 'frozen-rig/1') return undefined;
  const root = `outputs/v${version}`;
  const model = binding(rig.files.find(file => file.path === `${root}/out/check/build/skeleton.model.json`));
  const frames = binding(registration.idle);
  if (!model || frames?.path !== `${root}/idle/frames.json`
    || !motion.files.some(file => file.path === frames.path && file.sha256 === frames.sha256)) return undefined;
  return { model, frames };
}

/**
 * Read-only offer for next and record. No output bytes are read here.
 * Use the latest live version of the relevant role, including unaccepted rigs.
 */
export function resolveAdoptSource(project: JsonObject, kind: CurrentKind): SourceProblem | {
  ok: true;
  version: number;
  at: string;
  builtBy: string;
  builtWith: JsonObject;
  files: LegacyFile[];
  builtFrom: Binding[];
  run?: Binding;
  report?: Binding;
  bouncedDirectionVerdict?: number;
} {
  if (project.current !== undefined && !isObject(project.current)) {
    return { ok: false, code: 'RECORD_ADOPT_SOURCE_INVALID', path: 'current', why: 'expected an object of current outputs' };
  }
  if (isObject(project.current) && Object.hasOwn(project.current, kind)) {
    return { ok: false, code: 'RECORD_ADOPT_CURRENT_EXISTS', path: `current.${kind}`, why: 'a current entry already exists' };
  }
  const versions = readVersions(project);
  const relevant = kind === 'direction' ? versions.posts : versions.rigs;
  const version = Math.max(0, ...relevant.filter(row => row.live && Number.isSafeInteger(row.n)).map(row => row.n));
  if (version === 0) return { ok: false, code: 'RECORD_ADOPT_SOURCE_MISSING', path: 'versions', why: `there is no live ${role(kind)} version for ${kind}` };
  const inventory = adoptedOutputBindings(project, kind, version);
  if (!inventory.ok) return inventory;

  const { source, files } = inventory;
  const path = `versions[v${version}]`;
  const at = typeof source.at === 'string' ? Date.parse(source.at) : NaN;
  const { built_by: builtBy, built_with: builtWith, provenance } = source;
  if (!Number.isFinite(at) || typeof builtBy !== 'string' || !builtBy.trim() || !isObject(builtWith)
    || Object.values(builtWith).some(value => typeof value !== 'string' || !value)) {
    return { ok: false, code: 'RECORD_ADOPT_SOURCE_INVALID', path, why: 'the source lacks a valid build date, builder or package-version map' };
  }
  const root = `outputs/v${version}`;
  const find = (rel: string): Binding | undefined => binding(files.find(file => file.path === `${root}/${rel}`));
  const builtFrom: Binding[] = [];
  if (kind === 'rig') {
    const config = adoptedRigConfigBinding(source);
    if (config) builtFrom.push(config);
  }
  if (kind === 'direction') {
    const direction = binding(isObject(provenance) ? provenance.direction : undefined);
    if (direction) builtFrom.push(direction);
    const scene = asArray(source.outputs).map(binding).find(file => file?.path === `evidence/compose-src/v${version}/scene.json`);
    if (scene) builtFrom.push(scene);
  }
  const run = kind === 'parts' ? find('plate-assemble/run.json')
    : kind === 'rig' ? find('out/rig/run.json') ?? find('out/check/build/run.json')
      : kind === 'motion' ? find('idle/render-run.json') : find('compose/compose-run.json');
  const report = kind === 'parts' ? find('plate-assemble/check/parts-check.json')
    : kind === 'rig' ? find('out/check/check.json')
      : kind === 'direction' ? find('compose/check/check.json') : undefined;
  const directionVerdict = kind === 'direction' ? humanReviewVerdicts(source.verdicts, 'direction-review').at(-1) : undefined;
  return { ok: true, version, at: new Date(at).toISOString(), builtBy, builtWith, files, builtFrom: builtFrom.sort(byPath), run, report,
    ...(directionVerdict?.record.verdict === 'bounced' ? { bouncedDirectionVerdict: directionVerdict.index } : {}) };
}
