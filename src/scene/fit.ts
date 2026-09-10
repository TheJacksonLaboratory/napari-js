import type { SurfaceBounds } from '../layers/surface-layer';
import type { Fit3D } from '../layers/layer';

/**
 * The framing decisions, as pure functions.
 *
 * They live outside {@link Viewer} because the viewer needs a canvas and a WebGPU device,
 * and these unit tests run in node — the same reason the camera and LUT maths is separated
 * from the visuals. Framing is a policy question with several cases and a genuinely wrong
 * answer for each, so it should not be the part that is only exercised by looking at it.
 */

/** Anything with a 3D extent. Structural, so a host's own layer type qualifies too. */
export interface Bounded {
  bounds(): SurfaceBounds;
}

/** Three finite numbers — the shape a 3D framing can actually be computed from. */
function isVec3(v: unknown): v is [number, number, number] {
  return (
    Array.isArray(v) &&
    v.length >= 3 &&
    Number.isFinite(v[0]) &&
    Number.isFinite(v[1]) &&
    Number.isFinite(v[2])
  );
}

/**
 * A layer's 3D bounds, or null if it has none to give.
 *
 * The RESULT is checked, not just the presence of the method, because `bounds()` is not one
 * contract across the layer tree: {@link ShapesLayer} has one too, and it returns 2D bounds
 * — or null for an empty layer. A structural "has a bounds function" guard accepts it, and
 * then an empty ShapesLayer throws on `b.min[0]` while a non-empty one contributes an
 * `undefined` z that turns the camera target into NaN. A 2D layer has no say in how a 3D
 * scene is framed, so it is skipped rather than coerced.
 */
function bounds3dOf(layer: unknown): SurfaceBounds | null {
  if (typeof (layer as Bounded | null)?.bounds !== 'function') return null;
  const b = (layer as Bounded).bounds();
  if (!b || !isVec3(b.min) || !isVec3(b.max)) return null;
  return b;
}

/**
 * The smallest box containing every layer that has one, or null when none do.
 *
 * The UNION is the point. A point cloud inside a reference volume is a single scene, and
 * framing on whichever layer happened to be added last shows a part of it — usually the
 * part that was added last, which is not a property anyone chose.
 */
export function unionBounds(layers: Iterable<unknown>): SurfaceBounds | null {
  let min: [number, number, number] | null = null;
  const max: [number, number, number] = [0, 0, 0];
  for (const layer of layers) {
    const b = bounds3dOf(layer);
    if (!b) continue;
    if (!min) {
      min = [b.min[0], b.min[1], b.min[2]];
      max[0] = b.max[0];
      max[1] = b.max[1];
      max[2] = b.max[2];
      continue;
    }
    for (let a = 0; a < 3; a++) {
      if (b.min[a] < min[a]) min[a] = b.min[a];
      if (b.max[a] > max[a]) max[a] = b.max[a];
    }
  }
  if (!min) return null;
  const center: [number, number, number] = [
    (min[0] + max[0]) / 2,
    (min[1] + max[1]) / 2,
    (min[2] + max[2]) / 2,
  ];
  // Degenerate scenes (one point, or a flat sheet) still need a usable radius, or the
  // camera ends up at distance zero and renders nothing.
  const radius = 0.5 * Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) || 1;
  return { min, max: [max[0], max[1], max[2]], center, radius };
}

/**
 * Whether this add should frame, given the viewer default, a per-add override, and whether
 * a framing has already happened.
 *
 * Only a real framing counts as "fitted": a `never` add must not consume the one framing a
 * later `once` add is waiting for, or a host that mounts a hidden layer first would find
 * its scene never framed at all.
 */
export function resolveFit(policy: Fit3D, override: Fit3D | undefined, fitted: boolean): boolean {
  const effective = override ?? policy;
  if (effective === 'never') return false;
  if (effective === 'once' && fitted) return false;
  return true;
}

/**
 * Whether a 3D scene has been framed yet, and who is allowed to frame it next.
 *
 * A class rather than a boolean on the viewer because the bug this replaces lived in the
 * GLUE, not in {@link resolveFit}: an explicit `fitToLayers()` framed the scene without
 * recording that it had, so under `once` the next add reframed on that layer alone and
 * silently undid the union the host had just asked for. That is a sequence — reset, fit,
 * add — and a sequence can only be tested if the state it walks through is reachable
 * without a canvas and a GPU.
 */
export class Fit3DState {
  private fitted = false;

  constructor(private readonly policy: Fit3D) {}

  /**
   * Whether this add should frame, recording it when it does.
   *
   * Only a real framing counts: a `never` add must not consume the one framing a later
   * `once` add is waiting for, or a host that mounts a hidden layer first would find its
   * scene never framed at all.
   */
  claim(override?: Fit3D): boolean {
    if (!resolveFit(this.policy, override, this.fitted)) return false;
    this.fitted = true;
    return true;
  }

  /** Record a framing the host performed itself, so `once` does not grant another. */
  markFitted(): void {
    this.fitted = true;
  }

  /** Let the next add frame again — the scene's subject has changed. */
  reset(): void {
    this.fitted = false;
  }
}

/** Camera target and distance for a box — the framing itself, separated from the decision. */
export function framingFor(b: SurfaceBounds): {
  target: [number, number, number];
  distance: number;
} {
  return { target: b.center, distance: Math.max(b.radius * 2.5, 1e-3) };
}
