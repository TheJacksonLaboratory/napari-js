import type { SurfaceLayer } from '../layers/surface-layer';
import { SURFACE_VERTEX_FLOATS } from '../layers/surface-layer';
import type { BlendMode } from '../layers/layer';
import { DEPTH_FORMAT, type LayerVisual, type RenderView } from './layer-visual';
import { buildLut, LUT_SIZE } from '../color/lut';
import { SURFACE_SHADER } from './surface-shader';
import { blendStateFor } from './blend';
import type { Camera3D } from '../camera/camera3d';

const VERTEX_STRIDE = SURFACE_VERTEX_FLOATS * 4; // [x,y,z,value] → 16 bytes
/** mat4(16) + params vec4 + light vec4 + flags vec4. */
export const SURFACE_UNIFORM_FLOATS = 28;
const UNIFORM_BYTES = SURFACE_UNIFORM_FLOATS * 4;
const AMBIENT = 0.35;

/**
 * Pack the per-frame uniforms (layout in surface-shader.ts) into `out`. Pure, so the packing —
 * the window, the flags, the headlight — is testable without a device.
 */
export function packSurfaceUniforms(
  out: Float32Array,
  layer: SurfaceLayer,
  camera: Camera3D,
  vw: number,
  vh: number,
): void {
  out.set(camera.viewProjection(vw, vh), 0);
  const [lo, hi] = layer.contrastLimits;
  out[16] = lo;
  out[17] = hi;
  out[18] = layer.gamma;
  out[19] = layer.opacity;
  // Headlight: light from the camera toward the scene, so the mesh is lit from the viewer side.
  const eye = camera.eye();
  const t = camera.target;
  let lx = eye[0] - t[0];
  let ly = eye[1] - t[1];
  let lz = eye[2] - t[2];
  const ll = Math.hypot(lx, ly, lz) || 1;
  lx /= ll;
  ly /= ll;
  lz /= ll;
  out[20] = lx;
  out[21] = ly;
  out[22] = lz;
  out[23] = AMBIENT;
  out[24] = layer.wireframe ? 1 : 0;
  out[25] = layer.invert ? 1 : 0;
  out[26] = 0;
  out[27] = 0;
}

/**
 * Renders a {@link SurfaceLayer} as an indexed triangle mesh (see surface-shader.ts). Uploads the
 * interleaved position+value vertex buffer and the face index buffer once (the mesh is immutable);
 * only the LUT and blend pipeline are rebuilt reactively. Uses depth testing (the renderer attaches
 * a depth buffer for 3D passes) so the mesh self-occludes correctly under the orbit camera.
 */
export class SurfaceVisual implements LayerVisual {
  readonly ndisplay = 3 as 2 | 3;

  private readonly module: GPUShaderModule;
  private readonly uniformBuffer: GPUBuffer;
  private readonly scratch = new Float32Array(SURFACE_UNIFORM_FLOATS);
  private readonly vertexBuffer: GPUBuffer;
  private readonly indexBuffer: GPUBuffer;
  private readonly edgeBuffer: GPUBuffer;
  private readonly lutTexture: GPUTexture;
  private readonly lutSampler: GPUSampler;
  private readonly indexCount: number;
  private readonly edgeCount: number;
  private bindGroup: GPUBindGroup;
  private pipeline: GPURenderPipeline;
  private currentBlend: BlendMode;
  private currentWireframe: boolean;
  private lutVersion: number;

  constructor(
    private readonly device: GPUDevice,
    private readonly format: GPUTextureFormat,
    private readonly layer: SurfaceLayer,
  ) {
    this.module = device.createShaderModule({ code: SURFACE_SHADER });
    this.uniformBuffer = device.createBuffer({
      size: UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const verts = layer.buildVertexData();
    this.vertexBuffer = device.createBuffer({
      size: Math.max(VERTEX_STRIDE, verts.byteLength),
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    if (verts.byteLength > 0) {
      device.queue.writeBuffer(this.vertexBuffer, 0, verts as GPUAllowSharedBufferSource);
    }

    // Index buffers must be a multiple of 4 bytes; uint32 indices already satisfy that.
    this.indexCount = layer.indexCount;
    this.indexBuffer = device.createBuffer({
      size: Math.max(4, layer.faces.byteLength),
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    if (layer.faces.byteLength > 0) {
      device.queue.writeBuffer(this.indexBuffer, 0, layer.faces as GPUAllowSharedBufferSource);
    }

    // Wireframe edge index buffer (line-list of the triangle edges).
    const edges = layer.buildEdgeIndices();
    this.edgeCount = edges.length;
    this.edgeBuffer = device.createBuffer({
      size: Math.max(4, edges.byteLength),
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    if (edges.byteLength > 0) {
      device.queue.writeBuffer(this.edgeBuffer, 0, edges as GPUAllowSharedBufferSource);
    }

    this.lutTexture = device.createTexture({
      size: [LUT_SIZE, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.writeLut();
    this.lutVersion = layer.colormapVersion;
    this.lutSampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });

    this.currentBlend = layer.blending;
    this.currentWireframe = layer.wireframe;
    this.pipeline = this.buildPipeline(layer.blending, layer.wireframe);
    this.bindGroup = this.buildBindGroup();
  }

  private buildPipeline(blend: BlendMode, wireframe: boolean): GPURenderPipeline {
    return this.device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module: this.module,
        entryPoint: 'vs',
        buffers: [
          {
            arrayStride: VERTEX_STRIDE,
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x3' }, // position
              { shaderLocation: 1, offset: 12, format: 'float32' }, // value
            ],
          },
        ],
      },
      fragment: {
        module: this.module,
        entryPoint: 'fs',
        targets: [{ format: this.format, blend: blendStateFor(blend) }],
      },
      // Wireframe draws the triangle edges as a line-list; filled draws the triangles.
      primitive: { topology: wireframe ? 'line-list' : 'triangle-list', cullMode: 'none' },
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
    if (
      this.layer.blending !== this.currentBlend ||
      this.layer.wireframe !== this.currentWireframe
    ) {
      this.currentBlend = this.layer.blending;
      this.currentWireframe = this.layer.wireframe;
      this.pipeline = this.buildPipeline(this.currentBlend, this.currentWireframe);
      this.bindGroup = this.buildBindGroup();
    }
    if (this.layer.colormapVersion !== this.lutVersion) {
      this.lutVersion = this.layer.colormapVersion;
      this.writeLut();
    }
  }

  draw(pass: GPURenderPassEncoder, view: RenderView): void {
    const wireframe = this.layer.wireframe;
    const count = wireframe ? this.edgeCount : this.indexCount;
    if (count === 0) return;
    packSurfaceUniforms(this.scratch, this.layer, view.camera3d, view.vw, view.vh);
    this.device.queue.writeBuffer(this.uniformBuffer, 0, this.scratch);

    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.setVertexBuffer(0, this.vertexBuffer);
    pass.setIndexBuffer(wireframe ? this.edgeBuffer : this.indexBuffer, 'uint32');
    pass.drawIndexed(count);
  }

  dispose(): void {
    this.vertexBuffer.destroy();
    this.indexBuffer.destroy();
    this.edgeBuffer.destroy();
    this.lutTexture.destroy();
    this.uniformBuffer.destroy();
  }
}
