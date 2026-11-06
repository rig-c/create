/** Validate generator CLI arguments before any fixture is materialized. */
export function generatorArgs(
  script: string,
  usage: string,
  args: string[] = process.argv.slice(2),
): { destination: string; check: boolean } {
  const [destination, flag, ...extra] = args;
  let badArgument = extra[0];
  if (!destination) {
    badArgument = '(missing destination)';
  } else if (destination.startsWith('--')) {
    badArgument = destination;
  } else if (flag !== undefined && flag !== '--check') {
    badArgument = flag;
  }
  if (badArgument !== undefined) {
    const error = new Error(`${script}: invalid argument ${JSON.stringify(badArgument)}; supply a destination and optional --check.\n${usage}`);
    error.name = 'GENERATOR_ARGS_INVALID';
    throw error;
  }
  return { destination: destination!, check: flag === '--check' };
}
