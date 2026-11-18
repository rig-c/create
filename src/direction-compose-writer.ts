/** Freeze compose bytes before committing project.json; caller owns rollback. */
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { isDeepStrictEqual as equal } from 'node:util';
import { isObject } from './check.ts';
import { composeRoot, composeScenePath, DIRECTION_COMPOSE_SPEC, validateComposeDirectionShape } from './direction-compose.ts';
import { closed, directionFail, directionHash, directionJson } from './direction.ts';
import { sceneRigAcceptance, SceneError } from './scene.ts';
import type { JsonObject } from './templates.ts';

function tree(root: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const walk = (path: string): void => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) directionFail('DIRECTION_COMPOSE_FILE', path, 'compose trees must contain only regular files and directories');
    if (stat.isDirectory()) for (const name of readdirSync(path).sort()) walk(join(path, name));
    else if (stat.isFile()) files.set(relative(root, path).split('\\').join('/'), readFileSync(path));
    else directionFail('DIRECTION_COMPOSE_FILE', path, 'regular compose files required');
  };
  try { walk(root); }
  catch (e) { if (e instanceof Error && 'code' in e && String(e.code).startsWith('DIRECTION_')) throw e; directionFail('DIRECTION_COMPOSE_FILE', root, 'retain a readable compose output tree'); }
  return files;
}
function createRoot(dir: string, path: string, rollback: string[]): void {
  let at = dir;
  for (const part of path.split('/')) {
    at = join(at, part);
    let present = false;
    try { lstatSync(at); present = true; } catch (e) { if (!(e instanceof Error) || !('code' in e) || e.code !== 'ENOENT') throw e; }
    if (present) {
      const stat = lstatSync(at);
      if (!stat.isDirectory() || stat.isSymbolicLink() || at === join(dir, path)) directionFail('DIRECTION_COMPOSE_FILE', path, 'immutable destination must be absent with real directory parents');
    } else { mkdirSync(at); if (at === join(dir, path)) rollback.push(at); }
  }
}
export function freezeCompose(dir: string, project: JsonObject, doc: JsonObject, n: number, rigN: number, options: Record<string, string>, rollback: string[]): { doc: JsonObject; inventory: JsonObject[]; verify: () => void } {
  if (doc.schema !== DIRECTION_COMPOSE_SPEC || !options['--compose-out']) directionFail('DIRECTION_COMPOSE_SCHEMA', 'direction.compose', 'pass --compose-out for a direction@3 write');
  if (!closed(doc.rig, ['version'], ['acceptance']) || doc.rig.version !== rigN) directionFail('DIRECTION_COMPOSE_SCHEMA', 'direction.rig', 'declare only the selected rig version and optional writer-filled acceptance');
  let seal: JsonObject;
  try { seal = sceneRigAcceptance(project, rigN); }
  catch (e) { if (e instanceof SceneError) directionFail(e.code, e.path, e.message); throw e; }
  validateComposeDirectionShape({ ...doc, rig: { version: rigN, acceptance: seal } });
  const source = resolve(dir, options['--compose-out']);
  const files = tree(source);
  const reportBytes = files.get('scene.json');
  if (!reportBytes) directionFail('DIRECTION_COMPOSE_FILE', source, 'compose output must include scene.json');
  const report = directionJson(reportBytes, 'compose/scene.json');
  const sceneSource = resolve(dir, options['--compose-scene'] ?? (isObject(doc.compose) && isObject(doc.compose.scene) && typeof doc.compose.scene.path === 'string' && existsSync(join(dir, doc.compose.scene.path)) ? doc.compose.scene.path : String(report.scene)));
  let sceneBytes: Buffer;
  try { if (!lstatSync(sceneSource).isFile() || lstatSync(sceneSource).isSymbolicLink()) throw Error(); sceneBytes = readFileSync(sceneSource); }
  catch { return directionFail('DIRECTION_COMPOSE_FILE', 'direction.compose.scene', 'pass --compose-scene naming the exact scene input compose read'); }
  const root = composeRoot(n); const scenePath = composeScenePath(n);
  createRoot(dir, root, rollback); createRoot(dir, dirname(scenePath), rollback);
  const inventory: JsonObject[] = [];
  for (const [name, bytes] of files) {
    const path = `${root}/${name}`;
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), bytes, { flag: 'wx' });
    inventory.push({ path, sha256: directionHash(bytes) });
  }
  writeFileSync(join(dir, scenePath), sceneBytes, { flag: 'wx' });
  const bind = (name: string): JsonObject => {
    const bytes = files.get(name);
    if (!bytes) directionFail('DIRECTION_COMPOSE_FILE', `${root}/${name}`, 'retain all required compose producer outputs');
    return { path: `${root}/${name}`, sha256: directionHash(bytes) };
  };
  const result: JsonObject = { ...doc, rig: { version: rigN, acceptance: seal }, compose: {
    scene: { path: scenePath, sha256: directionHash(sceneBytes) }, out: root,
    report: bind('scene.json'), check: bind('check/check.json'), run: bind('compose-run.json'),
  }, model: bind('check/build/skeleton.model.json') };
  const verify = (): void => {
    try {
      if (!equal(files, tree(source)) || !equal(files, tree(join(dir, root))) || !lstatSync(sceneSource).isFile() || lstatSync(sceneSource).isSymbolicLink()
        || !readFileSync(sceneSource).equals(sceneBytes) || !readFileSync(join(dir, scenePath)).equals(sceneBytes)) throw Error('compose bytes moved');
    } catch { directionFail('DIRECTION_SOURCE_CHANGED', 'direction.compose', 'compose source or frozen bytes changed during publication'); }
  };
  return { doc: result, inventory, verify };
}
