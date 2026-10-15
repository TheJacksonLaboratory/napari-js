import { configDefaults, defineConfig } from 'vitest/config';

// GPU-free unit tests only (model/LUT/camera/transform math). The real-GPU tests (test/gpu,
// headless Chromium) run separately: `npm run test:gpu`, vitest.gpu.config.ts.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: [...configDefaults.exclude, 'test/gpu/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'text', 'lcov'],
      include: ['src/**/*.ts'],
      // Inline-WGSL shader files are constant strings (no logic); GPU visuals/engine require a
      // real device and are validated in the browser playground, not in unit tests.
      exclude: ['src/**/*shader*.ts'],
    },
  },
});
