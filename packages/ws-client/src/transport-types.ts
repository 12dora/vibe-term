// Gateway transport 的对外契约：事件、命令与能力声明。
// 编码器 / 解码器 / 具体 transport 实现共用本模块，避免相互 import 成环。

import type { EventDevicePayload, EventTmuxPayload, StateSnapshotPayload } from '@tmex/shared';
import type { ClientSendResult, ConnectionState, StateFeedMode } from './client';
import type { MovePanePosition } from './message-builder';
import type { PendingDropReason } from './pending-send-queue';

export type ServerTooOldSide = 'gateway' | 'node' | 'client';

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

/** canonical PaneData 帧。游标字段只在从注册表内部合成的补发帧上缺省。 */
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

export type GatewaySubscriptionRejectionReason =
  | 'not_found'
  | 'resource_exhausted'
  | 'epoch_changed';

export interface GatewaySubscriptionRejection {
  deviceId: string;
  paneId: string;
  reason: GatewaySubscriptionRejectionReason;
}

export type GatewayTransportEvent =
  | { type: 'connection-state'; state: ConnectionState }
  | { type: 'state-feed-mode'; mode: StateFeedMode }
  | { type: 'latency'; latencyMs: number; rawMs: number }
  // 有一端不满足 canonical v1.1 门槛：不降级，只上报让宿主提示升级。
  // side 指明太旧的是哪一端（gateway = 直连的网关，node = 入口转发到的远端节点，
  // client = 本页面），version 是那一端自报的版本，nodeId 只在 node 侧有值——
  // 被拒的转发流对端未必是当前 runtime 的 node，只能由网关在 ERROR 里点名。
  | {
      type: 'server-too-old';
      side: ServerTooOldSide;
      minVersion: string;
      version: string | null;
      nodeId?: string | null;
    }
  | { type: 'device-connected'; deviceId: string }
  | { type: 'device-disconnected'; deviceId: string }
  | { type: 'device-event'; event: EventDevicePayload }
  | { type: 'metadata-snapshot'; snapshot: StateSnapshotPayload }
  // canonical metadata patch 已在客户端合并并按设备树顺序排好，消费方直接替换整棵快照
  | { type: 'metadata-patch'; deviceId: string; snapshot: StateSnapshotPayload }
  | { type: 'tmux-event'; event: EventTmuxPayload }
  | { type: 'terminal-data'; frame: GatewayTerminalData }
  | { type: 'screen-snapshot'; snapshot: GatewayPaneScreenSnapshot }
  | { type: 'history-page'; page: GatewayPaneHistoryPage }
  | {
      type: 'subscription-applied';
      deviceId: string;
      generation: bigint;
      paneIds: readonly string[];
      rejectedPaneIds: readonly string[];
      rejections?: readonly GatewaySubscriptionRejection[];
    }
  | {
      type: 'rebase-required';
      deviceId?: string;
      paneId?: string;
      reason: GatewayRebaseReason;
    }
  | { type: 'clipboard-write'; deviceId: string; paneId: string; text: string }
  | { type: 'site-theme-update'; theme: 'dark' | 'light' }
  // 服务端设置变更的缓存失效信号；namespace 保持 wire 原样（服务端可新增取值，客户端按需匹配）
  | { type: 'settings-update'; namespace: string }
  | { type: 'transport-error'; error: Error }
  | {
      type: 'pending-overflow';
      /** overflow = 待发预算耗尽；stale = 断线期间缓冲的输入过期被丢弃。 */
      reason?: PendingDropReason;
      kind: number;
      pendingFrames: number;
      pendingBytes: number;
      droppedFrames: number;
    }
  | TerminalViewportPolicyEvent;

export type GatewayNodeEvent = {
  type: 'node-event';
  nodeId: string;
  status: 'online' | 'offline' | 'revoked';
  reach: string | null;
  inventory: string | null;
  version: string | null;
  directCapable: boolean | null;
  name: string | null;
};

export type TerminalViewportPolicyEvent = {
  type: 'terminal-viewport-policy';
  kind: 'terminal-viewport-policy';
  deviceId: string;
  windowId: string;
  paneId: string;
  owner: boolean;
  cols: number;
  rows: number;
};

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
  | {
      type: 'terminal-viewport';
      deviceId: string;
      paneId: string;
      cols: number;
      rows: number;
      visible: boolean;
    }
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
  readonly latencyRawMs: number | null;
  readonly serverCapabilities: readonly string[];
  readonly stateFeedMode?: StateFeedMode;
  connect(): void;
  disconnect(): void;
  dispose(): void;
  getState(): ConnectionState;
  isReady(): boolean;
  send(command: GatewayTransportCommand): ClientSendResult | boolean;
  onEvent(handler: GatewayTransportEventHandler): () => void;
}

/** 编码后的控制帧：wire kind + Borsh payload。 */
export interface EncodedGatewayCommand {
  kind: number;
  payload: Uint8Array;
}
