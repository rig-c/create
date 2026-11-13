import { readFileSync } from './check-reads.ts';

import { refuse, USAGE_EXIT } from './refusal.ts';

/** Decode valid UTF-8 without removing a BOM, spaces, CRLFs or the final newline. */
export function readVerbatim(file: string): string {
  let bytes: Buffer;
  try {
    bytes = readFileSync(file === '-' ? 0 : file);
  } catch (error) {
    refuse('VERBATIM_UNREADABLE', `${file}: ${error instanceof Error ? error.message : String(error)}; --verbatim-file paths resolve against the current working directory, not the project folder; supply an absolute path or run from the folder containing the file`);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    refuse('VERBATIM_INVALID_UTF8', 'verbatim input must be valid UTF-8 to round-trip through project.json', USAGE_EXIT);
  }
}
