import type { ShapesLayer } from '../layers/shapes-layer';
import type { BlendMode } from '../layers/layer';
import type { LayerVisual, RenderView } from './layer-visual';
import { multiply, scaleTranslate2d } from '../math/mat4';
import { buildLut, LUT_SIZE } from '../color/lut';
import { SHAPES_SHADER } from './shapes-shader';
import { blendStateFor } from './blend';

const UNIFORM_FLOATS = 28; // mat4(16) + window vec4 + color vec4 + extra vec4
const UNIFORM_BYTES = UNIFORM_FLOATS * 4;

/**
 * Renders a {@link ShapesLayer}: one non-indexed draw over an expanded vertex
 * buffer, as a line-list (outline) or a triangle-list (fill).
 *
 * Two vertex buffers rather than one interleaved: positions come from the ring
 * expansion and change only with the geometry, while the per-vertex scalar changes
 * whenever the caller recolours by a different column. Splitting them means a
 * recolour rewrites the smaller buffer and leaves 10⁵–10⁶ positions untouched.
 *
 * The expansion is checked against `device.limits.maxBufferSize` before allocating,
 * because the failure it prevents is not a thrown error but a silently zeroed
 * buffer: WebGPU validation is asynchronous, so an oversized allocation draws
 * nothing and reads exactly like a coordinate bug.
 */
export class ShapesVisual implements LayerVisual {
  readonly ndisplay = 2 as 2 | 3;
  private readonly module: GPUShaderModule;
  private readonly uniformBuffer: GPUBuffer;
  private readonly lutTexture: GPUTexture;
  private readonly lutSampler: GPUSampler;
  private readonly scratch = new Float32Array(UNIFORM_FLOATS);
  private positionBuffer: GPUBuffer | null = null;
  private valueBuffer: GPUBuffer | null = null;
  private shapeIds: Uint32Array = new Uint32Array(0);
  private vertexCount = 0;
  private pipeline: GPURenderPipeline;
  private bindGroup: GPUBindGroup;
  private currentBlend: BlendMode;
  private currentDraw: ShapesLayer['draw'];
  private dataVersion = -1;
  private valueVersion = -1;
  private lutVersion: number;

  constructor(
    private readonly device: GPUDevice,
    private readonly format: GPUTextureFormat,
    private readonly layer: ShapesLayer,
  ) {
    this.module = device.createShaderModule({ code: SHAPES_SHADER });
    this.uniformBuffer = device.createBuffer({
      size: UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.lutTexture = device.createTexture({
      size: [LUT_SIZE, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.writeLut();
    this.lutVersion = layer.colormapVersion;
    this.lutSampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    this.currentBlend = layer.blending;
    this.currentDraw = layer.draw;
    this.pipeline = this.buildPipeline(layer.blending, layer.draw);
    this.bindGroup = this.buildBindGroup();
  }

  private buildPipeline(blend: BlendMode, draw: ShapesLayer['draw']): GPURenderPipeline {
    return this.device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module: this.module,
        entryPoint: 'vs',
        buffers: [
          { arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }] },
          { arrayStride: 4, attributes: [{ shaderLocation: 1, offset: 0, format: 'float32' }] },
        ],
      },
      fragment: {
        module: this.module,
        entryPoint: 'fs',
        targets: [{ format: this.format, blend: blendStateFor(blend) }],
      },
      // No depth state: 2D passes carry no depth attachment, and shapes are drawn
      // in layer order like the other 2D visuals.
      primitive: { topology: draw === 'outline' ? 'line-list' : 'triangle-list', cullMode: 'none' },
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
    if (this.layer.blending !== this.currentBlend || this.layer.draw !== this.currentDraw) {
      this.currentBlend = this.layer.blending;
      this.currentDraw = this.layer.draw;
      this.pipeline = this.buildPipeline(this.currentBlend, this.currentDraw);
      this.bindGroup = this.buildBindGroup();
    }
    if (this.layer.colormapVersion !== this.lutVersion) {
      this.lutVersion = this.layer.colormapVersion;
      this.writeLut();
    }
    if (this.layer.dataVersion !== this.dataVersion || !this.positionBuffer) {
      this.dataVersion = this.layer.dataVersion;
      this.rebuildGeometry();
      // The values ride on the new vertex layout, so they are rewritten with it.
      this.valueVersion = this.layer.valueVersion;
      this.rebuildValues();
    } else if (this.layer.valueVersion !== this.valueVersion) {
      this.valueVersion = this.layer.valueVersion;
      this.rebuildValues();
    }
  }

  private rebuildGeometry(): void {
    this.positionBuffer?.destroy();
    this.positionBuffer = null;
    this.vertexCount = 0;
    this.shapeIds = new Uint32Array(0);

    const needed = this.layer.vertexCount() * 8; // float32x2
    if (needed === 0) return;
    const limit = this.device.limits.maxBufferSize;
    if (needed > limit) {
      // Refuse loudly rather than allocate past the limit: the async validation
      // failure would leave an empty buffer and look like bad coordinates.
      console.error(
        `[napari-js] ShapesLayer needs a ${(needed / 1048576).toFixed(1)} MB vertex buffer for ` +
          `${this.layer.shapeCount} shapes (${this.layer.draw}), over this device's ` +
          `maxBufferSize of ${(limit / 1048576).toFixed(1)} MB. Draw fewer shapes, or create the ` +
          'device with a raised `requiredLimits.maxBufferSize`.',
      );
      return;
    }

    const geometry = this.layer.buildGeometry();
    this.shapeIds = geometry.shapeIds;
    this.vertexCount = geometry.count;
    this.positionBuffer = this.device.createBuffer({
      size: geometry.positions.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(
      this.positionBuffer,
      0,
      geometry.positions as GPUAllowSharedBufferSource,
    );
  }

  private rebuildValues(): void {
    this.valueBuffer?.destroy();
    this.valueBuffer = null;
    if (this.vertexCount === 0) return;
    const values = this.layer.buildVertexValues(this.shapeIds);
    this.valueBuffer = this.device.createBuffer({
      size: values.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.valueBuffer, 0, values as GPUAllowSharedBufferSource);
  }

  draw(pass: GPURenderPassEncoder, view: RenderView): void {
    if (!this.positionBuffer || !this.valueBuffer || this.vertexCount === 0) return;
    const mvp = multiply(
      view.camera2d.viewProjection(view.vw, view.vh),
      scaleTranslate2d(
        this.layer.scale[0],
        this.layer.scale[1],
        this.layer.translate[0],
        this.layer.translate[1],
      ),
    );
    const [lo, hi] = this.layer.contrastLimits;
    const color = this.layer.color;
    const s = this.scratch;
    s.set(mvp, 0);
    s[16] = lo;
    s[17] = hi;
    s[18] = this.layer.gamma;
    s[19] = this.layer.opacity;
    s[20] = color[0];
    s[21] = color[1];
    s[22] = color[2];
    s[23] = this.layer.values ? 1 : 0;
    s[24] = color[3];
    s[25] = 0;
    s[26] = 0;
    s[27] = 0;
    this.device.queue.writeBuffer(this.uniformBuffer, 0, s);

    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.setVertexBuffer(0, this.positionBuffer);
    pass.setVertexBuffer(1, this.valueBuffer);
    pass.draw(this.vertexCount);
  }

  dispose(): void {
    this.positionBuffer?.destroy();
    this.valueBuffer?.destroy();
    this.lutTexture.destroy();
    this.uniformBuffer.destroy();
  }
}
