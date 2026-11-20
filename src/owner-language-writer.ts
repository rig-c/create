import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PROJECT_SCHEMA } from './check.ts';
import { readProject } from './feedback.ts';
import { acquireBoundJobWrite } from './job-writer.ts';
import { parseOwnerLanguage, withOwnerLanguage } from './owner-language.ts';
import { writeRecord } from './record-input.ts';
import { refuse, USAGE_EXIT } from './refusal.ts';
import type { JsonObject } from './templates.ts';

export function ownerLanguageCommand(args: string[]): string {
  const [action, tag, target, ...extra] = args;
  if (action !== 'set' || target?.startsWith('-') || extra.length) {
    refuse('OWNER_LANGUAGE_USAGE', 'project.json.owner.language: use rig-create owner-language set <tag> [<dir>]', USAGE_EXIT);
  }
  const language = parseOwnerLanguage(tag);
  const dir = resolve(target ?? process.cwd());
  const { file } = readProject(dir);
  const release = acquireBoundJobWrite(dir);
  try {
    const original = readFileSync(file);
    const project = JSON.parse(original.toString('utf8')) as JsonObject;
    if (project?.schema !== PROJECT_SCHEMA) {
      refuse('SCHEMA_UNKNOWN', 'project.json.schema: use owner-language set in a rig-create/project@0 project');
    }
    if (project.owner && typeof project.owner === 'object' && !Array.isArray(project.owner) && project.owner.language === language) {
      return `owner.language: ${language} (already set)`;
    }
    writeRecord(file, original, withOwnerLanguage(project, language), 'owner-language', 'OWNER_LANGUAGE_SOURCE_CHANGED');
    return `owner.language: ${language}`;
  } finally { release(); }
}
