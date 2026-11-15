import type { TmuxConnectionOptions } from '../connection-types';
import type { ControlModeCommandQueue } from '../control-mode-capture';
import {
  type ControlModeSubscription,
  type ControlModeSubscriptionCallbacks,
  SOURCE_METADATA_SUBSCRIPTION_COMMANDS,
} from '../control-mode-subscription';
import type { PaneStreamNotification } from '../pane-stream-parser';
import {
  CONTROL_ATTACH_READY_TIMEOUT_MS,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
} from './constants';
import type { ExternalControlHandle } from './types';

export interface ControlModeHost {
  deviceId: string;
  logPrefix: string;
  stalledControlLabel: string;
  connected: boolean;
  manualDisconnect: boolean;
  controlStderrTail: string;
  controlCommands: ControlModeCommandQueue;
  controlSubscription: ControlModeSubscription | null;
  callbacks: TmuxConnectionOptions;
  createParkingWindow(): Promise<string | null>;
  removeParkingWindow(windowId: string | null): Promise<void>;
  attachControlTransport(onAttachReady: () => void): Promise<ExternalControlHandle>;
  isAttachedControlTransport(transport: ExternalControlHandle): boolean;
  controlAttachFailureMessage(): string;
  onControlAttachPrematureClose(message: string): void;
  getControlWriter(): ((data: string) => void) | null;
  killControlTransport(): void;
  detachControlTransport(): () => void;
  requestSnapshot(): void;
  recordBell(paneId?: string, windowId?: string): void;
  emitNotification(paneId: string, notification: PaneStreamNotification): void;
  noteThemeSubscription(paneId: string, subscribed: boolean): void;
  clearThemeSubscription(paneId: string): void;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  heartbeatPending: boolean;
  heartbeatTimeoutTimer: ReturnType<typeof setTimeout> | null;
}

interface HeartbeatProbe {
  queue: ControlModeCommandQueue;
  sentAt: number;
  rejected: boolean;
}

const HEARTBEAT_COMMAND = 'display-message -p "vibeterm-hb"';

export class ControlModeLifecycle {
  private attachedOnce = false;
  private heartbeat: HeartbeatProbe | null = null;

  constructor(private readonly host: ControlModeHost) {}

  async startControlClient(): Promise<void> {
    this.host.callbacks.onInputTransportInvalidated?.();
    this.stopHeartbeat();

    let attachReadyResolve: (() => void) | null = null;
    const attachReady = new Promise<void>((resolve) => {
      attachReadyResolve = resolve;
    });

    const reattach = this.attachedOnce;
    this.attachedOnce = true;
    const parkingWindowId = await this.host.createParkingWindow();
    console.debug(
      `${this.host.logPrefix} parking window created id=${parkingWindowId ?? 'none'} reason=${
        reattach ? 'reattach' : 'attach'
      } device=${this.host.deviceId}`
    );
    let transport: ExternalControlHandle;
    try {
      transport = await this.host.attachControlTransport(() => {
        attachReadyResolve?.();
        attachReadyResolve = null;
      });
      // attach 之后订阅才存在：先登记护盾窗口 id，再删窗口，%window-close 才会被过滤掉
      this.host.controlSubscription?.noteParkingWindow(parkingWindowId);
      await Promise.race([
        attachReady,
        new Promise<void>((resolve) => setTimeout(resolve, CONTROL_ATTACH_READY_TIMEOUT_MS)),
      ]);
    } finally {
      await this.host.removeParkingWindow(parkingWindowId);
      console.debug(
        `${this.host.logPrefix} parking window removed id=${parkingWindowId ?? 'none'} reason=${
          reattach ? 'reattach' : 'attach'
        } device=${this.host.deviceId}`
      );
    }

    if (!this.host.isAttachedControlTransport(transport)) {
      const message = this.host.controlStderrTail.trim() || this.host.controlAttachFailureMessage();
      this.host.onControlAttachPrematureClose(message);
      throw new Error(message);
    }

    this.host.callbacks.onInputTransportReady?.();
    for (const command of SOURCE_METADATA_SUBSCRIPTION_COMMANDS) {
      void this.host.controlCommands
        .execute((value) => transport.write(value), command, { transform: () => undefined })
        .catch((error) => this.host.callbacks.onError(error));
    }

    this.startHeartbeat();
  }

  stopControlClient(): void {
    this.host.callbacks.onInputTransportInvalidated?.();
    this.stopHeartbeat();
    const killDetached = this.host.detachControlTransport();
    this.host.controlSubscription?.dispose();
    this.host.controlSubscription = null;
    this.host.controlCommands.dispose();
    killDetached();
  }

  startHeartbeat(): void {
    this.stopHeartbeat();
    this.host.heartbeatTimer = setInterval(() => this.sendHeartbeat(), HEARTBEAT_INTERVAL_MS);
  }

