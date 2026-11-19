import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const load = createRequire(import.meta.url);
const { newRaster } = load('@rig-c/parts/src/raster/types.ts') as typeof import('../node_modules/@rig-c/parts/src/raster/types.ts');
const { encodePngBytes } = load('@rig-c/parts/src/raster/png.ts') as typeof import('../node_modules/@rig-c/parts/src/raster/png.ts');
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Synthetic bytes and the published Parts 2476b25 receipt shape. */
export function externalMaskEvidence() {
  const painting = newRaster(2, 2);
  painting.data.fill(255);
  const mask = newRaster(2, 2);
  mask.data.set([255, 255, 255, 255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255, 255]);
  const paintingBytes = encodePngBytes(painting);
  const maskBytes = encodePngBytes(mask);
  const receipt = {
    spec: 'rig-parts-external-receipt/1',
    kind: 'mask',
    file: { path: 'mask.png', sha256: sha256(maskBytes) },
    painting: { path: '../painting.png', sha256: sha256(paintingBytes) },
    grid: { width: 2, height: 2 },
    producer: { tool: 'synthetic external tool', script_sha256: 'a'.repeat(64) },
  };
  return { paintingBytes, maskBytes, receipt };
}
