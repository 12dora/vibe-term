// Gateway transport 的对外契约：事件、命令与能力声明。
// 编码器 / 解码器 / 具体 transport 实现共用本模块，避免相互 import 成环。

import type {
  EventDevicePayload,
  EventTmuxPayload,
  StateSnapshotPayload,
  wsBorsh,
} from '@tmex/shared';
import type { ConnectionState } from './client';
import type { MovePanePosition } from './message-builder';

export interface GatewayTerminalCursor {
  paneEpoch: Uint8Array;
  terminalSeq: bigint;
}

export interface GatewayHistoryCursor {
  paneEpoch: Uint8Array;
  historyEpoch: Uint8Array;
  beforeLine: number;
}

export interface GatewayPaneScreenSnapshot {
  requestId?: Uint8Array;
  deviceId: string;
  paneId: string;
  paneEpoch: Uint8Array;
  baseSeq: bigint;
  rows: number;
  cols: number;
  modes: number;
  data: Uint8Array;
  historyCursor: GatewayHistoryCursor | null;
}

export interface GatewayPaneHistoryPage {
  requestId?: Uint8Array;
  deviceId: string;
  paneId: string;
  paneEpoch: Uint8Array;
  historyEpoch: Uint8Array;
  lineStart: number;
  lineEnd: number;
  truncated: boolean;
  data: Uint8Array;
  nextCursor: GatewayHistoryCursor | null;
}

export interface GatewayTerminalData {
  deviceId: string;
  paneId: string;
  data: Uint8Array;
  paneEpoch?: Uint8Array;
  seqStart?: bigint;
  seqEnd?: bigint;
}

export type GatewayRebaseReason =
  | 'metadata_gap'
  | 'pane_gap'
  | 'epoch_changed'
  | 'cache_evicted'
  | 'resource_exhausted';

export type GatewayTransportEvent =
  | { type: 'connection-state'; state: ConnectionState }
  | { type: 'latency'; latencyMs: number }
  | { type: 'terminal-progress'; deviceId?: string }
  | { type: 'device-connected'; deviceId: string }
  | { type: 'device-disconnected'; deviceId: string }
  | { type: 'device-event'; event: EventDevicePayload }
  | { type: 'metadata-snapshot'; snapshot: StateSnapshotPayload }
  | {
      type: 'metadata-patch';
      deviceId: string;
      patch: wsBorsh.LegacyStateSnapshotDiff;
    }
  | { type: 'tmux-event'; event: EventTmuxPayload }
  | { type: 'selection-ack'; deviceId: string; selectToken: Uint8Array }
  | {
      type: 'legacy-history';
      deviceId: string;
      paneId: string;
      selectToken: Uint8Array;
      data: string;
      alternateScreen: boolean;
      modes: number;
    }
  | { type: 'live-resume'; deviceId: string; selectToken: Uint8Array }
  | { type: 'terminal-data'; frame: GatewayTerminalData }
  | { type: 'screen-snapshot'; snapshot: GatewayPaneScreenSnapshot }
  | { type: 'history-page'; page: GatewayPaneHistoryPage }
  | {
      type: 'subscription-applied';
      deviceId: string;
      generation: bigint;
      paneIds: readonly string[];
      rejectedPaneIds: readonly string[];
    }
  | {
      type: 'rebase-required';
      deviceId?: string;
      paneId?: string;
      reason: GatewayRebaseReason;
    }
  | { type: 'clipboard-write'; deviceId: string; paneId: string; text: string }
  | { type: 'site-theme-update'; theme: 'dark' | 'light' }
  | { type: 'transport-error'; error: Error };

export type GatewayTransportEventHandler = (event: GatewayTransportEvent) => void;

export type GatewayTransportCommand =
  | { type: 'connect-device'; deviceId: string }
  | { type: 'disconnect-device'; deviceId: string }
  | {
      type: 'select-pane';
      deviceId: string;
      windowId: string;
      paneId: string;
      selectToken: Uint8Array;
      wantHistory: boolean;
      cols?: number;
      rows?: number;
    }
  | { type: 'select-window'; deviceId: string; windowId: string }
  | {
      type: 'terminal-input';
      deviceId: string;
      paneId: string;
      data: string;
      isComposing: boolean;
    }
  | { type: 'terminal-paste'; deviceId: string; paneId: string; data: string }
  | { type: 'terminal-resize'; deviceId: string; paneId: string; cols: number; rows: number }
  | { type: 'terminal-sync-size'; deviceId: string; paneId: string; cols: number; rows: number }
  | { type: 'create-window'; deviceId: string; name?: string; cwd?: string }
  | { type: 'close-window'; deviceId: string; windowId: string }
  | { type: 'close-pane'; deviceId: string; paneId: string }
  | { type: 'rename-window'; deviceId: string; windowId: string; name: string }
  | { type: 'set-window-style'; deviceId: string; style: string }
  | { type: 'reorder-windows'; deviceId: string; windowIds: string[] }
  | {
      type: 'set-pane-subscriptions';
      deviceId: string;
      generation: bigint;
      paneIds: string[];
    }
  | {
      type: 'request-pane-screen';
      requestId: Uint8Array;
      deviceId: string;
      paneId: string;
      byteLimit: number;
    }
  | {
      type: 'request-pane-history';
      requestId: Uint8Array;
      deviceId: string;
      paneId: string;
      cursor: GatewayHistoryCursor | null;
      byteLimit: number;
    }
  | {
      type: 'resize-pane-in-window';
      deviceId: string;
      paneId: string;
      cols?: number;
      rows?: number;
    }
  | { type: 'apply-stacked-layout'; deviceId: string; windowId: string; cols: number; rows: number }
  | {
      type: 'split-pane';
      deviceId: string;
      paneId: string;
      direction: 'right' | 'down';
      cwd?: string;
    }
  | { type: 'focus-pane'; deviceId: string; windowId: string; paneId: string }
  | { type: 'rename-pane'; deviceId: string; paneId: string; name: string }
  | {
      type: 'move-pane';
      deviceId: string;
      srcPaneId: string;
      dstPaneId: string;
      position: MovePanePosition;
    }
  | { type: 'break-pane'; deviceId: string; paneId: string }
  | { type: 'reorder-panes'; deviceId: string; windowId: string; paneIds: string[] };

export interface GatewayTransportCapabilities {
  sequencedTerminal: boolean;
  atomicScreen: boolean;
  cursorHistory: boolean;
  // select-pane / select-window / focus-pane 是否真正驱动服务端（tmux）的 active 状态。
  // 为 false 时 selection 是纯本地语义，消费方不得再拿快照里的 tmux active 反向改写
  // 本地路由，否则本地选择会被服务端 active 弹回。
  serverSelection: boolean;
}

export type GatewayTransportSourceRoute = 'gateway' | 'local' | 'relay' | 'unknown';

export interface GatewayTransport {
  readonly kind: 'websocket' | 'shared';
  readonly sourceRoute: GatewayTransportSourceRoute;
  readonly capabilities: GatewayTransportCapabilities;
  readonly hasConnectedOnce: boolean;
  readonly latencyMs: number | null;
  readonly serverCapabilities: readonly string[];
  connect(): void;
  disconnect(): void;
  dispose(): void;
  getState(): ConnectionState;
  isReady(): boolean;
  send(command: GatewayTransportCommand): boolean;
  onEvent(handler: GatewayTransportEventHandler): () => void;
}

/** 编码后的控制帧：wire kind + Borsh payload。 */
export interface EncodedGatewayCommand {
  kind: number;
  payload: Uint8Array;
}
