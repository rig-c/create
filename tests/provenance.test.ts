import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { checkProject } from '../src/check.ts';
import { readTemplate, type JsonObject } from '../src/templates.ts';
import { cli, gitEnv, tempDir } from './helpers.ts';
import { citedSections, codes, fixture, obj, supersede, version, waypoint, withCode } from './fixtures.ts';

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

/** Puts a config file for version `n` under the project and records its path and hash, so the check reads its sections. */
function withConfig(n: number, config: JsonObject, mutate: (p: JsonObject) => void = () => {}): string {
  const text = `${JSON.stringify(config, null, 2)}\n`;
  const path = `derived/v${n}/config.json`;
  return fixture(
    (p) => {
      obj(version(p, n).provenance).config = { path, sha256: sha(text) };
      mutate(p);
    },
    'example-project.json',
    { [path]: text },
  );
}

/** v2's config as the sections its provenance lists, plus the not-a-direction-call ones parts writes. */
const V2_CONFIG: JsonObject = {
  key: 'keeper',
  generation: { run: 1 },
  seethrough: {}, assemble: {}, limbs: {}, bones: {}, meshes: {}, regions: {}, constraints: {}, stops: {}, motion: {},
  note: 'built from the example',
};

describe('the filled example', () => {
  const report = checkProject(fixture());

  test('passes with only legacy hash warnings', () => {
    expect(report.refusals).toEqual([]);
    expect(report.warnings.filter((w) => w.code !== 'STEP_SIGNOFF_HASH_MISSING')).toEqual([]);
    expect(report.ok).toBe(true);
  });

  test('says that no version\'s config was read (derived/ is not kept), and which sections were checked', () => {
    expect(report.provenance.map((s) => [s.version, s.kind, s.config])).toEqual([
      ['versions[v1]', 'rig', 'absent'],
      ['versions[v2]', 'rig', 'absent'],
      ['versions[v3]', 'post', 'absent'],
      ['versions[v4]', 'post', 'absent'],
    ]);
    expect(report.provenance[1]?.sections).toContain('stops');
    const result = cli(['interview', '--check', fixture()], tempDir(), gitEnv());
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('config not read for versions[v1] (absent)');
  });
});

