// 多节点通知的汇聚声明：签一条 `notification-sink` 密钥日志记录，经 `?hub=sync` 送上级。
//
// 声明原先是节点自述（`node.status` 的 inventory），被攻陷的节点可以自称汇聚机，把别人的
// 事件全收走。改成用户签名记录后判据只剩「用户签过的那一条」，与 `rename-node` 同路：
// 取 head → 签名 → append，整段进 key log 写锁（head 是全局的，并行会造出两条同 seq 的记录）。

import { type RecordSigner, buildSignedRecord, headFromResponse } from '@/auth/key-log-actions';
import type { AuthApi } from '@tmex/api-client/auth/index';
import { requireRootEpoch } from '@tmex/api-client/auth/index';
import { errorMessage } from '@tmex/shared';
import { buildNotificationSinkPayload, encodeBase64url, hexToBytes } from '@tmex/shared/auth';
import { withKeyLogLock } from './enrollment-engine';

/** 记录送出去了，但上级没确认（服务端未落库，可原样重来）。 */
export const NOTIFY_SINK_UNCONFIRMED = 'NOTIFY_SINK_UNCONFIRMED';

export interface NotificationSinkInput {
  head: Parameters<typeof buildSignedRecord>[0]['head'];
  rootEpoch: number;
  uid: string;
  /** 32 位小写 hex（与 `node_certs.node_id` 一致）。 */
  nodeIdHex: string;
  enabled: boolean;
  at: number;
  signer: RecordSigner;
}

export function buildNotificationSinkRecord(
  input: NotificationSinkInput
): Promise<{ bytes: Uint8Array; sig: Uint8Array }> {
  const nodeId = hexToBytes(input.nodeIdHex);
  if (nodeId.length !== 16) {
    return Promise.reject(new Error('node id must be 16 bytes'));
  }
  return buildSignedRecord({
    head: input.head,
    rootEpoch: input.rootEpoch,
    uid: input.uid,
    type: 'notification-sink',
    payload: buildNotificationSinkPayload({ nodeId, enabled: input.enabled, at: input.at }),
    signer: input.signer,
  });
}

export type NotificationSinkResult = { ok: true } | { ok: false; code: string };

export interface NotificationSinkDeps {
  api: AuthApi;
  mode: { uid: string; rootEpoch?: number | null };
  /** key log 写锁；缺省用引擎那条 FIFO 链。 */
  lock?: <T>(run: () => Promise<T>) => Promise<T>;
  now?: () => number;
}

/** 签一条 `notification-sink` 并提交。上级没确认时按「未确认」上报：服务端一条都没落库。 */
export async function setNotificationSinkViaKeyLog(
  deps: NotificationSinkDeps,
  input: { nodeIdHex: string; enabled: boolean },
  signer: RecordSigner
): Promise<NotificationSinkResult> {
  const lock = deps.lock ?? withKeyLogLock;
  try {
    const rootEpoch = requireRootEpoch(deps.mode);
    return await lock(async () => {
      const head = headFromResponse(await deps.api.keyLogHead());
      const record = await buildNotificationSinkRecord({
        head,
        rootEpoch,
        uid: deps.mode.uid,
        nodeIdHex: input.nodeIdHex,
        enabled: input.enabled,
        at: (deps.now ?? Date.now)(),
        signer,
      });
      const appended = await deps.api.appendKeyLog(
        { bytes: encodeBase64url(record.bytes), sig: encodeBase64url(record.sig) },
        { hubSync: true }
      );
      if (!appended.ok) return { ok: false as const, code: appended.code };
      if (appended.hubAck === false) {
        return { ok: false as const, code: appended.hubError || NOTIFY_SINK_UNCONFIRMED };
      }
      return { ok: true as const };
    });
  } catch (err) {
    return { ok: false, code: errorMessage(err) };
  }
}
