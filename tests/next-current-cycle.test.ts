import { expect, mock, test } from 'bun:test';
import { join } from 'node:path';
import * as cli from '../src/cli.ts';
import { nextCommand, type NextReport } from '../src/next.ts';
import { gitEnv, run, tempDir } from './helpers.ts';

const DIRECTION_STEPS = [
  'rigc render',
  'rig-create record motion',
  'rig-create scene write',
  'rig-create direction write',
  'rig-parts compose',
  'rig-create record direction',
];
const BUILD_STEPS = [
  'rig-parts assemble', 'rig-parts check-parts', 'rig-create record parts',
  'rig-parts rig', 'rig-parts check', 'rig-create record rig',
];

function commands(report: NextReport, prefix: string) {
  return report.moves.flatMap(move =>
    move.command?.split(' && ').some(command => command.startsWith(`${prefix} `)) ? [move.command] : []);
}

async function replay(destination: string): Promise<void> {
  const dir = join(destination, 'example-current');
  let writers = 0;
  let now = 0;
  let directionStep = 0;
  let buildStep = 0;
  const main = cli.main;
  const assertOffered = (prefix: string, at: number) => {
    const report = JSON.parse(nextCommand([dir, '--json'], at).stdout) as NextReport;
    const offered = commands(report, prefix);
    if (offered.length === 0) throw new Error(`next at ${report.stage} omitted ${prefix}`);
    if (prefix.startsWith('rig-create signoff ') && !offered.some(command =>
      ['--by', '--owner-chat', '--said-at', '--relayed-by'].every(flag => command.includes(` ${flag} `)))) {
      throw new Error(`next at ${report.stage} omitted the owner chat relay for ${prefix}`);
    }
    if (BUILD_STEPS.includes(prefix)) {
      const expected = BUILD_STEPS[buildStep];
      const future = BUILD_STEPS.slice(buildStep + 1).filter(step => commands(report, step).length > 0);
      if (prefix !== expected || future.length > 0) {
        throw new Error(`next at ${report.stage} expected ${expected}, called ${prefix}, offered early: ${future.join(', ')}`);
      }
      buildStep++;
    }
    if (DIRECTION_STEPS.includes(prefix)) {
      const expected = DIRECTION_STEPS[directionStep];
      const future = DIRECTION_STEPS.slice(directionStep + 1).filter(step => commands(report, step).length > 0);
      if (prefix !== expected || future.length > 0) {
        throw new Error(`next at ${report.stage} expected ${expected}, called ${prefix}, offered early: ${future.join(', ')}`);
      }
      directionStep++;
    }
    return offered;
  };
  mock.module('../src/cli.ts', () => ({
    ...cli,
    main(args: string[], at: number) {
      const writer = args[0];
      if (writer !== 'init') {
        const words = writer === 'structure-snapshot' ? 1 : writer === 'plan' || writer === 'step-status' ? 3 : 2;
        const offered = assertOffered(`rig-create ${args.slice(0, words).join(' ')}`, now);
        if (writer === 'record' && (args[1] === 'parts' || args[1] === 'rig')) {
          const config = args[args.indexOf('--config') + 1];
          if (!offered.some(command => command.endsWith(` --config ${config}`))) {
            throw new Error(`next omitted the config bound by the staged ${args[1]} run`);
          }
        }
        writers++;
      }
      now = at;
      return main(args, at);
    },
  }));
  Bun.spawnSync = new Proxy(Bun.spawnSync, {
    apply(target, receiver, args) {
      const [command, options] = args;
      if (options?.cwd === dir && Array.isArray(command) && typeof command[1] === 'string') {
        if (command[1].endsWith('/rigc.cjs') && command[2] === 'render') assertOffered('rigc render', now);
        if (command[1].endsWith('/rig-parts.cjs') && typeof command[2] === 'string') {
          const prefix = `rig-parts ${command[2]}`;
          // The second check-parts call creates retained arrival evidence, outside staging.
          if (command[2] !== 'check-parts' || command.includes('outputs/parts.next/rig')) assertOffered(prefix, now);
        }
      }
      return Reflect.apply(target, receiver, args);
    },
  });
  const { generateExampleCurrent } = await import('../scripts/generate-example-current.ts');
  generateExampleCurrent(destination);
  if (buildStep !== BUILD_STEPS.length) throw new Error(`replay finished after ${buildStep} of ${BUILD_STEPS.length} build steps`);
  if (directionStep !== DIRECTION_STEPS.length) throw new Error(`replay finished after ${directionStep} of ${DIRECTION_STEPS.length} direction steps`);
  console.log(`offered_writers=${writers} build_steps=${buildStep} direction_steps=${directionStep}`);
}

if (process.argv[2] === '--replay-current-example') {
  await replay(process.argv[3]!);
} else {
  test('#1057 the current example replays only writers offered by next', () => {
    const root = tempDir();
    const result = run([process.execPath, import.meta.path, '--replay-current-example', join(root, 'replay')], root, gitEnv());
    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('current example: accepted; 0 refusals, 0 warnings');
    expect(result.stdout).toMatch(/offered_writers=[1-9][0-9]* build_steps=6 direction_steps=6/);
    console.log(result.stdout.trimEnd().split('\n').at(-1));
  }, 120_000);
}
