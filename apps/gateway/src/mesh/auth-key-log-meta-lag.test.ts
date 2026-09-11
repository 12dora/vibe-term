// 版本门对「成员密钥未送达」成员的豁免（`relay-meta-lag.ts` 的 exemptMetaKeyLaggingNodes）。

import { describe, expect, test } from 'bun:test';
import { encodeKeyLogRecord } from '@vibeterm/shared/auth';
import { exemptMetaKeyLaggingNodes } from './relay-meta-lag';

const LAGGING = 'ab'.repeat(8);
const OLD = 'cd'.repeat(8);

function record(type: string): Uint8Array {
  return encodeKeyLogRecord({
    domain: 'vibeterm/keylog',
    uid: 'u1',
    seq: 3n,
    prev_hash: new Uint8Array(32),
    root_epoch: 1,
    type: type as never,
    payload: new Uint8Array(0),
    signer: 'root',
    credential_id: null,
  });
}

type Compat = { ok: boolean; code?: string; nodes: { id: string }[] };

const blocked = (ids: string[]): Compat => ({
  ok: false,
  code: 'KEYLOG_TYPE_UNSUPPORTED_BY_NODES',
  nodes: ids.map((id) => ({ id })),
});

describe('exemptMetaKeyLaggingNodes', () => {
  test('rename-node：唯一挡路的是欠成员密钥的那台时整条放行', () => {
    const out = exemptMetaKeyLaggingNodes(
      blocked([LAGGING]),
      record('rename-node'),
      () => new Set([LAGGING])
    );
    expect(out.ok).toBe(true);
  });

  test('meta-key：补发这条本身不能被它要补的那台挡住（否则死锁）', () => {
    const out = exemptMetaKeyLaggingNodes(
      blocked([LAGGING]),
      record('meta-key'),
      () => new Set([LAGGING])
    );
    expect(out.ok).toBe(true);
  });

  test('真正的旧节点照样挡住，只把欠密钥那台从名单里摘掉', () => {
    const out = exemptMetaKeyLaggingNodes(
      blocked([LAGGING, OLD]),
      record('rename-node'),
      () => new Set([LAGGING])
    );
    expect(out.ok).toBe(false);
    expect(out.nodes.map((node) => node.id)).toEqual([OLD]);
  });

  test('fail-closed 的记录类型不豁免', () => {
    const out = exemptMetaKeyLaggingNodes(
      blocked([LAGGING]),
      record('readmit-node'),
      () => new Set([LAGGING])
    );
    expect(out.ok).toBe(false);
  });

  test('非中继模式（没有名单来源）原样返回', () => {
    const out = exemptMetaKeyLaggingNodes(blocked([LAGGING]), record('rename-node'), null);
    expect(out.ok).toBe(false);
  });
});
