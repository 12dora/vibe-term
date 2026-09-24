import { describe, expect, test } from 'bun:test';
import type { SessionsMemoryResponse, SessionsMemoryWindow } from '@vibeterm/api-client';
import { WINDOW_MEMORY_SETTINGS_DEFAULTS } from '@vibeterm/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  MemoryLimitsReleaseNotice,
  memoryLimitsReleaseLines,
  memoryLimitsReleaseReport,
} from './memory-limits-release';

const NOW = Date.UTC(2026, 8, 24, 12);
const DAY_MS = 86_400_000;
const GB = 1024 ** 3;
const UNLIMITED = { ...WINDOW_MEMORY_SETTINGS_DEFAULTS, enabled: false };

function win(
  overrides: Partial<SessionsMemoryWindow> & { windowId: string }
): SessionsMemoryWindow {
  return {
    windowName: overrides.windowId,
    scopes: [],
    current: GB,
    high: 8 * GB,
    max: 12 * GB,
    swapMax: 4 * GB,
    oomKills: 0,
    oomFlag: false,
    panes: 1,
    sampledAt: NOW - 1_000,
    source: 'cgroup',
    ...overrides,
  };
}

function response(windows: SessionsMemoryWindow[], connected = true): SessionsMemoryResponse {
  return {
    devices: [
      {
        deviceId: 'd1',
        deviceName: 'jiefa-app',
        connected,
        supported: true,
        limitsSupported: true,
        windows,
      },
    ],
  };
}

describe('memoryLimitsReleaseReport', () => {
  test('设置仍是自定义限额：窗口带限额是正常的，不提示', () => {
    expect(
      memoryLimitsReleaseReport(
        response([win({ windowId: '@1' })]),
        WINDOW_MEMORY_SETTINGS_DEFAULTS,
        NOW
      )
    ).toBeNull();
  });

  test('没有读数或没有打开时的记录：不提示', () => {
    expect(memoryLimitsReleaseReport(null, UNLIMITED, NOW)).toBeNull();
    expect(memoryLimitsReleaseReport(response([win({ windowId: '@1' })]), null, NOW)).toBeNull();
  });

  test('几天前的旧读数（线上 jiefa-app 的情形）：只说读数过期，不说「仍带限额」', () => {
    const report = memoryLimitsReleaseReport(
      response([win({ windowId: '@1', sampledAt: NOW - 4 * DAY_MS })]),
      UNLIMITED,
      NOW
    );
    expect(report).toEqual({
      lingering: [],
      stale: { count: 1, oldestSampledAt: NOW - 4 * DAY_MS },
    });
  });

  test('新鲜读数仍带限额：点名窗口', () => {
    const report = memoryLimitsReleaseReport(
      response([
        win({ windowId: '@1', windowName: 'vim' }),
        win({ windowId: '@2', high: 0, max: 0, swapMax: 0 }),
      ]),
      UNLIMITED,
      NOW
    );
    expect(report).toEqual({ lingering: ['jiefa-app / vim'], stale: null });
  });

  test('三项全 0 也算不限制', () => {
    const report = memoryLimitsReleaseReport(
      response([win({ windowId: '@1' })]),
      { ...WINDOW_MEMORY_SETTINGS_DEFAULTS, memoryHighMb: 0, memoryMaxMb: 0, memorySwapMaxMb: 0 },
      NOW
    );
    expect(report?.lingering).toEqual(['jiefa-app / @1']);
  });

  test('网关标了 stale、或设备已断开：新时间戳也按过期处理；RSS 读数没有限额可言', () => {
    const marked = { ...win({ windowId: '@1' }), stale: true } as SessionsMemoryWindow;
    expect(memoryLimitsReleaseReport(response([marked]), UNLIMITED, NOW)?.stale?.count).toBe(1);
    expect(
      memoryLimitsReleaseReport(response([win({ windowId: '@1' })], false), UNLIMITED, NOW)?.stale
        ?.count
    ).toBe(1);
    expect(
      memoryLimitsReleaseReport(response([win({ windowId: '@1', source: 'rss' })]), UNLIMITED, NOW)
    ).toBeNull();
  });
});

