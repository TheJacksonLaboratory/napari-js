import { AxesLayer, axesLineVertices } from '../layers/axes-layer';
import { DEPTH_FORMAT, type LayerVisual, type RenderView } from './layer-visual';
import { AXES_SHADER } from './axes-shader';

const UNIFORM_BYTES = 64; // one mat4x4<f32>
const VERTEX_STRIDE = 24; // [x,y,z, r,g,b] × 4 bytes

/**
 * Renders an {@link AxesLayer} as solid-colour GPU lines (`line-list`) transformed by the 3D
 * camera MVP. It never depth-tests or writes (`depthCompare: 'always'`), so the gizmo overlays
 * the volume/surface — the usual look for an axes/scale widget.
 */
export class AxesVisual implements LayerVisual {
  readonly ndisplay = 3 as 2 | 3;
  readonly writesDepth = false;

  private readonly module: GPUShaderModule;
  private readonly uniformBuffer: GPUBuffer;
  private readonly pipeline: GPURenderPipeline;
  private readonly bindGroup: GPUBindGroup;
  private readonly mvpScratch = new Float32Array(16);
  private vertexBuffer: GPUBuffer;
  private vertexCount: number;
  private geomVersion: number;

  constructor(
    private readonly device: GPUDevice,
    format: GPUTextureFormat,
    private readonly layer: AxesLayer,
  ) {
    this.module = device.createShaderModule({ code: AXES_SHADER });
    this.uniformBuffer = device.createBuffer({
      size: UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module: this.module,
        entryPoint: 'vs',
        buffers: [
          {
            arrayStride: VERTEX_STRIDE,
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x3' },
              { shaderLocation: 1, offset: 12, format: 'float32x3' },
            ],
          },
        ],
      },
      fragment: { module: this.module, entryPoint: 'fs', targets: [{ format }] },
      primitive: { topology: 'line-list' },
      depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: false, depthCompare: 'always' },
    });
    this.bindGroup = device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }],
    });

    this.vertexBuffer = this.uploadGeometry();
    this.vertexCount = this.lastCount;
    this.geomVersion = layer.geometryVersion;
  }

  private lastCount = 0;
  private uploadGeometry(): GPUBuffer {
    const verts = axesLineVertices(this.layer);
    this.lastCount = verts.length / 6;
    const buffer = this.device.createBuffer({
      size: Math.max(VERTEX_STRIDE, verts.byteLength),
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    if (verts.byteLength > 0) {
      this.device.queue.writeBuffer(buffer, 0, verts as GPUAllowSharedBufferSource);
    }
    return buffer;
  }

  sync(): void {
    if (this.layer.geometryVersion !== this.geomVersion) {
      this.geomVersion = this.layer.geometryVersion;
      this.vertexBuffer.destroy();
      this.vertexBuffer = this.uploadGeometry();
      this.vertexCount = this.lastCount;
    }
  }

  draw(pass: GPURenderPassEncoder, view: RenderView): void {
    if (this.vertexCount === 0) return;
    this.mvpScratch.set(view.camera3d.viewProjection(view.vw, view.vh));
    this.device.queue.writeBuffer(this.uniformBuffer, 0, this.mvpScratch);
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.setVertexBuffer(0, this.vertexBuffer);
    pass.draw(this.vertexCount);
  }

  dispose(): void {
    this.vertexBuffer.destroy();
    this.uniformBuffer.destroy();
  }
}
