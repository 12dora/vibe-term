// 吊销确认框的文案路由：行内一台与卡头一批的标题、正文。
// Base UI 的对话框走 portal 且实现按需到货，静态渲染什么都不输出，只能对这份路由断言。

import { describe, expect, test } from 'bun:test';
import type { NodeRow } from '@/node/mesh-nodes';
import { revokeDialogCopy } from './revoke-dialog';
import type { RevokePlan } from './types';

const t = (key: string, options?: Record<string, unknown>) =>
  options ? `${key}:${JSON.stringify(options)}` : key;

function row(name: string): NodeRow {
  return { id: name, name } as NodeRow;
}

describe('revokeDialogCopy', () => {
  test('单台：标题按一台算，正文带节点名', () => {
    const plan: RevokePlan = { kind: 'single', targets: [row('studio')] };
    const copy = revokeDialogCopy(plan, t);
    expect(copy.title).toBe('nodes.revoke.confirmTitle:{"count":1}');
    expect(copy.body).toBe('nodes.revoke.confirmText:{"name":"studio"}');
  });

  test('批量：标题按台数算，正文列出全部名字', () => {
    const plan: RevokePlan = { kind: 'bulk', targets: [row('a'), row('b')] };
    const copy = revokeDialogCopy(plan, t);
    expect(copy.title).toBe('nodes.revoke.confirmTitle:{"count":2}');
    expect(copy.body).toBe('nodes.revoke.bulkConfirm:{"count":2,"names":"a、b"}');
  });
});
