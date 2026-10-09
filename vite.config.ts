import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

// `vite build` → library bundle in dist/ (+ .d.ts). `vite` (dev) serves index.html →
// the playground. Both use this config; the dev server ignores `build.lib`.
//
// Two entries: the library (`napari-js`) and its GPU-free test double (`napari-js/testing`).
// The testing entry must re-export the SAME classes, not bundled copies, or `instanceof` fails
// across the two. Left alone, Rollup would split the modules both reach into a third, hashed
// chunk and turn `napari-js.js` into half a library. Instead every library module is pinned to
// the `napari-js` chunk (which holds its entry, so it stays `napari-js.js`), and
// `allow-extension` lets that chunk export the few internals the testing entry imports. The
// main bundle stays one file, and the test double is only in `testing.js`.
export default defineConfig({
  plugins: [dts({ include: ['src'], outDir: 'dist' })],
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'es2022',
    lib: {
      entry: { 'napari-js': 'src/index.ts', testing: 'src/testing/index.ts' },
      formats: ['es'],
      fileName: (_format, entryName) => `${entryName}.js`,
    },
    rollupOptions: {
      preserveEntrySignatures: 'allow-extension',
      output: {
        manualChunks: (id): string | undefined =>
          id.includes('/src/') && !id.includes('/src/testing/') ? 'napari-js' : undefined,
      },
    },
  },
});
