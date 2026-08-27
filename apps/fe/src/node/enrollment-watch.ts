// 待确认 enrollment 的证书检测。
//
// 证书有两条到达路径，二者都汇进**唯一**的判定入口 `offerCertificate()`：
//   1. 推送：hub 收到 redeem 后经 uplink 通知发起 enrollment 的 entry，entry 再以
//      `ENROLL_REDEEMED` 帧转发到 `/mesh/ws`（`mesh-events.ts` 解码后多播）。
//   2. 轮询：`GET /n/<hub>/api/hub/enrollments/:id` 按 enrollment id 查 redeem 结果。
//      页面刚打开、WS 断线或推送丢失时由它兜底。
//
// 两条路径的证书都必须过 `enroll_pk` 匹配 + `cert_sig` 验签 + pending 未过期三关。

import { useEffect, useRef } from 'react';
import type { CertificateCandidate, PendingEnrollment } from './enrollment';
import { findPendingForCertificate } from './enrollment';
import type { HubApi } from './hub-api';
import { type MeshEventSource, sharedMeshEvents } from './mesh-events';

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

export interface EnrollmentWatchOptions {
  pendings: PendingEnrollment[];
  hubApi: HubApi | null;
  enabled?: boolean;
  intervalMs?: number;
  now?: () => number;
  /** 覆盖轮询来源（测试注入）。 */
  collect?: () => Promise<CertificateCandidate[]>;
  /** 覆盖推送来源（测试注入）；缺省用宿主共享的 `/mesh/ws`。 */
  events?: MeshEventSource;
  onOutcome: (outcome: CertificateOutcome) => void;
}

/**
 * pending 存在期间订阅推送 + 轮询证书。
 *
 * 轮询查的是**本次 enrollment 的 id**，返回的证书必定属于自己，因此与推送一样，
 * `unknown` 结果是真正的异常信号（收到不属于任何 pending 的证书），照常上报。
 */
export function useEnrollmentWatch(options: EnrollmentWatchOptions): void {
  const { pendings, hubApi, onOutcome } = options;
  const enabled = (options.enabled ?? true) && pendings.length > 0;
  const intervalMs = options.intervalMs ?? ENROLLMENT_POLL_INTERVAL_MS;
  const nowFn = options.now ?? Date.now;
  const collect = options.collect;
  const events = options.events;

  const stateRef = useRef({ pendings, hubApi, onOutcome, nowFn, collect });
  stateRef.current = { pendings, hubApi, onOutcome, nowFn, collect };

  // 推送：hub → entry → `/mesh/ws`。
  useEffect(() => {
    if (!enabled) return;
    const source = events ?? sharedMeshEvents();
    source.start();
    return source.onEnrollRedeemed((event) => {
      const { pendings: rows, onOutcome: emit, nowFn: now } = stateRef.current;
      emit(
        offerCertificate(rows, { certificate: event.certificate, certSig: event.certSig }, now())
      );
    });
  }, [enabled, events]);

  // 轮询兜底。
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
        if (custom) candidates = await custom();
        else if (hub) candidates = await collectRedeemedCertificates(hub, rows);
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
