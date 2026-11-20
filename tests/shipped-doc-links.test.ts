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

test('shipped documentation links resolve inside the npm package', () => {
  const result = Bun.spawnSync(['npm', 'pack', '--dry-run', '--json'], { cwd: root });
  expect(result.exitCode).toBe(0);
  const { name } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name: string };
  const { files } = readNpmJson(result.stdout.toString(), 'npm pack --dry-run --json', 'pack', name);
  expect(files).toBeArray();
  const packed = new Set(files);
  const docs = [...packed].filter(file => file === 'README.md' || /^docs\/.*\.md$/.test(file));
  expect(docs.length).toBeGreaterThan(0);
  const missing = docs.flatMap(file => unpackedLinks(file, readFileSync(join(root, file), 'utf8'), packed));
  expect(missing).toEqual([]);

  const planted = unpackedLinks('docs/fixture.md', '[Repository rules](../AGENTS.md#rules)', packed);
  expect(planted).toEqual(['docs/fixture.md -> AGENTS.md']);
  expect(() => expect(planted).toEqual([])).toThrow();
});
