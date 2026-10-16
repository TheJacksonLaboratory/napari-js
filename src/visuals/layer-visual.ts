import type { Camera } from '../camera/camera';
import type { Camera3D } from '../camera/camera3d';

/**
 * Depth-buffer format for 3D passes. The renderer attaches a depth texture of this format when
 * drawing `ndisplay === 3` layers, so every 3D visual's pipeline must declare a matching
 * `depthStencil.format`. 2D passes have no depth attachment.
 */
export const DEPTH_FORMAT: GPUTextureFormat = 'depth24plus';

/**
 * Format of the depth texture a translucent surface's nearest layer is found in (see
 * {@link LayerVisual.drawNearest}): 32-bit float, so the colour pass compares its fragments' depth
 * with exactly what the depth pass wrote.
 */
export const NEAREST_DEPTH_FORMAT: GPUTextureFormat = 'depth32float';

/** Per-frame view state handed to every visual. 2D visuals use `camera2d`; volume uses `camera3d`. */
export interface RenderView {
  camera2d: Camera;
  camera3d: Camera3D;
  /** CSS-pixel projection size. */
  vw: number;
  vh: number;
  /** Current z-slice (2D stacks). */
  z: number;
  ndisplay: 2 | 3;
}

/** A GPU renderer for one layer. The renderer draws only visuals whose `ndisplay` matches. */
export interface LayerVisual {
  /** Display dimensionality this visual renders in (2 for image/points/labels, 3 for volume). */
  readonly ndisplay: 2 | 3;
  /** Reconcile GPU state with the layer's current display properties (cheap; pre-draw). */
  sync(): void;
  /** Encode draws for the given view. */
  draw(pass: GPURenderPassEncoder, view: RenderView): void;
  /**
   * Whether this frame draws the visual by its nearest layer (a translucent surface): the renderer
   * then calls {@link drawDepth} in a depth-only pass of its own, then {@link drawNearest}, after
   * every other layer, instead of {@link draw}.
   */
  drawsNearest?(): boolean;
  /** Write the visual's depth only, into a {@link NEAREST_DEPTH_FORMAT} attachment. */
  drawDepth?(pass: GPURenderPassEncoder, view: RenderView): void;
  /** Draw the visual's colour where it is the nearest layer `nearest` (from drawDepth) holds. */
  drawNearest?(pass: GPURenderPassEncoder, view: RenderView, nearest: GPUTextureView): void;
  dispose(): void;
}
