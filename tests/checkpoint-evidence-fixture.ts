import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkpointEvidenceCommand, checkpointTableCommand } from '../src/checkpoint-evidence-writer.ts';
import { jobHash } from '../src/job-outbox.ts';
import { stageIndex } from '../src/stages.ts';
import { TEST_NOW } from './clock.ts';
import { arr, fixture, obj, retainSignoffs } from './fixtures.ts';

export function checkpointWorkspace(sourceFormat: 'png' | 'svg' = 'png') {
  const root = realpathSync(fixture(project => {
    // Reuse the example's writer-registered PNG as the first source, matching
    // legacy projects whose painting is designated by inputs[0].
    if (sourceFormat === 'png') {
      const inputs = arr(project.inputs).map(obj);
      const painting = inputs.find(input => input.path === 'inputs/painting.png');
      if (!painting) throw Error('synthetic PNG input is missing');
      project.inputs = [painting, ...inputs.filter(input => input !== painting)];
    }
    project.stage = 'parts';
    project.versions = [];
    project.scenes = [];
    delete project.direction_contract;
    retainSignoffs(project, signature => stageIndex(String(obj(signature).stage)) < stageIndex('parts'));
    project.advances = arr(project.advances).filter(value => stageIndex(String(obj(value).stage)) <= stageIndex('parts'));
    for (const item of arr(obj(obj(project.interview).post).items).map(obj)) item.guide = null;
    for (const item of arr(obj(project.interview).waypoints).map(obj)) {
      if (['bones', 'meshes', 'constraints', 'motion'].includes(String(item.id))) item.guide = null;
    }
    for (const step of arr(obj(project.plan).steps).map(obj)) {
      step.status = step.id === 'assemble' ? 'at-checkpoint' : step.id === 'seethrough' ? 'done' : 'pending';
    }
  }, 'example-project.json'));
  const png = readFileSync(join(import.meta.dir, 'fixtures/rig-registration/build/rectangle.png'));
  const tiles = Array.from({ length: 4 }, (_, index) => {
    const path = `evidence/checkpoint/pair-${index}.png`;
    mkdirSync(join(root, 'evidence/checkpoint'), { recursive: true });
    writeFileSync(join(root, path), png);
    return { id: `pair-${index}`, label: `Pair ${index} — setup beside worst, marked cells`, path, sha256: jobHash(png) };
  });
  const rows = Array.from({ length: 103 }, (_, index) => ({ pair: `pair-${index % 4}`, frame: 102 - index,
    classification: 'FAIL', cells: index + 1, flags: { marked: true }, note: index === 0 ? '  한글\n<b>raw</b>\t' : '', accepted: false, extra: null }));
  writeFileSync(join(root, 'evidence/checkpoint/producer.json'), JSON.stringify({ pairFrames: rows }));
  checkpointTableCommand([root, '--file', 'evidence/checkpoint/producer.json', '--rows', 'pairFrames', '--out', 'evidence/checkpoint/table.json']);
  const packet = { schema: 'rig-review-checkpoint-evidence/1' as const, checkpointId: 'assemble', planStepId: 'assemble', tiles,
    table: { path: 'evidence/checkpoint/table.json', sha256: jobHash(readFileSync(join(root, 'evidence/checkpoint/table.json'))), label: 'Complete 103 rows' },
    routesText: '(i) accept openings\n(ii) repair\n(iii) change source', recommendationText: 'HQ recommendation — (i), preserve raw FAIL' };
  const file = join(root, 'evidence/checkpoint/packets.json');
  const attach = (packets: unknown = [packet]) => {
    writeFileSync(file, JSON.stringify(packets));
    return checkpointEvidenceCommand([root, '--file', file], TEST_NOW);
  };
  return { root, packet, rows, attach };
}
