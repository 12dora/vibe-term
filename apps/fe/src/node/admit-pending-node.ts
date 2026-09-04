// 「批准加入」：把 Hub 上一台 `admission_status === 'pending'` 的节点写进本地密钥日志。
//
// 与 enrollment 引擎的自动 admit 是**同一件事、不同入口**：那条路是本浏览器自己生成的加入码，
// 材料在 `PendingEnrollment` 里；这条路是别处（多半是 CLI 的 Hub 密码加入）建的 enrollment，
// 材料由 `GET /n/<hub>/api/hub/nodes` 随行下发，本浏览器只负责签一条 `admit-node`。
//
// 两条路都走引擎那把 key log 写锁与 `submitAdmitRecord`：head 是全局的，两条记录并行读到同一个
// 头就会造出同 seq 的分叉，Hub 只收得下一条。手上还留着未确认字节时**只重发**，绝不重签。

import { leaseSigner } from '@/auth/credential-prompt';
import type { CredentialPromptHandle } from '@/auth/credential-prompt';
import { type RecordSigner, headFromResponse } from '@/auth/key-log-actions';
import type { AuthApi, AuthModeResponse } from '@tmex/api-client/auth/index';
import { requireRootEpoch } from '@tmex/api-client/auth/index';
import { decodeBase64url, encodeBase64url } from '@tmex/shared/auth';
import {
  type AdmitDisposition,
  buildAdmitNodeRecord,
  submitAdmitRecord,
  unconfirmedRecord,
} from './enrollment';
import { withKeyLogLock } from './enrollment-engine';
import type { NodeRow, PendingAdmitMaterial } from './merge-nodes';

export interface AdmitPendingContext {
  api: AuthApi;
  /** 签 `admit-node` 所需的用户身份；`ResolvedMode` 天然满足。 */
  mode: Pick<AuthModeResponse, 'rootEpoch'> & { uid: string };
  prompt: CredentialPromptHandle;
  /**
   * 每次 await 之后的复核：这一行是否仍然挂着、仍是 pending、`enrollmentId` 与材料是否还是
   * 点击时那一份。凭据对话框与写锁都要等，期间 Hub 轮询可能已经把这一行改掉或移除，
   * 拿旧材料继续签就是一次用户看不见的后台写入（或稳定的 `node_id_reused`）。
   * 缺省（测试与非 React 入口）恒为有效。
   */
  stillValid?: (enrollmentId: string) => boolean;
}

export type AdmitPendingResult =
  | AdmitDisposition
  /** Hub 没随行下发全套材料（旧 Hub / 证书还没发）：只能等下一次刷新。 */
  | { kind: 'no-material' }
  /** 用户取消了凭据对话框。 */
  | { kind: 'cancelled' }
  | { kind: 'failed'; message: string };

/**
 * 批准一台待批准节点。凭据走 `request({ purpose: 'admit', reuse: true })`：
 * 与自动 admit 共用 5 分钟复用窗口，连批几台只需确认一次。
 */
export async function admitPendingNode(
  row: Pick<NodeRow, 'admitMaterial'>,
  ctx: AdmitPendingContext
): Promise<AdmitPendingResult> {
  const material = row.admitMaterial;
  if (!material) return { kind: 'no-material' };
  const id = material.enrollmentId;
  const valid = () => ctx.stillValid?.(id) ?? true;
  // 上一次没被 Hub 确认：那份字节仍然接得上，重签只会按已推进的 head 造出新 seq。
  const stored = unconfirmedRecord(id);
  if (stored) {
    return await guard(id, () =>
      withKeyLogLock(async () =>
        valid() ? await submitAdmitRecord(ctx.api, id, stored) : CANCELLED
      )
    );
  }
  let signer: RecordSigner | null;
  try {
    signer = await ctx.prompt.request({ purpose: 'admit', reuse: true });
  } catch (err) {
    return failure(err);
  }
  if (!signer) return { kind: 'cancelled' };
  if (!valid()) return CANCELLED;
  return await guard(id, () =>
    withKeyLogLock(async () => (valid() ? await appendAdmit(material, signer, ctx) : CANCELLED))
  );
}

const CANCELLED = { kind: 'cancelled' } as const;

/**
 * 异常收口。**关键**：`submitAdmitRecord` 是先暂存字节再发请求，因此提交阶段抛出的超时 / 断网
 * 说明「服务端落没落库未知」，而字节还留着——这与「Hub 未确认」是同一种处境，必须提示重发，
 * 说成失败会让用户重来一遍加入流程。只有取 head / 解码 / 签名阶段（尚无暂存）才是真失败。
 */
async function guard(
  enrollmentId: string,
  run: () => Promise<AdmitPendingResult>
): Promise<AdmitPendingResult> {
  try {
    return await run();
  } catch (err) {
    if (unconfirmedRecord(enrollmentId)) return { kind: 'unconfirmed' };
    return failure(err);
  }
}

function failure(err: unknown): AdmitPendingResult {
  return { kind: 'failed', message: err instanceof Error ? err.message : String(err) };
}

/**
 * 锁内的实际动作：取 head → 签 `admit-node` → `POST /api/auth/keylog?hub=sync`。
 * 租约只罩住构造签名这一小段，网络提交期间不占着根钥。
 */
async function appendAdmit(
  material: PendingAdmitMaterial,
  signer: RecordSigner,
  ctx: AdmitPendingContext
): Promise<AdmitDisposition> {
  const head = headFromResponse(await ctx.api.keyLogHead());
  const release = leaseSigner(signer);
  let record: { bytes: Uint8Array; sig: Uint8Array };
  try {
    record = await buildAdmitNodeRecord({
      head,
      rootEpoch: requireRootEpoch(ctx.mode),
      uid: ctx.mode.uid,
      // `buildAdmitNodeRecord` 只从 pending 里取授权那两段，其余字段与这条记录无关。
      pending: {
        hubEnrollmentId: material.enrollmentId,
        enrollPk: '',
        authorizationBytes: material.authorization,
        authorizationSig: material.authorizationSig,
        exp: 0,
        name: null,
        createdAt: 0,
      },
      certificateBytes: decodeBase64url(material.certificate),
      certSig: decodeBase64url(material.certSig),
      signer,
    });
  } finally {
    release();
  }
  return await submitAdmitRecord(ctx.api, material.enrollmentId, {
    bytes: encodeBase64url(record.bytes),
    sig: encodeBase64url(record.sig),
  });
}
