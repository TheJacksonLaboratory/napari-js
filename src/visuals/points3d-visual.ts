import type { Points3DLayer } from '../layers/points3d-layer';
import {
  POINTS3D_DATA_FLOATS,
  POINTS3D_STYLE_FLOATS,
  POINTS3D_COLOR_FLOATS,
} from '../layers/points3d-layer';
import type { Mat4 } from '../math/mat4';
import type { BlendMode } from '../layers/layer';
import { DEPTH_FORMAT, type LayerVisual, type RenderView } from './layer-visual';
import { buildLut, LUT_SIZE } from '../color/lut';
import { POINTS3D_SHADER } from './points3d-shader';
import { blendStateFor } from './blend';

// Two instance buffers on different clocks: the static half moves with the dataset, the
// style half with every selection click. See the note in points3d-layer.ts.
const DATA_STRIDE = POINTS3D_DATA_FLOATS * 4; // [x,y,z,value] → 16 bytes
const STYLE_STRIDE = POINTS3D_STYLE_FLOATS * 4; // [alpha,sizeScale] → 8 bytes
const COLOR_STRIDE = POINTS3D_COLOR_FLOATS * 4; // [r,g,b,a] → 16 bytes
/** mat4(16) + params vec4 + window vec4 + flags vec4. */
export const POINTS3D_UNIFORM_FLOATS = 28;
const UNIFORM_BYTES = POINTS3D_UNIFORM_FLOATS * 4;

/**
 * Pack the per-frame uniforms (layout in points3d-shader.ts) into `out`. Pure, so the packing —
 * and in particular which flags reach the shader — is testable without a device.
 */
export function packPoints3DUniforms(
  out: Float32Array,
  layer: Points3DLayer,
  viewProjection: Mat4,
  vw: number,
  vh: number,
): void {
  out.set(viewProjection, 0);
  out[16] = vw;
  out[17] = vh;
  out[18] = layer.size;
  out[19] = layer.opacity;
  const [lo, hi] = layer.contrastLimits;
  out[20] = lo;
  out[21] = hi;
  out[22] = layer.gamma;
  out[23] = 0;
  out[24] = layer.colors ? 1 : 0;
  out[25] = layer.invert ? 1 : 0;
  out[26] = 0;
  out[27] = 0;
}

/**
 * Renders a {@link Points3DLayer} as instanced, screen-facing billboards (see points3d-shader.ts):
 * one quad per point, sized in screen pixels, colored by its value through the LUT, depth-tested
 * against the renderer's 3D depth buffer so points occlude correctly under the orbit camera.
 */
export class Points3DVisual implements LayerVisual {
  readonly ndisplay = 3 as 2 | 3;

  private readonly module: GPUShaderModule;
  private readonly uniformBuffer: GPUBuffer;
  private readonly scratch = new Float32Array(POINTS3D_UNIFORM_FLOATS);
  private readonly instanceBuffer: GPUBuffer;
  private readonly styleBuffer: GPUBuffer;
  /** N×RGBA when the layer has per-point colours, else one element read with stride 0. */
  private colorBuffer: GPUBuffer;
  private perPointColor: boolean;
  private colorsVersion: number;
  private readonly lutTexture: GPUTexture;
  private readonly lutSampler: GPUSampler;
  private readonly count: number;
  private bindGroup: GPUBindGroup;
  private pipeline: GPURenderPipeline;
  private currentBlend: BlendMode;
  private lutVersion: number;
  private dataVersion: number;
  private styleVersion: number;

