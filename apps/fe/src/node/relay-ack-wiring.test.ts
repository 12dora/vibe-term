// 「中继没确认」必须在**每一条**追加密钥日志的路径上冒出来，不能只在中继自己的流程里。
//
// 这里验的是接线而不是判定（判定在 `relay-ack.test.ts`）：把 sonner 换成记录器，
// 驱动几条互不相干的写入路径，看 `relayAck:false` 是不是都换来了一条 warning。
// 事故的形状就是「界面报成功、成员什么都没收到」，所以断言的重点是**成功路径上也有告警**。

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { AuthApi } from '@vibeterm/api-client/auth/index';

const warnings: string[] = [];
mock.module('sonner', () => ({
  toast: {
    success: () => undefined,
    error: () => undefined,
    warning: (message: string) => void warnings.push(message),
    info: () => undefined,
    message: () => undefined,
    dismiss: () => undefined,
  },
}));

const { encodeBase64url, rootKeyFromSeed } = await import('@vibeterm/shared/auth');
const { submitAdmitRecord } = await import('./admit-record');
const { renameNodeViaKeyLog } = await import('./rename-node');
const { setNotificationSinkViaKeyLog } = await import('./notification-sink');

const KEY_LOG_HEAD = {
  seq: 4,
  hash: encodeBase64url(new Uint8Array(32).fill(7)),
};

const NODE_ID = 'ab'.repeat(16);
const MODE = { uid: 'u1', rootEpoch: 3 };
const signer = { kind: 'root' as const, rootKey: rootKeyFromSeed(new Uint8Array(32).fill(0x42)) };

/** 这些路径缺省用引擎那条 FIFO 写锁，单测里不需要真排队。 */
const passthrough = <T>(run: () => Promise<T>): Promise<T> => run();

/** 只回结果的最小 AuthApi：这些路径本身怎么签名不是本文件要验的。 */
function apiWith(result: unknown) {
  return {
    keyLogHead: () => Promise.resolve(KEY_LOG_HEAD),
    appendKeyLog: () => Promise.resolve(result),
  } as unknown as AuthApi;
}

const ACKED = { ok: true, hubAck: true, relayAck: true };
const UNACKED = { ok: true, hubAck: true, relayAck: false, relayError: 'offline' };
const record = { bytes: 'YWJj', sig: 'ZGVm' };

beforeEach(() => {
  warnings.length = 0;
});

describe('relayAck 告警的接线', () => {
  test('准入：中继确认了就一句都不发', async () => {
    const disposition = await submitAdmitRecord(apiWith(ACKED), 'p1', record);
    expect(disposition).toEqual({ kind: 'admitted' });
    expect(warnings).toEqual([]);
  });

  test('准入：中继没确认时仍然是 admitted，但必须挂一条告警', async () => {
    const disposition = await submitAdmitRecord(apiWith(UNACKED), 'p2', record);
    // 本地确实准入了，所以结论不变；新节点连不上其余成员这件事由告警说。
    expect(disposition).toEqual({ kind: 'admitted' });
    // 只数条数：全局 i18next 在单测里没初始化，文案本身由 `relay-ack.test.ts` 覆盖。
    expect(warnings).toHaveLength(1);
  });

  test('改名：成功路径上带告警', async () => {
    const result = await renameNodeViaKeyLog(
      { api: apiWith(UNACKED), mode: MODE, lock: passthrough },
      { nodeIdHex: NODE_ID, name: 'n1' },
      signer
    );
    expect(result.ok).toBe(true);
    expect(warnings).toHaveLength(1);
  });

  test('通知汇聚：成功路径上带告警', async () => {
    const result = await setNotificationSinkViaKeyLog(
      { api: apiWith(UNACKED), mode: MODE, lock: passthrough, now: () => 1 },
      { nodeIdHex: NODE_ID, enabled: true },
      signer
    );
    expect(result.ok).toBe(true);
    expect(warnings).toHaveLength(1);
  });

  test('上级没确认那一档不重复告警：记录压根没落库，说的是另一件事', async () => {
    const disposition = await submitAdmitRecord(
      apiWith({ ok: true, hubAck: false, hubError: 'RELAY_OFFLINE' }),
      'p3',
      record
    );
    expect(disposition).toEqual({ kind: 'unconfirmed' });
    expect(warnings).toEqual([]);
  });
});
