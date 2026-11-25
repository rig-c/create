import { join } from 'node:path';
import { existsSync } from './check-reads.ts';
import { loadPartsSource, locateParts, PARTS_PACKAGE } from './parts-sections.ts';
import { Refusal, refuse } from './refusal.ts';
import type { JsonObject } from './templates.ts';

type Pair = readonly [number, number];
type MeshEditOp =
  | { readonly op: 'move'; readonly v: number; readonly from: Pair; readonly to: Pair }
  | { readonly op: 'add'; readonly at: Pair; readonly onEdge?: Pair }
  | { readonly op: 'remove'; readonly v: number }
  | { readonly op: 'edge' | 'unedge'; readonly a: number; readonly b: number };

/** Decoded Review value. Parts owns digest, source binding and geometry checks. */
export interface MeshEditValue {
  readonly skin: string;
  readonly slot: string;
  readonly attachment: string;
  readonly basis: 'setup';
  readonly source: {
    readonly vertexCount: number;
    readonly triangleCount: number;
    readonly hullLength: number;
    readonly hash: string;
    readonly frame: { readonly width: number; readonly height: number };
    readonly positions: readonly Pair[];
  };
  readonly ops: readonly MeshEditOp[];
}

export interface MeshEditEntry {
  readonly edit: MeshEditValue;
  readonly sha256: string;
}

/** The fields this seam consumes from a finalized act whose source the caller has bound. */
export type MeshEditAct = {
  readonly schema: 'rig-review/act@8';
  readonly kind: 'review-verdict';
  readonly actId: string;
  readonly source: { readonly sourceHash: string };
  readonly value: {
    readonly stage: 'rig-review';
    readonly verdict: 'changes-requested';
    readonly meshEdits: readonly MeshEditEntry[];
    readonly comments?: readonly unknown[];
  };
} | {
  /** act@10 mesh carrier (#982): the act@8 payload unchanged, with no verdict. */
  readonly schema: 'rig-review/act@10';
  readonly kind: 'comments';
  readonly actId: string;
  readonly source: { readonly sourceHash: string };
  readonly value: { readonly meshEdits: readonly MeshEditEntry[]; readonly comments?: readonly unknown[] };
};

/** A finalized mesh edit: an act@8 Request changes, or an act@10 comment carrying mesh edits. */
export function isMeshEditAct(act: { readonly schema: string; readonly kind: string; readonly value: object }): boolean {
  const value = act.value as { stage?: unknown; verdict?: unknown; meshEdits?: unknown };
  if (!Array.isArray(value.meshEdits) || value.meshEdits.length === 0) return false;
  if (act.schema === 'rig-review/act@10') return act.kind === 'comments';
  return act.schema === 'rig-review/act@8' && act.kind === 'review-verdict' && value.stage === 'rig-review' && value.verdict === 'changes-requested';
}

export interface MeshEditPaths {
  readonly rig: string;
  readonly config: string;
  readonly parts: string;
  readonly out: string;
}

export interface MeshEditInput extends MeshEditPaths {
  readonly part: string;
  readonly edit: MeshEditValue;
  readonly actId: string;
  readonly actSourceHash: string;
  readonly payloadSha256: string;
}

export type MeshEditProvenance = JsonObject & { readonly spec: 'rig-parts-remesh/1' };

export interface MeshEditProblem {
  readonly code: string;
  readonly object: string;
  readonly detail: string;
}

interface RemeshResult {
  readonly provenance: MeshEditProvenance;
  /** Paths relative to the new revision directory, including remesh.json. */
  readonly written: readonly string[];
}

export type MeshEditResult =
  | (RemeshResult & { readonly status: 'applied' | 'replayed'; readonly input: MeshEditInput })
  | { readonly status: 'superseded'; readonly input: MeshEditInput; readonly problem: MeshEditProblem };

export class MeshEditRefusal extends Refusal {
  readonly object: string;
  readonly detail: string;

