/** Reproduce the /2 fixture with review's own writer at the schema-final head. */
import { setSystemTime } from 'bun:test';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const HEAD = '07c07d254725c97cfc63aa7b028cb8ef8ccf9045';
const [producerArg, destinationArg, flag] = process.argv.slice(2);
if (!producerArg || !destinationArg || (flag !== undefined && flag !== '--check')) {
  throw Error('usage: bun tests/generate-parts-verdict-v2.ts <review checkout at schema-final head> <fresh dir> [--check]');
}
const producer = resolve(producerArg), destination = resolve(destinationArg);
if (readFileSync(join(producer, '.git/HEAD'), 'utf8').trim() !== HEAD) throw Error('review checkout is not at schema-final head');
if (existsSync(destination)) throw Error('generation needs a fresh directory');
process.env.RIG_REVIEW_STATE_DIR = join(destination, 'state');
mkdirSync(destination, { recursive: true });
cpSync(join(import.meta.dir, 'fixtures/rig-review-1.5.0/derived'), join(destination, 'derived'), { recursive: true });

// Dynamic imports keep the fixture consumer independent of an external checkout/install.
const { loadPartsView, saveVerdict, verdictSource, readVerdict } = await import(pathToFileURL(join(producer, 'src/parts-view.ts')).href);
const { preparePartsComment } = await import(pathToFileURL(join(producer, 'src/parts-comment-crops.ts')).href);
setSystemTime(new Date('2026-11-05T12:00:00.000Z'));
try {
  for (const withComments of [false, true]) {
    const verdict = join(destination, 'evidence', withComments ? 'parts-review-comments.json' : 'parts-review.json');
    const pkg = await loadPartsView(join(destination, 'derived/parts/rig'), { verdict });
    const comments = [];
    if (withComments) {
      const png = readFileSync(join(destination, 'derived/parts/rig/parts/torso.png'));
      const sha256 = createHash('sha256').update(png).digest('hex');
      const camera = { zoom: 2, center: { x: 2, y: 2 }, viewport: { width: 40, height: 40 } };
      comments.push(await preparePartsComment(pkg, {
        schema: 'rig-review-parts-comment/1', id: 'edge-one', summary: 'Retain this clean edge.',
        part: 'torso', imageHash: sha256, sourceHash: verdictSource(pkg).sha256,
        imageRegion: { x: 1, y: 1, width: 2, height: 2 }, rigRegion: { x: 3, y: 3, width: 2, height: 2 },
        view: { camera, cameraSync: true, referenceCamera: camera, background: 'checker', alpha: true, footprints: true, mesh: false },
        crop: { path: `comment-crops/${sha256}.png`, sha256, width: 4, height: 4, png: 'data:image/png;base64,' + png.toString('base64') }, nativeCrop: null,
      }));
    }
    await saveVerdict(pkg, { status: 'approved', parts: Object.fromEntries(pkg.items.map((item: { name: string }) => [item.name, { outcome: 'clean' }])), comments });
    if ((await readVerdict(pkg)).verdict?.comments.length !== comments.length) throw Error('producer read-back differs');
  }
} finally { setSystemTime(); }

if (flag === '--check') {
  const shipped = join(import.meta.dir, 'fixtures/rig-review-parts-verdict-2');
  function compare(dir: string, relative = ''): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(relative, entry.name);
      if (entry.isDirectory()) compare(join(dir, entry.name), path);
      else if (!readFileSync(join(shipped, path)).equals(readFileSync(join(destination, path)))) throw Error(`${path}: producer fixture differs`);
    }
  }
  compare(destination);
}
console.log(`review ${HEAD}: saveVerdict + readVerdict, /2 approved without and with comments`);
