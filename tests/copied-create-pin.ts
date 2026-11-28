import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CREATE_PACKAGE, runningCreateVersion } from '../src/pins.ts';

// Re-pin the temp copy to the running Create so tests unrelated to the pin avoid the numbered-project pin warning.
export function copyWithRunningCreatePin(source: string, destination: string): void {
  cpSync(source, destination, { recursive: true });
  const path = join(destination, 'package.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as { dependencies: Record<string, string> };
  manifest.dependencies[CREATE_PACKAGE] = runningCreateVersion();
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
}
