/** Bind parts' declared whole-file edit receipts; pixel measurements remain producer-owned. */
import { asArray, isObject, type Finding } from './check.ts';
import type { JsonObject } from './templates.ts';

export const EDITED_PART_INPUTS_SINCE = '2026-11-15T00:00:00Z';

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
