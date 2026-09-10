import { wsBorsh } from '@vibeterm/shared';
import { rttChangedMaterially } from '../mesh/address-class';
import type { DeviceSessionRuntime } from '../tmux-client/device-session-runtime';
import type { HostLatencySample } from '../tmux-client/host-latency-tracker';
import { encodePayloadFrames } from './borsh/codec-borsh';
import type { GatewaySession } from './gateway-session';
import type { DeviceConnectionEntry } from './types';
import { gatewayWebSocketSendGuard } from './websocket-send-guard';

/** 估计没有实质变化时的最低重发间隔，兜住「一直在变但都不显著」的情况。 */
export const DEVICE_LATENCY_REFRESH_MS = 15_000;

export interface DeviceLatencyBroadcastHost {
  readonly connections: Map<string, DeviceConnectionEntry>;
}

interface LastSent {
  rttMs: number;
  at: number;
}

/**
 * 把每个设备的宿主一跳延迟推给「连了这台设备」的会话：估计有实质变化，或距上次下发满
 * 15 s 才发一帧，走与 PONG 相同的优先通道，不排在终端输出后面。
 */
export class DeviceLatencyBroadcast {
  private readonly lastSent = new Map<string, LastSent>();

  constructor(
    private readonly host: DeviceLatencyBroadcastHost,
    private readonly now: () => number = () => Date.now()
  ) {}

  /** 运行时挂载时接上监听与探针闸门，返回值在运行时分离时调用。 */
  attach(deviceId: string, runtime: DeviceSessionRuntime): () => void {
    runtime.setHostLatencyProbeGate?.(() => this.hasSessions(deviceId, runtime));
    const unsubscribe = runtime.onHostLatency?.((sample) =>
      this.publish(deviceId, runtime, sample)
    );
    return () => {
      runtime.setHostLatencyProbeGate?.(null);
      unsubscribe?.();
      this.lastSent.delete(deviceId);
    };
  }

  /** 会话刚连上设备：已有估计就立刻单发一帧，不等下一次变化。 */
  handleDeviceConnected(session: GatewaySession, deviceId: string): void {
    const entry = this.host.connections.get(deviceId);
    const sample = entry?.runtime.getHostLatency?.();
    if (!sample) return;
    this.sendTo(session, deviceId, sample);
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
    const due =
      !last ||
      rttChangedMaterially(last.rttMs, sample.rttMs) ||
      now - last.at >= DEVICE_LATENCY_REFRESH_MS;
    if (!due) return;
    let sent = false;
    for (const session of sessionsOf(entry)) {
      if (this.sendTo(session, deviceId, sample)) sent = true;
    }
    if (sent) this.lastSent.set(deviceId, { rttMs: sample.rttMs, at: now });
  }

  private sendTo(session: GatewaySession, deviceId: string, sample: HostLatencySample): boolean {
    if (session.closed || !session.borshState.negotiated) return false;
    const payload = wsBorsh.encodePayload(wsBorsh.schema.DeviceLatencySchema, {
      deviceId,
      rttMs: sample.rttMs,
      rawMs: sample.rawMs,
      hop: sample.hop,
      sampledAt: BigInt(sample.sampledAt),
    });
    const state = session.borshState;
    const frames = encodePayloadFrames(
      wsBorsh.KIND_DEVICE_LATENCY,
      payload,
      state.seqGen,
      state.maxFrameBytes
    );
    const status = gatewayWebSocketSendGuard.sendPriorityFrames(
      session.activeCarrier,
      frames as readonly BufferSource[]
    );
    return status === 'sent';
  }

  private hasSessions(deviceId: string, runtime: DeviceSessionRuntime): boolean {
    const entry = this.host.connections.get(deviceId);
    if (!entry || entry.runtime !== runtime) return false;
    return entry.clients.size > 0 || Boolean(entry.canonicalClients?.size);
  }
}

function sessionsOf(entry: DeviceConnectionEntry): Set<GatewaySession> {
  if (!entry.canonicalClients?.size) return entry.clients;
  const sessions = new Set(entry.clients);
  for (const session of entry.canonicalClients) sessions.add(session);
  return sessions;
}
