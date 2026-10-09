// `napari-js/colormaps`: matplotlib's colormaps as exact 256-entry RGB tables, one
// tree-shakeable `Uint8Array(768)` export per map (`VIRIDIS_LUT`, `TURBO_LUT`, …), plus
// `lutColormap` to turn one into a napari-js `Colormap`. Provenance and licences: ./luts.ts.
export * from './luts';
export { COLORMAP_LUTS } from './registry';
export { lutColormap } from '../color/colormap';

import { COLORMAP_LUTS } from './registry';
import { lutColormap } from '../color/colormap';
import type { Colormap } from '../color/colormap';

/**
 * A matplotlib colormap by name (case-insensitive, e.g. `'turbo'`, `'RdBu'`), or null when
 * unknown. Uses {@link COLORMAP_LUTS}, so it keeps every map in the bundle.
 */
export function matplotlibColormap(name: string): Colormap | null {
  const key = name.toLowerCase();
  const lut = COLORMAP_LUTS[key];
  return lut ? lutColormap(key, lut) : null;
}
