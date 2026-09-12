import { describe, expect, test } from 'bun:test';
import { placeSelectionToolbar } from './selection-anchor';

const TOOLBAR = { width: 160, height: 40 };
const CONTAINER = { left: 10, top: 20, width: 400, height: 300 };

describe('placeSelectionToolbar', () => {
  test('上方空间足够时放在选区之上并水平居中', () => {
    const placed = placeSelectionToolbar({
      selection: { left: 110, top: 120, width: 80, height: 20 },
      container: CONTAINER,
      toolbar: TOOLBAR,
      gap: 8,
    });
    expect(placed.placement).toBe('above');
    expect(placed.top).toBe(52);
    expect(placed.left).toBe(60);
  });

  test('上方空间不够时改放到选区下方', () => {
    const placed = placeSelectionToolbar({
      selection: { left: 110, top: 30, width: 80, height: 20 },
      container: CONTAINER,
      toolbar: TOOLBAR,
      gap: 8,
    });
    expect(placed.placement).toBe('below');
    expect(placed.top).toBe(38);
    expect(placed.left).toBe(60);
  });

  test('水平方向夹在容器内 8px 边距', () => {
    const leftClamp = placeSelectionToolbar({
      selection: { left: 12, top: 120, width: 10, height: 20 },
      container: CONTAINER,
      toolbar: TOOLBAR,
      gap: 8,
    });
    expect(leftClamp.left).toBe(8);

    const rightClamp = placeSelectionToolbar({
      selection: { left: 390, top: 120, width: 10, height: 20 },
      container: CONTAINER,
      toolbar: TOOLBAR,
      gap: 8,
    });
    expect(rightClamp.left).toBe(232);
  });
});
