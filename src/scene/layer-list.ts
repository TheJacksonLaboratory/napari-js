import { Emitter } from './events';
import type { Layer } from '../layers/layer';

/** A reorder of one layer within a {@link LayerList}: where it was and where it is now. */
export interface LayerMove {
  layer: Layer;
  from: number;
  to: number;
}

/** Ordered, evented collection of layers. Index 0 is drawn first (bottom). */
export class LayerList implements Iterable<Layer> {
  private readonly _items: Layer[] = [];

  readonly added = new Emitter<Layer>();
  readonly removed = new Emitter<Layer>();
  /**
   * Fires when {@link move} reorders a layer. A reorder is NOT a remove plus an add: the layer
   * stays mounted, so `removed`/`added` stay quiet and the renderer keeps its GPU visual.
   */
  readonly moved = new Emitter<LayerMove>();
  /** Fires on any structural change (add/insert/remove/move/clear). */
  readonly changed = new Emitter<LayerList>();

  get items(): readonly Layer[] {
    return this._items;
  }

  get length(): number {
    return this._items.length;
  }

  add(layer: Layer): Layer {
    this._items.push(layer);
    this.added.emit(layer);
    this.changed.emit(this);
    return layer;
  }

  /**
   * Add `layer` at `index` instead of on top (napari's `LayerList.insert`). `index` is clamped
   * to `0..length`, so `insert(0, layer)` puts it at the bottom of the draw order and
   * `insert(length, layer)` is {@link add}. Emits `added` then `changed`, like `add`.
   *
   * Throws for a layer that is already in the list: inserting it again would mount it twice,
   * and reordering one that is mounted is what {@link move} is for.
   */
  insert(index: number, layer: Layer): Layer {
    if (this._items.includes(layer)) {
      throw new Error(`Layer "${layer.name}" is already in the list; use move() to reorder it.`);
    }
    this._items.splice(clampIndex(index, this._items.length), 0, layer);
    this.added.emit(layer);
    this.changed.emit(this);
    return layer;
  }

  /**
   * Move a mounted layer so it ends up at `index` (napari's `LayerList.move`), clamped to
   * `0..length-1`. Index 0 is the bottom of the draw order.
   *
   * This is the way to restack layers. Removing and re-adding one does reorder it, but the
   * renderer treats the remove as the end of the layer and disposes its GPU visual, so the
   * re-add uploads the whole buffer again — for a large point cloud or image, on every
   * restack. A move only changes `items`, which the renderer already draws in order, so the
   * visual and its uploaded buffers are kept. Emits {@link moved} and `changed`, never
   * `removed`/`added`.
   *
   * Returns false (and emits nothing) when the layer is not in the list or is already at
   * `index`.
   */
  move(layer: Layer, index: number): boolean {
    const from = this._items.indexOf(layer);
    if (from < 0) return false;
    const to = clampIndex(index, this._items.length - 1);
    if (to === from) return false;
    this._items.splice(from, 1);
    this._items.splice(to, 0, layer);
    this.moved.emit({ layer, from, to });
    this.changed.emit(this);
    return true;
  }

  remove(layer: Layer): boolean {
    const i = this._items.indexOf(layer);
    if (i < 0) return false;
    this._items.splice(i, 1);
    this.removed.emit(layer);
    this.changed.emit(this);
    return true;
  }

  clear(): void {
    const old = this._items.splice(0, this._items.length);
    for (const layer of old) this.removed.emit(layer);
    this.changed.emit(this);
  }

  [Symbol.iterator](): Iterator<Layer> {
    return this._items[Symbol.iterator]();
  }
}

/** Clamp a target index into `0..max`, truncating fractions. */
function clampIndex(index: number, max: number): number {
  if (Number.isNaN(index)) throw new Error('LayerList index must be a number (got NaN).');
  const i = Math.trunc(index);
  return i < 0 ? 0 : i > max ? max : i;
}
