// 窄屏（sm 以下）的分享记录卡：两张表各换成一列卡片，testid 与宽表一一对应。
// 无 DOM 测试环境，用 react-dom/server 静态渲染；直接渲染卡片列表，不桩 matchMedia。

import { describe, expect, test } from 'bun:test';
import { installWindowStorage } from '@vibeterm/stores/test-utils';
import type { ShareRow } from './share-rows';

installWindowStorage();

const { renderToStaticMarkup } = await import('react-dom/server');
const { ActiveSharesCardList, ShareHistoryCardList } = await import('./share-card-lists');

const NOW = 1_700_000_000_000;

function record(patch: Partial<ShareRow> = {}): ShareRow {
  return {
    nodeId: 'self',
    nodeName: '本机',
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
    origin: 'https://vibeterm.example.com',
    url: 'https://vibeterm.example.com/s/sh1',
    viewers: 2,
    logBytes: 0,
    logTruncated: false,
    recordLog: true,
    ...patch,
  };
}

function active(shares: ShareRow[], showNode = false): string {
  return renderToStaticMarkup(
    <ActiveSharesCardList
      shares={shares}
      now={NOW}
      busyRowKey={null}
      showNode={showNode}
      deviceName={() => 'MacBook'}
      onStop={() => undefined}
      onPasswordAction={() => undefined}
    />
  );
}

function history(shares: ShareRow[]): string {
  return renderToStaticMarkup(
    <ShareHistoryCardList
      shares={shares}
      now={NOW}
      busyRowKey={null}
      deviceName={() => 'MacBook'}
      onReplay={() => undefined}
      onDelete={() => undefined}
    />
  );
}

describe('窄屏分享记录卡', () => {
  test('进行中：复制链接 / 终止 / ⋯ 都在，容器 testid 不变', () => {
    const html = active([record()]);
    expect(html).not.toContain('<table');
    expect(html).toContain('data-testid="share-active-table"');
    expect(html).toContain('data-testid="share-active-row-sh1"');
    expect(html).toContain('data-testid="share-copy-sh1"');
    expect(html).toContain('data-testid="share-stop-sh1"');
    expect(html).toContain('data-testid="share-menu-sh1"');
    expect(html).toContain('data-testid="share-viewers-sh1"');
  });

  test('多节点时才点名是哪台', () => {
    expect(active([record()], true)).toContain('data-testid="share-node-sh1"');
    expect(active([record()])).not.toContain('data-testid="share-node-sh1"');
  });

  test('历史：回放没日志时禁用，删除可点', () => {
    const html = history([record({ state: 'ended', endReason: 'expired', endedAt: NOW })]);
    expect(html).toContain('data-testid="share-history-row-sh1"');
    expect(html).toContain('data-testid="share-log-size-sh1"');
    expect(html).toContain('disabled=""');
    expect(html).toContain('data-testid="share-delete-sh1"');
  });

  test('两张表的空态各自保留 testid', () => {
    expect(active([])).toContain('data-testid="share-active-empty"');
    expect(history([])).toContain('data-testid="share-history-empty"');
  });
});
