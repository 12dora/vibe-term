import { wsBorsh } from '@vibeterm/shared';
import { rttChangedMaterially } from '../mesh/address-class';
import type { DeviceSessionRuntime } from '../tmux-client/device-session-runtime';
import type { HostLatencySample } from '../tmux-client/host-latency-tracker';
import { encodePayloadFrames } from './borsh/codec-borsh';
import type { GatewaySession } from './gateway-session';
import type { ShareSessionIndex } from './share-session-index';
import type { DeviceConnectionEntry } from './types';
import { gatewayWebSocketSendGuard } from './websocket-send-guard';

/** 估计没有实质变化时的最低重发间隔，兜住「一直在变但都不显著」的情况。 */
export const DEVICE_LATENCY_REFRESH_MS = 15_000;
/** 实质变化后的最短下发间隔，避免本机 0–3 ms 抖动按键就推一帧。 */
export const DEVICE_LATENCY_MIN_INTERVAL_MS = 5_000;
/** 本机一跳抖动低于此值一律视为噪声，不走材料性变化。 */
const DEVICE_LATENCY_MATERIAL_FLOOR_MS = 2;

export interface DeviceLatencyBroadcastHost {
  readonly connections: Map<string, DeviceConnectionEntry>;
  readonly shareIndex: Pick<ShareSessionIndex, 'visibleClients'>;
}

export type DeviceLatencySchedule = {
  setTimeout: (callback: () => void, delayMs: number) => unknown;
  clearTimeout: (timer: unknown) => void;
};

interface LastSent {
  rttMs: number;
  at: number;
}

const defaultSchedule: DeviceLatencySchedule = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => {
    clearTimeout(timer as ReturnType<typeof setTimeout>);
  },
};

/**
 * 把每个设备的宿主一跳延迟推给「连了这台设备」的非分享会话：实质变化且间隔够，或距上次下发满
 * 15 s 才发一帧，走与 PONG 相同的优先通道。载体有优先通道时背压中也照发——这帧不到 64 字节，
 * 而且正是队列积压时必须挤出去的那一帧；没有优先通道的载体（浏览器直连 socket）仍然跳过。
 */
export class DeviceLatencyBroadcast {
  private readonly lastSent = new Map<string, LastSent>();
  private readonly refreshTimers = new Map<string, unknown>();

  constructor(
    private readonly host: DeviceLatencyBroadcastHost,
    private readonly now: () => number = () => Date.now(),
    private readonly schedule: DeviceLatencySchedule = defaultSchedule
  ) {}

  /** 运行时挂载时接上监听与探针闸门，返回值在运行时分离时调用。 */
  attach(deviceId: string, runtime: DeviceSessionRuntime): () => void {
    runtime.setHostLatencyProbeGate?.(() => this.hasSessions(deviceId, runtime));
    const unsubscribe = runtime.onHostLatency?.((sample) =>
      this.publish(deviceId, runtime, sample)
    );
    return () => {
      this.clearRefresh(deviceId);
      runtime.setHostLatencyProbeGate?.(null);
      unsubscribe?.();
      this.lastSent.delete(deviceId);
    };
  }

  /** 会话刚连上设备：已有估计就立刻单发一帧，不等下一次变化。 */
  handleDeviceConnected(session: GatewaySession, deviceId: string): void {
    const entry = this.host.connections.get(deviceId);
    if (!entry) return;
    if (!entry.clients.has(session) && !entry.canonicalClients?.has(session)) return;
    const sample = entry.runtime.getHostLatency?.();
    if (!sample) return;
    for (const target of this.host.shareIndex.visibleClients([session], deviceId, null)) {
      this.sendEncoded(target, encodeDeviceLatencyPayload(deviceId, sample));
    }
    this.armRefresh(deviceId, entry.runtime);
  }

