import type { LinkStream } from '@vibeterm/shared/link';

export type RelayAttachRole = 'primary' | 'secondary';

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

/** 多中继同时挂载时的在线索引与选路；单中继时退化为只含 primary 的一行。 */
export interface RelayPresenceIndex {
  snapshot(): RelayPresenceSnapshot[];
  primaryUrl(): string | null;
  /** 对端在线的、当前已连接的中继 URL（primary 在前）。 */
  relaysFor(peerId: string): string[];
  /** 按 rtt(self,R)+rtt(peer,R) 最小选中继；无样本的行排在有样本之后，同分优先 primary。 */
  chooseRelay(peerId: string, opts?: { exclude?: readonly string[] }): RelayChoice | null;
  onlineUnion(): Set<string>;
}

export interface RelayStreamOpener {
  /** 经指定中继向对端开一条 relay 流；中继未连接/对端不在线时 reject。 */
  openRelayVia(url: string, peerNodeId: string): Promise<LinkStream>;
}
