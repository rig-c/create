/** Keep the synthetic narrative deterministic and inside the current contract dates. */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readTemplate } from '../src/templates.ts';

const timestamp = /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g;
const boundaries = readdirSync(join(import.meta.dir, '../src')).filter(name => name.endsWith('.ts')).flatMap(name =>
  [...readFileSync(join(import.meta.dir, '../src', name), 'utf8').matchAll(/export const \w+_SINCE = '([^']+)'/g)].map(match => Date.parse(match[1]!)));
export const EXAMPLE_ANCHOR = Math.max(...boundaries);
if (!Number.isFinite(EXAMPLE_ANCHOR)) throw new Error('example needs readable exported contract dates');

const legacyEvents = [...JSON.stringify(readTemplate('legacy-example-project.json')).matchAll(timestamp)].map(match => match[0]);
const addedEvents = [
  '2026-11-05T00:00:00Z',
  '2026-11-10T14:00:00Z', '2026-11-10T14:04:00Z',
  '2026-11-10T14:10:00Z', '2026-11-10T14:10:30Z',
  '2026-11-10T14:12:00Z', '2026-11-10T14:12:30Z',
  '2026-11-10T14:13:00Z', '2026-11-10T14:13:30Z', '2026-11-10T14:14:30Z',
  '2026-11-10T16:10:00Z',
  '2026-11-11T10:00:00Z', '2026-11-11T10:15:00Z',
  '2026-11-11T11:00:00Z', '2026-11-11T11:01:00Z', '2026-11-11T11:02:00Z',
  '2026-11-11T11:03:00Z', '2026-11-11T11:04:00Z', '2026-11-11T11:05:00Z', '2026-11-11T11:10:00Z',
  '2026-11-13T10:01:00Z', '2026-11-13T10:03:00Z',
  '2026-11-16T10:00:00Z', '2026-11-16T10:05:00Z',
];
const events = [...new Set([...legacyEvents, ...addedEvents].map(value => Date.parse(value)))].sort((a, b) => a - b);
if (events.length > 121) throw new Error('example events exceed the two-minute timeline');

export function exampleTime(value: string): string {
  const index = events.indexOf(Date.parse(value));
  if (index < 0) throw new Error(`undeclared example event ${value}`);
  return new Date(EXAMPLE_ANCHOR + index * 1000).toISOString();
}

/** Only fixture event strings enter this function, before their writers bind any hashes. */
export function retimeExample<T>(value: T): T {
  return JSON.parse(JSON.stringify(value).replace(timestamp, value => exampleTime(value))) as T;
}

/** A final event after the signed narrative, without changing any existing event index. */
export const EXAMPLE_REOPEN_AT = new Date(EXAMPLE_ANCHOR + events.length * 1000).toISOString();

/** The fixed "now" for tests and generators that act after the whole narrative: twelve hours after the latest contract date. */
export const EXAMPLE_NOW = EXAMPLE_ANCHOR + 12 * 60 * 60 * 1000;

/** The shared canonical SOURCE_DATE_EPOCH (whole seconds at EXAMPLE_ANCHOR) for producer spawns without their own clock. */
export const EXAMPLE_SOURCE_DATE_EPOCH = String(Math.trunc(EXAMPLE_ANCHOR / 1000));

