import { describe, it, expect } from 'vitest';
import { LayerList } from '../src/scene/layer-list';
import { PointsLayer } from '../src/layers/points-layer';

const mk = (name: string): PointsLayer => new PointsLayer([[0, 0]], { name });

describe('LayerList', () => {
  it('adds layers, tracks length and order, and is iterable', () => {
    const list = new LayerList();
    const a = list.add(mk('a'));
    const b = list.add(mk('b'));
    expect(list.length).toBe(2);
    expect([...list]).toEqual([a, b]);
    expect(list.items[0]).toBe(a);
  });

  it('fires added/removed/changed events', () => {
    const list = new LayerList();
    let added = 0;
    let removed = 0;
    let changed = 0;
    list.added.connect(() => added++);
    list.removed.connect(() => removed++);
    list.changed.connect(() => changed++);
    const a = list.add(mk('a'));
    list.remove(a);
    expect(added).toBe(1);
    expect(removed).toBe(1);
    expect(changed).toBe(2); // add + remove
  });

  it('remove returns false for a layer not in the list', () => {
    const list = new LayerList();
    expect(list.remove(mk('ghost'))).toBe(false);
  });

  it('clear empties the list and emits removed for each', () => {
    const list = new LayerList();
    list.add(mk('a'));
    list.add(mk('b'));
    let removed = 0;
    list.removed.connect(() => removed++);
    list.clear();
    expect(list.length).toBe(0);
    expect(removed).toBe(2);
  });
});

describe('LayerList reorder (move / insert)', () => {
  const names = (list: LayerList): string[] => list.items.map((l) => l.name);

  const three = (): { list: LayerList; a: PointsLayer; b: PointsLayer; c: PointsLayer } => {
    const list = new LayerList();
    const a = list.add(mk('a')) as PointsLayer;
    const b = list.add(mk('b')) as PointsLayer;
    const c = list.add(mk('c')) as PointsLayer;
    return { list, a, b, c };
  };

  it('move puts the layer at the target index (final position)', () => {
    const { list, a, c } = three();
    expect(list.move(a, 2)).toBe(true);
    expect(names(list)).toEqual(['b', 'c', 'a']);
    expect(list.move(c, 0)).toBe(true);
    expect(names(list)).toEqual(['c', 'b', 'a']);
  });

  it('move emits moved + changed and never removed/added', () => {
    const { list, b } = three();
    const log: string[] = [];
    list.added.connect(() => log.push('added'));
    list.removed.connect(() => log.push('removed'));
    list.changed.connect(() => log.push('changed'));
    const moves: { from: number; to: number; name: string }[] = [];
    list.moved.connect((m) => moves.push({ from: m.from, to: m.to, name: m.layer.name }));
    list.move(b, 0);
    expect(log).toEqual(['changed']);
    expect(moves).toEqual([{ from: 1, to: 0, name: 'b' }]);
    // The list is already in its final order when listeners run.
    expect(names(list)).toEqual(['b', 'a', 'c']);
  });

  it('move clamps the index and is a silent no-op for the same slot or a stranger', () => {
    const { list, a, c } = three();
    let changed = 0;
    list.changed.connect(() => changed++);
    expect(list.move(a, 99)).toBe(true);
    expect(names(list)).toEqual(['b', 'c', 'a']);
    expect(list.move(c, -5)).toBe(true);
    expect(names(list)).toEqual(['c', 'b', 'a']);
    expect(list.move(c, 0)).toBe(false); // already there
    expect(list.move(mk('ghost'), 0)).toBe(false);
    expect(changed).toBe(2);
    expect(() => list.move(a, NaN)).toThrow(/NaN/);
  });

  it('insert adds at the index, clamped, and emits added + changed', () => {
    const { list } = three();
    const log: string[] = [];
    list.added.connect((l) => log.push(`added:${l.name}`));
    list.changed.connect(() => log.push('changed'));
    list.insert(1, mk('x'));
    list.insert(-3, mk('bottom'));
    list.insert(100, mk('top'));
    expect(names(list)).toEqual(['bottom', 'a', 'x', 'b', 'c', 'top']);
    expect(log).toEqual(['added:x', 'changed', 'added:bottom', 'changed', 'added:top', 'changed']);
  });

  it('add refuses a layer that is already mounted, like insert, and emits nothing', () => {
    const { list, b } = three();
    let events = 0;
    list.added.connect(() => events++);
    list.changed.connect(() => events++);
    expect(() => list.add(b)).toThrow(/already in the list; use move\(\)/);
    expect(names(list)).toEqual(['a', 'b', 'c']);
    expect(events).toBe(0);
  });

  it('insert refuses a layer that is already mounted', () => {
    const { list, b } = three();
    expect(() => list.insert(0, b)).toThrow(/already in the list; use move\(\)/);
    expect(names(list)).toEqual(['a', 'b', 'c']);
  });
});
