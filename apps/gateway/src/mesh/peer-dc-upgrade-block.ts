import type { LinkSession } from '@vibeterm/shared/link';
import type { MeshScheduler, PeerTransportKind } from './types';

/** pending / 非本次升级的 DC 在途时，短冷却后再拨；0 会热循环，15s 扫描会丢升级。 */
export const BLOCKED_UPGRADE_RETRY_MS = 250;

export type UpgradeGate = {
  nextEligibleAt: number;
  failures: number;
  coalesced: boolean;
  scheduled: boolean;
};
export type DcUpgradeRetry = {
  attempt: number;
  abort: AbortController | null;
};
export type DcUpgradeLivePeer = {
  retiring: boolean;
  transport: PeerTransportKind;
  peerNodeId: string;
  quiesceCapable: boolean;
  session: LinkSession;
  dcAttemptId: string | null;
  linkSinceAt?: number;
};

export type DcUpgradePorts = {
  scheduler: MeshScheduler;
  live: () => Map<string, DcUpgradeLivePeer>;
  dialDc: (nodeId: string, opts?: { skipDc?: boolean }) => Promise<LinkSession>;
  shouldTryDc: (nodeId: string) => boolean;
  dcCapable: (nodeId: string) => boolean;
  emitLinkInfo: (live: DcUpgradeLivePeer) => void;
  log: (event: string, fields?: Record<string, unknown>) => void;
  stopped: () => boolean;
  stopSignal: () => AbortSignal;
  isTrusted: (nodeId: string) => boolean;
  pending: () => Map<string, Promise<LinkSession>>;
  upgrading: () => Map<string, Promise<LinkSession>>;
  hasDcInflight: (nodeId: string) => boolean;
  probeQuiesce: (live: DcUpgradeLivePeer) => void;
  hasWsSecureCandidate: (nodeId: string) => boolean;
  lostDirect: () => Set<string>;
  clearUnstableStreak?: (nodeId?: string) => void;
  canDialDirect?: (nodeId: string, opts: { peerInitiated: boolean }) => boolean;
  allowsUpgrade?: (nodeId: string) => boolean;
  peerCapability?: (nodeId: string) => { version: string | null; directCapable: boolean } | null;
  dcProven?: (nodeId: string) => boolean;
};

export function isUpgradeBlockedByInflight(
  ports: DcUpgradePorts,
  wsUpgradeInflight: Set<string>,
  live: DcUpgradeLivePeer,
  nodeId: string
): boolean {
  const wsSecure = live.transport === 'relay' && ports.hasWsSecureCandidate(nodeId);
  if (wsSecure && !wsUpgradeInflight.has(nodeId)) return false;
  return (
    ports.pending().has(nodeId) || ports.upgrading().has(nodeId) || ports.hasDcInflight(nodeId)
  );
}

export type BlockedUpgradeDefer = {
  nodeId: string;
  ports: DcUpgradePorts;
  gate: UpgradeGate;
  watching: Set<string>;
  retry: () => void;
};

export function deferBlockedUpgrade(d: BlockedUpgradeDefer): void {
  d.gate.coalesced = true;
  const inflight = d.ports.upgrading().get(d.nodeId) ?? d.ports.pending().get(d.nodeId);
  if (inflight) {
    watchInflight(d, inflight);
    return;
  }
  armShortRetry(d);
}

function watchInflight(d: BlockedUpgradeDefer, inflight: Promise<unknown>): void {
  if (d.watching.has(d.nodeId)) return;
  d.watching.add(d.nodeId);
  // 只关心「结束了」：失败由在途任务自己处理，这里不能再把拒绝抛成未处理异常
  const settled = (): void => {
    d.watching.delete(d.nodeId);
    if (d.gate.coalesced && !d.ports.stopped()) d.retry();
  };
  inflight.then(settled, settled);
}

function armShortRetry(d: BlockedUpgradeDefer): void {
  if (d.gate.scheduled || d.ports.stopped()) return;
  d.gate.scheduled = true;
  void d.ports.scheduler.sleep(BLOCKED_UPGRADE_RETRY_MS, d.ports.stopSignal()).then(
    () => {
      d.gate.scheduled = false;
      if (d.ports.stopped() || !d.gate.coalesced) return;
      d.retry();
    },
    () => {
      d.gate.scheduled = false;
    }
  );
}
