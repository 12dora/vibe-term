// 中继模式下的节点改名：签一条 `rename-node` 密钥日志记录，经 `?hub=sync` 送上级。
//
// hub 模式有 HTTP 控制面（`POST /n/<hub>/api/hub/nodes/:id/rename`），中继没有——中继是盲的，
// 它只转发密文，不认识「节点」这个概念。因此改名与 `set-relays` / `meta-key` 同路：
// 取 head → 签名 → append，整段进 key log 写锁（head 是全局的，并行会造出两条同 seq 的记录）。

import { type RecordSigner, buildSignedRecord, headFromResponse } from '@/auth/key-log-actions';
import type { AuthApi } from '@tmex/api-client/auth/index';
import { requireRootEpoch } from '@tmex/api-client/auth/index';
import { errorMessage } from '@tmex/shared';
import { buildRenameNodePayload, encodeBase64url, hexToBytes } from '@tmex/shared/auth';
import { classifyKeyLogFailure } from './enrollment';
import { withKeyLogLock } from './enrollment-engine';

/** 记录送出去了，但上级没确认（服务端未落库，可原样重来）。 */
export const RENAME_UNCONFIRMED = 'RENAME_UNCONFIRMED';

export interface RenameNodeInput {
  head: Parameters<typeof buildSignedRecord>[0]['head'];
  rootEpoch: number;
  uid: string;
  /** 32 位小写 hex（与 `node_certs.node_id` 一致）。 */
  nodeIdHex: string;
  name: string;
  signer: RecordSigner;
}

export function buildRenameNodeRecord(
  input: RenameNodeInput
): Promise<{ bytes: Uint8Array; sig: Uint8Array }> {
  const nodeId = hexToBytes(input.nodeIdHex);
  if (nodeId.length !== 16) {
    return Promise.reject(new Error('node id must be 16 bytes'));
  }
  return buildSignedRecord({
    head: input.head,
    rootEpoch: input.rootEpoch,
    uid: input.uid,
    type: 'rename-node',
    payload: buildRenameNodePayload({ nodeId, name: input.name }),
    signer: input.signer,
  });
}

export type RenameNodeResult = { ok: true } | { ok: false; code: string };

export interface RenameNodeDeps {
  api: AuthApi;
  mode: { uid: string; rootEpoch?: number | null };
  /** key log 写锁；缺省用引擎那条 FIFO 链。已经持锁的调用方要显式传 `alreadyLocked`。 */
  lock?: <T>(run: () => Promise<T>) => Promise<T>;
}

/** 签一条 `rename-node` 并提交。上级没确认时按「未确认」上报：服务端一条都没落库。 */
export async function renameNodeViaKeyLog(
  deps: RenameNodeDeps,
  input: { nodeIdHex: string; name: string },
  signer: RecordSigner
): Promise<RenameNodeResult> {
  const lock = deps.lock ?? withKeyLogLock;
  try {
    const rootEpoch = requireRootEpoch(deps.mode);
    return await lock(async () => {
      const head = headFromResponse(await deps.api.keyLogHead());
      const record = await buildRenameNodeRecord({
        head,
        rootEpoch,
        uid: deps.mode.uid,
        nodeIdHex: input.nodeIdHex,
        name: input.name,
        signer,
      });
      const appended = await deps.api.appendKeyLog(
        { bytes: encodeBase64url(record.bytes), sig: encodeBase64url(record.sig) },
        { hubSync: true }
      );
      if (!appended.ok) return { ok: false as const, code: appended.code };
      if (appended.hubAck === false) {
        return { ok: false as const, code: appended.hubError || RENAME_UNCONFIRMED };
      }
      return { ok: true as const };
    });
  } catch (err) {
    return { ok: false, code: errorMessage(err) };
  }
}

/** 失败码 → 是否值得原样重试（未确认 / 被顶掉的头都可以重来）。 */
export function renameRetryable(code: string): boolean {
  if (code === RENAME_UNCONFIRMED) return true;
  const failure = classifyKeyLogFailure(code);
  return failure === 'unconfirmed' || failure === 'stale';
}
