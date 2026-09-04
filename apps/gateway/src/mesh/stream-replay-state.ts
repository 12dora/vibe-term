import { wsBorsh } from '@tmex/shared';
import { ERROR_CANONICAL_V11_REQUIRED, peerNodeTooOldMessage } from '../ws/canonical-gate';
import { ViewportReplayCache } from './stream-replay-state-viewport';

export type InboundReplayNote = {
  kind: number | null;
  deviceId?: string;
  /** HELLO_S2C 帧上附带：对端节点是否达不到 canonical v1.1 门槛。 */
  peerUnsupported?: boolean;
};

export interface StaleNodeStreamPump {
  id: string;
  nodeId: string;
  replay: StreamReplayState;
}

/**
 * 对端节点低于 canonical v1.1 门槛（含 HELLO 未答/解不出版本）：不回退 legacy 状态流，
 * 直接向浏览器发 ERROR，并整条拆掉（上游流 + 在途流 + 浏览器）。返回是否已拒绝。
 */
export function rejectStaleNodeStream<P extends StaleNodeStreamPump>(
  unsupported: boolean | undefined,
  pump: P,
  io: {
    log(line: string): void;
    sendToBrowser(pump: P, bytes: Uint8Array): void;
    closePump(pump: P, info: { code?: number; reason?: string }): void;
  }
): boolean {
  if (!unsupported) return false;
  const message = peerNodeTooOldMessage(pump.nodeId, pump.replay.peerVersion);
  io.log(`[mesh][stream] stream=${pump.id} node=${pump.nodeId} rejected: ${message}`);
  try {
    io.sendToBrowser(
      pump,
      wsBorsh.encodeEnvelope(
        wsBorsh.KIND_ERROR,
        wsBorsh.encodePayload(wsBorsh.schema.ErrorSchema, {
          refSeq: null,
          code: ERROR_CANONICAL_V11_REQUIRED,
          message,
          retryable: false,
        }),
        1
      )
    );
  } catch {}
  io.closePump(pump, { code: 1002, reason: 'node-too-old' });
  return true;
}

type PendingScreenTransaction = {
  pane: wsBorsh.CanonicalPaneTarget;
  paneEpoch: Uint8Array;
  baseSeq: bigint;
  totalBytes: number;
  nextOffset: number;
};

export class StreamReplayState {
  hello: Uint8Array | null = null;
  helloForwarded = false;
  readonly devices = new Map<string, Uint8Array>();
  readonly connectedForwarded = new Set<string>();
  readonly agents = new Map<string, Uint8Array>();
  /** 对端节点在 HELLO_S2C 里播报的版本；低于 canonical v1.1 门槛时整条流不可用。 */
  peerVersion: string | null = null;
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
  private readonly canonicalTargets = new Map<string, wsBorsh.CanonicalPaneSubscription>();
  private readonly viewport = new ViewportReplayCache();
  private readonly screenTransactions = new Map<string, PendingScreenTransaction>();
  private outboundSeq = 1;
  private clientMaxFrameBytes = wsBorsh.DEFAULT_MAX_FRAME_BYTES;
  private serverMaxFrameBytes = wsBorsh.DEFAULT_MAX_FRAME_BYTES;
  private readonly resumeDevices = new Set<string>();
  private resumeGeneration: bigint | null = null;
  private canonicalResourceGapQueued = false;
  private lastBrowserSignals: Uint8Array[] = [];

  /** fail-closed：版本未知或过旧都视为不支持 canonical v1.1。 */
  peerSupportsCanonical(): boolean {
    return wsBorsh.peerSupportsCanonicalV11(this.peerVersion);
  }

  browserSignalFrames(): Uint8Array[] {
    return this.lastBrowserSignals.map((frame) => frame.slice());
  }

