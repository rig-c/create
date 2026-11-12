/** A fresh process avoids parts module-cache reuse across an install swap. */
import { checkProject } from './check.ts';
if (import.meta.main) {
  const input = await Bun.stdin.json();
  process.stdout.write(JSON.stringify(checkProject(input.dir, input.project, { now: input.now, readOnly: true })));
}