describe('a section with no citation', () => {
  test('a listed section with no entries is refused by name', () => {
    const report = checkProject(fixture((p) => { citedSections(p, 2).constraints = []; }));
    expect(codes(report)).toEqual(['SECTION_UNCITED']);
    expect(report.refusals[0]?.path).toBe('versions[v2].provenance.sections[constraints]');
  });

  test('through the CLI: exit 1, the section named', () => {
    const result = cli(['interview', '--check', fixture((p) => { citedSections(p, 2).constraints = []; })], tempDir(), gitEnv());
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('SECTION_UNCITED: versions[v2].provenance.sections[constraints]');
  });

  test('with the config present, a section it has that provenance does not list is refused by name', () => {
    const report = checkProject(withConfig(2, { ...V2_CONFIG, cloth: {} }));
    expect(report.provenance[1]?.config).toBe('verified');
    expect(codes(report)).toEqual(['SECTION_UNCITED']);
    expect(report.refusals[0]?.path).toBe('versions[v2].provenance.sections[cloth]');
  });

  test('with the config present and every direction section cited, it passes; key, generation and note need none', () => {
    const report = checkProject(withConfig(2, V2_CONFIG));
    expect(report.provenance[1]?.config).toBe('verified');
    expect(report.refusals).toEqual([]);
  });

  test('a config whose hash is not the recorded one is not read: a warning, and the listed sections are checked', () => {
    const report = checkProject(withConfig(2, { ...V2_CONFIG, cloth: {} }, (p) => {
      obj(obj(version(p, 2).provenance).config).sha256 = '0'.repeat(64);
    }));
    expect(report.provenance[1]?.config).toBe('changed');
    expect(report.refusals).toEqual([]);
    expect(report.warnings.filter((w) => w.code !== 'STEP_SIGNOFF_HASH_MISSING').map((w) => w.code)).toEqual(['PROVENANCE_CONFIG_CHANGED']);
  });

  test('a section placed `none` (not a direction call) passes without provenance', () => {
    const report = checkProject(fixture((p) => {
      const s = citedSections(p, 1);
      s.note = [];
      s.generation = [];
      s.proposed_rig_scale = [];
    }));
    expect(report.refusals).toEqual([]);
  });

  test('a misspelt section name is refused: the real section would stay uncited', () => {
    const report = checkProject(fixture((p) => {
      const s = citedSections(p, 2);
      s.constraint = s.constraints ?? [];
      delete s.constraints;
    }));
    expect(codes(report)).toEqual(['SECTION_UNKNOWN']);
    expect(report.refusals[0]?.path).toBe('versions[v2].provenance.sections[constraint]');
  });

  test('a config\'s records and annotations beside the real sections are not sections: it passes, no citation asked', () => {
    const report = checkProject(withConfig(2, { ...V2_CONFIG, bones_note: 'chest pivots low', 'x-run': { seed: 7, steps: [3, 5] }, 'x-seed_note': 42 }));
    expect(report.provenance[1]?.config).toBe('verified');
    expect(report.provenance[1]?.sections).not.toContain('bones_note');
    expect(report.provenance[1]?.sections).not.toContain('x-run');
    expect(report.provenance[1]?.sections).not.toContain('x-seed_note');
    expect(report.refusals).toEqual([]);
  });

  test('keys that are no record or annotation name are still refused: x_status, a bare x-, a note holding no string', () => {
    const report = checkProject(withConfig(2, { ...V2_CONFIG, x_status: 'draft', 'x-': 1, xstatus: 1, 'X-status': 1, meshes_note: { by: 'hand' } }));
    expect(report.provenance[1]?.config).toBe('verified');
    expect(withCode(report, 'SECTION_UNKNOWN').map((f) => f.path)).toEqual([
      'versions[v2].provenance.sections[x_status]',
      'versions[v2].provenance.sections[x-]',
      'versions[v2].provenance.sections[xstatus]',
      'versions[v2].provenance.sections[X-status]',
      'versions[v2].provenance.sections[meshes_note]',
    ]);
    expect(codes(report).every((c) => c === 'SECTION_UNKNOWN')).toBe(true);
  });

  test('a provenance entry citing an annotation key is refused: meshes_note is no section', () => {
    const report = checkProject(fixture((p) => {
      citedSections(p, 2).meshes_note = [{ entry: 'torso', guide: 'meshes', delegated: true }];
    }));
    expect(codes(report)).toEqual(['SECTION_UNKNOWN']);
    expect(report.refusals[0]?.path).toBe('versions[v2].provenance.sections[meshes_note]');
  });

  test('with the config read, a citation under an annotation or record key it holds is still refused', () => {
    const report = checkProject(withConfig(2, { ...V2_CONFIG, meshes_note: 'torso by hand', 'x-run': { seed: 7 } }, (p) => {
      citedSections(p, 2).meshes_note = [{ entry: 'torso', guide: 'meshes', delegated: true }];
      citedSections(p, 2)['x-run'] = [{ entry: 'seed', guide: 'meshes', delegated: true }];
    }));
    expect(report.provenance[1]?.config).toBe('verified');
    expect(withCode(report, 'SECTION_UNKNOWN').map((f) => f.path)).toEqual([
      'versions[v2].provenance.sections[meshes_note]',
      'versions[v2].provenance.sections[x-run]',
    ]);
    expect(codes(report).every((c) => c === 'SECTION_UNKNOWN')).toBe(true);
  });

  test('a version with no provenance at all is refused', () => {
    const report = checkProject(fixture((p) => { version(p, 1).provenance = null; }));
    expect(codes(report)).toEqual(['PROVENANCE_MISSING']);
    expect(report.refusals[0]?.path).toBe('versions[v1].provenance');
  });

  test('an entry with neither a quote nor delegated: true is uncited', () => {
    const report = checkProject(fixture((p) => {
      citedSections(p, 1).meshes = [{ entry: 'torso', guide: 'meshes' }];
    }));
    expect(codes(report)).toEqual(['ENTRY_UNCITED']);
    expect(report.refusals[0]?.path).toBe('versions[v1].provenance.sections[meshes][0]');
  });
});

