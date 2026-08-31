// Gateway 切换屏障实现
// 处理 TMUX_SELECT 事务: ACK -> HISTORY -> LIVE_RESUME
// 参考: docs/terminal/2026021404-terminal-switch-barrier-design.md

import type { GatewaySession } from '../gateway-session';
import { gatewayWebSocketSendGuard } from '../websocket-send-guard';
import {
  encodeLiveResume,
  encodeSwitchAck,
  encodeTermHistory,
  encodeTermOutput,
} from './codec-borsh';
import { sessionStateStore } from './session-state';

const SWITCH_ACK_TIMEOUT_MS = 1500;
const HISTORY_TIMEOUT_MS = 1500;
const PENDING_WRITES_POLL_MS = 25;

export interface SwitchBarrierContext {
  deviceId: string;
  windowId: string;
  paneId: string;
  selectToken: Uint8Array;
  wantHistory: boolean;
  cols: number | null;
  rows: number | null;
}

export interface SwitchBarrierCallbacks {
  onAckSent?: () => void;
  onHistorySent?: () => void;
  onLiveResumed?: () => void;
  onTimeout?: (stage: 'ack' | 'history') => void;
}

type PendingTransaction = {
  context: SwitchBarrierContext;
  callbacks: SwitchBarrierCallbacks;
  timers: ReturnType<typeof setTimeout>[];
};

type LiveResumeAttempt = 'skipped' | 'waiting' | 'dispatched';

export class SwitchBarrier {
  private pendingTransactions = new Map<GatewaySession, Map<string, PendingTransaction>>();

  private tokensEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  private getOrCreateDeviceMap(session: GatewaySession): Map<string, PendingTransaction> {
    const existing = this.pendingTransactions.get(session);
    if (existing) return existing;
    const created = new Map<string, PendingTransaction>();
    this.pendingTransactions.set(session, created);
    return created;
  }

  private getPending(session: GatewaySession, deviceId: string) {
    return this.pendingTransactions.get(session)?.get(deviceId);
  }

  private setPending(session: GatewaySession, deviceId: string, value: PendingTransaction): void {
    this.getOrCreateDeviceMap(session).set(deviceId, value);
  }

  private deletePending(session: GatewaySession, deviceId: string): void {
    const map = this.pendingTransactions.get(session);
    if (!map) return;
    map.delete(deviceId);
    if (map.size === 0) {
      this.pendingTransactions.delete(session);
    }
  }

  private sendOnSession(
    session: GatewaySession,
    data: Uint8Array | Uint8Array[]
  ): 'sent' | 'backpressured' | 'dropped' {
    const borshState = session.borshState;
    if (!borshState) return 'dropped';
    const frames = Array.isArray(data) ? data : [data];
    return gatewayWebSocketSendGuard.sendFramesStatus(
      session.activeCarrier,
      frames as readonly BufferSource[],
      borshState.maxFrameBytes
    );
  }

  /**
   * 启动一个新的选择事务
   */
  startTransaction(
    session: GatewaySession,
    context: SwitchBarrierContext,
    callbacks: SwitchBarrierCallbacks = {}
  ): boolean {
    this.cancelTransaction(session, context.deviceId);

    const started = sessionStateStore.startSelectTransaction(
      session,
      context.deviceId,
      context.windowId,
      context.paneId,
      context.selectToken
    );

    if (!started) {
      console.error(`[switch-barrier] Failed to start transaction for ${context.deviceId}`);
      return false;
    }

    const timers: ReturnType<typeof setTimeout>[] = [];

    timers.push(
      setTimeout(() => {
        this.handleTimeout(session, context.deviceId, 'ack', context.selectToken);
      }, SWITCH_ACK_TIMEOUT_MS)
    );

    this.setPending(session, context.deviceId, {
      context,
      callbacks,
      timers,
    });

    return true;
  }

  /**
   * 发送 SWITCH_ACK
   */
  sendSwitchAck(session: GatewaySession, deviceId: string): void {
    const pending = this.getPending(session, deviceId);
    if (!pending) return;
    const selectState = sessionStateStore.getOrCreateSelectTransaction(session, deviceId)?.state;
    if (selectState !== 'SELECTING') {
      return;
    }

    const { context } = pending;
    const borshState = session.borshState;
    if (!borshState) return;

    const ackTimer = pending.timers.shift();
    if (ackTimer) clearTimeout(ackTimer);

    if (!sessionStateStore.transitionSelectState(session, deviceId, 'ACKED')) {
      return;
    }

    const seq = borshState.seqGen();
    const ackData = encodeSwitchAck(
      {
        deviceId,
        windowId: context.windowId,
        paneId: context.paneId,
        selectToken: context.selectToken,
      },
      seq
    );

    if (this.sendOnSession(session, ackData) !== 'sent') {
      gatewayWebSocketSendGuard.markStreamGap(session.activeCarrier);
      this.failTransaction(session, deviceId);
      return;
    }

    if (context.wantHistory) {
      pending.timers.push(
        setTimeout(() => {
          this.handleTimeout(session, deviceId, 'history', context.selectToken);
        }, HISTORY_TIMEOUT_MS)
      );
    }

    pending.callbacks.onAckSent?.();

    if (!context.wantHistory) {
      this.sendLiveResume(session, deviceId, context.selectToken);
    }
  }

