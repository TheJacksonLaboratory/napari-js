import type { SurfaceLayer } from '../layers/surface-layer';
import { SURFACE_VERTEX_FLOATS } from '../layers/surface-layer';
import type { BlendMode } from '../layers/layer';
import { DEPTH_FORMAT, type LayerVisual, type RenderView } from './layer-visual';
import { buildLut, LUT_SIZE } from '../color/lut';
import { SURFACE_SHADER } from './surface-shader';
import { blendStateFor } from './blend';
import type { Camera3D } from '../camera/camera3d';
import { MAX_CLIPPING_PLANES } from '../layers/clipping';

const VERTEX_STRIDE = SURFACE_VERTEX_FLOATS * 4; // [x,y,z,value] → 16 bytes
/** mat4(16) + params vec4 + light vec4 + flags vec4 + color vec4 + 2 vec4 per clipping plane. */
export const SURFACE_UNIFORM_FLOATS = 32 + 8 * MAX_CLIPPING_PLANES;
/** Per-vertex colour: RGBA float32 → 16 bytes (stride 0 when the layer has none). */
const COLOR_STRIDE = 16;
const COLOR_MODE = { colormap: 0, color: 1, vertex: 2 } as const;
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
  out[26] = COLOR_MODE[layer.colorMode];
  const planes = layer.clippingPlanes;
  out[27] = planes.length;
  const color = layer.color ?? [1, 1, 1, 1];
  out[28] = color[0];
  out[29] = color[1];
  out[30] = color[2];
  out[31] = color[3];
  out.fill(0, 32, SURFACE_UNIFORM_FLOATS);
  planes.forEach((p, i) => {
    const o = 32 + 8 * i;
    out.set(p.position, o);
    out.set(p.normal, o + 4);
  });
}

/**
 * Renders a {@link SurfaceLayer} as an indexed triangle mesh (see surface-shader.ts). Uploads the
 * interleaved position+value vertex buffer and the face index buffer, again only when the layer's
 * `dataVersion` moves ({@link SurfaceLayer.setData}); the LUT and blend pipeline are rebuilt
 * reactively. Uses depth testing (the renderer attaches
 * a depth buffer for 3D passes) so the mesh self-occludes correctly under the orbit camera.
 */
export class SurfaceVisual implements LayerVisual {
  readonly ndisplay = 3 as 2 | 3;

  private readonly module: GPUShaderModule;
  private readonly uniformBuffer: GPUBuffer;
  private readonly scratch = new Float32Array(SURFACE_UNIFORM_FLOATS);
  private vertexBuffer: GPUBuffer | undefined;
  private indexBuffer: GPUBuffer | undefined;
  private edgeBuffer: GPUBuffer | undefined;
  /** Per-vertex colours, or one dummy element read by every vertex (stride 0). */
  private colorBuffer: GPUBuffer | undefined;
  /** Whether the pipeline reads {@link colorBuffer} per vertex. */
  private currentVertexColors: boolean;
  private colorVersion: number;
  private readonly lutTexture: GPUTexture;
  private readonly lutSampler: GPUSampler;
  private indexCount = 0;
  private edgeCount = 0;
  private dataVersion: number;
  private bindGroup: GPUBindGroup;
  private pipeline: GPURenderPipeline;
  private currentBlend: BlendMode;
  private currentWireframe: boolean;
  private currentTranslucent: boolean;
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

