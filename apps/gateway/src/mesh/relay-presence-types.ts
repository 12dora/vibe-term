import type { LinkStream } from '@vibeterm/shared/link';
import type {
  RelayAttachRole,
  RelayChoice,
  RelayPeerPresence,
  RelayPresenceSnapshot,
} from '@vibeterm/shared/relay';

export type { RelayAttachRole, RelayChoice, RelayPeerPresence, RelayPresenceSnapshot };

/** 多中继同时挂载时的在线索引与选路；单中继时退化为只含 primary 的一行。 */
export interface RelayPresenceIndex {
  snapshot(): RelayPresenceSnapshot[];
  primaryUrl(): string | null;
  /** 对端在线的、当前已连接的中继 URL（primary 在前）。 */
  relaysFor(peerId: string): string[];
  /** 按 rtt(self,R)+rtt(peer,R) 最小选中继；无样本的行排在有样本之后，同分优先 primary。 */
  chooseRelay(peerId: string, opts?: { exclude?: readonly string[] }): RelayChoice | null;
  onlineUnion(): Set<string>;
  /** 该中继最新清单里 online 的 admitted 对端数；未连接时为 null。 */
  peersOnlineOn?(url: string): number | null;
}

export interface RelayStreamOpener {
  /** 经指定中继向对端开一条 relay 流；中继未连接/对端不在线时 reject。 */
  openRelayVia(url: string, peerNodeId: string): Promise<LinkStream>;
}