  /**
   * 发送 TERM_HISTORY
   */
  sendTermHistory(
    session: GatewaySession,
    deviceId: string,
    paneId: string,
    historyData: Uint8Array,
    alternateScreen: boolean,
    modes: number
  ): void {
    const pending = this.getPending(session, deviceId);
    if (!pending) return;
    const selectState = sessionStateStore.getOrCreateSelectTransaction(session, deviceId)?.state;
    if (selectState !== 'ACKED') {
      return;
    }

    const { context } = pending;
    if (context.paneId !== paneId) {
      return;
    }
    const borshState = session.borshState;
    if (!borshState) return;

    const historyTimer = pending.timers.shift();
    if (historyTimer) clearTimeout(historyTimer);

    if (!sessionStateStore.transitionSelectState(session, deviceId, 'HISTORY_APPLIED')) {
      return;
    }

    const historyMessages = encodeTermHistory(
      {
        deviceId,
        paneId: context.paneId,
        selectToken: context.selectToken,
        encoding: 2, // utf8-bytes
        alternateScreen,
        modes,
        data: historyData,
      },
      borshState.seqGen,
      borshState.maxFrameBytes
    );

    const historyStatus = this.sendOnSession(session, historyMessages);
    if (historyStatus !== 'sent') {
      gatewayWebSocketSendGuard.markStreamGap(session.activeCarrier);
      this.dispatchLiveResume(session, deviceId, context.selectToken);
      return;
    }

    pending.callbacks.onHistorySent?.();
    this.sendLiveResume(session, deviceId, context.selectToken);
  }

  /**
   * 发送 LIVE_RESUME
   */
  sendLiveResume(
    session: GatewaySession,
    deviceId: string,
    expectedToken?: Uint8Array
  ): LiveResumeAttempt {
    const pending = this.getPending(session, deviceId);
    if (!pending) return 'skipped';
    const selectState = sessionStateStore.getOrCreateSelectTransaction(session, deviceId)?.state;
    if (selectState !== 'ACKED' && selectState !== 'HISTORY_APPLIED') {
      return 'skipped';
    }

    const { context } = pending;
    if (expectedToken && !this.tokensEqual(context.selectToken, expectedToken)) {
      return 'skipped';
    }
    if (!session.borshState) return 'skipped';
    if (session.closed) return 'skipped';

    if (session.activeCarrier.hasPendingWrites?.()) {
      this.schedulePendingWritesWait(session, deviceId, pending, context.selectToken);
      return 'waiting';
    }

    this.dispatchLiveResume(session, deviceId, expectedToken);
    return 'dispatched';
  }

  private schedulePendingWritesWait(
    session: GatewaySession,
    deviceId: string,
    capturedPending: PendingTransaction,
    capturedToken: Uint8Array
  ): void {
    const deadline = Date.now() + HISTORY_TIMEOUT_MS;
    const tick = () => {
      if (this.getPending(session, deviceId) !== capturedPending) return;
      if (!this.tokensEqual(capturedPending.context.selectToken, capturedToken)) return;
      if (session.closed) return;

      const overdue = Date.now() >= deadline;
      if (!overdue && session.activeCarrier.hasPendingWrites?.()) {
        capturedPending.timers.push(setTimeout(tick, PENDING_WRITES_POLL_MS));
        return;
      }
      this.dispatchLiveResume(session, deviceId, capturedToken);
    };
    capturedPending.timers.push(setTimeout(tick, PENDING_WRITES_POLL_MS));
  }

  private dispatchLiveResume(
    session: GatewaySession,
    deviceId: string,
    expectedToken?: Uint8Array
  ): void {
    const pending = this.getPending(session, deviceId);
    if (!pending) return;
    const selectState = sessionStateStore.getOrCreateSelectTransaction(session, deviceId)?.state;
    if (selectState !== 'ACKED' && selectState !== 'HISTORY_APPLIED') {
      return;
    }

    const { context } = pending;
    if (expectedToken && !this.tokensEqual(context.selectToken, expectedToken)) {
      return;
    }
    const borshState = session.borshState;
    if (!borshState) return;
    if (session.closed) return;

    const seq = borshState.seqGen();
    const liveResumeData = encodeLiveResume(
      {
        deviceId,
        paneId: context.paneId,
        selectToken: context.selectToken,
      },
      seq
    );

    const resumeStatus = this.sendOnSession(session, liveResumeData);

    for (const timer of pending.timers) {
      clearTimeout(timer);
    }
    pending.timers = [];

    if (resumeStatus !== 'sent') {
      gatewayWebSocketSendGuard.markStreamGap(session.activeCarrier);
      this.failTransaction(session, deviceId);
      return;
    }

    if (!sessionStateStore.transitionSelectState(session, deviceId, 'LIVE')) {
      return;
    }

    const bufferedOutput = sessionStateStore.stopOutputBuffering(session, deviceId);

    for (const data of bufferedOutput) {
      const outputSeq = borshState.seqGen();
      const outputData = encodeTermOutput(
        {
          deviceId,
          paneId: context.paneId,
          encoding: 1, // raw bytes
          data,
        },
        outputSeq
      );
      if (this.sendOnSession(session, outputData) !== 'sent') {
        gatewayWebSocketSendGuard.markStreamGap(session.activeCarrier);
        break;
      }
    }

    this.completeTransaction(session, deviceId);

    pending.callbacks.onLiveResumed?.();
  }

