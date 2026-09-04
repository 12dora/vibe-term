// `rename-node` 记录：编码、签名、`?hub=sync` 提交，以及失败码的分类。

import { describe, expect, test } from 'bun:test';
import type { RecordSigner } from '@/auth/key-log-actions';
import type { AuthApi } from '@tmex/api-client/auth/index';
import {
  decodeBase64url,
  decodeKeyLogRecord,
  decodeRenameNodePayload,
  deriveSeed,
  encodeBase64url,
  nodeIdToHex,
  rootKeyFromSeed,
} from '@tmex/shared/auth';
import { RENAME_UNCONFIRMED, renameNodeViaKeyLog, renameRetryable } from './rename-node';

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

describe('renameNodeViaKeyLog', () => {
  test('签出的记录是 rename-node，payload 带节点 id 与 trim 后的名字，且走 hub=sync', async () => {
    const appended: Appended[] = [];
    const hubSync: boolean[] = [];
    const result = await renameNodeViaKeyLog(
      { api: authApi(appended, { ok: true, hubAck: true }, { hubSync }), mode: MODE, lock: noLock },
      { nodeIdHex: NODE_ID, name: '  书房  ' },
      await rootSigner()
    );

    expect(result).toEqual({ ok: true });
    expect(appended).toHaveLength(1);
    expect(hubSync).toEqual([true]);
    const record = decodeKeyLogRecord(decodeBase64url(appended[0].bytes));
    expect(record.type).toBe('rename-node');
    expect(record.seq).toBe(10n);
    const payload = decodeRenameNodePayload(record.payload);
    expect(nodeIdToHex(payload.node_id)).toBe(NODE_ID);
    expect(payload.name).toBe('书房');
  });

  test('上级没确认时按未确认上报（服务端一条都没落库）', async () => {
    const result = await renameNodeViaKeyLog(
      { api: authApi([], { ok: true, hubAck: false, hubError: '' }), mode: MODE, lock: noLock },
      { nodeIdHex: NODE_ID, name: 'studio' },
      await rootSigner()
    );
    expect(result).toEqual({ ok: false, code: RENAME_UNCONFIRMED });
  });

  test('append 失败原样带回错误码', async () => {
    const result = await renameNodeViaKeyLog(
      { api: authApi([], { ok: false, code: 'HUB_NOT_WRITER' }), mode: MODE, lock: noLock },
      { nodeIdHex: NODE_ID, name: 'studio' },
      await rootSigner()
    );
    expect(result).toEqual({ ok: false, code: 'HUB_NOT_WRITER' });
  });

  test('节点 id 不是 16 字节 / 名字为空：不发请求，折成失败', async () => {
    const appended: Appended[] = [];
    const deps = { api: authApi(appended), mode: MODE, lock: noLock };
    const signer = await rootSigner();
    expect((await renameNodeViaKeyLog(deps, { nodeIdHex: 'ab', name: 'x' }, signer)).ok).toBe(
      false
    );
    expect((await renameNodeViaKeyLog(deps, { nodeIdHex: NODE_ID, name: '  ' }, signer)).ok).toBe(
      false
    );
    expect(appended).toHaveLength(0);
  });
});

describe('renameRetryable', () => {
  test('未确认与被顶掉的头都值得重来，被拒的不值得', () => {
    expect(renameRetryable(RENAME_UNCONFIRMED)).toBe(true);
    expect(renameRetryable('seq_gap')).toBe(true);
    expect(renameRetryable('HUB_TIMEOUT')).toBe(true);
    expect(renameRetryable('KEYLOG_TYPE_UNSUPPORTED_BY_NODES')).toBe(false);
  });
});
