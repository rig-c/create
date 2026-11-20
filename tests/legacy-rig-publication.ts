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
  const current = '  const subjects = livePublicationSubjects(root, project, selector);';
  const [before, after, duplicate] = source.split(current);
  if (before === undefined || after === undefined || duplicate !== undefined) {
    throw Error('retained 1.7.2 publication producer insertion point moved');
  }
  const reviewStage = "  const reviewStage = selector.kind === 'post' ? 'direction-review' as const : 'rig-review' as const;";
  writeFileSync(file, before + reviewStage + '\n' + retained.subjectsSource + after);
  return join(runtime, 'tests/cli-at.ts');
}
