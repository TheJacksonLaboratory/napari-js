import { describe, it, expect } from 'vitest';
import { LruCache } from '../src/cache/lru';

describe('LruCache', () => {
  it('evicts the least-recently-used entry past capacity', () => {
    const evicted: string[] = [];
    const c = new LruCache<number>(2, (_v, k) => evicted.push(k));
    c.set('a', 1);
    c.set('b', 2);
    c.set('c', 3); // evicts 'a'
    expect(evicted).toEqual(['a']);
    expect(c.has('a')).toBe(false);
    expect(c.size).toBe(2);
  });

  it('get marks an entry most-recently-used', () => {
    const evicted: string[] = [];
    const c = new LruCache<number>(2, (_v, k) => evicted.push(k));
    c.set('a', 1);
    c.set('b', 2);
    c.get('a'); // 'a' now MRU → 'b' is oldest
    c.set('c', 3);
    expect(evicted).toEqual(['b']);
    expect(c.has('a')).toBe(true);
  });

  it('delete fires onEvict once and reports presence', () => {
    const evicted: string[] = [];
    const c = new LruCache<number>(4, (_v, k) => evicted.push(k));
    c.set('x', 9);
    expect(c.delete('x')).toBe(true);
    expect(c.delete('x')).toBe(false);
    expect(evicted).toEqual(['x']);
  });

  it('clear evicts everything', () => {
    const evicted: string[] = [];
    const c = new LruCache<number>(4, (_v, k) => evicted.push(k));
    c.set('a', 1);
    c.set('b', 2);
    c.clear();
    expect(evicted.sort()).toEqual(['a', 'b']);
    expect(c.size).toBe(0);
  });

  it('rejects a capacity below 1', () => {
    expect(() => new LruCache<number>(0)).toThrow();
  });
});

describe('LruCache key types', () => {
  it('takes non-string keys, still evicting least-recently-used', () => {
    const evicted: number[] = [];
    const c = new LruCache<string, number>(2, (_v, k) => evicted.push(k));
    c.set(1, 'a');
    c.set(2, 'b');
    c.get(1);
    c.set(3, 'c');
    expect(evicted).toEqual([2]);
    expect(c.get(1)).toBe('a');
    expect(c.has(3)).toBe(true);
  });

  it('evicts an undefined or falsy key like any other', () => {
    const evicted: Array<number | undefined> = [];
    const c = new LruCache<string, number | undefined>(1, (_v, k) => evicted.push(k));
    c.set(undefined, 'u');
    c.set(0, 'z');
    expect(evicted).toEqual([undefined]);
    expect(c.get(0)).toBe('z');
  });

  it('compares object keys by identity', () => {
    const k1 = { id: 1 };
    const c = new LruCache<number, object>(4);
    c.set(k1, 1);
    expect(c.get(k1)).toBe(1);
    expect(c.get({ id: 1 })).toBeUndefined();
  });

  it('defaults to string keys (LruCache<V> is unchanged)', () => {
    const c: LruCache<number, string> = new LruCache<number>(2);
    c.set('a', 1);
    expect(c.get('a')).toBe(1);
  });
});
