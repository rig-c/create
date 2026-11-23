import { posix } from 'node:path';
import { asArray, isObject, type Ctx, type Finding } from './check.ts';
import { draftPartBinding } from './corrections.ts';
import { declaredPartImages, exactEditedPartInputs, type PartImageIdentity } from './edited-part-inputs.ts';
import { jobHash } from './job-outbox.ts';
import { publicationFile } from './job-publication.ts';
import { decodePartsRead, isPartsReviewReceipt, PARTS_CLI_RECEIPT } from './parts-verdict-record.ts';
import { derivedTime } from './prepared-inputs.ts';
import { decodeReviewAct } from './review-act.ts';
import { storedReviewRead } from './review-read.ts';
import type { Json, JsonObject } from './templates.ts';

function draftPartImages(dir: string, drafts: JsonObject[]): PartImageIdentity[] {
  return drafts.flatMap(draft => {
    if (!isObject(draft.parts) || typeof draft.parts.path !== 'string') return [];
    const path = `${draft.parts.path}/parts.json`;
    const manifest = asArray(draft.parts.files).filter(isObject).find(file => file.path === path);
    if (!manifest) return [];
    try {
      const bytes = publicationFile(dir, path);
      if (jobHash(bytes) !== manifest.sha256) return [];
      const record = JSON.parse(bytes.toString('utf8')) as Json;
      if (!isObject(record)) return [];
      const outputs = declaredPartImages(record).flatMap(({ name }) => {
        const part = draftPartBinding(draft, name);
        return part ? [{ name, path: String(part.path), sha256: String(part.sha256) }] : [];
      });
      return [...outputs, ...exactEditedPartInputs(draft, record)];
    } catch { return []; } // The draft checker reports unreadable or changed data.
  });
}

/** Review's image binding is relative to its manifest, including in relocated CLI output. */
function reviewedImageAt(dir: string, draft: JsonObject, receipt: JsonObject, name: string, sha256: string): number {
  if (!isObject(draft.parts) || typeof draft.parts.path !== 'string' || !isObject(receipt.evidence)) return NaN;
  if (draftPartBinding(draft, name)?.sha256 !== sha256) return NaN;
  const image = `parts/${name}.png`;
  const manifestPath = `${draft.parts.path}/parts.json`;
  const manifest = asArray(draft.parts.files).filter(isObject).find(file => file.path === manifestPath);
  if (!manifest) return NaN;
  try {
    if (receipt.schema === PARTS_CLI_RECEIPT) {
      const verdict = decodePartsRead(storedReviewRead(dir, receipt.evidence));
      if (verdict.status === 'pending' || !isObject(verdict.source) || typeof verdict.updatedAt !== 'string') return NaN;
      const files = asArray(verdict.source.files).filter(isObject);
      const sourceManifest = files.find(file => typeof file.path === 'string' && posix.basename(file.path) === 'parts.json' && file.sha256 === manifest.sha256);
      return sourceManifest && files.some(file => file.path === posix.join(posix.dirname(String(sourceManifest.path)), image) && file.sha256 === sha256)
        ? Date.parse(verdict.updatedAt) : NaN;
    }
    const bytes = publicationFile(dir, String(receipt.evidence.path));
    if (jobHash(bytes) !== receipt.evidence.sha256) return NaN;
    const act = decodeReviewAct(bytes.toString('utf8'), 'parts-verdict');
    const parts = act.source.parts;
    return act.value.verdict !== 'pending' && parts.manifest.path === manifestPath && parts.manifest.sha256 === manifest.sha256
      && parts.images.some(row => row.role === 'part' && row.path === image && row.sha256 === sha256) ? Date.parse(act.at) : NaN;
  } catch { return NaN; } // The receipt validators own the error diagnostics.
}

/** Report one hole per dated derived entry and named edited part. */
export function partEditHoles(ctx: Ctx, firstBarAt: number, correctionImages: PartImageIdentity[]): Finding[] {
  const edits = asArray(ctx.project.derived).flatMap((entry, index) => {
    if (!isObject(entry) || entry.kind === 'run' || typeof entry.path !== 'string' || typeof entry.sha256 !== 'string') return [];
    const at = derivedTime(entry.at);
    return at > firstBarAt ? [{ index, path: entry.path, sha256: entry.sha256.toLowerCase(), at }] : [];
  });
  if (!edits.length) return [];
  const drafts = asArray(ctx.project.drafts).filter(isObject);
  const images = [...correctionImages, ...draftPartImages(ctx.dir, drafts)];
  const rejected = new Set(ctx.refusals.map(finding => finding.path));
  const receipts = asArray(ctx.project.review_acts).flatMap((receipt, index) => {
    const path = `review_acts[${index}]`;
    if (!isObject(receipt) || rejected.has(path) || rejected.has(`${path}.evidence`) || !isPartsReviewReceipt(receipt)) return [];
    const matches = drafts.filter(draft => draft.id === receipt.draft_id);
    return matches.length === 1 ? [{ receipt, draft: matches[0]! }] : [];
  });
  return edits.flatMap(edit => {
    const output = posix.normalize(edit.path);
    const names = new Set(images.filter(image => posix.normalize(image.path) === output && image.sha256 === edit.sha256).map(image => image.name));
    return [...names].flatMap(name => {
      if (receipts.some(({ receipt, draft }) => reviewedImageAt(ctx.dir, draft, receipt, name, edit.sha256) > edit.at)) return [];
      const path = `derived[${edit.index}]`;
      return [{ code: 'PART_EDIT_UNCOVERED', path,
        message: `${path}: part ${name} (${edit.path}, sha256 ${edit.sha256}) was edited after a step checkpoint sign-off; review a draft binding these exact part bytes in the Review parts tool and record its new verdict with rig-create parts-review` }];
    });
  });
}
