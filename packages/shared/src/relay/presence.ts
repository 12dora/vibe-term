import type { RelayAttachRole } from './status-row';

export type { RelayAttachRole };

export type RelayPeerPresence = {
  online: boolean;
  /** 对端上报的它到该中继的 RTT（状态 blob `rtt_ms`），2.2.x 对端为 null。 */
  rttMs: number | null;
  seenAt: number;
};

export type RelayPresenceSnapshot = {
  url: string;
  role: RelayAttachRole;
  connected: boolean;
  /** 本机到该中继的 uplink 心跳 RTT。 */
  selfRttMs: number | null;
  peers: ReadonlyMap<string, RelayPeerPresence>;
  listVersion: number;
  updatedAt: number;
};

export type RelayChoice = {
  url: string;
  role: RelayAttachRole;
  /** rtt(self,R)+rtt(peer,R)；任一侧无样本时为 null。 */
  scoreMs: number | null;
};
