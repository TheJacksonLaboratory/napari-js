import { defineConfig } from 'vitest/config';

// Real-GPU tests: the actual Viewer on a real canvas in headless Chromium (Playwright), pixels
// read back with `readDisplayedPixels`. `npm run test:gpu`; the GPU-free suite stays `npm test`.
//
// Chromium flags come from NAPARI_GPU_FLAGS (space-separated) when set. The default enables
// WebGPU on the machine's own GPU (Metal, D3D, Vulkan); CI sets NAPARI_GPU_SWIFTSHADER=1 for
// Chromium's software adapter on a runner without a GPU.
const SWIFTSHADER = [
  '--enable-unsafe-webgpu',
  '--enable-features=Vulkan',
  '--use-vulkan=swiftshader',
  '--use-webgpu-adapter=swiftshader',
  '--use-angle=swiftshader',
];
const flags = process.env.NAPARI_GPU_FLAGS
  ? process.env.NAPARI_GPU_FLAGS.split(/\s+/).filter(Boolean)
  : process.env.NAPARI_GPU_SWIFTSHADER === '1'
    ? SWIFTSHADER
    : ['--enable-unsafe-webgpu'];

export default defineConfig({
  define: {
    // With no adapter the tests skip, unless this is set (CI): then they fail.
    __NAPARI_GPU_REQUIRED__: JSON.stringify(process.env.NAPARI_GPU_REQUIRED === '1'),
  },
  test: {
    include: ['test/gpu/**/*.gpu.test.ts'],
    testTimeout: 30_000,
    browser: {
      enabled: true,
      provider: 'playwright',
      name: 'chromium',
      headless: true,
      providerOptions: {
        launch: { args: flags, channel: process.env.NAPARI_GPU_CHANNEL || 'chromium' },
        context: { deviceScaleFactor: 1, viewport: { width: 256, height: 256 } },
      },
    },
  },
});