  private tryDecodeEnvelope(bytes: Uint8Array): wsBorsh.Envelope | null {
    try {
      return wsBorsh.decodeEnvelopeView(bytes);
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
        case wsBorsh.KIND_HELLO_C2S: {
          this.hello = bytes.slice();
          const payload = wsBorsh.decodePayload(wsBorsh.schema.HelloC2SSchema, env.payload);
          this.clientMaxFrameBytes = payload.maxFrameBytes;
          return;
        }
        case wsBorsh.KIND_DEVICE_CONNECT: {
          const payload = wsBorsh.decodePayload(wsBorsh.schema.DeviceConnectSchema, env.payload);
          this.devices.set(payload.deviceId, bytes.slice());
          return;
        }
        case wsBorsh.KIND_DEVICE_DISCONNECT: {
          const payload = wsBorsh.decodePayload(wsBorsh.schema.DeviceDisconnectSchema, env.payload);
          this.devices.delete(payload.deviceId);
          this.connectedForwarded.delete(payload.deviceId);
          this.removeCanonicalDevice(payload.deviceId);
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
            this.reconcilePaneCursors(value.activePanes, value.hotPanes);
            return;
          }
          if ('ResizePaneV11' in command) this.viewport.noteResize(command.ResizePaneV11, env.seq);
          return;
        }
        default:
          this.viewport.noteFrame(env, bytes);
      }
    } catch {}
  }

  noteInbound(bytes: Uint8Array): InboundReplayNote {
    const env = this.tryDecodeEnvelope(bytes);
    if (!env) return { kind: null };
    if (env.kind === wsBorsh.KIND_HELLO_S2C) {
      try {
        const payload = wsBorsh.decodePayload(wsBorsh.schema.HelloS2CSchema, env.payload);
        this.serverMaxFrameBytes = payload.maxFrameBytes;
        this.peerVersion = payload.serverVersion;
      } catch {
        // 解不出 HELLO 就当版本未知：fail-closed，不能继承上一条流的判定。
        this.peerVersion = null;
      }
      return { kind: env.kind, peerUnsupported: !this.peerSupportsCanonical() };
    }
    if (env.kind === wsBorsh.KIND_DEVICE_CONNECTED) {
      try {
        const payload = wsBorsh.decodePayload(wsBorsh.schema.DeviceConnectedSchema, env.payload);
        this.resumeDevices.add(payload.deviceId);
        return { kind: env.kind, deviceId: payload.deviceId };
      } catch {
        return { kind: env.kind };
      }
    }
    if (env.kind !== wsBorsh.KIND_CANONICAL_EVENT) return { kind: env.kind };
    try {
      const header = wsBorsh.peekCanonicalPaneDataHeader(env.payload);
      if (header) {
        this.recordPaneCursor(header.pane, header.paneEpoch, header.seqEnd, false);
        return { kind: env.kind };
      }
      this.noteCanonicalEvent(wsBorsh.decodeCanonicalEventPayload(env.payload).event);
    } catch {}
    return { kind: env.kind };
  }

  beginResume(): void {
    // 新流要重新握手：版本判定不能沿用上一条流的结果。
    this.peerVersion = null;
    this.resumeDevices.clear();
    this.resumeGeneration = null;
    this.lastBrowserSignals = [];
    this.canonicalResourceGapQueued = false;
    this.screenTransactions.clear();
  }

  isResumeReady(): boolean {
    for (const deviceId of this.devices.keys()) {
      if (!this.resumeDevices.has(deviceId)) return false;
    }
    return true;
  }

  buildConnectFrames(): Uint8Array[] {
    const devices = [...this.devices.values()];
    if (!this.canonicalSub || devices.length === 0) return devices;
    const bootstrap = this.buildCanonicalBootstrap();
    return bootstrap ? [bootstrap, ...devices] : [];
  }

  buildPostConnectFrames(): Uint8Array[] {
    const canonical = this.buildCanonicalResume();
    return [
      ...(canonical ? [canonical] : []),
      ...this.viewport.replayFrames(),
      ...this.agents.values(),
    ];
  }

  viewportReplayFrames(): Uint8Array[] {
    return this.viewport.replayFrames();
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
    if (env.kind === wsBorsh.KIND_CHUNK) {
      try {
        if (wsBorsh.decodeChunk(env.payload).originalKind === wsBorsh.KIND_CANONICAL_COMMAND) {
          this.queueCanonicalResourceGap();
          return null;
        }
      } catch {}
      return bytes;
    }
    if (env.kind !== wsBorsh.KIND_CANONICAL_COMMAND) return bytes;
    let command: wsBorsh.CanonicalCommand;
    try {
      command = wsBorsh.decodeCanonicalCommandPayload(env.payload).command;
    } catch {
      if (this.canonicalFrameFits(bytes)) return bytes;
      this.queueCanonicalResourceGap();
      return null;
    }
    if ('SetPaneSubscriptions' in command) {
      return this.rewriteQueuedSubscription(env.seq, command.SetPaneSubscriptions);
    }
    if (this.canonicalFrameFits(bytes)) return bytes;
    this.queueCanonicalResourceGap();
    return null;
  }

  private rewriteQueuedSubscription(
    seq: number,
    value: Extract<
      wsBorsh.CanonicalCommand,
      { SetPaneSubscriptions: unknown }
    >['SetPaneSubscriptions']
  ): Uint8Array | null {
    const floor = this.resumeGeneration ?? 0n;
    const generation = value.generation > floor ? value.generation : floor + 1n;
    this.canonicalSub = {
      generation,
      activePanes: value.activePanes,
      hotPanes: value.hotPanes,
      seq,
    };
    this.reconcilePaneCursors(value.activePanes, value.hotPanes);
    this.resumeGeneration = generation;
    const frame = this.tryEncodeCanonicalSubscription(
      generation,
      value.activePanes,
      value.hotPanes
    );
    if (frame) return frame;

    const withoutCursor = (row: wsBorsh.CanonicalPaneSubscription) => ({
      pane: row.pane,
      cursor: null,
    });
    const activePanes = value.activePanes.map(withoutCursor);
    const hotPanes = value.hotPanes.map(withoutCursor);
    this.canonicalSub = { generation, activePanes, hotPanes, seq };
    this.reconcilePaneCursors(activePanes, hotPanes);
    const fallback = this.tryEncodeCanonicalSubscription(generation, activePanes, hotPanes);
    this.queueCanonicalResourceGap();
    return fallback;
  }

  describeReplay(): { mode: string; panes: string; cursor: string } {
    const rows = this.canonicalRows();
    if (!rows) return { mode: 'none', panes: '-', cursor: '-' };
    return {
      mode: 'canonical',
      panes: rows.map((row) => row.pane.paneId).join(',') || '-',
      cursor:
        rows
          .map((row) => {
            const cursor = this.paneCursors.get(paneCursorKey(row.pane.deviceId, row.pane.paneId));
            return `${row.pane.paneId}:${cursor ? cursor.terminalSeq : '-'}`;
          })
          .join(',') || '-',
    };
  }

  resumedPaneCount(): number {
    const rows = this.canonicalRows();
    if (!rows) return 0;
    return new Set(rows.map((row) => paneCursorKey(row.pane.deviceId, row.pane.paneId))).size;
  }

  private canonicalRows(): wsBorsh.CanonicalPaneSubscription[] | null {
    return this.canonicalSub
      ? [...this.canonicalSub.activePanes, ...this.canonicalSub.hotPanes]
      : null;
  }

  private noteCanonicalEvent(event: wsBorsh.CanonicalEvent): void {
    if ('ScreenBegin' in event) {
      this.noteScreenBegin(event.ScreenBegin);
      return;
    }
    if ('ScreenChunk' in event) {
      this.noteScreenChunk(event.ScreenChunk);
      return;
    }
    if ('ScreenCommit' in event) {
      this.noteScreenCommit(event.ScreenCommit);
      return;
    }
    if ('SourceGap' in event) {
      this.noteSourceGap(event.SourceGap);
      return;
    }
    if ('SubscriptionApplied' in event) {
      this.noteSubscriptionApplied(event.SubscriptionApplied);
      return;
    }
    if ('Error' in event && event.Error.requestId) {
      this.screenTransactions.delete(bytesKey(event.Error.requestId));
    }
  }

  private noteScreenBegin(
    begin: Extract<wsBorsh.CanonicalEvent, { ScreenBegin: unknown }>['ScreenBegin']
  ): void {
    if (!this.acceptsPaneCursor(begin.pane, begin.paneEpoch)) return;
    for (const [key, pending] of this.screenTransactions) {
      if (samePaneTarget(pending.pane, begin.pane)) this.screenTransactions.delete(key);
    }
    this.screenTransactions.set(bytesKey(begin.requestId), {
      pane: clonePaneTarget(begin.pane),
      paneEpoch: begin.paneEpoch.slice(),
      baseSeq: begin.baseSeq,
      totalBytes: begin.totalBytes,
      nextOffset: 0,
    });
  }

  private noteScreenChunk(
    chunk: Extract<wsBorsh.CanonicalEvent, { ScreenChunk: unknown }>['ScreenChunk']
  ): void {
    const key = bytesKey(chunk.requestId);
    const pending = this.screenTransactions.get(key);
    if (!pending) return;
    if (
      chunk.offset !== pending.nextOffset ||
      pending.nextOffset + chunk.data.byteLength > pending.totalBytes
    ) {
      this.screenTransactions.delete(key);
      return;
    }
    pending.nextOffset += chunk.data.byteLength;
  }

  private noteScreenCommit(
    commit: Extract<wsBorsh.CanonicalEvent, { ScreenCommit: unknown }>['ScreenCommit']
  ): void {
    const key = bytesKey(commit.requestId);
    const pending = this.screenTransactions.get(key);
    this.screenTransactions.delete(key);
    if (
      !pending ||
      commit.totalBytes !== pending.totalBytes ||
      pending.nextOffset !== pending.totalBytes
    ) {
      return;
    }
    this.recordPaneCursor(pending.pane, pending.paneEpoch, pending.baseSeq, true);
  }

  private noteSourceGap(
    gap: Extract<wsBorsh.CanonicalEvent, { SourceGap: unknown }>['SourceGap']
  ): void {
    if ('Stream' in gap.scope) {
      this.clearCanonicalCursors();
    } else if ('Pane' in gap.scope) {
      this.clearPaneCursor(gap.scope.Pane.pane);
    }
  }

  private noteSubscriptionApplied(
    applied: Extract<
      wsBorsh.CanonicalEvent,
      { SubscriptionApplied: unknown }
    >['SubscriptionApplied']
  ): void {
    for (const rejection of applied.rejected) {
      if (
        rejection.reason === wsBorsh.SUBSCRIPTION_REJECTED_NOT_FOUND ||
        rejection.reason === wsBorsh.SUBSCRIPTION_REJECTED_EPOCH_CHANGED
      ) {
        this.clearPaneCursor(rejection.pane);
      }
    }
  }

  private reconcilePaneCursors(
    activePanes: wsBorsh.CanonicalPaneSubscription[],
    hotPanes: wsBorsh.CanonicalPaneSubscription[]
  ): void {
    const targets = new Map<string, wsBorsh.CanonicalPaneSubscription>();
    for (const row of [...activePanes, ...hotPanes]) {
      const key = paneCursorKey(row.pane.deviceId, row.pane.paneId);
      if (!targets.has(key)) targets.set(key, row);
    }
    this.canonicalTargets.clear();
    for (const [key, row] of targets) this.canonicalTargets.set(key, row);
    for (const key of this.paneCursors.keys()) {
      if (!targets.has(key)) this.paneCursors.delete(key);
    }
    for (const [key, row] of targets) {
      if (!row.cursor) {
        this.paneCursors.delete(key);
        continue;
      }
      const current = this.paneCursors.get(key);
      if (
        current &&
        samePaneTarget(current.pane, row.pane) &&
        bytesEqual(current.paneEpoch, row.cursor.paneEpoch) &&
        current.terminalSeq >= row.cursor.terminalSeq
      ) {
        continue;
      }
      this.paneCursors.set(key, {
        pane: clonePaneTarget(row.pane),
        paneEpoch: row.cursor.paneEpoch.slice(),
        terminalSeq: row.cursor.terminalSeq,
      });
    }
    for (const [key, pending] of this.screenTransactions) {
      const row = targets.get(paneCursorKey(pending.pane.deviceId, pending.pane.paneId));
      if (!row || !samePaneTarget(row.pane, pending.pane)) this.screenTransactions.delete(key);
    }
  }

  private recordPaneCursor(
    pane: wsBorsh.CanonicalPaneTarget,
    paneEpoch: Uint8Array,
    terminalSeq: bigint,
    replace: boolean
  ): void {
    if (!this.acceptsPaneCursor(pane, paneEpoch)) return;
    const key = paneCursorKey(pane.deviceId, pane.paneId);
    const current = this.paneCursors.get(key);
    if (
      !replace &&
      current &&
      samePaneTarget(current.pane, pane) &&
      bytesEqual(current.paneEpoch, paneEpoch) &&
      current.terminalSeq > terminalSeq
    ) {
      return;
    }
    this.paneCursors.set(key, {
      pane: clonePaneTarget(pane),
      paneEpoch: paneEpoch.slice(),
      terminalSeq,
    });
  }

  private acceptsPaneCursor(pane: wsBorsh.CanonicalPaneTarget, paneEpoch: Uint8Array): boolean {
    const row = this.canonicalTargets.get(paneCursorKey(pane.deviceId, pane.paneId));
    return Boolean(
      row &&
        samePaneTarget(row.pane, pane) &&
        (!row.cursor || bytesEqual(row.cursor.paneEpoch, paneEpoch))
    );
  }

  private clearPaneCursor(pane: wsBorsh.CanonicalPaneTarget): void {
    const key = paneCursorKey(pane.deviceId, pane.paneId);
    const current = this.paneCursors.get(key);
    if (current && samePaneTarget(current.pane, pane)) this.paneCursors.delete(key);
    if (this.canonicalSub) {
      const clear = (row: wsBorsh.CanonicalPaneSubscription) =>
        samePaneTarget(row.pane, pane) ? { pane: row.pane, cursor: null } : row;
      this.canonicalSub = {
        ...this.canonicalSub,
        activePanes: this.canonicalSub.activePanes.map(clear),
        hotPanes: this.canonicalSub.hotPanes.map(clear),
      };
    }
    const target = this.canonicalTargets.get(key);
    if (target && samePaneTarget(target.pane, pane)) {
      this.canonicalTargets.set(key, { pane: target.pane, cursor: null });
    }
    for (const [requestId, pending] of this.screenTransactions) {
      if (samePaneTarget(pending.pane, pane)) this.screenTransactions.delete(requestId);
    }
  }

  private clearCanonicalCursors(): void {
    this.paneCursors.clear();
    this.screenTransactions.clear();
    for (const [key, row] of this.canonicalTargets) {
      this.canonicalTargets.set(key, { pane: row.pane, cursor: null });
    }
    if (!this.canonicalSub) return;
    const clear = (row: wsBorsh.CanonicalPaneSubscription) => ({ pane: row.pane, cursor: null });
    this.canonicalSub = {
      ...this.canonicalSub,
      activePanes: this.canonicalSub.activePanes.map(clear),
      hotPanes: this.canonicalSub.hotPanes.map(clear),
    };
  }

  private removeCanonicalDevice(deviceId: string): void {
    this.viewport.removeDevice(deviceId);
    if (this.canonicalSub) {
      this.canonicalSub = {
        ...this.canonicalSub,
        activePanes: this.canonicalSub.activePanes.filter((row) => row.pane.deviceId !== deviceId),
        hotPanes: this.canonicalSub.hotPanes.filter((row) => row.pane.deviceId !== deviceId),
      };
    }
    for (const [key, cursor] of this.paneCursors) {
      if (cursor.pane.deviceId === deviceId) this.paneCursors.delete(key);
    }
    for (const [key, row] of this.canonicalTargets) {
      if (row.pane.deviceId === deviceId) this.canonicalTargets.delete(key);
    }
    for (const [requestId, pending] of this.screenTransactions) {
      if (pending.pane.deviceId === deviceId) this.screenTransactions.delete(requestId);
    }
  }

  private buildCanonicalResume(): Uint8Array | null {
    if (!this.canonicalSub) return null;
    const patch = (row: wsBorsh.CanonicalPaneSubscription): wsBorsh.CanonicalPaneSubscription => {
      const cursor = this.paneCursors.get(paneCursorKey(row.pane.deviceId, row.pane.paneId));
      if (
        !cursor ||
        !samePaneTarget(cursor.pane, row.pane) ||
        (row.cursor && !bytesEqual(row.cursor.paneEpoch, cursor.paneEpoch))
      ) {
        return row;
      }
      return {
        pane: row.pane,
        cursor: { paneEpoch: cursor.paneEpoch, terminalSeq: cursor.terminalSeq },
      };
    };
    const generation = this.canonicalSub.generation + 1n;
    const frame = this.tryEncodeCanonicalSubscription(
      generation,
      this.canonicalSub.activePanes.map(patch),
      this.canonicalSub.hotPanes.map(patch)
    );
    if (frame) return frame;
    const withoutCursor = (row: wsBorsh.CanonicalPaneSubscription) => ({
      pane: row.pane,
      cursor: null,
    });
    const fallback = this.tryEncodeCanonicalSubscription(
      generation,
      this.canonicalSub.activePanes.map(withoutCursor),
      this.canonicalSub.hotPanes.map(withoutCursor)
    );
    this.queueCanonicalResourceGap();
    return fallback;
  }

  private buildCanonicalBootstrap(): Uint8Array | null {
    const frame = this.tryEncodeCanonicalSubscription(0n, [], []);
    if (frame) return frame;
    this.queueCanonicalResourceGap();
    return null;
  }

  private tryEncodeCanonicalSubscription(
    generation: bigint,
    activePanes: wsBorsh.CanonicalPaneSubscription[],
    hotPanes: wsBorsh.CanonicalPaneSubscription[]
  ): Uint8Array | null {
    try {
      const frame = wsBorsh.encodeEnvelope(
        wsBorsh.KIND_CANONICAL_COMMAND,
        wsBorsh.encodeCanonicalCommandPayload({
          SetPaneSubscriptions: { generation, activePanes, hotPanes },
        }),
        this.canonicalSub?.seq || this.outboundSeq
      );
      return this.canonicalFrameFits(frame) ? frame : null;
    } catch {
      return null;
    }
  }

  private queueCanonicalResourceGap(): void {
    if (this.canonicalResourceGapQueued) return;
    this.outboundSeq += 1;
    const frame = wsBorsh.encodeEnvelope(
      wsBorsh.KIND_CANONICAL_EVENT,
      wsBorsh.encodeCanonicalEventPayload({
        SourceGap: {
          reason: wsBorsh.SOURCE_GAP_REASON_RESOURCE_EXHAUSTED,
          scope: { Stream: {} },
        },
      }),
      this.outboundSeq
    );
    if (!this.canonicalFrameFits(frame)) {
      throw new wsBorsh.WsBorshError(
        wsBorsh.ERROR_FRAME_TOO_LARGE,
        false,
        `canonical recovery signal exceeds ${this.canonicalFrameLimit()} byte wire limit`
      );
    }
    this.lastBrowserSignals.push(frame);
    this.canonicalResourceGapQueued = true;
  }

  private canonicalFrameFits(frame: Uint8Array): boolean {
    return frame.byteLength <= this.canonicalFrameLimit();
  }

  private canonicalFrameLimit(): number {
    return Math.min(
      wsBorsh.CANONICAL_STATE_MAX_FRAME_BYTES,
      this.clientMaxFrameBytes,
      this.serverMaxFrameBytes
    );
  }
}

function paneCursorKey(deviceId: string, paneId: string): string {
  return `${deviceId}\0${paneId}`;
}

function bytesKey(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function samePaneTarget(
  left: wsBorsh.CanonicalPaneTarget,
  right: wsBorsh.CanonicalPaneTarget
): boolean {
  return (
    left.deviceId === right.deviceId &&
    left.paneId === right.paneId &&
    bytesEqual(left.serverEpoch, right.serverEpoch)
  );
}

function clonePaneTarget(pane: wsBorsh.CanonicalPaneTarget): wsBorsh.CanonicalPaneTarget {
  return { deviceId: pane.deviceId, serverEpoch: pane.serverEpoch.slice(), paneId: pane.paneId };
}
