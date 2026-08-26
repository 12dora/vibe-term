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

export class ControlModeLifecycle {
  constructor(private readonly host: ControlModeHost) {}

  async startControlClient(): Promise<void> {
    this.stopHeartbeat();

    let attachReadyResolve: (() => void) | null = null;
    const attachReady = new Promise<void>((resolve) => {
      attachReadyResolve = resolve;
    });

    const parkingWindowId = await this.host.createParkingWindow();
    let transport: ExternalControlHandle;
    try {
      transport = await this.host.attachControlTransport(() => {
        attachReadyResolve?.();
        attachReadyResolve = null;
      });
      await Promise.race([
        attachReady,
        new Promise<void>((resolve) => setTimeout(resolve, CONTROL_ATTACH_READY_TIMEOUT_MS)),
      ]);
    } finally {
      await this.host.removeParkingWindow(parkingWindowId);
    }

    if (!this.host.isAttachedControlTransport(transport)) {
      const message = this.host.controlStderrTail.trim() || this.host.controlAttachFailureMessage();
      this.host.onControlAttachPrematureClose(message);
      throw new Error(message);
    }

    for (const command of SOURCE_METADATA_SUBSCRIPTION_COMMANDS) {
      void this.host.controlCommands
        .execute((value) => transport.write(value), command, { transform: () => undefined })
        .catch((error) => this.host.callbacks.onError(error));
    }

    this.startHeartbeat();
  }

  stopControlClient(): void {
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
  }

  sendHeartbeat(): void {
    const host = this.host;
    const write = host.getControlWriter();
    if (!write || host.heartbeatPending || !host.connected || host.manualDisconnect) {
      return;
    }
    host.heartbeatPending = true;
    void host.controlCommands
      .execute((value) => write(value), 'display-message -p "tmex-hb"', {
        timeoutMs: HEARTBEAT_TIMEOUT_MS,
        transform: (block) => {
          if (block.lines.length !== 1 || block.lines[0] !== 'tmex-hb') {
            throw new Error('invalid tmux heartbeat response');
          }
        },
      })
      .then(() => this.onHeartbeatResponse())
      .catch(() => {});
    host.heartbeatTimeoutTimer = setTimeout(() => {
      if (!host.heartbeatPending || !host.connected || host.manualDisconnect) {
        return;
      }
      console.warn(
        `${host.logPrefix} tmux control client heartbeat timeout on ${host.deviceId}, killing stalled ${host.stalledControlLabel}`
      );
      host.killControlTransport();
    }, HEARTBEAT_TIMEOUT_MS);
  }

  onHeartbeatResponse(): void {
    const host = this.host;
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
      onExit: () => {},
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
      onBlockBegin: () => controlCommands.nextBlockIsLiteral(),
      onBlockEnd: (block) => {
        if (controlCommands.handleBlock(block)) return;
        onAttachReady();
      },
    };
  }
}
