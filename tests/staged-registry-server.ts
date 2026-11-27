// Test-only registry child. The parent runs synchronous installs, so the
// listener needs its own process. The parent's stdin pipe owns its lifetime.
import { createHash } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';

const [tarball, manifestPath, portFile] = process.argv.slice(2);
if (!tarball || !manifestPath || !portFile) throw new Error('usage: staged-registry-server <tgz> <package.json> <port file>');

const bytes = new Uint8Array(await Bun.file(tarball).arrayBuffer());
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name: string; version: string };
const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
const shasum = createHash('sha1').update(bytes).digest('hex');
const UPSTREAM = 'https://registry.npmjs.org';
const TARBALL_PATH = '/-/staged-create.tgz';

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request, server) {
    const head = request.method === 'HEAD';
    if (!head && request.method !== 'GET') return new Response(null, { status: 405 });

    const url = new URL(request.url);
    const path = decodeURIComponent(url.pathname);
    if (path === TARBALL_PATH) {
      return new Response(head ? null : bytes, { headers: { 'content-type': 'application/octet-stream' } });
    }
    if (path === `/${manifest.name}`) {
      if (head) return new Response(null, { headers: { 'content-type': 'application/json' } });
      const dist = { tarball: new URL(TARBALL_PATH, server.url).href, integrity, shasum };
      return Response.json({
        name: manifest.name,
        'dist-tags': { latest: manifest.version },
        versions: { [manifest.version]: { ...manifest, dist } },
      });
    }

    // Only the representation preference goes upstream. Fetch decodes the
    // body, so do not reuse the upstream encoding or content length.
    const upstream = await fetch(`${UPSTREAM}${url.pathname}${url.search}`, {
      method: request.method,
      headers: { accept: request.headers.get('accept') ?? '*/*' },
    });
    const contentType = upstream.headers.get('content-type');
    return new Response(upstream.body, {
      status: upstream.status,
      headers: contentType === null ? undefined : { 'content-type': contentType },
    });
  },
});

// EOF also covers a parent killed before its exit hook can run.
process.stdin.once('end', () => process.exit(0));
process.stdin.resume();
writeFileSync(`${portFile}.tmp`, String(server.port));
renameSync(`${portFile}.tmp`, portFile);
