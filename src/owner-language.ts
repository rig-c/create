import type { Finding } from './check.ts';
import { refuse, USAGE_EXIT } from './refusal.ts';
import type { Json, JsonObject } from './templates.ts';

const PATH = 'project.json.owner.language';
const SET = 'rig-create owner-language set <tag> [<dir>]';

function ownerObject(owner: Json | undefined): JsonObject | undefined {
  return owner && typeof owner === 'object' && !Array.isArray(owner) ? owner : undefined;
}

function canonicalTag(value: Json | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  try { return Intl.getCanonicalLocales(value)[0]; }
  catch { return undefined; }
}

export function parseOwnerLanguage(value: string | undefined): string {
  return canonicalTag(value) ?? refuse('OWNER_LANGUAGE_INVALID',
    `${PATH}: give one language tag such as ko or en-US with init --owner-language or ${SET}`, USAGE_EXIT);
}

export function withOwnerLanguage(project: JsonObject, language: string): JsonObject {
  return { ...project, owner: { ...ownerObject(project.owner), language } };
}

export function ownerLanguageFinding(project: JsonObject): Finding | undefined {
  const owner = ownerObject(project.owner);
  const language = owner?.language;
  if (canonicalTag(language) !== undefined) return undefined;
  const missing = project.owner === undefined || owner !== undefined && language === undefined;
  return {
    code: missing ? 'OWNER_LANGUAGE_MISSING' : 'OWNER_LANGUAGE_INVALID',
    path: PATH,
    message: `${PATH}: ${missing ? 'owner language is undeclared' : 'owner language must be a language tag such as ko or en-US'}; run ${SET} with the owner's language before publishing`,
  };
}

export function requireOwnerLanguage(project: JsonObject): void {
  const finding = ownerLanguageFinding(project);
  if (finding) refuse(finding.code, finding.message);
}
