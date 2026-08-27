// 待确认 enrollment 的证书检测。
//
// 后端现状：hub 收到 redeem 后只向**发起 enrollment 的 entry 的 ctl 流**推 `enroll.redeemed`，
// `/mesh/ws` 的 `NODE_EVENT` 不带证书，`GET /api/mesh/nodes` 与 `GET /n/<hub>/api/hub/nodes`
// 也都不返回 `certificate` / `cert_sig`。因此这里做两件事：
//
// 1. `offerCertificate()` 是**唯一**的检测入口——将来后端补上推送（或在列表里补两个字段）后，
//    只要把证书喂给它即可，匹配与 admit 触发逻辑零改动。
// 2. 在 pending 存在期间每 5 秒轮询两个列表，把其中**已经带上** `certificate` / `cert_sig`
//    的行喂给 `offerCertificate()`。字段缺失时轮询什么也不做，pending 停在「待确认」，
//    用户点确认按钮走同一条路径。

import type { MeshNode } from '@tmex/api-client/auth/index';
import { defaultAuthApi } from '@tmex/api-client/auth/index';
import { useEffect, useRef } from 'react';
import type { CertificateCandidate, PendingEnrollment } from './enrollment';
import { findPendingForCertificate } from './enrollment';
import type { HubApi, HubNodeRow } from './hub-api';

export const ENROLLMENT_POLL_INTERVAL_MS = 5000;

type MeshNodeWithCert = MeshNode & { certificate?: string; cert_sig?: string };

/** 从 hub 节点列表里抽出带证书的行（字段是前向兼容的，目前后端不返回）。 */
export function certificatesFromHubNodes(rows: HubNodeRow[]): CertificateCandidate[] {
  const out: CertificateCandidate[] = [];
  for (const row of rows) {
    if (row.certificate && row.cert_sig) {
      out.push({ certificate: row.certificate, certSig: row.cert_sig });
    }
  }
  return out;
}

/** 从 mesh 节点列表里抽出带证书的行（同上，前向兼容）。 */
export function certificatesFromMeshNodes(nodes: MeshNode[]): CertificateCandidate[] {
  const out: CertificateCandidate[] = [];
  for (const node of nodes as MeshNodeWithCert[]) {
    if (node.certificate && node.cert_sig) {
      out.push({ certificate: node.certificate, certSig: node.cert_sig });
    }
  }
  return out;
}

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

export interface EnrollmentWatchOptions {
  pendings: PendingEnrollment[];
  hubApi: HubApi | null;
  enabled?: boolean;
  intervalMs?: number;
  now?: () => number;
  /** 覆盖候选来源（测试注入）。 */
  collect?: () => Promise<CertificateCandidate[]>;
  onOutcome: (outcome: CertificateOutcome) => void;
}

/**
 * pending 存在期间轮询证书。轮询到的证书**不会**触发「未知节点证书」告警：
 * 列表里本来就有一堆与本次 enrollment 无关的旧证书，那是正常状态而不是攻击信号。
 * 该告警只由推送路径（将来的 `enroll.redeemed`）在 `offerCertificate` 返回 `unknown` 时发出。
 */
export function useEnrollmentWatch(options: EnrollmentWatchOptions): void {
  const { pendings, hubApi, onOutcome } = options;
  const enabled = (options.enabled ?? true) && pendings.length > 0;
  const intervalMs = options.intervalMs ?? ENROLLMENT_POLL_INTERVAL_MS;
  const nowFn = options.now ?? Date.now;
  const collect = options.collect;

  const stateRef = useRef({ pendings, hubApi, onOutcome, nowFn, collect });
  stateRef.current = { pendings, hubApi, onOutcome, nowFn, collect };

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    const tick = async () => {
      const {
        pendings: rows,
        hubApi: hub,
        onOutcome: emit,
        nowFn: now,
        collect: custom,
      } = stateRef.current;
      if (rows.length === 0) return;
      let candidates: CertificateCandidate[] = [];
      try {
        if (custom) {
          candidates = await custom();
        } else {
          const [hubRows, meshNodes] = await Promise.all([
            hub ? hub.listNodes().catch(() => [] as HubNodeRow[]) : Promise.resolve([]),
            defaultAuthApi.listNodes().catch(() => [] as MeshNode[]),
          ]);
          candidates = [
            ...certificatesFromHubNodes(hubRows),
            ...certificatesFromMeshNodes(meshNodes),
          ];
        }
      } catch {
        return;
      }
      if (cancelled) return;
      for (const candidate of candidates) {
        const outcome = offerCertificate(rows, candidate, now());
        if (outcome.kind !== 'unknown') emit(outcome);
      }
    };

    void tick();
    const timer = setInterval(() => void tick(), intervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [enabled, intervalMs]);
}
