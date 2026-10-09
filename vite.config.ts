import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

// `vite build` → library bundle in dist/ (+ .d.ts). `vite` (dev) serves index.html →
// the playground. Both use this config; the dev server ignores `build.lib`.
//
// Entries: the library (`napari-js`), its GPU-free test double (`napari-js/testing`), and
// opt-in subpaths (`overlays`, `colormaps`, `geometry`). A subpath entry must use the SAME classes as the
// library, not bundled copies, or `instanceof` fails across the two. Left alone, Rollup would
// split the modules both reach into a third, hashed chunk and turn `napari-js.js` into half a library. Instead every library module is pinned to
// the `napari-js` chunk (which holds its entry, so it stays `napari-js.js`), and
// `allow-extension` lets that chunk export the few internals the subpath entries import. The
// main bundle stays one file, and each subpath's own code is only in its own file.
const SUBPATHS = ['testing', 'overlays', 'colormaps', 'geometry'];
const isSubpathModule = (id: string): boolean =>
  SUBPATHS.some((dir) => id.includes(`/src/${dir}/`));

export default defineConfig({
  plugins: [dts({ include: ['src'], outDir: 'dist' })],
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'es2022',
    lib: {
      entry: {
        'napari-js': 'src/index.ts',
        ...Object.fromEntries(SUBPATHS.map((dir) => [dir, `src/${dir}/index.ts`])),
      },
      formats: ['es'],
      fileName: (_format, entryName) => `${entryName}.js`,
    },
    rollupOptions: {
      preserveEntrySignatures: 'allow-extension',
      output: {
        manualChunks: (id): string | undefined =>
          id.includes('/src/') && !isSubpathModule(id) ? 'napari-js' : undefined,
      },
    },
  },
});
