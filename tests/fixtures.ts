/**
 * Project fixtures for `interview --check` tests: the filled example (or any
 * template) written to a fresh folder under the OS temp dir, mutated in place
 * first. Nothing is copied into the repository.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { CheckReport } from '../src/check.ts';
import { stepHash } from '../src/step-hash.ts';
import { readTemplate, type Json, type JsonObject } from '../src/templates.ts';
import { tempDir } from './helpers.ts';
import { EXAMPLE_VERDICT, partsPackage } from './parts-package.ts';
import { newOrderExampleFiles } from './draft-fixture.ts';
import { preparedExampleFiles } from './prepared-fixture.ts';
import { alignLegacyBuilds, reviewExampleFiles } from './review-fixture.ts';

export type Mutate = (project: JsonObject) => void;

/**
 * A project folder holding `template` (default: the filled example) after
 * `mutate`; `files` are written under it (path → content). The filled example
 * also gets the assembled parts and the approved verdict its parts-review
 * sign-off rests on (tests/parts-package.ts), unless `files` replaces them.
 */
export function fixture(mutate: Mutate = () => {}, template = 'legacy-example-project.json', files: Record<string, string | Uint8Array> = {}, rawLegacy = false): string {
  return materializeFixture(join(tempDir(), 'project'), mutate, template, files, rawLegacy);
}

/** Open either example record with the same retained asset bytes. */
export function materializeFixture(dir: string, mutate: Mutate = () => {}, template = 'example-project.json', files: Record<string, string | Uint8Array> = {}, rawLegacy = false): string {
  if (template === 'legacy-example-project.json') files = { ...preparedExampleFiles(), ...reviewExampleFiles(), ...partsPackage({ verdict: EXAMPLE_VERDICT }).files, ...files };
  if (template === 'example-project.json' || template === 'example-reopened/project.json') files = { ...preparedExampleFiles(), ...newOrderExampleFiles(), ...files };
  mkdirSync(dir);
  const project = readTemplate(template);
  mutate(project);
  if (template === 'legacy-example-project.json' && !rawLegacy) alignLegacyBuilds(project, files);
  writeFileSync(join(dir, 'project.json'), `${JSON.stringify(project, null, 2)}\n`);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

// Typed access into the record, so a mutation names the object it changes.
export function obj(v: Json | undefined): JsonObject {
  if (v === null || v === undefined || typeof v !== 'object' || Array.isArray(v)) throw new Error('expected an object');
  return v;
}
export function arr(v: Json | undefined): Json[] {
  if (!Array.isArray(v)) throw new Error('expected an array');
  return v;
}
export function byId(list: Json[], id: string): JsonObject {
  const found = list.find((x) => obj(x).id === id);
  if (found === undefined) throw new Error(`no item ${id}`);
  return obj(found);
}
export const waypoint = (p: JsonObject, id: string): JsonObject => byId(arr(obj(p.interview).waypoints), id);
export const framing = (p: JsonObject, id: string): JsonObject => byId(arr(obj(p.interview).framing), id);
export const step = (p: JsonObject, id: string): JsonObject => byId(arr(obj(p.plan).steps), id);
/** The `versions[]` entry numbered `n`. */
export function version(p: JsonObject, n: number): JsonObject {
  const found = arr(p.versions).find((v) => obj(v).n === n);
  if (found === undefined) throw new Error(`no version ${n}`);
  return obj(found);
}
/** `versions[n].provenance.sections`. */
export const citedSections = (p: JsonObject, n: number): JsonObject => obj(obj(version(p, n).provenance).sections);

export const codes = (r: CheckReport): string[] => r.refusals.map((f) => f.code);
export const withCode = (r: CheckReport, code: string) => r.refusals.filter((f) => f.code === code);

/** Replaces an answer the way the record does (INTERVIEW.md § Answer shape): the old one moves whole into `history[]`, so versions built from it still cite it. */
export function supersede(record: JsonObject, field: 'guide' | 'answer', next: Json): void {
  const old = record[field];
  if (old !== null && old !== undefined) record.history = [...(Array.isArray(record.history) ? record.history : []), old];
  record[field] = next;
}

/** Rebuild existing synthetic approval hashes after setup edits that precede the tested operation. */
export function rehashSignoffs(project: JsonObject): void {
  for (const raw of arr(project.signoffs)) {
    const signoff = obj(raw);
    if (signoff.step_hashes === undefined) continue;
    const hashes = obj(signoff.step_hashes);
    for (const id of Object.keys(hashes)) hashes[id] = stepHash(step(project, id));
  }
}