describe('memoryLimitsReleaseReport：网关给的 stale / sampledAgeMs', () => {
  const zeros = { high: 0, max: 0, swapMax: 0 };

  test('标了 stale 的窗口即便限额被清成 0 也算「确认不了」，不当成已放开', () => {
    const marked = { ...win({ windowId: '@1', ...zeros }), stale: true } as SessionsMemoryWindow;
    expect(memoryLimitsReleaseReport(response([marked]), UNLIMITED, NOW)).toEqual({
      lingering: [],
      stale: { count: 1, oldestSampledAt: NOW - 1_000 },
    });
  });

  test('标了 stale 的窗口保留着真实限额：同样只说确认不了，不点名为「仍带限额」', () => {
    const marked = { ...win({ windowId: '@1' }), stale: true } as SessionsMemoryWindow;
    const report = memoryLimitsReleaseReport(response([marked]), UNLIMITED, NOW);
    expect(report?.lingering).toEqual([]);
    expect(report?.stale?.count).toBe(1);
  });

  test('节点时钟慢了一小时：按网关给的读数年龄判，新读数照样算新鲜', () => {
    const skewed = {
      ...win({ windowId: '@1', windowName: 'vim', sampledAt: NOW - 3_600_000 }),
      sampledAgeMs: 2_000,
    } as SessionsMemoryWindow;
    expect(memoryLimitsReleaseReport(response([skewed]), UNLIMITED, NOW)).toEqual({
      lingering: ['jiefa-app / vim'],
      stale: null,
    });
  });

  test('节点时钟快了几天：读数年龄说旧就是旧，采样时刻按年龄折算到浏览器时钟', () => {
    const old = {
      ...win({ windowId: '@1', sampledAt: NOW + 5 * DAY_MS }),
      sampledAgeMs: 2 * DAY_MS,
    } as SessionsMemoryWindow;
    expect(memoryLimitsReleaseReport(response([old]), UNLIMITED, NOW)).toEqual({
      lingering: [],
      stale: { count: 1, oldestSampledAt: NOW - 2 * DAY_MS },
    });
  });

  test('读数未过期且三项都是 0：确实已放开，不提示', () => {
    const released = { ...win({ windowId: '@1', ...zeros }), sampledAgeMs: 1_000 };
    expect(
      memoryLimitsReleaseReport(response([released as SessionsMemoryWindow]), UNLIMITED, NOW)
    ).toBeNull();
  });
});

describe('memoryLimitsReleaseLines', () => {
  const t = (key: string, options?: Record<string, unknown>) =>
    options ? `${key}:${JSON.stringify(options)}` : key;

  test('窗口最多点名 5 个，采样时刻按相对时间说', () => {
    const names = ['a', 'b', 'c', 'd', 'e', 'f'];
    const lines = memoryLimitsReleaseLines(
      t,
      { lingering: names, stale: { count: 1, oldestSampledAt: NOW - 3 * DAY_MS } },
      NOW
    );
    expect(lines.lingering).toBe(
      'settings.nodes.memory.notReleased:{"count":6,"windows":"a、b、c、d、e…"}'
    );
    expect(lines.stale).toContain('settings.share.time.daysAgo:{\\"n\\":3}');
  });

  test('只有一类时另一行为 null', () => {
    expect(memoryLimitsReleaseLines(t, { lingering: [], stale: null }, NOW)).toEqual({
      lingering: null,
      stale: null,
    });
  });
});

describe('MemoryLimitsReleaseNotice', () => {
  test('没有报告就什么都不渲染', () => {
    expect(
      renderToStaticMarkup(<MemoryLimitsReleaseNotice report={null} now={NOW} testId="x" />)
    ).toBe('');
  });
});
