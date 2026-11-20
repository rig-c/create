export type ToolchainKind = 'npm-lock-v3' | 'bun-lock';

/** The version and integrity fields of a registry package in either lock format. */
export function lockedPackage(raw: unknown, kind: ToolchainKind, name: string): { version: unknown; integrity: unknown } {
  const packages = (raw as { packages?: Record<string, unknown> } | null)?.packages;
  if (kind === 'bun-lock') {
    const entry = packages?.[name];
    const resolution = Array.isArray(entry) ? entry[0] : undefined;
    return {
      version: typeof resolution === 'string' && resolution.startsWith(`${name}@`) ? resolution.slice(name.length + 1) : undefined,
      integrity: Array.isArray(entry) ? entry.at(-1) : undefined,
    };
  }
  const entry = packages?.[`node_modules/${name}`] as { version?: unknown; integrity?: unknown } | null | undefined;
  return { version: entry?.version, integrity: entry?.integrity };
}
