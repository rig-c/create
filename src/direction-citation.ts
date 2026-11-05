/** The fixed-camera N/A exception is identical for direction and provenance readers. */
import { isObject, type Item } from './check.ts';
import type { Json, JsonObject } from './templates.ts';

export function fixedNotApplicableCamera(section: string, item: Item | undefined, citation: Json | undefined, document: JsonObject | undefined): boolean {
  const camera = document?.camera;
  return section === 'camera'
    && item?.state.state === 'not_applicable'
    && isObject(citation) && typeof citation.quote === 'string'
    && typeof item.state.answer.verbatim === 'string'
    && item.state.answer.verbatim.includes(citation.quote)
    && isObject(camera) && Array.isArray(camera.keys) && camera.keys.length === 1;
}