describe('a citation that does not resolve', () => {
  test('a quote not in the guide is refused by name', () => {
    const report = checkProject(fixture((p) => {
      citedSections(p, 2).constraints = [{ entry: 'scarf_wind', guide: 'constraints', quote: 'the scarf whips like a flag' }];
    }));
    expect(codes(report)).toEqual(['QUOTE_NOT_FOUND']);
    expect(report.refusals[0]?.path).toBe('versions[v2].provenance.sections[constraints][0]');
    expect(report.refusals[0]?.message).toContain("('scarf_wind')");
  });

  test('a quote from an addition is found; the same quote against the original sentence alone is not', () => {
    expect(checkProject(fixture()).refusals).toEqual([]); // v2 bones cites the bones addition
    const report = checkProject(fixture((p) => { delete obj(waypoint(p, 'bones').guide).additions; }));
    expect(codes(report)).toContain('QUOTE_NOT_FOUND');
    expect(withCode(report, 'QUOTE_NOT_FOUND').map((f) => f.path)).toContain('versions[v2].provenance.sections[bones][3]');
  });

  test('delegated: true on a user answer is refused', () => {
    const report = checkProject(fixture((p) => {
      citedSections(p, 1).meshes = [{ entry: 'torso', guide: 'meshes', delegated: true }];
    }));
    expect(codes(report)).toEqual(['DELEGATION_NOT_GIVEN']);
    expect(report.refusals[0]?.path).toBe('versions[v1].provenance.sections[meshes][0]');
  });

  test('delegated: true on a user answer that left part open passes while its agent_decision is there, and is refused without it', () => {
    // The example's assemble and regions sections cite the assemble guide's "the rest is up to you".
    expect(checkProject(fixture()).refusals).toEqual([]);
    const report = checkProject(fixture((p) => { delete obj(waypoint(p, 'assemble').guide).agent_decision; }));
    expect(withCode(report, 'DELEGATION_NOT_GIVEN').map((f) => f.path)).toEqual([
      'versions[v1].provenance.sections[assemble][2]',
      'versions[v1].provenance.sections[regions][1]',
      'versions[v2].provenance.sections[assemble][2]',
      'versions[v2].provenance.sections[regions][1]',
    ]);
  });

  test('delegated: true on a delegation the agent has not decided is refused', () => {
    const report = checkProject(fixture((p) => { delete obj(waypoint(p, 'seethrough').guide).agent_decision; }));
    expect(withCode(report, 'DELEGATION_NOT_GIVEN').map((f) => f.path)).toEqual([
      'versions[v1].provenance.sections[seethrough][0]',
      'versions[v2].provenance.sections[seethrough][0]',
    ]);
  });

  test('a guide id that is no answer of the interview is refused', () => {
    const report = checkProject(fixture((p) => {
      citedSections(p, 1).meshes = [{ entry: 'torso', guide: 'mesh', quote: 'The coat is one piece' }];
    }));
    expect(codes(report)).toEqual(['CITATION_GUIDE_UNKNOWN']);
  });

  test('a guide that has no answer is refused', () => {
    const report = checkProject(fixture((p) => { waypoint(p, 'meshes').guide = null; }));
    expect(withCode(report, 'CITATION_GUIDE_SILENT').map((f) => f.path)).toEqual([
      'versions[v1].provenance.sections[meshes][0]',
      'versions[v1].provenance.sections[regions][0]',
      'versions[v2].provenance.sections[meshes][0]',
      'versions[v2].provenance.sections[regions][0]',
    ]);
  });
});

