import { wsBorsh } from '@tmex/shared';
import { envInt } from './mesh-log';

export const FAILOVER_HISTORY_BYTES_PER_PANE_DEFAULT = 256 * 1024;
export const FAILOVER_HISTORY_BYTES_TOTAL = 1024 * 1024;

export type LegacyReplayStats = {
  replayBytes: number;
  historyPanes: number;
  skippedPanes: string[];
};

export type InboundReplayNote = { kind: number | null; deviceId?: string };

export class StreamReplayState {
  hello: Uint8Array | null = null;
  helloForwarded = false;
  readonly devices = new Map<string, Uint8Array>();
  readonly connectedForwarded = new Set<string>();
  readonly paneSubs = new Map<string, Uint8Array>();
  readonly lastSelect = new Map<string, Uint8Array>();
  readonly agents = new Map<string, Uint8Array>();
  canonicalSub: {
    generation: bigint;
    activePanes: wsBorsh.CanonicalPaneSubscription[];
    hotPanes: wsBorsh.CanonicalPaneSubscription[];
    seq: number;
  } | null = null;
  readonly paneCursors = new Map<
    string,
    { paneEpoch: Uint8Array; terminalSeq: bigint; pane: wsBorsh.CanonicalPaneTarget }
  >();
  private outboundSeq = 1;
  private readonly resumeDevices = new Set<string>();
  private resumeSnapshot = false;
  private resumeGeneration: bigint | null = null;
  private lastLegacyReplay: LegacyReplayStats = {
    replayBytes: 0,
    historyPanes: 0,
    skippedPanes: [],
  };

  legacyReplayStats(): LegacyReplayStats {
    return {
      replayBytes: this.lastLegacyReplay.replayBytes,
      historyPanes: this.lastLegacyReplay.historyPanes,
      skippedPanes: [...this.lastLegacyReplay.skippedPanes],
    };
  }

  private tryDecodeEnvelope(bytes: Uint8Array): wsBorsh.Envelope | null {
    try {
      return wsBorsh.decodeEnvelope(bytes);
    } catch {
      return null;
    }
  }

  noteOutbound(bytes: Uint8Array): void {
    const env = this.tryDecodeEnvelope(bytes);
    if (!env) return;
    this.outboundSeq = env.seq;
    try {
      switch (env.kind) {
        case wsBorsh.KIND_HELLO_C2S:
          this.hello = bytes.slice();
          return;
        case wsBorsh.KIND_DEVICE_CONNECT: {
          const payload = wsBorsh.decodePayload(wsBorsh.schema.DeviceConnectSchema, env.payload);
          this.devices.set(payload.deviceId, bytes.slice());
          return;
        }
        case wsBorsh.KIND_DEVICE_DISCONNECT: {
          const payload = wsBorsh.decodePayload(wsBorsh.schema.DeviceDisconnectSchema, env.payload);
          this.devices.delete(payload.deviceId);
          this.paneSubs.delete(payload.deviceId);
          this.lastSelect.delete(payload.deviceId);
          this.connectedForwarded.delete(payload.deviceId);
          return;
        }
        case wsBorsh.KIND_TMUX_SUBSCRIBE_PANES: {
          const payload = wsBorsh.decodePayload(
            wsBorsh.schema.TmuxSubscribePanesSchema,
            env.payload
          );
          if (payload.paneIds.length === 0) this.paneSubs.delete(payload.deviceId);
          else this.paneSubs.set(payload.deviceId, bytes.slice());
          return;
        }
        case wsBorsh.KIND_TMUX_SELECT: {
          const payload = wsBorsh.decodePayload(wsBorsh.schema.TmuxSelectSchema, env.payload);
          this.lastSelect.set(payload.deviceId, bytes.slice());
          return;
        }
        case wsBorsh.KIND_AGENT_SUBSCRIBE: {
          const payload = wsBorsh.decodePayload(wsBorsh.schema.AgentSubscribeSchema, env.payload);
          this.agents.set(payload.sessionId, bytes.slice());
          return;
        }
        case wsBorsh.KIND_AGENT_UNSUBSCRIBE: {
          const payload = wsBorsh.decodePayload(wsBorsh.schema.AgentUnsubscribeSchema, env.payload);
          this.agents.delete(payload.sessionId);
          return;
        }
        case wsBorsh.KIND_CANONICAL_COMMAND: {
          const command = wsBorsh.decodeCanonicalCommandPayload(env.payload).command;
          if ('SetPaneSubscriptions' in command) {
            const value = command.SetPaneSubscriptions;
            this.canonicalSub = {
              generation: value.generation,
              activePanes: value.activePanes,
              hotPanes: value.hotPanes,
              seq: env.seq,
            };
          }
        }
      }
    } catch {}
  }

