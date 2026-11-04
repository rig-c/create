import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';

import { isObject } from './check.ts';
import { locateParts } from './parts-sections.ts';
import { refuse, USAGE_EXIT } from './refusal.ts';
import type { Json, JsonObject } from './templates.ts';

export const SPLIT_CAPTIONS_HELP = `split-captions [<project dir|project.json>] [--config <file>]
  Print generated caption data as JSON. Config defaults to config.json beside the
  project record; relative --config paths are resolved beside that record.`;

interface Caption {
  path: string;
  value: Json;
  text: string;
}

interface Input {
  path: string;
  sha256: string;
}

export interface SplitCaptions {
  schema: 'rig-create/split-captions@0';
  inputs: { project: Input; config: Input };
  config: Caption[];
  parts: { name: string; label: string; text: string }[];
}

function readInput(file: string, base: string, kind: string): { input: Input; data: JsonObject } {
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch {
    refuse('SPLIT_CAPTIONS_INPUT_UNREADABLE', `${kind} at ${file} cannot be read`);
  }
  let data: Json;
  try {
    data = JSON.parse(bytes.toString('utf8')) as Json;
  } catch {
    refuse('SPLIT_CAPTIONS_INPUT_INVALID', `${kind} at ${file} must be a JSON object`);
  }
  if (!isObject(data)) refuse('SPLIT_CAPTIONS_INPUT_INVALID', `${kind} at ${file} must be a JSON object`);
  return {
    input: { path: relative(base, file).split('\\').join('/'), sha256: createHash('sha256').update(bytes).digest('hex') },
    data,
  };
}

const load = createRequire(import.meta.url);

/** Use the project's installed parts contract, including its early assembly door. */
function validateConfig(config: JsonObject, dir: string): void {
  const parts = locateParts(dir);
  if (parts === null) refuse('PARTS_NOT_INSTALLED', `@rig-c/parts is needed to read the config for ${dir}`);
  try {
    const parser = load(join(parts, 'src', 'config.ts')) as {
      parseConfig: (raw: JsonObject) => unknown;
      parseEarlyConfig: (raw: JsonObject, door: 'assemble') => unknown;
    };
    if (['bones', 'meshes', 'regions', 'motion'].every((key) => key in config)) parser.parseConfig(config);
    else parser.parseEarlyConfig(config, 'assemble');
  } catch (error) {
    refuse('SPLIT_CAPTIONS_CONFIG_INVALID', `${parts}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** These parts maps consume exact names, including keys that resemble annotations. */
const EXACT_NAME_MAPS = new Set([
  '["meshes"]',
  '["regions"]',
  '["limbs"]',
  '["motion","blink","still"]',
  '["turn","depths"]',
  '["depth","full","layers"]',
  '["depth","head","layers"]',
]);

function annotation(key: string): boolean {
  return key === 'note' || key.endsWith('_note') || (key.startsWith('x-') && key.length > 2);
}

/** Drop annotations before serialising, including those nested in array entries. */
function captionValue(value: Json, path: string[] = []): Json {
  if (Array.isArray(value)) return value.map((entry, i) => captionValue(entry, [...path, String(i)]));
  if (!isObject(value)) return value;
  const exactNames = EXACT_NAME_MAPS.has(JSON.stringify(path));
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => exactNames || !annotation(key))
    .map(([key, entry]) => [key, captionValue(entry, [...path, key])]));
}

/** Read both files once. Captions describe declarations, with exact input-byte hashes. */
export function splitCaptions(projectFile: string, configFile = join(dirname(projectFile), 'config.json')): SplitCaptions {
  const projectPath = resolve(projectFile);
  const dir = dirname(projectPath);
  const project = readInput(projectPath, dir, 'project');
  const config = readInput(resolve(configFile), dir, 'config');
  if (project.data.schema !== 'rig-create/project@0') {
    refuse('SCHEMA_UNKNOWN', `${projectPath} must have schema rig-create/project@0`);
  }
  const split = project.data.split;
  if (!isObject(split) || !Array.isArray(split.parts) || split.parts.length === 0) {
    refuse('SPLIT_CAPTIONS_PARTS_INVALID', 'split.parts must be a non-empty list');
  }
  const seen = new Set<string>();
  const labels = new Set(['physics', 'wind', 'jiggle', 'rigid', 'still']);
  const parts = split.parts.map((part, index) => {
    if (!isObject(part) || typeof part.name !== 'string' || part.name.trim() === '' ||
        typeof part.label !== 'string' || !labels.has(part.label) || seen.has(part.name)) {
      refuse('SPLIT_CAPTIONS_PARTS_INVALID', `split.parts[${index}] needs a unique non-empty name and a physics, wind, jiggle, rigid or still label`);
    }
    seen.add(part.name);
    return { name: part.name, label: part.label, text: `${JSON.stringify(part.name)} = ${JSON.stringify(part.label)}` };
  });
  validateConfig(config.data, dir);
  const values = captionValue(config.data) as JsonObject;
  const captions = Object.entries(values).map(([key, value]) => {
    const path = `config[${JSON.stringify(key)}]`;
    return { path, value, text: `${path} = ${JSON.stringify(value)}` };
  });
  return {
    schema: 'rig-create/split-captions@0',
    inputs: { project: project.input, config: config.input },
    config: captions,
    parts,
  };
}

export function splitCaptionsCommand(args: string[]): string {
  let target: string | undefined;
  let config: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === '--config') {
      const next = args[++i];
      if (config !== undefined || next === undefined || next.trim() === '' || next.startsWith('-')) {
        refuse('SPLIT_CAPTIONS_USAGE', '--config needs one file and may appear once', USAGE_EXIT);
      }
      config = next;
    } else if (arg.startsWith('-')) {
      refuse('UNKNOWN_OPTION', `split-captions does not take ${arg}`, USAGE_EXIT);
    } else {
      if (target !== undefined) refuse('SPLIT_CAPTIONS_USAGE', 'split-captions takes one project folder or project.json', USAGE_EXIT);
      target = arg;
    }
  }
  const path = resolve(target ?? process.cwd());
  const project = path.endsWith('.json') ? path : join(path, 'project.json');
  return JSON.stringify(splitCaptions(project, resolve(dirname(project), config ?? 'config.json')), null, 2);
}