  private publish(
    deviceId: string,
    runtime: DeviceSessionRuntime,
    sample: HostLatencySample
  ): void {
    const entry = this.host.connections.get(deviceId);
    if (!entry || entry.runtime !== runtime) return;
    const last = this.lastSent.get(deviceId);
    const now = this.now();
    if (shouldPublish(last, sample.rttMs, now)) {
      const sessions = [...this.host.shareIndex.visibleClients(sessionsOf(entry), deviceId, null)];
      if (sessions.length > 0) {
        const payload = encodeDeviceLatencyPayload(deviceId, sample);
        let sent = false;
        for (const session of sessions) {
          if (this.sendEncoded(session, payload)) sent = true;
        }
        if (sent) this.lastSent.set(deviceId, { rttMs: sample.rttMs, at: now });
      }
    }
    // refresh 触发时定时器已从 map 摘掉；早退也要续心跳，否则 1 ms 提前开火会把链掐断。
    this.armRefresh(deviceId, runtime);
  }

  private sendEncoded(session: GatewaySession, payload: Uint8Array): boolean {
    if (session.closed || !session.borshState.negotiated) return false;
    const carrier = session.activeCarrier;
    const hasPriorityLane = typeof carrier.sendPriority === 'function';
    if (!hasPriorityLane && gatewayWebSocketSendGuard.isBackpressured(carrier)) return false;
    const state = session.borshState;
    const frames = encodePayloadFrames(
      wsBorsh.KIND_DEVICE_LATENCY,
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

  private hasSessions(deviceId: string, runtime: DeviceSessionRuntime): boolean {
    const entry = this.host.connections.get(deviceId);
    if (!entry || entry.runtime !== runtime) return false;
    return entry.clients.size > 0 || Boolean(entry.canonicalClients?.size);
  }

  private armRefresh(deviceId: string, runtime: DeviceSessionRuntime): void {
    this.clearRefresh(deviceId);
    if (!this.hasSessions(deviceId, runtime)) return;
    if (!runtime.getHostLatency?.()) return;
    const last = this.lastSent.get(deviceId);
    const elapsed = last ? this.now() - last.at : Number.POSITIVE_INFINITY;
    const delay =
      elapsed >= DEVICE_LATENCY_REFRESH_MS
        ? DEVICE_LATENCY_REFRESH_MS
        : DEVICE_LATENCY_REFRESH_MS - elapsed;
    const timer = this.schedule.setTimeout(() => {
      this.refreshTimers.delete(deviceId);
      this.refresh(deviceId, runtime);
    }, delay);
    this.refreshTimers.set(deviceId, timer);
  }

  private clearRefresh(deviceId: string): void {
    const timer = this.refreshTimers.get(deviceId);
    if (timer === undefined) return;
    this.schedule.clearTimeout(timer);
    this.refreshTimers.delete(deviceId);
  }

  private refresh(deviceId: string, runtime: DeviceSessionRuntime): void {
    if (!this.hasSessions(deviceId, runtime)) return;
    const sample = runtime.getHostLatency?.();
    if (!sample) return;
    this.publish(deviceId, runtime, sample);
  }
}

function encodeDeviceLatencyPayload(deviceId: string, sample: HostLatencySample): Uint8Array {
  return wsBorsh.encodePayload(wsBorsh.schema.DeviceLatencySchema, {
    deviceId,
    rttMs: sample.rttMs,
    rawMs: sample.rawMs,
    hop: sample.hop,
    sampledAt: BigInt(sample.sampledAt),
  });
}

function shouldPublish(last: LastSent | undefined, rttMs: number, now: number): boolean {
  if (!last) return true;
  if (now - last.at >= DEVICE_LATENCY_REFRESH_MS) return true;
  if (now - last.at < DEVICE_LATENCY_MIN_INTERVAL_MS) return false;
  return hostRttChangedMaterially(last.rttMs, rttMs);
}

function hostRttChangedMaterially(prev: number, next: number): boolean {
  if (Math.abs(next - prev) < DEVICE_LATENCY_MATERIAL_FLOOR_MS) return false;
  return rttChangedMaterially(prev, next);
}

function sessionsOf(entry: DeviceConnectionEntry): Set<GatewaySession> {
  if (!entry.canonicalClients?.size) return entry.clients;
  const sessions = new Set(entry.clients);
  for (const session of entry.canonicalClients) sessions.add(session);
  return sessions;
}
