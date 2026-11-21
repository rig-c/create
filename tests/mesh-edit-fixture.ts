import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readModel, readSetupMesh, underNoSkin } from '@rig-c/core/core';
import { jobHash } from '../src/job-outbox.ts';
import type { JsonObject } from '../src/templates.ts';

/** One Review mesh edit that moves the first hull vertex of each named attachment in the published model. */
export function meshEdits(root: string, source: JsonObject, attachments: readonly string[] = ['torso']): JsonObject[] {
  const model = readFileSync(join(root, String((source.model as JsonObject).path)), 'utf8');
  const { stage, skins } = JSON.parse(model);
  return attachments.map(name => {
    const mesh = readSetupMesh(underNoSkin(readModel(model)), { slot: name, skin: 'default', attachment: name });
    const attachment = skins.find((skin: { name: string }) => skin.name === 'default').attachments[name][name];
    const positions = Array.from({ length: mesh.vertices.length / 2 }, (_, i) =>
      [mesh.vertices[2 * i]! - stage.x, stage.y + stage.height - mesh.vertices[2 * i + 1]!]);
    const vertex = mesh.hull!;
    const from = positions[vertex]!;
    const edit = {
      attachment: name, basis: 'setup', ops: [{ from, op: 'move', to: [Math.round((from[0]! + 0.5) * 100) / 100, Math.round(from[1]! * 100) / 100], v: vertex }],
      skin: 'default', slot: name,
      source: { frame: { height: stage.height, width: stage.width }, hash: jobHash(JSON.stringify(attachment)),
        hullLength: mesh.hull, positions, triangleCount: mesh.triangles.length / 3, vertexCount: positions.length },
    };
    // Keys are in the order of Review's signed digest; name attachments in Review's skin/slot/attachment order.
    return { edit, sha256: jobHash(JSON.stringify(edit)) };
  });
}
