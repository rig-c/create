import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readNpmJson } from '../scripts/npm-json.ts';

const root = fileURLToPath(new URL('../', import.meta.url));

function unpackedLinks(document: string, markdown: string, packed: ReadonlySet<string>): string[] {
  const missing: string[] = [];
  Bun.markdown.render(markdown, {
    link(_children, { href }) {
      const path = href.split(/[?#]/, 1)[0];
      if (!path || /^(?:[a-z][a-z\d+.-]*:|\/)/i.test(path)) return '';
      const target = posix.join(posix.dirname(document), decodeURIComponent(path));
      if (!packed.has(target) && ![...packed].some(file => file.startsWith(`${target.replace(/\/$/, '')}/`))) {
        missing.push(`${document} -> ${target}`);
      }
      return '';
    },
  });
  return missing;
}

function sameRepositoryUrls(markdown: string): string[] {
  return markdown.match(/https:\/\/(?:github\.com\/rig-c\/create\/(?:blob|tree|raw)\/|raw\.githubusercontent\.com\/rig-c\/create\/)[^\s)"'>]*/gu) ?? [];
}

test('shipped documentation links resolve: the README in the repository, the guides inside the npm package', () => {
  const result = Bun.spawnSync(['npm', 'pack', '--dry-run', '--json'], { cwd: root });
  expect(result.exitCode).toBe(0);
  const { name } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name: string };
  const { files } = readNpmJson(result.stdout.toString(), 'npm pack --dry-run --json', 'pack', name);
  expect(files).toBeArray();
  const packed = new Set(files);
  const docs = [...packed].filter(file => file === 'README.md' || /^docs\/.*\.md$/.test(file));
  expect(docs.length).toBeGreaterThan(0);
  // The README is the package page: the registry renders its relative links and images against
  // the repository field, so they are held to the repository's tracked files. Every other shipped
  // document is read from an installed copy and may only link what is packed with it.
  const tracked = new Set(Bun.spawnSync(['git', 'ls-files'], { cwd: root }).stdout.toString().split('\n').filter(Boolean));
  expect(tracked.has('README.md')).toBe(true);
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  const missing = docs.flatMap(file => file === 'README.md'
    ? unpackedLinks(file, readme, tracked)
    : unpackedLinks(file, readFileSync(join(root, file), 'utf8'), packed));
  expect(missing).toEqual([]);
  expect(unpackedLinks('README.md', '[Gone](docs/NO-SUCH-PAGE.md)', tracked)).toEqual(['README.md -> docs/NO-SUCH-PAGE.md']);

  // A link or image to a file of this repository is written relative in the README.
  expect(sameRepositoryUrls(readme)).toEqual([]);
  expect(sameRepositoryUrls('[Releasing](https://github.com/rig-c/create/blob/main/RELEASING.md) <img src="https://raw.githubusercontent.com/rig-c/create/main/assets/banner.svg" />')).toHaveLength(2);
  expect(sameRepositoryUrls('[Core](https://github.com/rig-c/core/blob/main/README.md) [issue](https://github.com/rig-c/create/issues/1)')).toEqual([]);

  const planted = unpackedLinks('docs/fixture.md', '[Repository rules](../AGENTS.md#rules)', packed);
  expect(planted).toEqual(['docs/fixture.md -> AGENTS.md']);
  expect(() => expect(planted).toEqual([])).toThrow();
}, 30_000);
