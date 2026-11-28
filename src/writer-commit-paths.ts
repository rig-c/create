export const OUTPUTS_IGNORE = ['/outputs/*', '!/outputs/parts/'] as const;
export const BASELINE_PATHS = ['project.json', 'package.json', 'bun.lock'] as const;
export const GITIGNORE_MIGRATION_LINE = `gitignore: /outputs/ -> ${OUTPUTS_IGNORE.join(' ')}`;

const EXCLUDED_BOUND_PATHS = new Set<string>([
  ...BASELINE_PATHS,
  '.gitignore',
  'collection.json',
  'review-live.json',
]);

/** Filter bound project-relative paths to those eligible for scoped tool-write commits. */
export function eligibleBoundPaths(paths: readonly string[]): string[] {
  return [...new Set(paths)].filter(path =>
    path.length > 0 && !path.startsWith('/') && !path.includes('\\') && !path.includes('\0')
    && !path.split('/').some(part => !part || ['.', '..', '.git'].includes(part.toLowerCase()))
    && !EXCLUDED_BOUND_PATHS.has(path)
    && !/^(?:scratch\/|node_modules\/|\.rig-create-)/.test(path),
  );
}
