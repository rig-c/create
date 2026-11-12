import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** Tags and ancestry must be available (CI checks siblings out at fetch-depth 0). */
export function checkSourcePins(createRoot: string): void {
  const parent = dirname(createRoot);
  const pins = JSON.parse(readFileSync(join(createRoot, 'scripts/source-ci-pins.json'), 'utf8')) as Record<string, string>;
  const dependencies = (JSON.parse(readFileSync(join(createRoot, 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>;
  }).dependencies;
  const git = (name: string, args: string[]): string => {
    const result = Bun.spawnSync(['git', ...args], { cwd: join(parent, name), stdout: 'pipe', stderr: 'pipe' });
    if (result.exitCode !== 0) throw new Error(`SOURCE_PIN_ANCESTRY: scripts/source-ci-pins.json @rig-c/${name}: git ${args.join(' ')} failed; fetch release tags and history, then choose a SHA at or after the release tag`);
    return result.stdout.toString().trim();
  };
  const reviewVersion = dependencies['@rig-c/review'];
  if (!reviewVersion || !/^\d+\.\d+\.\d+$/.test(reviewVersion)) throw new Error('SOURCE_PIN_ANCESTRY: package.json @rig-c/review: use an exact published version');
  const releaseReview = JSON.parse(git('review', ['show', `v${reviewVersion}:package.json`])) as { dependencies: Record<string, string> };
  for (const name of ['core', 'parts', 'review', 'play']) {
    const version = name === 'play' ? releaseReview.dependencies['@rig-c/play'] : dependencies[`@rig-c/${name}`];
    if (!version || !/^\d+\.\d+\.\d+$/.test(version) || !/^[a-f0-9]{40}$/.test(pins[name] ?? '')) {
      throw new Error(`SOURCE_PIN_ANCESTRY: scripts/source-ci-pins.json @rig-c/${name}: require a full SHA and exact release version in package.json (play uses release Review); update the pin`);
    }
    git(name, ['merge-base', '--is-ancestor', `refs/tags/v${version}^{commit}`, pins[name]!]);
    console.log(`@rig-c/${name}: ${pins[name]} is at or after v${version}`);
  }
}

if (import.meta.main) checkSourcePins(resolve(import.meta.dir, '..'));
