// `notification-sink` 记录：编码、签名、`?hub=sync` 提交。

import { describe, expect, test } from 'bun:test';
import type { RecordSigner } from '@/auth/key-log-actions';
import type { AuthApi } from '@tmex/api-client/auth/index';
import {
  decodeBase64url,
  decodeKeyLogRecord,
  decodeNotificationSinkPayload,
  deriveSeed,
  encodeBase64url,
  nodeIdToHex,
  rootKeyFromSeed,
} from '@tmex/shared/auth';
import { NOTIFY_SINK_UNCONFIRMED, setNotificationSinkViaKeyLog } from './notification-sink';

const KDF = {
  salt: new Uint8Array(16).fill(0x05),
  memory_kib: 64,
  iterations: 1,
  parallelism: 1,
};
const NODE_ID = 'ab'.repeat(16);
const MODE = { uid: 'user-1', rootEpoch: 0 };

async function rootSigner(): Promise<RecordSigner> {
  return { kind: 'root', rootKey: rootKeyFromSeed(await deriveSeed('pw', KDF)) };
}

type Appended = { bytes: string; sig: string };

function authApi(
  appended: Appended[],
  result: unknown = { ok: true, hubAck: true },
  options: { hubSync?: boolean[] } = {}
): AuthApi {
  return {
    keyLogHead: () =>
      Promise.resolve({ seq: 9, hash: encodeBase64url(new Uint8Array(32).fill(3)) }),
    appendKeyLog: (body: Appended, opts?: { hubSync?: boolean }) => {
      appended.push(body);
      options.hubSync?.push(opts?.hubSync === true);
      return Promise.resolve(result);
    },
  } as unknown as AuthApi;
}

const noLock = <T>(run: () => Promise<T>) => run();

describe('setNotificationSinkViaKeyLog', () => {
  test('签出的记录是 notification-sink，payload 带节点 id / 开关 / 时间，且走 hub=sync', async () => {
    const appended: Appended[] = [];
    const hubSync: boolean[] = [];
    const result = await setNotificationSinkViaKeyLog(
      {
        api: authApi(appended, { ok: true, hubAck: true }, { hubSync }),
        mode: MODE,
        lock: noLock,
        now: () => 1_700_000_000_000,
      },
      { nodeIdHex: NODE_ID, enabled: true },
      await rootSigner()
    );

    expect(result).toEqual({ ok: true });
    expect(hubSync).toEqual([true]);
    const row = appended[0];
    if (!row) throw new Error('no record appended');
    const record = decodeKeyLogRecord(decodeBase64url(row.bytes));
    expect(record.type).toBe('notification-sink');
    expect(record.seq).toBe(10n);
    expect(record.signer).toBe('root');
    const payload = decodeNotificationSinkPayload(record.payload);
    expect(nodeIdToHex(payload.node_id)).toBe(NODE_ID);
    expect(payload.enabled).toBe(true);
    expect(payload.at).toBe(1_700_000_000_000n);
  });

  test('关闭时 enabled=false', async () => {
    const appended: Appended[] = [];
    await setNotificationSinkViaKeyLog(
      { api: authApi(appended), mode: MODE, lock: noLock },
      { nodeIdHex: NODE_ID, enabled: false },
      await rootSigner()
    );
    const row = appended[0];
    if (!row) throw new Error('no record appended');
    const record = decodeKeyLogRecord(decodeBase64url(row.bytes));
    expect(decodeNotificationSinkPayload(record.payload).enabled).toBe(false);
  });

  test('上级没确认时按未确认上报', async () => {
    const result = await setNotificationSinkViaKeyLog(
      { api: authApi([], { ok: true, hubAck: false }), mode: MODE, lock: noLock },
      { nodeIdHex: NODE_ID, enabled: true },
      await rootSigner()
    );
    expect(result).toEqual({ ok: false, code: NOTIFY_SINK_UNCONFIRMED });
  });

  test('服务端拒绝时透出失败码（版本门等）', async () => {
    const result = await setNotificationSinkViaKeyLog(
      {
        api: authApi([], { ok: false, code: 'KEYLOG_TYPE_UNSUPPORTED_BY_NODES' }),
        mode: MODE,
        lock: noLock,
      },
      { nodeIdHex: NODE_ID, enabled: true },
      await rootSigner()
    );
    expect(result).toEqual({ ok: false, code: 'KEYLOG_TYPE_UNSUPPORTED_BY_NODES' });
  });

  test('节点 id 不是 16 字节时不提交', async () => {
    const appended: Appended[] = [];
    const result = await setNotificationSinkViaKeyLog(
      { api: authApi(appended), mode: MODE, lock: noLock },
      { nodeIdHex: 'ab', enabled: true },
      await rootSigner()
    );
    expect(result.ok).toBe(false);
    expect(appended).toEqual([]);
  });
});