  constructor(
    private readonly device: GPUDevice,
    private readonly format: GPUTextureFormat,
    private readonly layer: Points3DLayer,
  ) {
    this.module = device.createShaderModule({ code: POINTS3D_SHADER });
    this.uniformBuffer = device.createBuffer({
      size: UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const data = layer.buildInstanceData();
    const style = layer.buildStyleData();
    this.count = layer.count;
    this.instanceBuffer = device.createBuffer({
      size: Math.max(DATA_STRIDE, data.byteLength),
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.styleBuffer = device.createBuffer({
      size: Math.max(STYLE_STRIDE, style.byteLength),
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    if (data.byteLength > 0) {
      device.queue.writeBuffer(this.instanceBuffer, 0, data as GPUAllowSharedBufferSource);
      device.queue.writeBuffer(this.styleBuffer, 0, style as GPUAllowSharedBufferSource);
    }

    this.lutTexture = device.createTexture({
      size: [LUT_SIZE, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.writeLut();
    this.lutVersion = layer.colormapVersion;
    this.lutSampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });

    this.perPointColor = layer.colors !== null;
    this.colorBuffer = this.createColorBuffer();
    this.colorsVersion = layer.colorsVersion;

    this.currentBlend = layer.blending;
    this.dataVersion = layer.dataVersion;
    this.styleVersion = layer.styleVersion;
    this.pipeline = this.buildPipeline(layer.blending, this.perPointColor);
    this.bindGroup = this.buildBindGroup();
  }

  /**
   * The colour buffer for the layer's current colours. Without per-point colours it is a single
   * zeroed element the pipeline reads with stride 0, so a layer that never sets `colors` does not
   * pay 16 bytes per point for a buffer the shader ignores.
   */
  private createColorBuffer(): GPUBuffer {
    const colors = this.layer.colors;
    const bytes = colors && colors.byteLength > 0 ? colors.byteLength : COLOR_STRIDE;
    const buffer = this.device.createBuffer({
      size: bytes,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    if (colors && colors.byteLength > 0) {
      this.device.queue.writeBuffer(buffer, 0, colors as GPUAllowSharedBufferSource);
    }
    return buffer;
  }

  /** Re-upload the colours, reallocating only when per-point colour is switched on or off. */
  private writeColors(): void {
    const has = this.layer.colors !== null;
    if (has !== this.perPointColor) {
      this.colorBuffer.destroy();
      this.perPointColor = has;
      this.colorBuffer = this.createColorBuffer();
      // The stride lives in the pipeline, so toggling per-point colour is a pipeline change.
      this.pipeline = this.buildPipeline(this.currentBlend, has);
      this.bindGroup = this.buildBindGroup();
      return;
    }
    const colors = this.layer.colors;
    if (colors && colors.byteLength > 0) {
      this.device.queue.writeBuffer(this.colorBuffer, 0, colors as GPUAllowSharedBufferSource);
    }
  }

  /** Re-upload the static half after the geometry or the scalars changed. */
  private writeInstances(): void {
    const data = this.layer.buildInstanceData();
    if (data.byteLength === 0) return;
    this.device.queue.writeBuffer(this.instanceBuffer, 0, data as GPUAllowSharedBufferSource);
  }

  /** Re-upload only the style half — what a selection change actually touches. */
  private writeStyle(): void {
    const style = this.layer.buildStyleData();
    if (style.byteLength === 0) return;
    this.device.queue.writeBuffer(this.styleBuffer, 0, style as GPUAllowSharedBufferSource);
  }

  private buildPipeline(blend: BlendMode, perPointColor: boolean): GPURenderPipeline {
    return this.device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module: this.module,
        entryPoint: 'vs',
        buffers: [
          {
            arrayStride: DATA_STRIDE,
            stepMode: 'instance',
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x3' }, // position
              { shaderLocation: 1, offset: 12, format: 'float32' }, // value
            ],
          },
          {
            arrayStride: STYLE_STRIDE,
            stepMode: 'instance',
            attributes: [
              { shaderLocation: 2, offset: 0, format: 'float32' }, // per-point alpha
              { shaderLocation: 3, offset: 4, format: 'float32' }, // per-point size scale
            ],
          },
          {
            // Stride 0 without per-point colours: every instance reads the one dummy element.
            arrayStride: perPointColor ? COLOR_STRIDE : 0,
            stepMode: 'instance',
            attributes: [{ shaderLocation: 4, offset: 0, format: 'float32x4' }], // per-point RGBA
          },
        ],
      },
      fragment: {
        module: this.module,
        entryPoint: 'fs',
        targets: [{ format: this.format, blend: blendStateFor(blend) }],
      },
      primitive: { topology: 'triangle-list' },
      // Billboards write depth at the point's center so they occlude within the 3D pass.
      depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: 'less' },
    });
  }

  private buildBindGroup(): GPUBindGroup {
    return this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: this.lutSampler },
        { binding: 2, resource: this.lutTexture.createView() },
      ],
    });
  }

  private writeLut(): void {
    this.device.queue.writeTexture(
      { texture: this.lutTexture },
      buildLut(this.layer.colormap, LUT_SIZE),
      { bytesPerRow: LUT_SIZE * 4, rowsPerImage: 1 },
      { width: LUT_SIZE, height: 1 },
    );
  }

  sync(): void {
    if (this.layer.blending !== this.currentBlend) {
      this.currentBlend = this.layer.blending;
      this.pipeline = this.buildPipeline(this.currentBlend, this.perPointColor);
      this.bindGroup = this.buildBindGroup();
    }
    if (this.layer.colormapVersion !== this.lutVersion) {
      this.lutVersion = this.layer.colormapVersion;
      this.writeLut();
    }
    // The buffer is sized from the layer's count, which cannot change, so a data change is
    // always a rewrite in place rather than a reallocation.
    if (this.layer.dataVersion !== this.dataVersion) {
      this.dataVersion = this.layer.dataVersion;
      this.writeInstances();
    }
    // Separately, so a selection click does not re-upload the positions with it.
    if (this.layer.styleVersion !== this.styleVersion) {
      this.styleVersion = this.layer.styleVersion;
      this.writeStyle();
    }
    // Colours move the style clock too, but only a recolour re-uploads them.
    if (this.layer.colorsVersion !== this.colorsVersion) {
      this.colorsVersion = this.layer.colorsVersion;
      this.writeColors();
    }
  }

  draw(pass: GPURenderPassEncoder, view: RenderView): void {
    if (this.count === 0) return;
    packPoints3DUniforms(
      this.scratch,
      this.layer,
      view.camera3d.viewProjection(view.vw, view.vh),
      view.vw,
      view.vh,
    );
    this.device.queue.writeBuffer(this.uniformBuffer, 0, this.scratch);

    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.setVertexBuffer(0, this.instanceBuffer);
    pass.setVertexBuffer(1, this.styleBuffer);
    pass.setVertexBuffer(2, this.colorBuffer);
    pass.draw(6, this.count);
  }

  dispose(): void {
    this.instanceBuffer.destroy();
    this.styleBuffer.destroy();
    this.colorBuffer.destroy();
    this.lutTexture.destroy();
    this.uniformBuffer.destroy();
  }
}
