import type { wsBorsh } from '@tmex/shared';
import { bytesEqual, bytesKey, copyBytes } from './canonical-state-helpers';
import type {
  GatewayRebaseReason,
  GatewayTransportCommand,
  GatewayTransportEventHandler,
} from './transport-types';

type CanonicalEvent = wsBorsh.CanonicalEvent;
type ScreenBegin = Extract<CanonicalEvent, { ScreenBegin: unknown }>['ScreenBegin'];
type HistoryBegin = Extract<CanonicalEvent, { HistoryBegin: unknown }>['HistoryBegin'];

interface ContentAssembly<Begin> {
  begin: Begin;
  data: Uint8Array;
  receivedBytes: number;
}

export interface PendingContentRequest {
  kind: 'history' | 'screen';
  deviceId: string;
  paneId: string;
  serverEpoch: Uint8Array;
  command: Extract<
    GatewayTransportCommand,
    { type: 'request-pane-screen' | 'request-pane-history' }
  >;
}

export interface CanonicalContentTransactionsOptions {
  emit: GatewayTransportEventHandler;
  acceptPane(
    deviceId: string,
    paneId: string,
    serverEpoch: Uint8Array,
    paneEpoch: Uint8Array
  ): boolean;
  onCommitted(kind: PendingContentRequest['kind'], deviceId: string, paneId: string): void;
  onScreenCursor(
    deviceId: string,
    paneId: string,
    paneEpoch: Uint8Array,
    terminalSeq: bigint
  ): void;
  onRebase(deviceId: string, paneId: string, reason: GatewayRebaseReason): void;
}

export class CanonicalContentTransactions {
  private readonly screens = new Map<string, ContentAssembly<ScreenBegin>>();
  private readonly histories = new Map<string, ContentAssembly<HistoryBegin>>();
  private readonly requests = new Map<string, PendingContentRequest>();
  private maxScreenBytes = 512 * 1024;
  private maxHistoryBytes = 256 * 1024;

  constructor(private readonly options: CanonicalContentTransactionsOptions) {}

  setLimits(maxScreenBytes: number, maxHistoryBytes: number): void {
    this.maxScreenBytes = Math.min(maxScreenBytes, 512 * 1024);
    this.maxHistoryBytes = Math.min(maxHistoryBytes, 256 * 1024);
  }

  reset(): void {
    this.clear();
    this.maxScreenBytes = 512 * 1024;
    this.maxHistoryBytes = 256 * 1024;
  }

  clear(): void {
    this.screens.clear();
    this.histories.clear();
    this.requests.clear();
  }

  rememberRequest(requestId: Uint8Array, request: PendingContentRequest): void {
    for (const [key, existing] of this.requests) {
      if (
        existing.kind === request.kind &&
        existing.deviceId === request.deviceId &&
        existing.paneId === request.paneId
      ) {
        this.requests.delete(key);
        if (existing.kind === 'screen') this.screens.delete(key);
        else this.histories.delete(key);
      }
    }
    this.requests.set(bytesKey(requestId), request);
  }

  beginScreen(begin: ScreenBegin): void {
    if (!this.matchesRequest(begin.requestId, 'screen', begin.pane)) return;
    if (
      !this.options.acceptPane(
        begin.pane.deviceId,
        begin.pane.paneId,
        begin.pane.serverEpoch,
        begin.paneEpoch
      )
    ) {
      this.options.onRebase(begin.pane.deviceId, begin.pane.paneId, 'epoch_changed');
      return;
    }
    if (this.screens.has(bytesKey(begin.requestId))) {
      this.options.onRebase(begin.pane.deviceId, begin.pane.paneId, 'pane_gap');
      return;
    }
    if (begin.totalBytes > this.maxScreenBytes) {
      this.options.onRebase(begin.pane.deviceId, begin.pane.paneId, 'resource_exhausted');
      return;
    }
    this.screens.set(bytesKey(begin.requestId), {
      begin,
      data: new Uint8Array(begin.totalBytes),
      receivedBytes: 0,
    });
  }

