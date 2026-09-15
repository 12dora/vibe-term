import { wsBorsh } from '@vibeterm/shared';
import type { DeviceSessionRuntime } from '../tmux-client/device-session-runtime';
import {
  type WindowMemoryRuntimeHost,
  bindWindowMemoryRuntimeHost,
} from '../window-memory/runtime-host';
import type { WindowMemoryAggregate } from '../window-memory/types';
import { encodePayloadFrames } from './borsh/codec-borsh';
import type { GatewaySession } from './gateway-session';
import type { ShareSessionIndex } from './share-session-index';
import type { DeviceConnectionEntry } from './types';
import { gatewayWebSocketSendGuard } from './websocket-send-guard';

export interface WindowMemoryBroadcastHost {
  readonly connections: Map<string, DeviceConnectionEntry>;
  readonly shareIndex: Pick<ShareSessionIndex, 'visibleClients'>;
}

/**
 * 把每个设备的窗口内存聚合推给「连了这台设备」的非分享会话。
 * 变化检测与 30 s 心跳由 tracker 完成，这里只做直通扇出；走与 DEVICE_LATENCY 相同的优先通道。
 */
export class WindowMemoryBroadcast implements WindowMemoryRuntimeHost {
  private readonly attached = new Map<string, DeviceSessionRuntime>();

  constructor(private readonly host: WindowMemoryBroadcastHost) {}

  attach(deviceId: string, runtime: DeviceSessionRuntime): () => void {
    this.attached.set(deviceId, runtime);
    const unsubscribe = runtime.onWindowMemory?.((windows) =>
      this.publish(deviceId, runtime, windows)
    );
    return () => {
      unsubscribe?.();
      if (this.attached.get(deviceId) === runtime) this.attached.delete(deviceId);
    };
  }

  handleDeviceConnected(session: GatewaySession, deviceId: string): void {
    const entry = this.host.connections.get(deviceId);
    if (!entry) return;
    if (!entry.clients.has(session) && !entry.canonicalClients?.has(session)) return;
    const windows = entry.runtime.getWindowMemory?.() ?? [];
    if (windows.length === 0) return;
    for (const target of this.host.shareIndex.visibleClients([session], deviceId, null)) {
      this.sendWindows(target, deviceId, windows);
    }
  }

  getRuntime(deviceId: string): DeviceSessionRuntime | undefined {
    return this.attached.get(deviceId);
  }

  requestTickAll(): void {
    for (const runtime of this.attached.values()) {
      void Promise.resolve(runtime.tickWindowMemory?.()).catch(() => {});
    }
  }

  private publish(
    deviceId: string,
    runtime: DeviceSessionRuntime,
    windows: WindowMemoryAggregate[]
  ): void {
    const entry = this.host.connections.get(deviceId);
    if (!entry || entry.runtime !== runtime || windows.length === 0) return;
    const sessions = [...this.host.shareIndex.visibleClients(sessionsOf(entry), deviceId, null)];
    if (sessions.length === 0) return;
    for (const window of windows) {
      const payload = encodeWindowMemoryPayload(deviceId, window);
      for (const session of sessions) this.sendEncoded(session, payload);
    }
  }

  private sendWindows(
    session: GatewaySession,
    deviceId: string,
    windows: WindowMemoryAggregate[]
  ): void {
    for (const window of windows) {
      this.sendEncoded(session, encodeWindowMemoryPayload(deviceId, window));
    }
  }

  private sendEncoded(session: GatewaySession, payload: Uint8Array): boolean {
    if (session.closed || !session.borshState.negotiated) return false;
    const carrier = session.activeCarrier;
    const hasPriorityLane = typeof carrier.sendPriority === 'function';
    if (!hasPriorityLane && gatewayWebSocketSendGuard.isBackpressured(carrier)) return false;
    const state = session.borshState;
    const frames = encodePayloadFrames(
      wsBorsh.KIND_WINDOW_MEMORY,
      payload,
      state.seqGen,
      state.maxFrameBytes
    );
    const status = gatewayWebSocketSendGuard.sendPriorityFrames(
      carrier,
      frames as readonly BufferSource[]
    );
    return status === 'sent';
  }
}

export function bindWindowMemoryBroadcast(instance: WindowMemoryBroadcast | null): void {
  bindWindowMemoryRuntimeHost(instance);
}

function encodeWindowMemoryPayload(deviceId: string, window: WindowMemoryAggregate): Uint8Array {
  return wsBorsh.encodePayload(wsBorsh.WindowMemorySchema, {
    deviceId,
    windowId: window.windowId,
    current: BigInt(window.current),
    high: BigInt(window.high),
    max: BigInt(window.max),
    swapMax: BigInt(window.swapMax),
    oomKills: window.oomKills >>> 0,
    oomFlag: window.oomFlag,
    panes: Math.min(255, Math.max(0, window.panes)),
    sampledAt: BigInt(window.sampledAt),
  });
}

function sessionsOf(entry: DeviceConnectionEntry): Set<GatewaySession> {
  if (!entry.canonicalClients?.size) return entry.clients;
  const sessions = new Set(entry.clients);
  for (const session of entry.canonicalClients) sessions.add(session);
  return sessions;
}
