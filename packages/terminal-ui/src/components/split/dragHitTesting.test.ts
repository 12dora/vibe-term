import { describe, expect, test } from 'bun:test';
import { parseWindowLayout } from '@tmex/shared';
import { computeSplitLayoutGeometry } from '../splitLayoutGeometry';
import {
  hasPassedDragThreshold,
  hitTestPaneDrop,
  pointWithinRect,
  resolveGutterResizeTarget,
  resolveSidebarDropTarget,
} from './dragHitTesting';

// 左右两个 pane：104x62 + 1 cell 间隙 + 103x62，整窗 208x62
const SIDE_BY_SIDE = '7d1d,208x62,0,0{104x62,0,0,0,103x62,105,0,1}';
const CONTAINER = { left: 0, top: 0, width: 2080, height: 620 };

function geometryOf(layout: string) {
  const parsed = parseWindowLayout(layout);
  if (!parsed) throw new Error(`invalid layout: ${layout}`);
  return computeSplitLayoutGeometry(parsed.root, { width: 1, height: 1 });
}

describe('pointWithinRect', () => {
  const rect = { left: 10, top: 20, width: 100, height: 50 };

  test('includes the boundary', () => {
    expect(pointWithinRect(10, 20, rect)).toBe(true);
    expect(pointWithinRect(110, 70, rect)).toBe(true);
  });

  test('excludes points outside', () => {
    expect(pointWithinRect(9.5, 40, rect)).toBe(false);
    expect(pointWithinRect(60, 70.5, rect)).toBe(false);
  });
});

describe('hitTestPaneDrop', () => {
  const geometry = geometryOf(SIDE_BY_SIDE);

  test('maps client px to layout cells and picks the quadrant nearest an edge', () => {
    // 容器左侧 5% 宽度处 → 左 pane 的最左侧 → left
    const hit = hitTestPaneDrop(
      geometry.panes,
      { x: CONTAINER.width * 0.02, y: CONTAINER.height * 0.5 },
      CONTAINER,
      208,
      62
    );
    expect(hit).toEqual({ paneId: '%0', position: 'left' });
  });

  test('resolves the right-hand pane and its top quadrant', () => {
    const hit = hitTestPaneDrop(
      geometry.panes,
      { x: CONTAINER.width * 0.75, y: CONTAINER.height * 0.02 },
      CONTAINER,
      208,
      62
    );
    expect(hit).toEqual({ paneId: '%1', position: 'top' });
  });

  test('returns null in the gutter gap between panes', () => {
    // 第 104.5 列正好落在两 pane 之间的 1 cell 间隙里
    const hit = hitTestPaneDrop(
      geometry.panes,
      { x: (104.5 / 208) * CONTAINER.width, y: CONTAINER.height * 0.5 },
      CONTAINER,
      208,
      62
    );
    expect(hit).toBeNull();
  });

  test('returns null for a degenerate container', () => {
    expect(
      hitTestPaneDrop(geometry.panes, { x: 0, y: 0 }, { ...CONTAINER, width: 0 }, 208, 62)
    ).toBeNull();
  });

  test('honours the container offset', () => {
    const offset = { left: 300, top: 100, width: 2080, height: 620 };
    const hit = hitTestPaneDrop(
      geometry.panes,
      { x: 300 + CONTAINER.width * 0.75, y: 100 + CONTAINER.height * 0.5 },
      offset,
      208,
      62
    );
    expect(hit?.paneId).toBe('%1');
  });
});

describe('resolveSidebarDropTarget', () => {
  const candidates = {
    windows: [
      { windowId: '@1', rect: { left: 0, top: 0, width: 200, height: 30 } },
      { windowId: '@2', rect: { left: 0, top: 30, width: 200, height: 30 } },
      { windowId: '@3', rect: { left: 0, top: 60, width: 0, height: 30 } },
    ],
    sidebars: [{ left: 0, top: 0, width: 200, height: 800 }],
  };

  test('a foreign window row becomes a move target', () => {
    expect(resolveSidebarDropTarget(candidates, { x: 100, y: 40 }, '@1')).toEqual({
      type: 'window',
      windowId: '@2',
      rect: { left: 0, top: 30, width: 200, height: 30 },
    });
  });

  test('the current window row is not a valid drop target', () => {
    expect(resolveSidebarDropTarget(candidates, { x: 100, y: 10 }, '@1')).toBeNull();
  });

  test('collapsed (zero-width) rows are skipped', () => {
    expect(resolveSidebarDropTarget(candidates, { x: 100, y: 70 }, '@1')).toEqual({
      type: 'break',
      rect: { left: 0, top: 0, width: 200, height: 800 },
    });
  });

  test('the rest of the sidebar breaks the pane into its own window', () => {
    expect(resolveSidebarDropTarget(candidates, { x: 100, y: 400 }, '@1')).toEqual({
      type: 'break',
      rect: { left: 0, top: 0, width: 200, height: 800 },
    });
  });

  test('outside the sidebar there is no target', () => {
    expect(resolveSidebarDropTarget(candidates, { x: 900, y: 400 }, '@1')).toBeNull();
  });

  test('returns a copy of the rect (not the candidate instance)', () => {
    const target = resolveSidebarDropTarget(candidates, { x: 100, y: 400 }, '@1');
    expect(target?.type).toBe('break');
    if (target && target.type === 'break') {
      expect(target.rect).not.toBe(candidates.sidebars[0]);
    }
  });
});

describe('hasPassedDragThreshold', () => {
  test('needs the euclidean distance to reach the threshold', () => {
    expect(hasPassedDragThreshold({ x: 0, y: 0 }, { x: 3, y: 4 }, 6)).toBe(false);
    expect(hasPassedDragThreshold({ x: 0, y: 0 }, { x: 3, y: 4 }, 5)).toBe(true);
    expect(hasPassedDragThreshold({ x: 10, y: 10 }, { x: 10, y: 4 }, 6)).toBe(true);
  });
});

describe('resolveGutterResizeTarget', () => {
  const cell = { width: 10, height: 20 };

  test('converts px delta into an absolute cell count on the x axis', () => {
    expect(
      resolveGutterResizeTarget({
        axis: 'x',
        deltaPx: 34,
        cell,
        edgePaneSize: { width: 405, height: 400 },
      })
    ).toBe(43);
  });

  test('uses cell height on the y axis', () => {
    expect(
      resolveGutterResizeTarget({
        axis: 'y',
        deltaPx: -45,
        cell,
        edgePaneSize: { width: 405, height: 400 },
      })
    ).toBe(18);
  });

  test('sub-cell movement is not committed', () => {
    expect(
      resolveGutterResizeTarget({
        axis: 'x',
        deltaPx: 4,
        cell,
        edgePaneSize: { width: 405, height: 400 },
      })
    ).toBeNull();
  });

  test('refuses to shrink a pane below two cells', () => {
    expect(
      resolveGutterResizeTarget({
        axis: 'x',
        deltaPx: -100,
        cell,
        edgePaneSize: { width: 100, height: 400 },
      })
    ).toBeNull();
  });

  test('an unusable cell size yields no target', () => {
    expect(
      resolveGutterResizeTarget({
        axis: 'x',
        deltaPx: 100,
        cell: { width: 0, height: 20 },
        edgePaneSize: { width: 405, height: 400 },
      })
    ).toBeNull();
  });
});