  getTransactionPaneId(session: GatewaySession, deviceId: string): string | null {
    const pending = this.getPending(session, deviceId);
    if (!pending) return null;
    const selectState = sessionStateStore.getOrCreateSelectTransaction(session, deviceId)?.state;
    if (selectState !== 'ACKED') return null;
    return pending.context.paneId;
  }

  getSelectToken(session: GatewaySession, deviceId: string): Uint8Array | null {
    return this.getPending(session, deviceId)?.context.selectToken ?? null;
  }

  validateToken(session: GatewaySession, deviceId: string, token: Uint8Array): boolean {
    const currentToken = this.getSelectToken(session, deviceId);
    if (!currentToken) return false;

    if (currentToken.length !== token.length) return false;
    for (let i = 0; i < currentToken.length; i++) {
      if (currentToken[i] !== token[i]) return false;
    }
    return true;
  }

  shouldBufferOutput(session: GatewaySession, deviceId: string): boolean {
    return sessionStateStore.isBuffering(session, deviceId);
  }

  bufferOutput(session: GatewaySession, deviceId: string, data: Uint8Array): boolean {
    return sessionStateStore.bufferOutput(session, deviceId, data);
  }

  private handleTimeout(
    session: GatewaySession,
    deviceId: string,
    stage: 'ack' | 'history',
    expectedToken?: Uint8Array
  ): void {
    const pending = this.getPending(session, deviceId);
    if (!pending) return;
    if (expectedToken && !this.tokensEqual(pending.context.selectToken, expectedToken)) {
      return;
    }

    console.warn(`[switch-barrier] Transaction timeout at stage: ${stage} for ${deviceId}`);

    if (stage === 'history') {
      const attempt = this.sendLiveResume(session, deviceId, expectedToken);
      if (attempt !== 'waiting') {
        sessionStateStore.stopOutputBuffering(session, deviceId);
      }
      pending.callbacks.onTimeout?.(stage);
      return;
    }

    sessionStateStore.transitionSelectState(session, deviceId, 'SELECT_FAILED');
    sessionStateStore.stopOutputBuffering(session, deviceId);

    pending.callbacks.onTimeout?.(stage);

    this.cleanupTransaction(session, deviceId);
  }

  cancelTransaction(session: GatewaySession, deviceId: string): void {
    const pending = this.getPending(session, deviceId);
    if (!pending) return;

    for (const timer of pending.timers) {
      clearTimeout(timer);
    }

    sessionStateStore.stopOutputBuffering(session, deviceId);

    this.cleanupTransaction(session, deviceId);
  }

  private failTransaction(session: GatewaySession, deviceId: string): void {
    const pending = this.getPending(session, deviceId);
    if (pending) {
      for (const timer of pending.timers) {
        clearTimeout(timer);
      }
      pending.timers = [];
    }

    const state = sessionStateStore.getOrCreateSelectTransaction(session, deviceId)?.state;
    if (state === 'ACKED' || state === 'HISTORY_APPLIED' || state === 'SELECTING') {
      sessionStateStore.transitionSelectState(session, deviceId, 'SELECT_FAILED');
    }
    sessionStateStore.stopOutputBuffering(session, deviceId);
    this.completeTransaction(session, deviceId);
  }

  private completeTransaction(session: GatewaySession, deviceId: string): void {
    if (!sessionStateStore.transitionSelectState(session, deviceId, 'STABLE')) {
      return;
    }

    this.cleanupTransaction(session, deviceId);
  }

  private cleanupTransaction(session: GatewaySession, deviceId: string): void {
    this.deletePending(session, deviceId);
  }

  cleanupClient(session: GatewaySession): void {
    const deviceMap = this.pendingTransactions.get(session);
    if (!deviceMap) return;
    for (const deviceId of Array.from(deviceMap.keys())) {
      this.cancelTransaction(session, deviceId);
    }
  }
}

export const switchBarrier = new SwitchBarrier();
