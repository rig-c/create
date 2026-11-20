import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { initCollection, initMember } from '../src/collection.ts';
import { freshProjectRecord } from '../src/init.ts';
import { nextCommand, remedyForFinding, type NextCollectionReport } from '../src/next.ts';
import { tempDir } from './helpers.ts';

const TEST_NOW = Date.parse('2026-11-11T15:00:00Z');

describe('next on a collection root (#657)', () => {
  test('a fresh collection exits 0 with kind: "collection", stage interview, and INTERVIEW_INCOMPLETE remedies', () => {
    const dir = join(tempDir(), 'harbour');
    initCollection(dir, { install: false });

    const jsonRes = nextCommand([dir, '--json'], TEST_NOW);
    expect(jsonRes.exit).toBe(0);
    const report = JSON.parse(jsonRes.stdout) as NextCollectionReport;
    expect(report.kind).toBe('collection');
    expect(report.collection_dir).toBe(dir);
    expect(report.stage).toBe('interview');
    expect(report.effective_stage).toBe('interview');
    expect(report.members).toEqual([]);
    const incomplete = report.refusals.filter(r => r.code === 'INTERVIEW_INCOMPLETE');
    expect(incomplete.length).toBeGreaterThan(0);
    for (const r of incomplete) {
      expect(r.path.length).toBeGreaterThan(0);
      expect(r.message.length).toBeGreaterThan(0);
      expect(r.remedy).toBe(remedyForFinding(r.code, r.message));
      expect(r.remedy.length).toBeGreaterThan(0);
    }

    const textRes = nextCommand([dir], TEST_NOW);
    expect(textRes.exit).toBe(0);
    expect(textRes.stdout).toContain(`next (collection): ${dir} — stage: interview`);
    expect(textRes.stdout).toContain('[INTERVIEW_INCOMPLETE]');
    expect(textRes.stdout).toContain(`remedy: ${incomplete[0]!.remedy}`);
    expect(textRes.stdout).toContain('members (0): none');
  });

  test('a collection with one member lists members[0] with its name and next command', () => {
    const dir = join(tempDir(), 'harbour');
    initCollection(dir, { install: false });
    const member = initMember(dir, 'keeper', new Date(TEST_NOW));

    const jsonRes = nextCommand([dir, '--json'], TEST_NOW);
    expect(jsonRes.exit).toBe(0);
    const report = JSON.parse(jsonRes.stdout) as NextCollectionReport;
    expect(report.kind).toBe('collection');
    expect(report.members).toEqual([
      {
        name: 'keeper',
        command: `rig-create next ${member.dir}`,
      },
    ]);

    const textRes = nextCommand([dir], TEST_NOW);
    expect(textRes.exit).toBe(0);
    expect(textRes.stdout).toContain('members (1):');
    expect(textRes.stdout).toContain(`keeper: rig-create next ${member.dir}`);
  });

  test('a folder with neither collection.json nor project.json refuses with PROJECT_JSON_MISSING', () => {
    const empty = join(tempDir(), 'empty');
    mkdirSync(empty, { recursive: true });

    expect(() => nextCommand([empty, '--json'], TEST_NOW)).toThrow(
      expect.objectContaining({ code: 'PROJECT_JSON_MISSING' }),
    );
  });

  test('a member folder produces the same next JSON as a standalone project fixture', () => {
    const dir = join(tempDir(), 'harbour');
    initCollection(dir, { install: false });
    const member = initMember(dir, 'keeper', new Date(TEST_NOW));

    const standalone = join(tempDir(), 'keeper');
    mkdirSync(standalone, { recursive: true });
    writeFileSync(
      join(standalone, 'project.json'),
      `${JSON.stringify(freshProjectRecord('keeper', TEST_NOW), null, 2)}\n`,
    );

    const memberNext = nextCommand([member.dir, '--json'], TEST_NOW);
    const standaloneNext = nextCommand([standalone, '--json'], TEST_NOW);
    expect(memberNext.exit).toBe(0);
    expect(standaloneNext.exit).toBe(0);
    expect(memberNext.stdout.replaceAll(member.dir, '<dir>')).toBe(
      standaloneNext.stdout.replaceAll(standalone, '<dir>'),
    );
  });
});
