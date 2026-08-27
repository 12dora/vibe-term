import { describe, expect, test } from 'bun:test';
import {
  buildPaneLocationLabel as buildLabelRaw,
  formatTerminalNotificationToast as formatToastRaw,
} from './notification-format';

const t = (key: string, params?: Record<string, unknown>) => {
  if (!params || Object.keys(params).length === 0) return key;
  const values = Object.values(params).join(', ');
  return `${key}[${values}]`;
};

const buildPaneLocationLabel = (data: Record<string, unknown>) => buildLabelRaw(data, t);
const formatTerminalNotificationToast = (data: Record<string, unknown>) => formatToastRaw(data, t);

describe('buildPaneLocationLabel', () => {
  test('uses paneTitle when available', () => {
    const label = buildPaneLocationLabel({
      windowIndex: 0,
      paneIndex: 1,
      paneTitle: 'build monitor',
      paneCurrentCommand: 'make',
    });
    expect(label).toContain('build monitor');
    expect(label).toContain('0');
  });

  test('uses paneCurrentCommand as fallback when paneTitle is absent', () => {
    const label = buildPaneLocationLabel({
      windowIndex: 2,
      paneIndex: 0,
      paneCurrentCommand: 'vim',
    });
    expect(label).toContain('vim');
    expect(label).toContain('2');
  });

  test('falls back to pane index when no title or command', () => {
    const label = buildPaneLocationLabel({
      windowIndex: 1,
      paneIndex: 3,
    });
    expect(label).toContain('3');
    expect(label).toContain('1');
  });

  test('returns empty string when no data', () => {
    const label = buildPaneLocationLabel({});
    expect(label).toBe('');
  });
});

// 位置标签的分支矩阵已由 buildPaneLocationLabel 覆盖，这里只验证 wrapper 的组合与回退
describe('formatTerminalNotificationToast', () => {
  test('composes title, pane location and body', () => {
    const result = formatTerminalNotificationToast({
      title: 'Build finished',
      body: 'All tests passed',
      source: 'osc777',
      windowIndex: 7,
      paneIndex: 3,
    });

    expect(result.title).toBe('Build finished');
    expect(result.description).toContain('7');
    expect(result.description).toContain('3');
    expect(result.description).toContain('All tests passed');
  });

  test('uses fallback title when title is missing', () => {
    const result = formatTerminalNotificationToast({
      body: 'Alert',
    });

    expect(result.title).toBe('terminal.notificationFallbackTitle');
    expect(result.description).toBe('Alert');
  });

  test('uses source fallback when body is empty', () => {
    const result = formatTerminalNotificationToast({
      source: 'osc777',
    });

    expect(result.description).toContain('osc777');
  });

  test('uses fallback detail when both body and source are missing', () => {
    const result = formatTerminalNotificationToast({});

    expect(result.title).toBe('terminal.notificationFallbackTitle');
    expect(result.description).toBe('terminal.notificationFallbackDetail');
  });
});
