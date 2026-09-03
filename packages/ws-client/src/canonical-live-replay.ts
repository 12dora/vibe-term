import type {
  GatewayHistoryCursor,
  GatewayPaneHistoryPage,
  GatewayPaneScreenSnapshot,
  GatewayRebaseReason,
  GatewayTerminalData,
} from './transport-types';

const DEFAULT_MAX_REPLAY_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_REPLAY_BYTES = 8 * 1024 * 1024;
const MAX_HISTORY_BYTES = 10_000 * 200;
const MAX_HISTORY_PAGES = 22;

interface PaneReplay {
  paneEpoch: Uint8Array;
  nextSeq: bigint;
  historyCursor: GatewayHistoryCursor;
  frames: GatewayTerminalData[];
  bytes: number;
  historyBytes: number;
  historyPages: number;
}

export interface CanonicalHistoryReplay {
  tracked: boolean;
  valid: boolean;
  frames: readonly GatewayTerminalData[];
  reason?: GatewayRebaseReason;
}

function paneKey(deviceId: string, paneId: string): string {
  return `${deviceId}:${paneId}`;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function cursorContinues(page: GatewayPaneHistoryPage, cursor: GatewayHistoryCursor): boolean {
  return (
    bytesEqual(page.paneEpoch, cursor.paneEpoch) &&
    bytesEqual(page.historyEpoch, cursor.historyEpoch) &&
    page.lineEnd === cursor.beforeLine &&
    page.lineStart <= page.lineEnd &&
    (!page.nextCursor ||
      (bytesEqual(page.nextCursor.paneEpoch, page.paneEpoch) &&
        bytesEqual(page.nextCursor.historyEpoch, page.historyEpoch) &&
        page.nextCursor.beforeLine === page.lineStart))
  );
}

export class CanonicalLiveReplay {
  private readonly panes = new Map<string, PaneReplay>();
  private readonly invalidPanes = new Map<string, GatewayRebaseReason>();
  private totalBytes = 0;

  constructor(
    private readonly maxBytes = DEFAULT_MAX_REPLAY_BYTES,
    private readonly maxTotalBytes = DEFAULT_MAX_TOTAL_REPLAY_BYTES
  ) {}

  begin(snapshot: GatewayPaneScreenSnapshot): void {
    const key = paneKey(snapshot.deviceId, snapshot.paneId);
    this.deletePane(key);
    this.invalidPanes.delete(key);
    if (!snapshot.historyCursor) {
      return;
    }
    this.panes.set(key, {
      paneEpoch: Uint8Array.from(snapshot.paneEpoch),
      nextSeq: snapshot.baseSeq,
      historyCursor: {
        paneEpoch: Uint8Array.from(snapshot.historyCursor.paneEpoch),
        historyEpoch: Uint8Array.from(snapshot.historyCursor.historyEpoch),
        beforeLine: snapshot.historyCursor.beforeLine,
      },
      frames: [],
      bytes: 0,
      historyBytes: 0,
      historyPages: 0,
    });
  }

  capture(frame: GatewayTerminalData): GatewayRebaseReason | null {
    if (
      frame.paneEpoch === undefined ||
      frame.seqStart === undefined ||
      frame.seqEnd === undefined
    ) {
      return null;
    }
    const key = paneKey(frame.deviceId, frame.paneId);
    if (this.invalidPanes.has(key)) return null;
    const state = this.panes.get(key);
    if (!state) return null;
    if (!bytesEqual(state.paneEpoch, frame.paneEpoch)) {
      this.deletePane(key);
      return 'epoch_changed';
    }
    if (frame.seqEnd <= state.nextSeq) return null;
    let seqStart = frame.seqStart;
    let data = frame.data;
    if (seqStart < state.nextSeq) {
      const offset = Number(state.nextSeq - seqStart);
      data = data.subarray(offset);
      seqStart = state.nextSeq;
    }
    if (seqStart !== state.nextSeq || frame.seqEnd - seqStart !== BigInt(data.byteLength)) {
      this.deletePane(key);
      return 'pane_gap';
    }
    if (state.bytes + data.byteLength > this.maxBytes) {
      this.invalidatePane(frame.deviceId, frame.paneId, 'resource_exhausted');
      return null;
    }
    this.evictForTotalBudget(key, data.byteLength);
    if (this.totalBytes + data.byteLength > this.maxTotalBytes) {
      this.invalidatePane(frame.deviceId, frame.paneId, 'resource_exhausted');
      return null;
    }
    state.frames.push({
      ...frame,
      paneEpoch: Uint8Array.from(frame.paneEpoch),
      seqStart,
      seqEnd: frame.seqEnd,
      data: Uint8Array.from(data),
    });
    state.bytes += data.byteLength;
    this.totalBytes += data.byteLength;
    state.nextSeq = frame.seqEnd;
    this.panes.delete(key);
    this.panes.set(key, state);
    return null;
  }

  historyPage(page: GatewayPaneHistoryPage): CanonicalHistoryReplay {
    const key = paneKey(page.deviceId, page.paneId);
    const invalid = this.invalidPanes.get(key);
    if (invalid) return { tracked: true, valid: false, frames: [], reason: invalid };
    const state = this.panes.get(key);
    if (!state) return { tracked: false, valid: true, frames: [] };
    if (
      !bytesEqual(state.paneEpoch, page.paneEpoch) ||
      !cursorContinues(page, state.historyCursor)
    ) {
      return { tracked: true, valid: false, frames: [], reason: 'cache_evicted' };
    }
    if (
      state.historyPages >= MAX_HISTORY_PAGES ||
      state.historyBytes + page.data.byteLength > MAX_HISTORY_BYTES
    ) {
      this.deletePane(key);
      return { tracked: true, valid: true, frames: [] };
    }
    const frames = [...state.frames];
    state.historyPages += 1;
    state.historyBytes += page.data.byteLength;
    if (page.nextCursor) {
      state.historyCursor = {
        paneEpoch: Uint8Array.from(page.nextCursor.paneEpoch),
        historyEpoch: Uint8Array.from(page.nextCursor.historyEpoch),
        beforeLine: page.nextCursor.beforeLine,
      };
    } else {
      this.deletePane(key);
    }
    return { tracked: true, valid: true, frames };
  }

  invalidatePane(deviceId: string, paneId: string, reason: GatewayRebaseReason): void {
    const key = paneKey(deviceId, paneId);
    this.deletePane(key);
    this.invalidPanes.set(key, reason);
  }

  clearPane(deviceId: string, paneId: string): void {
    const key = paneKey(deviceId, paneId);
    this.deletePane(key);
    this.invalidPanes.delete(key);
  }

  clearDevice(deviceId: string): void {
    const prefix = `${deviceId}:`;
    for (const key of this.panes.keys()) {
      if (key.startsWith(prefix)) this.deletePane(key);
    }
    for (const key of this.invalidPanes.keys()) {
      if (key.startsWith(prefix)) this.invalidPanes.delete(key);
    }
  }

  clear(): void {
    this.panes.clear();
    this.invalidPanes.clear();
    this.totalBytes = 0;
  }

  private deletePane(key: string): void {
    const state = this.panes.get(key);
    if (state) this.totalBytes -= state.bytes;
    this.panes.delete(key);
  }

  private evictForTotalBudget(currentKey: string, incomingBytes: number): void {
    for (const key of this.panes.keys()) {
      if (this.totalBytes + incomingBytes <= this.maxTotalBytes) return;
      if (key === currentKey) continue;
      this.deletePane(key);
      this.invalidPanes.set(key, 'resource_exhausted');
    }
  }
}
