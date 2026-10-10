import type { PointsLayer } from '../layers/points-layer';
import { POINTS_INSTANCE_STRIDE } from '../layers/points-layer';
import type { BlendMode } from '../layers/layer';
import type { LayerVisual, RenderView } from './layer-visual';
import { multiply, scaleTranslate2d, type Mat4 } from '../math/mat4';
import { POINTS_SHADER } from './points-shader';
import { blendStateFor } from './blend';

const STRIDE_BYTES = POINTS_INSTANCE_STRIDE * 4; // 48
/** mat4(16) + params vec4: layer symbol code, opacity, borderWidth, 0. */
export const POINTS_UNIFORM_FLOATS = 20;
const UNIFORM_FLOATS = POINTS_UNIFORM_FLOATS;
const UNIFORM_BYTES = UNIFORM_FLOATS * 4;

/**
 * Pack the per-frame uniforms (layout in points-shader.ts) into `out`. Pure, so what reaches
 * the shader is testable without a device.
 */
export function packPointsUniforms(out: Float32Array, layer: PointsLayer, mvp: Mat4): void {
  out.set(mvp, 0);
  out[16] = layer.symbolCode();
  out[17] = layer.opacity;
  out[18] = layer.borderWidth;
  out[19] = 0;
}

/** Renders a {@link PointsLayer} as instanced SDF markers. */
export class PointsVisual implements LayerVisual {
  readonly ndisplay = 2 as 2 | 3;
  private readonly module: GPUShaderModule;
  private readonly uniformBuffer: GPUBuffer;
  private readonly scratch = new Float32Array(UNIFORM_FLOATS);
  private instanceBuffer: GPUBuffer | null = null;
  private pipeline: GPURenderPipeline;
  private currentBlend: BlendMode;
  private dataVersion = -1;

  constructor(
    private readonly device: GPUDevice,
    private readonly format: GPUTextureFormat,
    private readonly layer: PointsLayer,
  ) {
    this.module = device.createShaderModule({ code: POINTS_SHADER });
    this.uniformBuffer = device.createBuffer({
      size: UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.currentBlend = layer.blending;
    this.pipeline = this.buildPipeline(layer.blending);
  }

  private buildPipeline(blend: BlendMode): GPURenderPipeline {
    return this.device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module: this.module,
        entryPoint: 'vs',
        buffers: [
          {
            arrayStride: STRIDE_BYTES,
            stepMode: 'instance',
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x2' }, // pos
              { shaderLocation: 1, offset: 8, format: 'float32' }, // size
              { shaderLocation: 2, offset: 12, format: 'float32x4' }, // face
              { shaderLocation: 3, offset: 28, format: 'float32x4' }, // border
              { shaderLocation: 4, offset: 44, format: 'float32' }, // symbol code / -1
            ],
          },
        ],
      },
      fragment: {
        module: this.module,
        entryPoint: 'fs',
        targets: [{ format: this.format, blend: blendStateFor(blend) }],
      },
      primitive: { topology: 'triangle-list' },
    });
  }

  sync(): void {
    if (this.layer.blending !== this.currentBlend) {
      this.currentBlend = this.layer.blending;
      this.pipeline = this.buildPipeline(this.currentBlend);
    }
    if (this.layer.dataVersion !== this.dataVersion || !this.instanceBuffer) {
      this.dataVersion = this.layer.dataVersion;
      this.rebuildInstances();
    }
  }

  private rebuildInstances(): void {
    this.instanceBuffer?.destroy();
    if (this.layer.count === 0) {
      this.instanceBuffer = null;
      return;
    }
    const data = this.layer.buildInstanceData();
    this.instanceBuffer = this.device.createBuffer({
      size: data.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.instanceBuffer, 0, data);
  }

  draw(pass: GPURenderPassEncoder, view: RenderView): void {
    if (!this.instanceBuffer || this.layer.count === 0) return;
    const mvp = multiply(
      view.camera2d.viewProjection(view.vw, view.vh),
      scaleTranslate2d(
        this.layer.scale[0],
        this.layer.scale[1],
        this.layer.translate[0],
        this.layer.translate[1],
      ),
    );
    packPointsUniforms(this.scratch, this.layer, mvp);
    this.device.queue.writeBuffer(this.uniformBuffer, 0, this.scratch);

    const bindGroup = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }],
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.setVertexBuffer(0, this.instanceBuffer);
    pass.draw(6, this.layer.count);
  }

  dispose(): void {
    this.instanceBuffer?.destroy();
    this.uniformBuffer.destroy();
  }
}
