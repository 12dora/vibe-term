// 待确认 enrollment 的证书检测。
//
// 证书有两条到达路径，二者都汇进**唯一**的判定入口 `offerCertificate()`：
//   1. 推送：hub 收到 redeem 后经 uplink 通知发起 enrollment 的 entry，entry 再以
//      `ENROLL_REDEEMED` 帧转发到 `/mesh/ws`（`mesh-events.ts` 解码后多播）。
//   2. 轮询：`GET /n/<hub>/api/hub/enrollments/:id` 按 enrollment id 查 redeem 结果。
//      页面刚打开、WS 断线或推送丢失时由它兜底。
//
// 两条路径的证书都必须过 `enroll_pk` 匹配 + `cert_sig` 验签 + pending 未过期三关。
//
// 本文件只留**纯判定**：驱动这两条路径的唯一回路在 `enrollment-engine.ts`（宿主级单例）。

import type { CertificateCandidate, PendingEnrollment } from './enrollment';
import { findPendingForCertificate } from './enrollment';
import type { HubApi } from './hub-api';

export const ENROLLMENT_POLL_INTERVAL_MS = 5000;

export type CertificateOutcome =
  | {
      kind: 'admit';
      pending: PendingEnrollment;
      nodeIdHex: string;
      certificateBytes: Uint8Array;
      certSig: Uint8Array;
    }
  | { kind: 'invalid'; pending: PendingEnrollment; reason: 'bad_cert_sig' | 'expired' }
  | { kind: 'unknown' };

/**
 * 唯一的证书判定入口：匹配 pending 就返回 `admit`，签名坏 / pending 过期返回 `invalid`，
 * 谁都不匹配返回 `unknown`（调用方按「收到未知节点证书」告警并忽略）。
 */
export function offerCertificate(
  pendings: PendingEnrollment[],
  candidate: CertificateCandidate,
  now: number
): CertificateOutcome {
  const found = findPendingForCertificate(pendings, candidate, now);
  if (!found) return { kind: 'unknown' };
  if (found.match.ok) {
    return {
      kind: 'admit',
      pending: found.pending,
      nodeIdHex: found.match.nodeIdHex,
      certificateBytes: found.match.certificateBytes,
      certSig: found.match.certSig,
    };
  }
  if (found.match.reason === 'bad_cert_sig' || found.match.reason === 'expired') {
    return { kind: 'invalid', pending: found.pending, reason: found.match.reason };
  }
  return { kind: 'unknown' };
}

/**
 * 一批候选证书 → 要上报的 outcome。**推送与轮询共用同一份**，`unknown` 同样上报：
 * 轮询查的是本次 enrollment 的 id，hub 却回了一份对不上任何 pending 的证书，
 * 这是真正的异常信号，静默丢弃等于隐藏「收到未知节点证书」告警（见 F4-fix 评审 Minor）。
 */
export function outcomesForCandidates(
  pendings: PendingEnrollment[],
  candidates: CertificateCandidate[],
  now: number
): CertificateOutcome[] {
  return candidates.map((candidate) => offerCertificate(pendings, candidate, now));
}

/** 逐条 pending 向 hub 查 redeem 结果，返回已 redeem 的证书候选。 */
export async function collectRedeemedCertificates(
  hubApi: HubApi,
  pendings: PendingEnrollment[]
): Promise<CertificateCandidate[]> {
  const rows = await Promise.all(
    pendings.map(async (pending) => {
      try {
        const status = await hubApi.getEnrollment(pending.hubEnrollmentId);
        if (status.status !== 'redeemed' || !status.certificate || !status.cert_sig) return null;
        return { certificate: status.certificate, certSig: status.cert_sig };
      } catch {
        return null;
      }
    })
  );
  return rows.filter((row): row is CertificateCandidate => row !== null);
}