  noteInbound(bytes: Uint8Array): InboundReplayNote {
    const env = this.tryDecodeEnvelope(bytes);
    if (!env) return { kind: null };
    if (env.kind === wsBorsh.KIND_DEVICE_CONNECTED) {
      try {
        const payload = wsBorsh.decodePayload(wsBorsh.schema.DeviceConnectedSchema, env.payload);
        this.resumeDevices.add(payload.deviceId);
        return { kind: env.kind, deviceId: payload.deviceId };
      } catch {
        return { kind: env.kind };
      }
    }
    if (env.kind === wsBorsh.KIND_STATE_SNAPSHOT || env.kind === wsBorsh.KIND_CHUNK) {
      if (this.resumeDevices.size > 0) this.resumeSnapshot = true;
      return { kind: env.kind };
    }
    if (env.kind !== wsBorsh.KIND_CANONICAL_EVENT) return { kind: env.kind };
    try {
      const header = wsBorsh.peekCanonicalPaneDataHeader(env.payload);
      if (header) {
        this.paneCursors.set(paneCursorKey(header.pane.deviceId, header.pane.paneId), {
          pane: header.pane,
          paneEpoch: header.paneEpoch,
          terminalSeq: header.seqEnd,
        });
        return { kind: env.kind };
      }
      wsBorsh.decodeCanonicalEventPayload(env.payload);
    } catch {}
    return { kind: env.kind };
  }

  beginResume(): void {
    this.resumeDevices.clear();
    this.resumeSnapshot = false;
    this.resumeGeneration = null;
  }

  isResumeReady(): boolean {
    for (const deviceId of this.devices.keys()) {
      if (!this.resumeDevices.has(deviceId)) return false;
    }
    if (this.devices.size > 0 && this.paneSubs.size > 0 && !this.resumeSnapshot) return false;
    return true;
  }

  buildConnectFrames(): Uint8Array[] {
    return [...this.devices.values()];
  }

  buildPostConnectFrames(): Uint8Array[] {
    const canonical = this.buildCanonicalResume();
    return [
      ...(canonical ? [canonical] : []),
      ...this.paneSubs.values(),
      ...this.lastSelect.values(),
      ...this.buildLegacyHistoryRequests(),
      ...this.agents.values(),
    ];
  }

  markCanonicalResumeSent(): void {
    if (!this.canonicalSub) return;
    const sent = this.canonicalSub.generation + 1n;
    this.canonicalSub = { ...this.canonicalSub, generation: sent };
    this.resumeGeneration = sent;
  }

  rewriteQueuedFrame(bytes: Uint8Array): Uint8Array | null {
    const env = this.tryDecodeEnvelope(bytes);
    if (!env) return bytes;
    if (env.kind !== wsBorsh.KIND_CANONICAL_COMMAND) return bytes;
    try {
      const command = wsBorsh.decodeCanonicalCommandPayload(env.payload).command;
      if (!('SetPaneSubscriptions' in command)) return bytes;
      const value = command.SetPaneSubscriptions;
      const floor = this.resumeGeneration ?? 0n;
      const generation = value.generation > floor ? value.generation : floor + 1n;
      this.canonicalSub = {
        generation,
        activePanes: value.activePanes,
        hotPanes: value.hotPanes,
        seq: env.seq,
      };
      this.resumeGeneration = generation;
      return wsBorsh.encodeEnvelope(
        wsBorsh.KIND_CANONICAL_COMMAND,
        wsBorsh.encodeCanonicalCommandPayload({
          SetPaneSubscriptions: {
            generation,
            activePanes: value.activePanes,
            hotPanes: value.hotPanes,
          },
        }),
        env.seq
      );
    } catch {
      return bytes;
    }
  }

