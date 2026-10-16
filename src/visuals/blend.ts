import type { BlendMode } from '../layers/layer';

/**
 * Map a {@link BlendMode} to a WebGPU blend state for premultiplied-alpha output.
 * `opaque` returns `undefined` (blending disabled).
 */
export function blendStateFor(mode: BlendMode): GPUBlendState | undefined {
  switch (mode) {
    case 'opaque':
      return undefined;
    case 'translucent':
    case 'translucent_no_depth':
      return {
        color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      };
    case 'additive':
      return {
        color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
        alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
      };
    case 'minimum':
      return {
        color: { srcFactor: 'one', dstFactor: 'one', operation: 'min' },
        alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'min' },
      };
  }
}
