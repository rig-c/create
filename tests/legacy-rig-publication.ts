/** Portable old publication producer: retain the 1.7.2 subjects expression, not private host state. */
import { cpSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import retained from './fixtures/rig-publication-1.7.2.json';

/** Only a temporary runtime copy changes; the real consumer record and host use the public APIs. */
export function legacyRigPublicationCli(runtime: string): string {
  const repo = join(import.meta.dir, '..');
  cpSync(join(repo, 'src'), join(runtime, 'src'), { recursive: true });
  for (const name of ['node_modules', 'templates', 'scripts', 'package.json', 'bun.lock']) {
    symlinkSync(join(repo, name), join(runtime, name));
  }
  mkdirSync(join(runtime, 'tests'));
  cpSync(join(import.meta.dir, 'cli-at.ts'), join(runtime, 'tests/cli-at.ts'));
  const file = join(runtime, 'src/job-publication.ts');
  const source = readFileSync(file, 'utf8');
  const start = source.indexOf("  const subjects: JobPublishedContext['subjects'] = [", source.indexOf('const reviewStage ='));
  const end = source.indexOf('\n  return {', start);
  if (start < 0 || end < 0) throw Error('retained 1.7.2 publication producer insertion point moved');
  writeFileSync(file, source.slice(0, start) + retained.subjectsSource + source.slice(end));
  return join(runtime, 'tests/cli-at.ts');
}
