// 自吊销：记录形状（`revoke-node` + 本机 node id）与五种结局的分类。
// 所有失败都必须收敛成 `failed`，绝不能抛出去打断退出流程。

import { describe, expect, test } from 'bun:test';
import type { RecordSigner } from '@/auth/key-log-actions';
import type {
  KeyLogAppendRequest,
  KeyLogAppendResult,
  KeyLogHeadResponse,
} from '@tmex/api-client/auth/index';
import {
  decodeBase64url,
  decodeKeyLogRecord,
  decodeRevokeNodePayload,
  encodeBase64url,
  rootKeyFromSeed,
} from '@tmex/shared/auth';
import { SELF_REVOKE_REASON, selfRevokeNode } from './self-revoke';

const UID = 'user-1';
const ROOT_EPOCH = 3;
const NODE_ID = '0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e';
const rootKey = rootKeyFromSeed(new Uint8Array(32).fill(0x42));
const signer: RecordSigner = { kind: 'root', rootKey };

const head: KeyLogHeadResponse = {
  seq: 0,
  hash: encodeBase64url(new Uint8Array(32)),
} as KeyLogHeadResponse;

/** 直接放行签名者，等价于用户在凭据对话框里确认。 */
const withSigner = async <T>(fn: (s: RecordSigner) => Promise<T>): Promise<T | null> =>
  await fn(signer);

function api(
  append: (body: KeyLogAppendRequest) => KeyLogAppendResult | Promise<KeyLogAppendResult>,
  headImpl: () => Promise<KeyLogHeadResponse> = () => Promise.resolve(head)
) {
  const calls: KeyLogAppendRequest[] = [];
  return {
    calls,
    api: {
      keyLogHead: headImpl,
      appendKeyLog: async (body: KeyLogAppendRequest, opts?: { hubSync?: boolean }) => {
        calls.push(body);
        expect(opts?.hubSync).toBe(true);
        return append(body);
      },
    },
  };
}

describe('selfRevokeNode', () => {
  test('hub 确认：签的是本机 node id 的 revoke-node', async () => {
    const h = api(() => ({ ok: true, hubAck: true }));
    const outcome = await selfRevokeNode({
      api: h.api,
      uid: UID,
      rootEpoch: ROOT_EPOCH,
      nodeIdHex: NODE_ID,
      withSigner,
    });
    expect(outcome).toEqual({ kind: 'revoked' });

    const record = decodeKeyLogRecord(decodeBase64url(h.calls[0]?.bytes ?? ''));
    expect(record.type).toBe('revoke-node');
    expect(record.uid).toBe(UID);
    expect(record.root_epoch).toBe(ROOT_EPOCH);
    const payload = decodeRevokeNodePayload(record.payload);
    expect(payload.node_id).toHaveLength(16);
    expect(payload.reason).toBe(SELF_REVOKE_REASON);
  });

  test('hub 没确认等于没吊销', async () => {
    const h = api(() => ({ ok: true, hubAck: false, hubError: 'hub_unreachable' }));
    expect(
      await selfRevokeNode({
        api: h.api,
        uid: UID,
        rootEpoch: ROOT_EPOCH,
        nodeIdHex: NODE_ID,
        withSigner,
      })
    ).toEqual({ kind: 'failed', reason: 'hub_unreachable' });
  });

  test('记录被拒：带上错误码', async () => {
    const h = api(() => ({ ok: false, code: 'KEY_LOG_FORK' }));
    expect(
      await selfRevokeNode({
        api: h.api,
        uid: UID,
        rootEpoch: ROOT_EPOCH,
        nodeIdHex: NODE_ID,
        withSigner,
      })
    ).toEqual({ kind: 'failed', reason: 'KEY_LOG_FORK' });
  });

  test('用户取消凭据：cancelled，不算失败', async () => {
    const h = api(() => ({ ok: true, hubAck: true }));
    expect(
      await selfRevokeNode({
        api: h.api,
        uid: UID,
        rootEpoch: ROOT_EPOCH,
        nodeIdHex: NODE_ID,
        withSigner: async () => null,
      })
    ).toEqual({ kind: 'cancelled' });
    expect(h.calls).toEqual([]);
  });

  test('读 head 失败也只是 failed，不抛', async () => {
    const h = api(
      () => ({ ok: true, hubAck: true }),
      () => Promise.reject(new Error('offline'))
    );
    expect(
      await selfRevokeNode({
        api: h.api,
        uid: UID,
        rootEpoch: ROOT_EPOCH,
        nodeIdHex: NODE_ID,
        withSigner,
      })
    ).toEqual({ kind: 'failed', reason: 'offline' });
  });

  test('node id 不合法：同样收敛成 failed', async () => {
    const h = api(() => ({ ok: true, hubAck: true }));
    const outcome = await selfRevokeNode({
      api: h.api,
      uid: UID,
      rootEpoch: ROOT_EPOCH,
      nodeIdHex: 'nope',
      withSigner,
    });
    expect(outcome.kind).toBe('failed');
    expect(h.calls).toEqual([]);
  });
});
