// 两张表的静态渲染：列、空状态、动作按钮的可用性。
// 无 DOM 测试环境，用 react-dom/server 静态渲染（与设置页其余用例同一套做法）；
// 没有 i18next 实例时 `t` 原样返回 key，因此断言的是 key 与 testId。

import { describe, expect, test } from 'bun:test';
import { installWindowStorage } from '@tmex/stores/test-utils';
import type { ShareRow } from './share-rows';

installWindowStorage();

const { Children } = await import('react');
const { renderToStaticMarkup } = await import('react-dom/server');
const { ActiveShareMenuList, SHARE_PASSWORD_ACTIONS } = await import('./active-shares-table');
const { ActiveSharesTable } = await import('./active-shares-table');
const { ShareHistoryTable } = await import('./history-table');

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
    origin: 'https://tmex.example.com',
    url: 'https://tmex.example.com/s/sh1',
    viewers: 2,
    logBytes: 0,
    logTruncated: false,
    recordLog: true,
    ...patch,
  };
}

const deviceName = (row: ShareRow) => (row.deviceId === 'dev1' ? 'MacBook' : null);

describe('ActiveSharesTable', () => {
  test('一行一条分享，摆出在线人数、终端与地址', () => {
    const html = renderToStaticMarkup(
      <ActiveSharesTable
        showNode={false}
        shares={[record()]}
        now={NOW}
        busyRowKey={null}
        deviceName={deviceName}
        onStop={() => undefined}
        onPasswordAction={() => undefined}
      />
    );
    expect(html).toContain('data-testid="share-active-row-sh1"');
    expect(html).toContain('MacBook · build');
    expect(html).toContain('tmex.example.com');
    expect(html).toContain('data-testid="share-viewers-sh1"');
    expect(html).toContain('data-testid="share-copy-sh1"');
    expect(html).toContain('data-testid="share-stop-sh1"');
    expect(html).toContain('data-testid="share-menu-sh1"');
  });

  test('正在写入的那一行禁用终止', () => {
    const html = renderToStaticMarkup(
      <ActiveSharesTable
        showNode={false}
        shares={[record()]}
        now={NOW}
        busyRowKey="self:sh1"
        deviceName={deviceName}
        onStop={() => undefined}
        onPasswordAction={() => undefined}
      />
    );
    // 服务端渲染下禁用态就是 `disabled=""`；这一行只有终止一个按钮会被禁用。
    expect(html).toContain('disabled=""');
  });

  test('多节点时多一列节点名，行按节点点名', () => {
    const html = renderToStaticMarkup(
      <ActiveSharesTable
        showNode
        shares={[
          record(),
          record({ id: 'sh2', nodeId: 'node-b', nodeName: 'studio', deviceId: 'dev2' }),
        ]}
        now={NOW}
        busyRowKey={null}
        deviceName={deviceName}
        onStop={() => undefined}
        onPasswordAction={() => undefined}
      />
    );
    expect(html).toContain('settings.share.active.columns.node');
    expect(html).toContain('data-testid="share-node-sh1"');
    expect(html).toContain('data-testid="share-node-sh2"');
    expect(html).toContain('studio');
  });

  test('单机时不摆节点列', () => {
    const html = renderToStaticMarkup(
      <ActiveSharesTable
        showNode={false}
        shares={[record()]}
        now={NOW}
        busyRowKey={null}
        deviceName={deviceName}
        onStop={() => undefined}
        onPasswordAction={() => undefined}
      />
    );
    expect(html).not.toContain('settings.share.active.columns.node');
    expect(html).not.toContain('data-testid="share-node-sh1"');
  });

  test('忙的那一行按「节点 + 分享」定位，同名分享不会互相禁用', () => {
    const rows = [record(), record({ id: 'sh1', nodeId: 'node-b', nodeName: 'studio' })];
    const html = renderToStaticMarkup(
      <ActiveSharesTable
        showNode
        shares={rows}
        now={NOW}
        busyRowKey="node-b:sh1"
        deviceName={deviceName}
        onStop={() => undefined}
        onPasswordAction={() => undefined}
      />
    );
    // 两行同 id，只有远端那一行的终止被禁用（Base UI 的按钮同时带 data-disabled）。
    expect(html.match(/data-disabled=""/g)).toHaveLength(1);
  });

  test('空表出空状态而不是空白', () => {
    const html = renderToStaticMarkup(
      <ActiveSharesTable
        showNode={false}
        shares={[]}
        now={NOW}
        busyRowKey={null}
        deviceName={deviceName}
        onStop={() => undefined}
        onPasswordAction={() => undefined}
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
        busyRowKey={null}
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
        busyRowKey={null}
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
        busyRowKey={null}
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
        busyRowKey={null}
        deviceName={deviceName}
        onReplay={() => undefined}
        onDelete={() => undefined}
      />
    );
    expect(html).toContain('data-testid="share-history-empty"');
  });
});

// 菜单内容走 portal，SSR 什么都不输出：当普通函数调用再对元素树断言
// （同 `LocalMachineMenuList`）。
describe('ActiveShareMenuList', () => {
  type ItemProps = { 'data-testid'?: string; disabled?: boolean; onClick?: () => void };

  function renderList(busy = false) {
    const picked: string[] = [];
    const list = ActiveShareMenuList({
      busy,
      label: (action) => `label:${action}`,
      onSelect: (action) => {
        picked.push(action);
      },
    }) as React.ReactElement<{ children?: React.ReactNode }>;
    const items = Children.toArray(list.props.children) as React.ReactElement<ItemProps>[];
    return { items, picked };
  }

  test('密码三件事各一项，testId 与顺序固定', () => {
    const { items } = renderList();
    expect(items.map((item) => item.props['data-testid'])).toEqual([
      'share-row-view-password',
      'share-row-change-password',
      'share-row-copy-link-password',
    ]);
    expect(SHARE_PASSWORD_ACTIONS).toEqual(['view', 'change', 'copy-link']);
  });

  test('点哪一项就抛哪一个动作', () => {
    const { items, picked } = renderList();
    for (const item of items) item.props.onClick?.();
    expect(picked).toEqual(['view', 'change', 'copy-link']);
  });

  test('该行有写操作在途时整组禁用', () => {
    expect(renderList(true).items.every((item) => item.props.disabled)).toBe(true);
  });
});
