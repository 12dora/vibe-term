import { describe, expect, test } from 'bun:test';
import {
  type PathRect,
  clampPoint,
  edgeScrollDelta,
  exceedsThreshold,
  hitPaths,
  intersects,
  rectFromPoints,
} from './marquee';

function row(path: string, top: number, height = 30): PathRect {
  return { path, rect: { left: 0, top, right: 400, bottom: top + height } };
}

describe('rectFromPoints', () => {
  test('normalises any drag direction', () => {
    const expected = { left: 10, top: 20, right: 110, bottom: 220 };
    expect(rectFromPoints({ x: 10, y: 20 }, { x: 110, y: 220 })).toEqual(expected);
    expect(rectFromPoints({ x: 110, y: 220 }, { x: 10, y: 20 })).toEqual(expected);
    expect(rectFromPoints({ x: 110, y: 20 }, { x: 10, y: 220 })).toEqual(expected);
  });

  test('a single point gives an empty rect', () => {
    expect(rectFromPoints({ x: 5, y: 5 }, { x: 5, y: 5 })).toEqual({
      left: 5,
      top: 5,
      right: 5,
      bottom: 5,
    });
  });
});

describe('intersects', () => {
  const base = { left: 0, top: 0, right: 100, bottom: 100 };

  test('overlap and containment', () => {
    expect(intersects(base, { left: 50, top: 50, right: 150, bottom: 150 })).toBe(true);
    expect(intersects(base, { left: 10, top: 10, right: 20, bottom: 20 })).toBe(true);
    expect(intersects({ left: 10, top: 10, right: 20, bottom: 20 }, base)).toBe(true);
  });

  test('disjoint or merely touching rects do not intersect', () => {
    expect(intersects(base, { left: 200, top: 0, right: 300, bottom: 100 })).toBe(false);
    expect(intersects(base, { left: 0, top: 200, right: 100, bottom: 300 })).toBe(false);
    expect(intersects(base, { left: 100, top: 0, right: 200, bottom: 100 })).toBe(false);
    expect(intersects(base, { left: 0, top: 100, right: 100, bottom: 200 })).toBe(false);
  });
});

describe('hitPaths', () => {
  const rows = [row('/a', 0), row('/b', 30), row('/c', 60), row('/d', 90)];

  test('collects the rows crossed by the marquee in row order', () => {
    const hit = hitPaths(rows, { left: 50, top: 40, right: 60, bottom: 75 });
    expect([...hit]).toEqual(['/b', '/c']);
  });

  test('nothing hit outside the rows', () => {
    expect(hitPaths(rows, { left: 50, top: 200, right: 60, bottom: 300 }).size).toBe(0);
    expect(hitPaths(rows, { left: 500, top: 0, right: 600, bottom: 300 }).size).toBe(0);
    expect(hitPaths([], { left: 0, top: 0, right: 10, bottom: 10 }).size).toBe(0);
  });

  test('grid tiles are hit only when both axes overlap', () => {
    const tiles: PathRect[] = [
      { path: '/1', rect: { left: 0, top: 0, right: 100, bottom: 96 } },
      { path: '/2', rect: { left: 104, top: 0, right: 204, bottom: 96 } },
      { path: '/3', rect: { left: 0, top: 100, right: 100, bottom: 196 } },
    ];
    expect([...hitPaths(tiles, { left: 120, top: 10, right: 180, bottom: 150 })]).toEqual(['/2']);
    expect([...hitPaths(tiles, { left: 50, top: 50, right: 150, bottom: 150 })]).toEqual([
      '/1',
      '/2',
      '/3',
    ]);
  });
});

describe('exceedsThreshold', () => {
  test('needs 4px on either axis by default', () => {
    expect(exceedsThreshold({ x: 0, y: 0 }, { x: 3, y: 3 })).toBe(false);
    expect(exceedsThreshold({ x: 0, y: 0 }, { x: 4, y: 0 })).toBe(true);
    expect(exceedsThreshold({ x: 0, y: 0 }, { x: 0, y: -4 })).toBe(true);
    expect(exceedsThreshold({ x: 0, y: 0 }, { x: 6, y: 0 }, 8)).toBe(false);
  });
});

describe('clampPoint', () => {
  test('keeps the point inside the content box', () => {
    expect(clampPoint({ x: -5, y: 900 }, 300, 600)).toEqual({ x: 0, y: 600 });
    expect(clampPoint({ x: 120, y: 80 }, 300, 600)).toEqual({ x: 120, y: 80 });
  });
});

describe('edgeScrollDelta', () => {
  test('no scrolling away from the edges', () => {
    expect(edgeScrollDelta(300, 100, 500)).toBe(0);
    expect(edgeScrollDelta(124, 100, 500)).toBe(0);
    expect(edgeScrollDelta(476, 100, 500)).toBe(0);
  });

  test('scrolls up near the top and down near the bottom, faster when closer', () => {
    const slowUp = edgeScrollDelta(120, 100, 500);
    const fastUp = edgeScrollDelta(102, 100, 500);
    expect(slowUp).toBeLessThan(0);
    expect(fastUp).toBeLessThan(slowUp);
    const slowDown = edgeScrollDelta(480, 100, 500);
    const fastDown = edgeScrollDelta(498, 100, 500);
    expect(slowDown).toBeGreaterThan(0);
    expect(fastDown).toBeGreaterThan(slowDown);
  });

  test('speed is capped once the pointer is past the edge', () => {
    expect(edgeScrollDelta(-400, 100, 500)).toBe(-18);
    expect(edgeScrollDelta(4000, 100, 500)).toBe(18);
    expect(edgeScrollDelta(4000, 100, 500, 24, 10)).toBe(10);
  });
});
