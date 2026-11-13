import type { LinkSession } from '@vibeterm/shared/link';
import type { RelayCtlMessage } from '@vibeterm/shared/relay';
import { type RelayLiveNode, type RelayRegistry, noteRelayPing } from './relay-registry';
import type { RelayTenantRecord } from './types';

export type RelayHeartbeatHost = {
  registry: RelayRegistry;
  heartbeatMissLimit: number;
  now: () => number;
  revalidate(live: RelayLiveNode): RelayTenantRecord | null;
  send(link: LinkSession, msg: RelayCtlMessage): void;
};

export function clearRelayHeartbeat(live: RelayLiveNode): void {
  if (live.heartbeat !== null) {
    clearInterval(live.heartbeat);
    live.heartbeat = null;
  }
}

export function startRelayHeartbeat(
  host: RelayHeartbeatHost,
  live: RelayLiveNode,
  intervalMs: number
): void {
  clearRelayHeartbeat(live);
  if (intervalMs <= 0) return;
  live.heartbeat = setInterval(() => {
    beatRelay(host, live);
  }, intervalMs);
}

export function beatRelay(host: RelayHeartbeatHost, live: RelayLiveNode): void {
  if (host.registry.fromLink(live.link) !== live) {
    clearRelayHeartbeat(live);
    return;
  }
  // 只跑数据流的链路从不进 dispatchAuthenticated，宽限到期只能靠这一拍收掉
  const tenant = host.revalidate(live);
  if (!tenant) return;
  if (live.awaitingPong) {
    if (live.byteFlowSeq !== live.pingByteFlowSeq) {
      live.misses = 0;
      live.pingByteFlowSeq = live.byteFlowSeq;
      return;
    }
    live.misses += 1;
    if (live.misses >= host.heartbeatMissLimit) {
      live.link.close('heartbeat-timeout');
    }
    return;
  }
  live.awaitingPong = true;
  noteRelayPing(live, host.now());
  host.send(live.link, { t: 'ping', token_rotated: live.tokenHash !== tenant.tokenHash });
}
