// 中继模式下的「加入码」：join 串 v3（`r3.`）与它的 enrollment 创建（plan-00 §1.5、§1.9）。
//
// 与 hub 模式的差别只有两处：enrollment 建在中继上（经本机 uplink 转发），join 串里除了
// `enroll_sk ‖ root_pk ‖ head_hash` 还带上 `K_log ‖ tenant_id ‖ token ‖ 中继地址表`——
// 新节点没有 hub 可问，必须自带解密密钥日志与连中继的全部材料。
//
// `enroll_sk` 与 `K_log` 都**只**出现在内存与展示给用户的 join 串里：落盘的 pending 只有公开字段
// （见 `enrollment.ts` 的 `PendingEnrollment`），字节缓冲用完立刻清零。

import type { RecordSigner } from '@/auth/key-log-actions';
import { enrollmentSignerFrom } from '@/auth/key-log-actions';
import type { RelayTenantApi } from '@tmex/api-client/relay/tenant-api';
import { createEnrollment, decodeBase64url, encodeBase64url } from '@tmex/shared/auth';
import { encodeRelayJoinToken } from '@tmex/shared/relay';
import type { CreatedEnrollment, PendingEnrollment } from './enrollment';
import { addPendingEnrollment } from './enrollment';
import type { HubApi } from './hub-api';

export interface CreateRelayEnrollmentInput {
  /** enrollment 通道：中继模式下是 `RelayEnrollmentApi`（路径指向 `/api/mesh/relay/*`）。 */
  channel: HubApi;
  /** 中继控制面：join 串材料（`K_log` / 租户令牌 / 地址表）从这里取。 */
  relayApi: RelayTenantApi;
  uid: string;
  rootEpoch: number;
  signer: RecordSigner;
  /** 32 字节根公钥（`/api/auth/mode`）。 */
  rootPublicKey: Uint8Array;
  /** `GET /api/auth/keylog/head` 的 head hash。 */
  keyLogHeadHash: Uint8Array;
  name?: string | null;
  now?: number;
  ttlMs?: number;
}

/**
 * 生成一次性 enrollment 密钥对、签授权、在中继上建 enrollment，并落一条**不含私钥**的 pending。
 *
 * join 串按 §1.5 的 `r3.` 布局拼；`enroll_sk`、`K_log` 与租户令牌的字节副本在 `finally` 里清零
 * （`encodeRelayJoinToken` 只负责清它自己那份编码缓冲）。
 */
export async function createEnrollmentOnRelay(
  input: CreateRelayEnrollmentInput
): Promise<CreatedEnrollment> {
  const now = input.now ?? Date.now();
  if (input.rootPublicKey.length !== 32) {
    throw new Error('root public key must be 32 bytes');
  }
  const material = await input.relayApi.joinMaterial();
  if (material.relays.length === 0) {
    throw new Error('relay list is empty');
  }
  const logKey = decodeBase64url(material.logKey);
  const token = decodeBase64url(material.token);
  const enrollment = await createEnrollment(enrollmentSignerFrom(input.signer), {
    uid: input.uid,
    rootEpoch: input.rootEpoch,
    now,
    ttlMs: input.ttlMs,
  });
  try {
    const enrollPk = encodeBase64url(enrollment.enrollPk);
    const authorizationBytes = encodeBase64url(enrollment.authorizationBytes);
    const authorizationSig = encodeBase64url(enrollment.authorizationSig);
    const ttl = input.ttlMs ?? 10 * 60 * 1000;
    const exp = now + ttl;
    const created = await input.channel.createEnrollment({
      enroll_pk: enrollPk,
      authorization: authorizationBytes,
      authorization_sig: authorizationSig,
      exp,
    });
    const joinToken = encodeRelayJoinToken({
      enrollSk: enrollment.enrollSk,
      rootPublicKey: input.rootPublicKey,
      keyLogHeadHash: input.keyLogHeadHash,
      logKey,
      tenantId: material.tenantId,
      token,
      relayUrls: material.relays,
    });
    const pending: PendingEnrollment = {
      hubEnrollmentId: created.id,
      enrollPk,
      authorizationBytes,
      authorizationSig,
      exp: created.expires_at ?? exp,
      name: input.name?.trim() ? input.name.trim() : null,
      createdAt: now,
    };
    addPendingEnrollment(pending);
    return { pending, joinToken, hubPublicUrl: material.relays[0] };
  } finally {
    enrollment.enrollSk.fill(0);
    logKey.fill(0);
    token.fill(0);
  }
}