  stopHeartbeat(): void {
    if (this.host.heartbeatTimer) {
      clearInterval(this.host.heartbeatTimer);
      this.host.heartbeatTimer = null;
    }
    if (this.host.heartbeatTimeoutTimer) {
      clearTimeout(this.host.heartbeatTimeoutTimer);
      this.host.heartbeatTimeoutTimer = null;
    }
    this.host.heartbeatPending = false;
    this.heartbeat = null;
  }

  /** 任何控制流进展（命令回执、%output、通知）都说明通道活着，一个心跳周期内不再补心跳。 */
  sendHeartbeat(): void {
    const host = this.host;
    const write = host.getControlWriter();
    if (!write || host.heartbeatPending || !host.connected || host.manualDisconnect) {
      return;
    }
    const queue = host.controlCommands;
    if (queue.idleMs() < HEARTBEAT_INTERVAL_MS) return;
    host.heartbeatPending = true;
    const probe: HeartbeatProbe = { queue, sentAt: queue.now(), rejected: false };
    this.heartbeat = probe;
    void queue
      .execute((value) => write(value), HEARTBEAT_COMMAND, {
        timeoutMs: HEARTBEAT_TIMEOUT_MS,
        poisonOnTimeout: false,
        transform: (block) => {
          if (block.lines.length !== 1 || block.lines[0] !== 'vibeterm-hb') {
            throw new Error('invalid tmux heartbeat response');
          }
        },
      })
      .then(
        () => this.onHeartbeatResponse(),
        () => {
          probe.rejected = true;
        }
      );
    this.armHeartbeatCheck();
  }

  /** 心跳没回执时只在通道整窗无进展（卡死）才拆；慢但仍在出数据就继续等。 */
  checkHeartbeat(): void {
    const host = this.host;
    const probe = this.heartbeat;
    host.heartbeatTimeoutTimer = null;
    if (!probe || !host.heartbeatPending || !host.connected || host.manualDisconnect) return;
    if (host.controlCommands !== probe.queue) {
      this.onHeartbeatResponse();
      return;
    }
    if (probe.queue.assessStall(probe.sentAt) === 'stalled') {
      console.warn(
        `${host.logPrefix} tmux control client heartbeat timeout on ${host.deviceId}, killing stalled ${host.stalledControlLabel}`
      );
      host.callbacks.onInputTransportInvalidated?.();
      probe.queue.poisonStalled();
      host.killControlTransport();
      return;
    }
    if (probe.rejected && probe.queue.lastActivityAt > probe.sentAt) {
      this.onHeartbeatResponse();
      return;
    }
    this.armHeartbeatCheck();
  }

  private armHeartbeatCheck(): void {
    this.host.heartbeatTimeoutTimer = setTimeout(() => this.checkHeartbeat(), HEARTBEAT_TIMEOUT_MS);
  }

  onHeartbeatResponse(): void {
    const host = this.host;
    this.heartbeat = null;
    if (!host.heartbeatPending) {
      return;
    }
    host.heartbeatPending = false;
    if (host.heartbeatTimeoutTimer) {
      clearTimeout(host.heartbeatTimeoutTimer);
      host.heartbeatTimeoutTimer = null;
    }
  }

  buildControlModeCallbacks(
    onAttachReady: () => void,
    controlCommands: ControlModeCommandQueue,
    write: (data: string) => void,
    isCurrent: () => boolean
  ): ControlModeSubscriptionCallbacks {
    const host = this.host;
    void controlCommands.expectAttach().then(onAttachReady, () => undefined);
    return {
      onTerminalOutput: (paneId, data) => {
        host.callbacks.onTerminalOutput(paneId, data);
      },
      onTitle: (paneId, title) => {
        host.callbacks.onSourceMetadata?.({ type: 'pane-title', paneId, title });
      },
      onSourceMetadata: (event) => {
        host.callbacks.onSourceMetadata?.(event);
      },
      onBell: (paneId) => {
        host.recordBell(paneId);
      },
      onNotification: (paneId, notification) => {
        host.emitNotification(paneId, notification);
      },
      onPromptMarker: (paneId, marker) => {
        if (marker.kind === 'A') {
          host.clearThemeSubscription(paneId);
        }
        host.callbacks.onPromptMarker?.(paneId, marker);
      },
      onClipboardWrite: (paneId, text) => {
        host.callbacks.onClipboardWrite?.(paneId, text);
      },
      onThemeSubscription: (paneId, subscribed) => {
        host.noteThemeSubscription(paneId, subscribed);
      },
      onStructureChanged: () => {
        host.requestSnapshot();
      },
      onExit: () => {
        if (!isCurrent()) return;
        host.callbacks.onInputTransportInvalidated?.();
        controlCommands.dispose('tmux control parser exited');
      },
      onPause: (paneId) => {
        if (!isCurrent()) {
          return;
        }
        void controlCommands
          .execute((value) => write(value), `refresh-client -A ${paneId}:continue`, {
            transform: () => undefined,
          })
          .catch((error) => host.callbacks.onError(error));
      },
      onBlockBegin: (args) => controlCommands.nextBlockIsLiteral(args),
      onBlockEnd: (block) => {
        if (controlCommands.handleBlock(block)) return;
        onAttachReady();
      },
    };
  }
}
