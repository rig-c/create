export type ToolchainKind = 'npm-lock-v3' | 'bun-lock';

/** The version and integrity at a slash-separated install path relative to the lockfile root. */
export function lockedPackage(raw: unknown, kind: ToolchainKind, name: string, installPath = `node_modules/${name}`): { version: unknown; integrity: unknown } {
  const packages = (raw as { packages?: Record<string, unknown> } | null)?.packages;
  if (kind === 'bun-lock') {
    const key = installPath.replace(/^node_modules\//, '').replaceAll('/node_modules/', '/');
    const entry = packages?.[key];
    const resolution = Array.isArray(entry) ? entry[0] : undefined;
    return {
      version: typeof resolution === 'string' && resolution.startsWith(`${name}@`) ? resolution.slice(name.length + 1) : undefined,
      integrity: Array.isArray(entry) ? entry.at(-1) : undefined,
    };
  }
  const entry = packages?.[installPath] as { version?: unknown; integrity?: unknown } | null | undefined;
  return { version: entry?.version, integrity: entry?.integrity };
}
