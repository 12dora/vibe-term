// 设备页窗口内存徽标：档位阈值、提示行与「没有读数就整块不渲染」。
// 无 DOM 测试环境，渲染用 react-dom/server；未初始化 i18n 时 `t()` 原样返回 key。

import { describe, expect, test } from 'bun:test';
import type { WindowMemorySample } from '@vibeterm/stores';
import { installWindowStorage } from '@vibeterm/stores/test-utils';

installWindowStorage();

const { renderToStaticMarkup } = await import('react-dom/server');
const { appNodeRuntimes } = await import('./node-runtimes');
const { WindowMemoryBadge, windowMemoryTone, windowMemoryTooltipLines } = await import(
  './window-memory-badge'
);

const GB = 1024 * 1024 * 1024;

function sample(overrides: Partial<WindowMemorySample> = {}): WindowMemorySample {
  const now = Date.now();
  return {
    current: GB,
    high: 8 * GB,
    max: 12 * GB,
    swapMax: 0,
    oomKills: 0,
    oomFlag: false,
    panes: 2,
    sampledAt: now,
    receivedAt: now,
    source: 'cgroup',
    ...overrides,
  };
}

function render(entry: WindowMemorySample | null, windowId = '@1'): string {
  appNodeRuntimes.get('self').runtime.stores.tmux.setState({
    windowMemorySupported: entry !== null,
    windowMemory: entry ? { 'dev-1': { '@1': entry } } : {},
  });
  return renderToStaticMarkup(
    <WindowMemoryBadge nodeId="self" deviceId="dev-1" windowId={windowId} />
  );
}

describe('windowMemoryTone', () => {
  test('未设软限额时恒为 ok', () => {
    expect(windowMemoryTone(sample({ high: 0, current: 900 * GB }))).toBe('ok');
  });

  test('75 % 转黄，到达软限额转红', () => {
    expect(windowMemoryTone(sample({ current: 5.9 * GB }))).toBe('ok');
    expect(windowMemoryTone(sample({ current: 6 * GB }))).toBe('warn');
    expect(windowMemoryTone(sample({ current: 7.9 * GB }))).toBe('warn');
    expect(windowMemoryTone(sample({ current: 8 * GB }))).toBe('blocked');
  });

  test('粘性 OOM 标记压过用量：现在很闲也照样是红的', () => {
    expect(windowMemoryTone(sample({ current: 1024, oomFlag: true }))).toBe('blocked');
  });

  test('RSS 兜底的宿主没有限额可比：用量再大也是 ok', () => {
    expect(windowMemoryTone(sample({ source: 'rss', current: 900 * GB }))).toBe('ok');
    expect(windowMemoryTone(sample({ source: 'rss', current: 9 * GB, high: 8 * GB }))).toBe('ok');
  });

  // 这条路径上网关不会发 oomFlag；真发了也按红处理，不要为了「没有限额」把警报吃掉。
  test('RSS 读数上万一带了 OOM 标记，仍然是红的', () => {
    expect(windowMemoryTone(sample({ source: 'rss', oomFlag: true }))).toBe('blocked');
  });
});

describe('windowMemoryTooltipLines', () => {
  const t = (key: string, options?: Record<string, unknown>) =>
    options && 'count' in options ? `${key}:${options.count}` : key;

  test('未设限的额度写成 ∞；没发生过 OOM 就不出那一行', () => {
    expect(windowMemoryTooltipLines(t, sample())).toEqual([
      'window.memory: 1.00 GB',
      'window.memoryLimitHigh: 8.00 GB',
      'window.memoryLimitMax: 12.0 GB',
      'window.memorySwapMax: ∞',
    ]);
  });

  test('有 OOM 计数就追加一行', () => {
    const lines = windowMemoryTooltipLines(t, sample({ oomKills: 3, oomFlag: true }));
    expect(lines.at(-1)).toBe('window.memoryOom:3');
  });

  test('粘性标记还在但计数器已随 scope 重建清零：至少算一次，不写 0', () => {
    const lines = windowMemoryTooltipLines(t, sample({ oomKills: 0, oomFlag: true }));
    expect(lines.at(-1)).toBe('window.memoryOom:1');
  });

  test('RSS 兜底：限额三行换成「限不了」+ 读数来源，不写 ∞', () => {
    const lines = windowMemoryTooltipLines(t, sample({ source: 'rss', current: 2 * GB }));
    expect(lines).toEqual([
      'window.memory: 2.00 GB',
      'window.memoryLimitUnavailable',
      'window.memorySourceRss',
    ]);
    expect(lines.join('\n')).not.toContain('∞');
  });
});

describe('WindowMemoryBadge', () => {
  test('有读数时渲染字节数与档位', () => {
    const html = render(sample({ current: 1.2 * GB }));
    expect(html).toContain('data-testid="window-memory-badge"');
    expect(html).toContain('1.20 GB');
    expect(html).toContain('data-tone="ok"');
    expect(html).not.toContain('window-memory-oom-dot');
  });

  test('超过软限额的 75 % 转黄，达到软限额转红', () => {
    expect(render(sample({ current: 6.5 * GB }))).toContain('data-tone="warn"');
    expect(render(sample({ current: 9 * GB }))).toContain('data-tone="blocked"');
  });

  test('OOM 过的窗口挂红点', () => {
    const html = render(sample({ oomKills: 2, oomFlag: true }));
    expect(html).toContain('data-testid="window-memory-oom-dot"');
    expect(html).toContain('data-tone="blocked"');
  });

  test('RSS 兜底：照样显示字节数，档位恒为 ok，提示里写明来源', () => {
    const html = render(sample({ source: 'rss', current: 9 * GB, high: 8 * GB }));
    expect(html).toContain('data-testid="window-memory-badge"');
    expect(html).toContain('9.00 GB');
    expect(html).toContain('data-tone="ok"');
    expect(html).toContain('window.memoryLimitUnavailable');
    expect(html).toContain('window.memorySourceRss');
    expect(html).not.toContain('window.memoryLimitHigh');
  });

  test('没有该窗口的读数（宿主不支持 / 换了窗口）时整块不渲染', () => {
    expect(render(null)).toBe('');
    expect(render(sample(), '@9')).toBe('');
  });

  test('超过三次心跳没有新帧的陈旧读数一律不展示', () => {
    const stale = sample({ receivedAt: Date.now() - 120_000 });
    expect(render(stale)).toBe('');
  });
});