    this.uploadGeometry();
    this.dataVersion = layer.dataVersion;
    this.uploadColors();
    this.colorVersion = layer.colorVersion;

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
    this.currentVertexColors = layer.vertexColors !== null;
    this.currentTranslucent = layer.translucent;
    this.pipeline = this.buildPipeline(
      layer.blending,
      layer.wireframe,
      this.currentVertexColors,
      this.currentTranslucent,
    );
    this.bindGroup = this.buildBindGroup();
  }

  /**
   * Write `data` into `buffer`, made (or replaced) when missing or too small; returns the buffer.
   * At least 16 bytes, so an empty mesh still binds a valid buffer.
   */
  private fill(
    buffer: GPUBuffer | undefined,
    data: ArrayBufferView,
    usage: GPUBufferUsageFlags,
  ): GPUBuffer {
    if (!buffer || data.byteLength > buffer.size) {
      buffer?.destroy();
      buffer = this.device.createBuffer({
        size: Math.max(16, data.byteLength),
        usage: usage | GPUBufferUsage.COPY_DST,
      });
    }
    if (data.byteLength > 0) {
      this.device.queue.writeBuffer(buffer, 0, data as GPUAllowSharedBufferSource);
    }
    return buffer;
  }

  /** Upload the vertices, the faces and the wireframe edges (uint32 indices: 4-byte aligned). */
  private uploadGeometry(): void {
    const layer = this.layer;
    this.vertexBuffer = this.fill(
      this.vertexBuffer,
      layer.buildVertexData(),
      GPUBufferUsage.VERTEX,
    );
    this.indexBuffer = this.fill(this.indexBuffer, layer.faces, GPUBufferUsage.INDEX);
    this.indexCount = layer.indexCount;
    const edges = layer.buildEdgeIndices();
    this.edgeBuffer = this.fill(this.edgeBuffer, edges, GPUBufferUsage.INDEX);
    this.edgeCount = edges.length;
  }

  /** Upload the per-vertex colours, or the one dummy colour every vertex reads without them. */
  private uploadColors(): void {
    const colors = this.layer.vertexColors ?? new Float32Array(4);
    this.colorBuffer = this.fill(this.colorBuffer, colors, GPUBufferUsage.VERTEX);
  }

  private buildPipeline(
    blend: BlendMode,
    wireframe: boolean,
    vertexColors: boolean,
    translucent: boolean,
  ): GPURenderPipeline {
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
          {
            arrayStride: vertexColors ? COLOR_STRIDE : 0,
            attributes: [{ shaderLocation: 2, offset: 0, format: 'float32x4' }], // colour
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
      // A translucent surface is depth-tested (opaque geometry in front hides it) but does not
      // write depth, so what is drawn behind it after it still shows through.
      depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: !translucent, depthCompare: 'less' },
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
    const vertexColors = this.layer.vertexColors !== null;
    const translucent = this.layer.translucent;
    if (
      this.layer.blending !== this.currentBlend ||
      this.layer.wireframe !== this.currentWireframe ||
      vertexColors !== this.currentVertexColors ||
      translucent !== this.currentTranslucent
    ) {
      this.currentBlend = this.layer.blending;
      this.currentWireframe = this.layer.wireframe;
      this.currentVertexColors = vertexColors;
      this.currentTranslucent = translucent;
      this.pipeline = this.buildPipeline(
        this.currentBlend,
        this.currentWireframe,
        vertexColors,
        translucent,
      );
      this.bindGroup = this.buildBindGroup();
    }
    if (this.layer.colormapVersion !== this.lutVersion) {
      this.lutVersion = this.layer.colormapVersion;
      this.writeLut();
    }
    if (this.layer.dataVersion !== this.dataVersion) {
      this.dataVersion = this.layer.dataVersion;
      this.uploadGeometry();
    }
    if (this.layer.colorVersion !== this.colorVersion) {
      this.colorVersion = this.layer.colorVersion;
      this.uploadColors();
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
    pass.setVertexBuffer(0, this.vertexBuffer!);
    pass.setVertexBuffer(1, this.colorBuffer!);
    pass.setIndexBuffer((wireframe ? this.edgeBuffer : this.indexBuffer)!, 'uint32');
    pass.drawIndexed(count);
  }

  dispose(): void {
    this.vertexBuffer?.destroy();
    this.indexBuffer?.destroy();
    this.edgeBuffer?.destroy();
    this.colorBuffer?.destroy();
    this.lutTexture.destroy();
    this.uniformBuffer.destroy();
  }
}