describe('an answer replaced after a version was built', () => {
  const NEW_MESHES: JsonObject = { delegated: false, by: 'user', at: '2026-11-16T10:00:00Z', verbatim: 'Everything bends.', value: { meshes: ['*'] }, source: 'chat' };

  test('the old answer in history[] still resolves the earlier versions\' quotes', () => {
    // The step that ran on the old answer is sent back for a re-sign (its own check); provenance adds nothing.
    expect(codes(checkProject(fixture((p) => { supersede(waypoint(p, 'meshes'), 'guide', NEW_MESHES); })))).toEqual(['GUIDE_CHANGED_UNSIGNED']);
  });

  test('overwritten without history[], the quotes no longer resolve', () => {
    const report = checkProject(fixture((p) => { waypoint(p, 'meshes').guide = NEW_MESHES; }));
    expect(withCode(report, 'QUOTE_NOT_FOUND').map((f) => f.path)).toEqual([
      'versions[v1].provenance.sections[meshes][0]',
      'versions[v1].provenance.sections[regions][0]',
      'versions[v2].provenance.sections[meshes][0]',
      'versions[v2].provenance.sections[regions][0]',
    ]);
  });

  test('a delegation the user later answered themselves still covers the versions built on it', () => {
    const own: JsonObject = { delegated: false, by: 'user', at: '2026-11-16T10:00:00Z', verbatim: 'Full pass only.', value: { passes: ['full'] }, source: 'chat' };
    expect(codes(checkProject(fixture((p) => { supersede(waypoint(p, 'seethrough'), 'guide', own); })))).toEqual(['GUIDE_CHANGED_UNSIGNED']);
  });
});

describe('a post version', () => {
  test('its sections are the post tool\'s, not parts\': none is exempt, an empty one is refused by name', () => {
    const report = checkProject(fixture((p) => { citedSections(p, 4).timing = []; }));
    expect(codes(report)).toEqual(['SECTION_UNCITED']);
    expect(report.refusals[0]?.path).toBe('versions[v4].provenance.sections[timing]');
  });

  test('a post section named like a `none` parts section still needs a citation', () => {
    const report = checkProject(fixture((p) => { citedSections(p, 4).note = []; }));
    expect(codes(report)).toEqual(['SECTION_UNCITED']);
  });

  test('a post section citing a rig waypoint is refused', () => {
    const report = checkProject(fixture((p) => {
      citedSections(p, 4).framing = [{ entry: 'crop', guide: 'assemble', quote: 'Standard cut' }];
    }));
    expect(codes(report)).toEqual(['CITATION_WRONG_PHASE']);
    expect(report.refusals[0]?.path).toBe('versions[v4].provenance.sections[framing][0]');
  });
});

describe('review fixes: hashing errors and inherited history', () => {
  test('a config path that is a directory reads as unreadable, not a crash', () => {
    const dir = fixture(() => {}, 'example-project.json', { 'derived/v2/config.json/inner.txt': 'x' });
    const report = checkProject(dir);
    expect(report.provenance.find((p) => p.version === 'versions[v2]')?.config).toBe('unreadable');
  });

  test("an inherited answer's earlier sentences come from the collection question's history", () => {
    const root = tempDir();
    const example = readTemplate('example-project.json');
    const old = obj(waypoint(example, 'constraints').guide);
    const collection = {
      schema: 'rig-create/collection@0',
      name: 'crew',
      interview: {
        waypoints: [
          { id: 'constraints', guide: { delegated: false, by: 'user', at: '2026-11-30T10:00:00Z', verbatim: 'Nothing sways.', value: 'none' }, history: [old] },
        ],
      },
    };
    writeFileSync(join(root, 'collection.json'), JSON.stringify(collection));
    const member = join(root, 'members', 'keeper');
    mkdirSync(member, { recursive: true });
    waypoint(example, 'constraints').guide = { basis: 'inherited', from: { collection: 'crew', question: 'constraints' }, by: 'interviewer', at: '2026-11-10T14:14:00Z' };
    writeFileSync(join(member, 'project.json'), JSON.stringify(example));
    const report = checkProject(member);
    expect(withCode(report, 'QUOTE_NOT_FOUND').filter((f) => f.path.includes('[constraints]'))).toEqual([]);
  });
});
