import { describe, expect, it } from 'bun:test';
import {
  SIDEBAR_WIDTH_DEFAULT_PX,
  SIDEBAR_WIDTH_MAX_RESERVE_PX,
  SIDEBAR_WIDTH_MIN_PX,
} from './constants';
import {
  clampSidebarWidth,
  parseStoredSidebarWidth,
  preferredSidebarWidth,
  resizedSidebarWidth,
  sidebarMaxWidth,
} from './width';

describe('sidebarMaxWidth', () => {
  it('视口足够宽时预留固定空间给主内容区', () => {
    expect(sidebarMaxWidth(1600)).toBe(1600 - SIDEBAR_WIDTH_MAX_RESERVE_PX);
  });

  it('视口过窄时不低于下限', () => {
    expect(sidebarMaxWidth(600)).toBe(SIDEBAR_WIDTH_MIN_PX);
    expect(sidebarMaxWidth(0)).toBe(SIDEBAR_WIDTH_MIN_PX);
  });

  it('SSR 场景（视口为 Infinity）不设上限', () => {
    expect(sidebarMaxWidth(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('preferredSidebarWidth', () => {
  it('取整并夹到下限', () => {
    expect(preferredSidebarWidth(500.4)).toBe(500);
    expect(preferredSidebarWidth(500.5)).toBe(501);
    expect(preferredSidebarWidth(10)).toBe(SIDEBAR_WIDTH_MIN_PX);
    expect(preferredSidebarWidth(-999)).toBe(SIDEBAR_WIDTH_MIN_PX);
  });
});

describe('clampSidebarWidth', () => {
  it('位于区间内时只做取整', () => {
    expect(clampSidebarWidth(640.2, 1600)).toBe(640);
  });

  it('超过视口上限时被裁剪', () => {
    expect(clampSidebarWidth(5000, 1600)).toBe(1600 - SIDEBAR_WIDTH_MAX_RESERVE_PX);
  });

  it('低于下限时被抬到下限', () => {
    expect(clampSidebarWidth(100, 1600)).toBe(SIDEBAR_WIDTH_MIN_PX);
  });

  it('窄视口下上下限冲突时下限优先', () => {
    expect(clampSidebarWidth(1000, 500)).toBe(SIDEBAR_WIDTH_MIN_PX);
    expect(clampSidebarWidth(100, 500)).toBe(SIDEBAR_WIDTH_MIN_PX);
  });

  it('SSR 场景不裁剪期望宽度', () => {
    expect(clampSidebarWidth(1200, Number.POSITIVE_INFINITY)).toBe(1200);
  });
});

describe('parseStoredSidebarWidth', () => {
  it('缺失或非法值回落到默认宽度', () => {
    expect(parseStoredSidebarWidth(null)).toBe(SIDEBAR_WIDTH_DEFAULT_PX);
    expect(parseStoredSidebarWidth('')).toBe(SIDEBAR_WIDTH_DEFAULT_PX);
    expect(parseStoredSidebarWidth('abc')).toBe(SIDEBAR_WIDTH_DEFAULT_PX);
    expect(parseStoredSidebarWidth('0')).toBe(SIDEBAR_WIDTH_DEFAULT_PX);
    expect(parseStoredSidebarWidth('-500')).toBe(SIDEBAR_WIDTH_DEFAULT_PX);
    expect(parseStoredSidebarWidth('Infinity')).toBe(SIDEBAR_WIDTH_DEFAULT_PX);
  });

  it('合法值取整并夹到下限，但不受视口裁剪', () => {
    expect(parseStoredSidebarWidth('640.6')).toBe(641);
    expect(parseStoredSidebarWidth('10')).toBe(SIDEBAR_WIDTH_MIN_PX);
    expect(parseStoredSidebarWidth('4000')).toBe(4000);
  });
});

describe('resizedSidebarWidth', () => {
  it('左侧栏向右拖拽变宽', () => {
    expect(resizedSidebarWidth(400, 80, 'left')).toBe(480);
    expect(resizedSidebarWidth(400, -80, 'left')).toBe(320);
  });

  it('右侧栏方向相反', () => {
    expect(resizedSidebarWidth(400, 80, 'right')).toBe(320);
    expect(resizedSidebarWidth(400, -80, 'right')).toBe(480);
  });
});
