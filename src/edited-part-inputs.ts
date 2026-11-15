/** Bind parts' declared whole-file edit receipts; pixel measurements remain producer-owned. */
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { asArray, isObject, type Finding } from './check.ts';
import type { JsonObject } from './templates.ts';

export const EDITED_PART_INPUTS_SINCE = '2026-11-15T00:00:00Z';

/** The caller reads only the draft's hash-bound parts.json, never a changed manifest. */
export function editedPartInputFindings(dir: string, draft: JsonObject, manifest: JsonObject, path: string): { findings: Finding[]; paths: Set<string> } {
  const findings: Finding[] = [];
  const paths = new Set<string>();
  for (const [index, part] of asArray(manifest.parts).entries()) {
    if (!isObject(part) || !isObject(part.provenance) || part.provenance.edited_part === undefined) continue;
    const edit = part.provenance.edited_part;
    const receipt = isObject(edit) && isObject(edit.receipt) ? edit.receipt : undefined;
    let named: string | undefined;
    if (isObject(edit) && typeof edit.dir === 'string' && receipt && typeof receipt.file === 'string' && isObject(draft.config)) {
      // Parts resolves the file as config directory + edited_part.dir + receipt.file.
      named = relative(resolve(dir), resolve(dir, dirname(String(draft.config.path)), edit.dir, receipt.file)).split(sep).join('/');
    }
    const contained = named !== undefined && named !== '' && named !== '..' && !named.startsWith('../') && !isAbsolute(named);
    if (contained) paths.add(named!);
    if (contained && receipt && typeof receipt.sha256 === 'string' && /^[a-f0-9]{64}$/.test(receipt.sha256)
      && asArray(draft.config_inputs).some(input => isObject(input) && input.directory === undefined && input.path === named && input.sha256 === receipt.sha256)) continue;
    const at = `${path}.parts.files`;
    findings.push({ code: 'DRAFT_EDITED_PART_UNBOUND', path: at,
      message: `${at}: draft ${String(draft.id)} parts[${index}] (${String(part.name)}) provenance.edited_part receipt ${named ?? '<invalid file>'} at sha256 ${String(receipt?.sha256 ?? '<invalid sha256>')} has no matching file binding in ${path}.config_inputs; preserve the old draft and record a new draft with draft-rig using parts that declares assemble.edited_parts receipt files` });
  }
  return { findings, paths };
}
