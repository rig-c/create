/** Synthetic act comment shapes for rig-c/review#1136: one per anchor kind Create already reads, plus the direction time-only pin. */
import { createHash } from 'node:crypto';
import { encodePng } from '@rig-c/core/plate';
import type { JsonObject } from '../src/templates.ts';

type Json = JsonObject;
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** Review's seconds basis for a pin with no producer frame (Review src/stage-comment.ts timeOnlyBasis). */
export const TIME_ONLY_BASIS = { schema: 'rig-review-time-only/1', basis: 'seconds',
  reason: 'frame is unavailable: no explicit producer frame index at this time (COMMENT_FRAME_UNAVAILABLE)' } as const;

export function syntheticCrop(): Json {
  const png = Buffer.from(encodePng(2, 2, new Uint8Array(2 * 2 * 4).fill(120)));
  const hash = sha256(png);
  return { path: `comment-crops/${hash}.png`, sha256: hash, png: `data:image/png;base64,${png.toString('base64')}`, width: 2, height: 2 };
}

function mark(sourceHash: string, modelHash: string, time: number, frame: Json | null): Json {
  const camera = { space: 'world', zoom: 2, center: { x: 25, y: 25 }, viewport: { width: 100, height: 100 }, visible: { x: 0, y: 0, width: 50, height: 50 } };
  return { schema: 'rig-review-comment/1', mode: 'animate', viewport: 'rig', frame, ...(frame === null ? { timeBasis: { ...TIME_ONLY_BASIS } } : {}),
    time, animation: 'idle', sourceHash, modelHash, referenceHash: null, referenceId: null, camera,
    screen: { x: 40, y: 30, width: 0, height: 0 }, world: { x: 4, y: 19, width: 0, height: 0 }, slots: [], crop: syntheticCrop(),
    bookmark: { schema: 'rig-review-inspection/1', binding: { mode: 'single', sourceHash, rigs: [modelHash] }, time, animation: 'idle',
      theme: 'light', layers: { images: true, meshes: false, bones: false },
      view: { schema: 'rig-review-view/1', cameras: { rig: camera, a: null, b: null, reference: null } }, selection: { inspector: 'playback' } } };
}

/** A direction pin as Review 4.18.3 writes it: exact held seconds, seconds basis, null frames, point geometry. */
export function directionPin(sourceHash: string, modelHash: string, time: number, text: string, target: string): Json {
  return { text, anchor: { id: `direction-pin-${time}`, frameStart: null, frameEnd: null, target: { kind: 'rig', name: target }, category: 'defect',
    context: { time, frame: null, animation: 'idle', interval: null, comment: mark(sourceHash, modelHash, time, null) } } };
}

/** A rig pin with an explicit producer frame, the Feedback shape interview picks already carry (#860). */
export function framedRigPin(text: string): Json {
  const source = 'a'.repeat(64);
  const model = 'b'.repeat(64);
  return { text, anchor: { id: 'synthetic-rig-point', frameStart: 3, frameEnd: 3, target: { kind: 'rig', name: 'synthetic-rig' }, category: 'quality',
    context: { comment: mark(source, model, 0.25, { index: 3, basis: 'producer' }) } } };
}

/** The direction act value Review wrote before #1136: the pin's projected label inside one anchorless comment (Review #1136 readback). */
export const HISTORICAL_DIRECTION_VALUE = { stage: 'direction-review', verdict: 'changes-requested',
  comments: [{ text: '[["rig-review-comment/1","animate","rig","rig","legacy",null,null]]\nHold this pose' }] };

/** Every comment shape Create reads today, keyed for the scalar-label check. */
export function existingShapes(): [string, Json[]][] {
  return [
    ['general', [{ text: '  First\r\nline  ' }]],
    ['checkpoint', [{ text: 'Approve assemble.', anchor: { checkpointId: 'assemble', planStepId: 'assemble' } }]],
    ['parts-issue', [{ text: 'Edge needs work.', anchor: { schema: 'rig-review-parts-comment/2', parts: [{ name: 'torso' }, { name: 'face' }], view: { mode: 'parts' } } }]],
    ['image-name', [{ text: 'Second', anchor: { name: 'candidate' } }]],
    ['feedback-slot', [{ text: 'Fix this', anchor: { id: 'old', target: { kind: 'slot', name: 'sleeve' }, frameStart: 3, frameEnd: 5 } }]],
    ['feedback-rig-framed', [framedRigPin('Review this point on the rig.')]],
    ['direction-time-only', [directionPin('c'.repeat(64), 'd'.repeat(64), 1.25, 'Hold the lantern here.', 'synthetic-composed'), { text: 'Overall direction note.' }]],
  ];
}
