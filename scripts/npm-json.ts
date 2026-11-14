/** npm 11 and 12 have different pack and view JSON envelopes. */
import { readFileSync } from 'node:fs';

export interface NpmPack {
  filename: string;
  entryCount: number;
  size: number;
  unpackedSize: number;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function shape(value: unknown): string {
  if (Array.isArray(value)) return `array(length=${value.length}) ${JSON.stringify(value).slice(0, 200)}`;
  if (object(value)) return `object(keys=${JSON.stringify(Object.keys(value))})`;
  return `${value === null ? 'null' : typeof value} ${JSON.stringify(value)}`;
}

export function readNpmJson(text: string, command: string, kind: 'pack', expected: string): NpmPack;
export function readNpmJson(text: string, command: string, kind: 'version', expected: string): string;
export function readNpmJson(text: string, command: string, kind: 'e404'): string;
export function readNpmJson(text: string, command: string, kind: 'pack' | 'version' | 'e404', expected?: string): NpmPack | string {
  const fail = (field: string, want: string, actual: unknown): never => {
    throw Error(`${command}: ${field}: expected ${want}; actual ${shape(actual)}`);
  };
  const envelope = kind === 'pack' ? `one-element array or object keyed only by ${JSON.stringify(expected)}`
    : kind === 'version' ? 'version string or one-element array of that string' : 'object with error.code "E404"';
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw Error(`${command}: stdout: expected valid JSON (${envelope}); actual invalid JSON ${JSON.stringify(text.slice(0, 200))}`); }

  if (kind === 'pack') {
    let entry: unknown;
    if (Array.isArray(value) && value.length === 1) entry = value[0];
    else if (object(value) && Object.keys(value).length === 1 && Object.hasOwn(value, expected!)) entry = value[expected!];
    else return fail('stdout', envelope, value);
    if (!object(entry)) return fail('pack entry', 'object', entry);
    if (entry.name !== expected) return fail('name', JSON.stringify(expected), entry.name);
    if (typeof entry.filename !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.tgz$/.test(entry.filename)) {
      return fail('filename', 'a .tgz basename without directory components', entry.filename);
    }
    for (const field of ['entryCount', 'size', 'unpackedSize'] as const) {
      if (typeof entry[field] !== 'number' || !Number.isSafeInteger(entry[field]) || entry[field] < 0) {
        return fail(field, 'a nonnegative safe integer', entry[field]);
      }
    }
    return { filename: entry.filename, entryCount: entry.entryCount as number, size: entry.size as number, unpackedSize: entry.unpackedSize as number };
  }
  if (kind === 'version') {
    const version = Array.isArray(value) && value.length === 1 ? value[0] : value;
    if (typeof version !== 'string' || version !== expected) return fail('version', `${envelope} equal to ${JSON.stringify(expected)}`, value);
    return version;
  }
  if (!object(value) || !object(value.error) || value.error.code !== 'E404') return fail('error.code', '"E404" in an error object', object(value) && object(value.error) ? value.error.code : value);
  return 'E404';
}

if (import.meta.main) {
  try {
    const [kind, file, spec, version, ...extra] = process.argv.slice(2);
    if (!file || !spec || extra.length || (kind !== 'version' && kind !== 'e404') || (kind === 'version' ? !version : version !== undefined)) {
      throw Error('usage: bun scripts/npm-json.ts version <json-file> <package@version> <version> | e404 <json-file> <package@version>');
    }
    const text = readFileSync(file, 'utf8');
    const command = `npm view ${spec} version --json`;
    if (kind === 'version') readNpmJson(text, command, kind, version!);
    else readNpmJson(text, command, kind);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
