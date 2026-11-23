/** Bind parts' declared whole-file edit receipts; pixel measurements remain producer-owned. */
import { posix, win32 } from 'node:path';
import { asArray, isObject, type Finding } from './check.ts';
import type { FileBinding } from './parts-verdict.ts';
import type { Json, JsonObject } from './templates.ts';

export const EDITED_PART_INPUTS_SINCE = '2026-11-15T00:00:00Z';
export type PartImageIdentity = FileBinding & { name: string };

/** Read the producer's edit declaration; byte changes alone never establish an edit. */
export function hasEditedPartDeclaration(part: JsonObject): boolean {
  return isObject(part.provenance) && part.provenance.edited_part !== undefined;
}

/** Named colour parts only; auxiliary files in parts.files are not part declarations. */
export function declaredPartImages(manifest: JsonObject): { name: string; edited: boolean }[] {
  return asArray(manifest.parts).filter(isObject)
    .filter((part): part is JsonObject & { name: string } => typeof part.name === 'string' && part.name !== '')
    .map(part => ({ name: part.name, edited: hasEditedPartDeclaration(part) }));
}

const relativePath = (value: Json | undefined): value is string =>
  typeof value === 'string' && value.trim() !== '' && !value.includes('\\') && !win32.isAbsolute(value);

/** The artifact check can accept the same receipt bytes at another path. Edit coverage needs the exact declared path and part. */
export function exactEditedPartInputs(draft: JsonObject, manifest: JsonObject): PartImageIdentity[] {
  if (!isObject(draft.config) || typeof draft.config.path !== 'string') return [];
  const configDir = posix.dirname(draft.config.path);
  const inputs = asArray(draft.config_inputs).filter(isObject);
  const identities = asArray(manifest.parts).flatMap(part => {
    if (!isObject(part) || typeof part.name !== 'string' || !part.name || !isObject(part.provenance)) return [];
    const edit = part.provenance.edited_part;
    if (!isObject(edit) || !relativePath(edit.dir) || !isObject(edit.receipt)) return [];
    const { part: name, file, sha256 } = edit.receipt;
    if (name !== part.name || !relativePath(file) || typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) return [];
    const path = posix.join(configDir, edit.dir, file);
    if (path === '..' || path.startsWith('../') || posix.isAbsolute(path)) return [];
    const matches = inputs.filter(input => input.path === path);
    return matches.length === 1 && matches[0]!.directory === undefined && matches[0]!.sha256 === sha256
      ? [{ name, path, sha256 }] : [];
  });
  return identities.filter(identity => identities.every(other => other.path !== identity.path || other.name === identity.name));
}

/** The caller reads only the draft's hash-bound parts.json, never a changed manifest. */
export function editedPartInputFindings(_dir: string, draft: JsonObject, manifest: JsonObject, path: string): { findings: Finding[]; paths: Set<string> } {
  const findings: Finding[] = [];
  const paths = new Set<string>();
  const regular = asArray(draft.config_inputs).filter((input): input is JsonObject =>
    isObject(input) && input.directory === undefined && typeof input.path === 'string' && input.path !== '');
  for (const [index, part] of asArray(manifest.parts).entries()) {
    if (!isObject(part) || !hasEditedPartDeclaration(part)) continue;
    const edit = (part.provenance as JsonObject).edited_part;
    const receipt = isObject(edit) && isObject(edit.receipt) ? edit.receipt : undefined;
    const file = receipt && typeof receipt.file === 'string' && receipt.file !== '' ? receipt.file : undefined;
    if (file !== undefined) paths.add(file);
    const sha256 = receipt && typeof receipt.sha256 === 'string' && /^[a-f0-9]{64}$/.test(receipt.sha256) ? receipt.sha256 : undefined;
    const suffixMatch = (input: JsonObject): boolean =>
      file !== undefined && (input.path === file || String(input.path).endsWith(`/${file}`));
    const shaMatches = sha256 !== undefined ? regular.filter(input => input.sha256 === sha256) : [];
    if (shaMatches.length > 0) {
      const bound = shaMatches.find(suffixMatch) ?? shaMatches[0]!;
      paths.add(String(bound.path));
      continue;
    }
    const chosen = regular.find(suffixMatch) ?? regular[0];
    const named = chosen !== undefined ? String(chosen.path) : file;
    if (named !== undefined) paths.add(named);
    const at = `${path}.parts.files`;
    findings.push({ code: 'DRAFT_EDITED_PART_UNBOUND', path: at,
      message: `${at}: draft ${String(draft.id)} parts[${index}] (${String(part.name)}) provenance.edited_part receipt ${named ?? '<invalid file>'} at sha256 ${String(receipt?.sha256 ?? '<invalid sha256>')} has no matching file binding in ${path}.config_inputs; preserve the old draft and record a new draft with draft-rig using parts that declares assemble.edited_parts receipt files` });
  }
  return { findings, paths };
}
