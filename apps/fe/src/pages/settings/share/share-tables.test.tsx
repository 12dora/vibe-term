// 两张表的静态渲染：列、空状态、动作按钮的可用性。
// 无 DOM 测试环境，用 react-dom/server 静态渲染（与设置页其余用例同一套做法）；
// 没有 i18next 实例时 `t` 原样返回 key，因此断言的是 key 与 testId。

import { describe, expect, test } from 'bun:test';
import type { ShareRecord } from '@tmex/shared/share';
import { installWindowStorage } from '@tmex/stores/test-utils';

installWindowStorage();

const { renderToStaticMarkup } = await import('react-dom/server');
const { ActiveSharesTable } = await import('./active-shares-table');
const { ShareHistoryTable } = await import('./history-table');

const NOW = 1_700_000_000_000;

function record(patch: Partial<ShareRecord> = {}): ShareRecord {
  return {
    id: 'sh1',
    name: 'demo share',
    deviceId: 'dev1',
    windowId: '@1',
    windowName: 'build',
    state: 'active',
    endReason: null,
    createdAt: NOW - 600_000,
    expiresAt: NOW + 3_600_000,
    endedAt: null,
    origin: 'https://tmex.example.com',
    url: 'https://tmex.example.com/s/sh1',
    viewers: 2,
    logBytes: 0,
    logTruncated: false,
    recordLog: true,
    ...patch,
  };
}

const deviceName = (id: string) => (id === 'dev1' ? 'MacBook' : null);

describe('ActiveSharesTable', () => {
  test('一行一条分享，摆出在线人数、终端与地址', () => {
    const html = renderToStaticMarkup(
      <ActiveSharesTable
        shares={[record()]}
        now={NOW}
        busyShareId={null}
        deviceName={deviceName}
        onStop={() => undefined}
      />
    );
    expect(html).toContain('data-testid="share-active-row-sh1"');
    expect(html).toContain('MacBook · build');
    expect(html).toContain('tmex.example.com');
    expect(html).toContain('data-testid="share-viewers-sh1"');
    expect(html).toContain('data-testid="share-copy-sh1"');
    expect(html).toContain('data-testid="share-stop-sh1"');
  });

  test('正在写入的那一行禁用终止', () => {
    const html = renderToStaticMarkup(
      <ActiveSharesTable
        shares={[record()]}
        now={NOW}
        busyShareId="sh1"
        deviceName={deviceName}
        onStop={() => undefined}
      />
    );
    // 服务端渲染下禁用态就是 `disabled=""`；这一行只有终止一个按钮会被禁用。
    expect(html).toContain('disabled=""');
  });

  test('空表出空状态而不是空白', () => {
    const html = renderToStaticMarkup(
      <ActiveSharesTable
        shares={[]}
        now={NOW}
        busyShareId={null}
        deviceName={deviceName}
        onStop={() => undefined}
      />
    );
    expect(html).toContain('data-testid="share-active-empty"');
    expect(html).toContain('settings.share.active.empty');
  });
});

describe('ShareHistoryTable', () => {
  const ended = record({
    state: 'ended',
    endReason: 'expired',
    endedAt: NOW - 60_000,
    expiresAt: NOW - 60_000,
    logBytes: 4096,
  });

  test('摆出结束原因与日志大小，回放可点', () => {
    const html = renderToStaticMarkup(
      <ShareHistoryTable
        shares={[ended]}
        now={NOW}
        busyShareId={null}
        deviceName={deviceName}
        onReplay={() => undefined}
        onDelete={() => undefined}
      />
    );
    expect(html).toContain('data-testid="share-history-row-sh1"');
    expect(html).toContain('settings.share.history.reason.expired');
    expect(html).toContain('data-testid="share-log-size-sh1"');
    expect(html).not.toContain('disabled=""');
  });

  test('没有日志时回放按钮禁用', () => {
    const html = renderToStaticMarkup(
      <ShareHistoryTable
        shares={[record({ state: 'ended', endReason: 'revoked', endedAt: NOW, logBytes: 0 })]}
        now={NOW}
        busyShareId={null}
        deviceName={deviceName}
        onReplay={() => undefined}
        onDelete={() => undefined}
      />
    );
    expect(html).toContain('settings.share.history.noLog');
    expect(html).toContain('disabled=""');
  });

  test('设备已删除时只出窗口名', () => {
    const html = renderToStaticMarkup(
      <ShareHistoryTable
        shares={[record({ deviceId: 'gone', state: 'ended', endReason: 'device_removed' })]}
        now={NOW}
        busyShareId={null}
        deviceName={deviceName}
        onReplay={() => undefined}
        onDelete={() => undefined}
      />
    );
    expect(html).toContain('settings.share.history.reason.deviceRemoved');
    expect(html).not.toContain('MacBook');
  });

  test('空表出空状态', () => {
    const html = renderToStaticMarkup(
      <ShareHistoryTable
        shares={[]}
        now={NOW}
        busyShareId={null}
        deviceName={deviceName}
        onReplay={() => undefined}
        onDelete={() => undefined}
      />
    );
    expect(html).toContain('data-testid="share-history-empty"');
  });
});