  constructor(readonly problems: readonly [MeshEditProblem, ...MeshEditProblem[]]) {
    const [first, ...rest] = problems;
    super(first.code, [`${first.object}: ${first.detail}`, ...rest.map(p => `${p.code}: ${p.object}: ${p.detail}`)].join('\n'));
    this.object = first.object;
    this.detail = first.detail;
  }
}

type ApplyMeshEditAct = (input: MeshEditInput) => RemeshResult;
const REMESH_SOURCE = 'src/remesh-api.ts';

function loadRemeshApi(projectDir: string): ApplyMeshEditAct {
  const parts = locateParts(projectDir);
  const remedy = `install a project ${PARTS_PACKAGE} release providing ${REMESH_SOURCE} and its applyMeshEditAct export`;
  if (parts === null) refuse('PARTS_REMESH_API_UNAVAILABLE', `${projectDir}: ${PARTS_PACKAGE} was not found; ${remedy}`);
  const path = join(parts, REMESH_SOURCE);
  if (!existsSync(path)) refuse('PARTS_REMESH_API_UNAVAILABLE', `${path}: file is absent; ${remedy}`);
  const { applyMeshEditAct } = loadPartsSource(parts, REMESH_SOURCE) as { applyMeshEditAct?: ApplyMeshEditAct };
  if (typeof applyMeshEditAct !== 'function') refuse('PARTS_REMESH_API_UNAVAILABLE', `${path}: applyMeshEditAct is absent; ${remedy}`);
  return applyMeshEditAct;
}

function isPartsProblem(value: unknown): value is MeshEditProblem {
  return value !== null && typeof value === 'object'
    && 'code' in value && typeof value.code === 'string'
    && 'object' in value && typeof value.object === 'string'
    && 'detail' in value && typeof value.detail === 'string';
}

function applyOne(apply: ApplyMeshEditAct, input: MeshEditInput): MeshEditResult {
  try {
    const { provenance, written } = apply(input);
    return { status: written.length === 0 ? 'replayed' : 'applied', input, provenance, written };
  } catch (error) {
    if (!(error instanceof Error) || !('problems' in error) || !Array.isArray(error.problems)) throw error;
    const [problem, ...rest]: unknown[] = error.problems;
    if (!isPartsProblem(problem) || !rest.every(isPartsProblem)) throw error;
    if (problem.code === 'REMESH_DELTA_ACT_SUPERSEDED' && rest.length === 0) {
      return { status: 'superseded', input, problem };
    }
    throw new MeshEditRefusal([problem, ...rest]);
  }
}

/**
 * Apply a decoded Request changes act in Review's order. pathsFor supplies the
 * initial rig and each edit's config, parts and fresh output directory. After
 * the first edit the current rig comes from the chain, including through both
 * kinds of replay. A refusal leaves any earlier Parts outputs in place. The
 * caller gets the batch results only after every unique edit has succeeded.
 */
export function applyMeshEdits(
  projectDir: string,
  act: MeshEditAct,
  pathsFor: (entry: MeshEditEntry, priorResults: readonly MeshEditResult[]) => MeshEditPaths,
): readonly MeshEditResult[] {
  if (!isMeshEditAct(act)) {
    refuse('REVIEW_ACT_INVALID', 'act.value.meshEdits: expected a finalized act@8 rig-review Request changes or an act@10 comment with at least one mesh edit; request the edit in the live Review job');
  }
  const apply = loadRemeshApi(projectDir);
  const results: MeshEditResult[] = [];
  const seen = new Set<string>();
  let currentRig: string | undefined;
  for (const entry of act.value.meshEdits) {
    const { edit, sha256 } = entry;
    const key = JSON.stringify([act.actId, edit.skin, edit.slot, edit.attachment]);
    if (seen.has(key)) continue;
    seen.add(key);
    const { rig, config, parts, out } = pathsFor(entry, results);
    const input: MeshEditInput = {
      rig: currentRig ?? rig, config, parts, part: edit.attachment, out, edit,
      actId: act.actId, actSourceHash: act.source.sourceHash, payloadSha256: sha256,
    };
    const result = applyOne(apply, input);
    results.push(result);
    currentRig = result.status === 'applied' ? out : input.rig;
  }
  return results;
}
