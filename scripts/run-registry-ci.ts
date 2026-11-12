import { resolve } from 'node:path';
import { runCiSuite } from './ci-suite.ts';
process.exit(runCiSuite(resolve(import.meta.dir,'..'),'registry').exitCode);
