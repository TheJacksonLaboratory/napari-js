/** GPU features napari-js opts into when the adapter supports them. */
export interface DeviceFeatures {
  /** Linear filtering of `r32float` textures (else 16-bit/float layers fall back to nearest). */
  float32Filterable: boolean;
}

/** A live WebGPU adapter + device pair plus the negotiated optional features. */
export interface DeviceContext {
  adapter: GPUAdapter;
  device: GPUDevice;
  features: DeviceFeatures;
}

/** Thrown when WebGPU is unavailable or no adapter/device can be obtained. */
export class WebGPUUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebGPUUnsupportedError';
  }
}

/**
 * Acquire a WebGPU device, opting into `float32-filterable` when available. Throws
 * {@link WebGPUUnsupportedError} with an actionable message when the environment lacks
 * `navigator.gpu`, has no suitable adapter, or device creation fails.
 */
export async function acquireDevice(
  options: { powerPreference?: GPUPowerPreference } = {},
): Promise<DeviceContext> {
  if (typeof navigator === 'undefined' || !('gpu' in navigator) || !navigator.gpu) {
    throw new WebGPUUnsupportedError(
      'WebGPU is not available in this environment (navigator.gpu is missing).',
    );
  }
  const adapter = await navigator.gpu.requestAdapter({
    powerPreference: options.powerPreference ?? 'high-performance',
  });
  if (!adapter) {
    throw new WebGPUUnsupportedError('No suitable GPUAdapter was found.');
  }

  const float32Filterable = adapter.features.has('float32-filterable');
  const requiredFeatures: GPUFeatureName[] = float32Filterable ? ['float32-filterable'] : [];
  // Ask for the buffer sizes the adapter actually offers. `requestDevice` otherwise
  // grants the SPEC DEFAULTS — 256 MiB per buffer and 128 MiB per storage binding —
  // regardless of the hardware, and a layer that needs more (10^5–10^6 polygons, a
  // large mesh) hits an ASYNCHRONOUS validation failure: the allocation is dropped,
  // the buffer reads as zeros, and nothing throws. Requesting the adapter's own
  // values can never exceed them, so this cannot fail on its own account.
  const requiredLimits: Record<string, number> = {
    maxBufferSize: adapter.limits.maxBufferSize,
    maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
  };

  try {
    let device: GPUDevice;
    try {
      device = await adapter.requestDevice({ requiredFeatures, requiredLimits });
    } catch {
      // Device acquisition is the one step that must not regress: if an
      // implementation refuses the limits for a reason of its own, take the
      // defaults rather than failing to open the viewer at all.
      device = await adapter.requestDevice({ requiredFeatures });
    }
    return { adapter, device, features: { float32Filterable } };
  } catch (cause) {
    throw new WebGPUUnsupportedError(
      `Failed to create a GPUDevice: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}