  beginHistory(begin: HistoryBegin): void {
    if (!this.matchesRequest(begin.requestId, 'history', begin.pane)) return;
    if (
      !this.options.acceptPane(
        begin.pane.deviceId,
        begin.pane.paneId,
        begin.pane.serverEpoch,
        begin.paneEpoch
      )
    ) {
      this.options.onRebase(begin.pane.deviceId, begin.pane.paneId, 'epoch_changed');
      return;
    }
    if (this.histories.has(bytesKey(begin.requestId)) || begin.lineEnd < begin.lineStart) {
      this.options.onRebase(begin.pane.deviceId, begin.pane.paneId, 'cache_evicted');
      return;
    }
    if (begin.totalBytes > this.maxHistoryBytes) {
      this.options.onRebase(begin.pane.deviceId, begin.pane.paneId, 'resource_exhausted');
      return;
    }
    this.histories.set(bytesKey(begin.requestId), {
      begin,
      data: new Uint8Array(begin.totalBytes),
      receivedBytes: 0,
    });
  }

  appendScreen(chunk: { requestId: Uint8Array; offset: number; data: Uint8Array }): void {
    this.append(this.screens, chunk);
  }

  appendHistory(chunk: { requestId: Uint8Array; offset: number; data: Uint8Array }): void {
    this.append(this.histories, chunk);
  }

  commitScreen(commit: Extract<CanonicalEvent, { ScreenCommit: unknown }>['ScreenCommit']): void {
    const key = bytesKey(commit.requestId);
    const transaction = this.screens.get(key);
    if (!transaction) return;
    this.screens.delete(key);
    this.requests.delete(key);
    const { begin } = transaction;
    if (
      !this.options.acceptPane(
        begin.pane.deviceId,
        begin.pane.paneId,
        begin.pane.serverEpoch,
        begin.paneEpoch
      )
    ) {
      this.options.onRebase(begin.pane.deviceId, begin.pane.paneId, 'epoch_changed');
      return;
    }
    if (
      commit.totalBytes !== begin.totalBytes ||
      transaction.receivedBytes !== begin.totalBytes ||
      (commit.historyCursor && !bytesEqual(commit.historyCursor.paneEpoch, begin.paneEpoch))
    ) {
      this.options.onRebase(begin.pane.deviceId, begin.pane.paneId, 'pane_gap');
      return;
    }
    this.options.onScreenCursor(
      begin.pane.deviceId,
      begin.pane.paneId,
      begin.paneEpoch,
      begin.baseSeq
    );
    this.options.onCommitted('screen', begin.pane.deviceId, begin.pane.paneId);
    this.options.emit({
      type: 'screen-snapshot',
      snapshot: {
        requestId: copyBytes(begin.requestId),
        deviceId: begin.pane.deviceId,
        paneId: begin.pane.paneId,
        paneEpoch: copyBytes(begin.paneEpoch),
        baseSeq: begin.baseSeq,
        rows: begin.rows,
        cols: begin.cols,
        modes: begin.modes,
        data: transaction.data,
        historyCursor: commit.historyCursor
          ? {
              paneEpoch: copyBytes(commit.historyCursor.paneEpoch),
              historyEpoch: copyBytes(commit.historyCursor.historyEpoch),
              beforeLine: commit.historyCursor.beforeLine,
            }
          : null,
      },
    });
  }

