// 升级确认框的文案路由：行内（本机 / 远端）、批量、latest 未知时的兜底。
// Base UI 的对话框走 portal 且实现按需到货，静态渲染什么都不输出，只能对这份路由断言。

import { describe, expect, test } from 'bun:test';
import type { NodeRow } from '@/node/mesh-nodes';
import type { NodeUpgradePending } from './types';
import { upgradeConfirmCopy } from './upgrade-confirm-dialog';

const t = (key: string, options?: Record<string, unknown>) =>
  options ? `${key}:${JSON.stringify(options)}` : key;

function row(overrides: Partial<NodeRow> & { id: string; name: string }): NodeRow {
  return { isSelf: false, ...overrides } as NodeRow;
}

describe('upgradeConfirmCopy', () => {
  test('本机：标题带名字，正文说服务重启', () => {
    const pending: NodeUpgradePending = {
      kind: 'row',
      row: row({ id: 'self', name: '本机', isSelf: true }),
      version: '1.2.0',
    };
    const copy = upgradeConfirmCopy(pending, t);
    expect(copy.title).toBe('nodes.upgrade.confirmTitleOne:{"name":"本机"}');
    expect(copy.body).toBe('nodes.upgrade.confirmSelf:{"version":"1.2.0"}');
    expect(copy.targets).toEqual([]);
  });

  test('远端节点：正文带节点名与目标版本', () => {
    const pending: NodeUpgradePending = {
      kind: 'row',
      row: row({ id: 'n1', name: 'studio' }),
      version: '1.2.0',
    };
    const copy = upgradeConfirmCopy(pending, t);
    expect(copy.title).toBe('nodes.upgrade.confirmTitleOne:{"name":"studio"}');
    expect(copy.body).toBe('nodes.upgrade.confirmRemote:{"name":"studio","version":"1.2.0"}');
  });

  test('latest 还没回来：目标版本落到「最新版本」这一句上', () => {
    const pending: NodeUpgradePending = {
      kind: 'row',
      row: row({ id: 'n1', name: 'studio' }),
      version: null,
    };
    const copy = upgradeConfirmCopy(pending, t);
    expect(copy.body).toBe(
      'nodes.upgrade.confirmRemote:{"name":"studio","version":"nodes.upgrade.latestPending"}'
    );
  });

  test('批量：正文报台数与版本，目标名字逐条列出', () => {
    const pending: NodeUpgradePending = {
      kind: 'batch',
      targets: [row({ id: 'a', name: 'a' }), row({ id: 'b', name: 'b' })],
      version: '1.2.0',
    };
    const copy = upgradeConfirmCopy(pending, t);
    expect(copy.title).toBe('nodes.upgrade.confirmTitle');
    expect(copy.body).toBe('nodes.upgrade.confirmAll:{"count":2,"version":"1.2.0"}');
    expect(copy.targets).toEqual([
      { id: 'a', name: 'a' },
      { id: 'b', name: 'b' },
    ]);
  });
});
