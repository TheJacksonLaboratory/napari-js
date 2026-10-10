/**
 * Bounded least-recently-used cache. Insertion/`get` mark an entry most-recently-used; when
 * size exceeds `capacity` the oldest entries are evicted via `onEvict` (used to destroy GPU
 * textures). Relies on `Map` preserving insertion order.
 *
 * Keys are strings by default; pass `K` for any other key (`LruCache<V, number>`), compared as
 * `Map` compares them (SameValueZero — objects by identity). `V` comes first so existing
 * `LruCache<V>` uses keep their string keys.
 */
export class LruCache<V, K = string> {
  private readonly map = new Map<K, V>();

  constructor(
    private readonly capacity: number,
    private readonly onEvict?: (value: V, key: K) => void,
  ) {
    if (capacity < 1) throw new Error('LruCache capacity must be >= 1.');
  }

  get size(): number {
    return this.map.size;
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  /** Get a value and mark it most-recently-used. */
  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  /** Insert/update a value (most-recently-used), evicting the oldest beyond capacity. */
  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.capacity) {
      const next = this.map.keys().next();
      if (next.done) break;
      const oldest = next.value;
      const evicted = this.map.get(oldest)!;
      this.map.delete(oldest);
      this.onEvict?.(evicted, oldest);
    }
  }

  delete(key: K): boolean {
    const value = this.map.get(key);
    if (value === undefined) return false;
    this.map.delete(key);
    this.onEvict?.(value, key);
    return true;
  }

  clear(): void {
    for (const [key, value] of this.map) this.onEvict?.(value, key);
    this.map.clear();
  }
}