  commitHistory(
    commit: Extract<CanonicalEvent, { HistoryCommit: unknown }>['HistoryCommit']
  ): void {
    const key = bytesKey(commit.requestId);
    const transaction = this.histories.get(key);
    if (!transaction) return;
    this.histories.delete(key);
    this.requests.delete(key);
    const { begin } = transaction;
    if (
      !this.options.acceptPane(
        begin.pane.deviceId,
        begin.pane.paneId,
        begin.pane.serverEpoch,
        begin.paneEpoch
      )
    ) {
      this.options.onRebase(begin.pane.deviceId, begin.pane.paneId, 'epoch_changed');
      return;
    }
    if (
      commit.totalBytes !== begin.totalBytes ||
      transaction.receivedBytes !== begin.totalBytes ||
      (commit.nextCursor &&
        (!bytesEqual(commit.nextCursor.paneEpoch, begin.paneEpoch) ||
          !bytesEqual(commit.nextCursor.historyEpoch, begin.historyEpoch) ||
          commit.nextCursor.beforeLine !== begin.lineStart))
    ) {
      this.options.onRebase(begin.pane.deviceId, begin.pane.paneId, 'cache_evicted');
      return;
    }
    this.options.onCommitted('history', begin.pane.deviceId, begin.pane.paneId);
    this.options.emit({
      type: 'history-page',
      page: {
        requestId: copyBytes(begin.requestId),
        deviceId: begin.pane.deviceId,
        paneId: begin.pane.paneId,
        paneEpoch: copyBytes(begin.paneEpoch),
        historyEpoch: copyBytes(begin.historyEpoch),
        lineStart: begin.lineStart,
        lineEnd: begin.lineEnd,
        truncated: begin.truncated,
        data: transaction.data,
        nextCursor: commit.nextCursor
          ? {
              paneEpoch: copyBytes(commit.nextCursor.paneEpoch),
              historyEpoch: copyBytes(commit.nextCursor.historyEpoch),
              beforeLine: commit.nextCursor.beforeLine,
            }
          : null,
      },
    });
  }

  takeFailedRequest(requestId: Uint8Array | null): PendingContentRequest | undefined {
    if (!requestId) return undefined;
    const key = bytesKey(requestId);
    const request = this.requests.get(key);
    this.requests.delete(key);
    this.screens.delete(key);
    this.histories.delete(key);
    return request;
  }

  pendingRequests(): PendingContentRequest[] {
    return Array.from(this.requests.values());
  }

  hasPending(kind: PendingContentRequest['kind'], deviceId: string, paneId: string): boolean {
    return Array.from(this.requests.values()).some(
      (request) =>
        request.kind === kind && request.deviceId === deviceId && request.paneId === paneId
    );
  }

  cancelPane(deviceId: string, paneId: string): void {
    for (const [key, transaction] of this.screens) {
      if (samePane(transaction.begin, deviceId, paneId)) this.screens.delete(key);
    }
    for (const [key, transaction] of this.histories) {
      if (samePane(transaction.begin, deviceId, paneId)) this.histories.delete(key);
    }
    for (const [key, request] of this.requests) {
      if (request.deviceId === deviceId && request.paneId === paneId) this.requests.delete(key);
    }
  }

  private append<Begin extends ScreenBegin | HistoryBegin>(
    transactions: Map<string, ContentAssembly<Begin>>,
    chunk: { requestId: Uint8Array; offset: number; data: Uint8Array }
  ): void {
    const key = bytesKey(chunk.requestId);
    const transaction = transactions.get(key);
    if (!transaction) return;
    if (
      chunk.offset !== transaction.receivedBytes ||
      chunk.offset + chunk.data.byteLength > transaction.data.byteLength
    ) {
      transactions.delete(key);
      this.options.onRebase(
        transaction.begin.pane.deviceId,
        transaction.begin.pane.paneId,
        'pane_gap'
      );
      return;
    }
    transaction.data.set(chunk.data, chunk.offset);
    transaction.receivedBytes += chunk.data.byteLength;
  }

  private matchesRequest(
    requestId: Uint8Array,
    kind: PendingContentRequest['kind'],
    pane: wsBorsh.CanonicalPaneTarget
  ): boolean {
    const request = this.requests.get(bytesKey(requestId));
    if (!request) return false;
    if (
      request.kind === kind &&
      request.deviceId === pane.deviceId &&
      request.paneId === pane.paneId &&
      bytesEqual(request.serverEpoch, pane.serverEpoch)
    ) {
      return true;
    }
    this.options.onRebase(request.deviceId, request.paneId, 'pane_gap');
    return false;
  }
}

function samePane(begin: ScreenBegin | HistoryBegin, deviceId: string, paneId: string): boolean {
  return begin.pane.deviceId === deviceId && begin.pane.paneId === paneId;
}