  describeReplay(): { mode: string; panes: string; cursor: string } {
    const rows = this.canonicalRows();
    if (rows) {
      return {
        mode: 'canonical',
        panes: rows.map((row) => row.pane.paneId).join(',') || '-',
        cursor:
          rows
            .map((row) => {
              const cursor = this.paneCursors.get(
                paneCursorKey(row.pane.deviceId, row.pane.paneId)
              );
              return `${row.pane.paneId}:${cursor ? cursor.terminalSeq : '-'}`;
            })
            .join(',') || '-',
      };
    }
    const paneIds = this.paneSubPayloads().flatMap((row) => row?.paneIds ?? []);
    return {
      mode: paneIds.length > 0 ? 'legacy' : 'none',
      panes: paneIds.join(',') || '-',
      cursor: '-',
    };
  }

  resumedPaneCount(): number {
    const rows = this.canonicalRows();
    if (rows) {
      return new Set(rows.map((row) => paneCursorKey(row.pane.deviceId, row.pane.paneId))).size;
    }
    let count = 0;
    for (const row of this.paneSubPayloads()) count += row ? row.paneIds.length : 1;
    return count;
  }

  private canonicalRows(): wsBorsh.CanonicalPaneSubscription[] | null {
    return this.canonicalSub
      ? [...this.canonicalSub.activePanes, ...this.canonicalSub.hotPanes]
      : null;
  }

  private paneSubPayloads(): Array<{ deviceId: string; paneIds: string[] } | null> {
    const out: Array<{ deviceId: string; paneIds: string[] } | null> = [];
    for (const frame of this.paneSubs.values()) {
      const env = this.tryDecodeEnvelope(frame);
      if (!env) {
        out.push(null);
        continue;
      }
      try {
        out.push(wsBorsh.decodePayload(wsBorsh.schema.TmuxSubscribePanesSchema, env.payload));
      } catch {
        out.push(null);
      }
    }
    return out;
  }

  private buildLegacyHistoryRequests(): Uint8Array[] {
    if (this.canonicalSub) {
      this.lastLegacyReplay = { replayBytes: 0, historyPanes: 0, skippedPanes: [] };
      return [];
    }
    const perPane = envInt(
      'TMEX_FAILOVER_HISTORY_BYTES_PER_PANE',
      FAILOVER_HISTORY_BYTES_PER_PANE_DEFAULT
    );
    const frames: Uint8Array[] = [];
    const skippedPanes: string[] = [];
    const seen = new Set<string>();
    let replayBytes = 0;
    let historyPanes = 0;
    for (const row of this.paneSubPayloads()) {
      if (!row) continue;
      for (const paneId of row.paneIds) {
        const key = `${row.deviceId}\0${paneId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (perPane <= 0 || replayBytes + perPane > FAILOVER_HISTORY_BYTES_TOTAL) {
          skippedPanes.push(paneId);
          continue;
        }
        const requestToken = new Uint8Array(16);
        crypto.getRandomValues(requestToken);
        this.outboundSeq += 1;
        frames.push(
          wsBorsh.encodeEnvelope(
            wsBorsh.KIND_TMUX_FETCH_PANE_HISTORY,
            wsBorsh.encodePayload(wsBorsh.schema.TmuxFetchPaneHistorySchema, {
              deviceId: row.deviceId,
              paneId,
              requestToken,
            }),
            this.outboundSeq
          )
        );
        replayBytes += perPane;
        historyPanes += 1;
      }
    }
    this.lastLegacyReplay = { replayBytes, historyPanes, skippedPanes };
    return frames;
  }

  private buildCanonicalResume(): Uint8Array | null {
    if (!this.canonicalSub) return null;
    const patch = (row: wsBorsh.CanonicalPaneSubscription): wsBorsh.CanonicalPaneSubscription => {
      const cursor = this.paneCursors.get(paneCursorKey(row.pane.deviceId, row.pane.paneId));
      if (!cursor) return row;
      return {
        pane: row.pane,
        cursor: { paneEpoch: cursor.paneEpoch, terminalSeq: cursor.terminalSeq },
      };
    };
    const payload = wsBorsh.encodeCanonicalCommandPayload({
      SetPaneSubscriptions: {
        generation: this.canonicalSub.generation + 1n,
        activePanes: this.canonicalSub.activePanes.map(patch),
        hotPanes: this.canonicalSub.hotPanes.map(patch),
      },
    });
    return wsBorsh.encodeEnvelope(
      wsBorsh.KIND_CANONICAL_COMMAND,
      payload,
      this.canonicalSub.seq || this.outboundSeq
    );
  }
}

function paneCursorKey(deviceId: string, paneId: string): string {
  return `${deviceId}\0${paneId}`;
}
