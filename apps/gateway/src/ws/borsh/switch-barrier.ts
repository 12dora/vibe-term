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
  sendToClient,
} from './codec-borsh';
import { sessionStateStore } from './session-state';

const SWITCH_ACK_TIMEOUT_MS = 1500;
const HISTORY_TIMEOUT_MS = 1500;
const LIVE_RESUME_DELAY_MS = 450;

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

  private sendOnSession(session: GatewaySession, data: Uint8Array | Uint8Array[]): boolean {
    const borshState = session.borshState;
    if (!borshState) return false;
    return sendToClient(session.activeCarrier, data, borshState.maxFrameBytes);
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

    if (!this.sendOnSession(session, ackData)) {
      gatewayWebSocketSendGuard.markStreamGap(session.activeCarrier);
      this.completeTransaction(session, deviceId);
      return;
    }

    if (context.wantHistory) {
      pending.timers.push(
        setTimeout(() => {
          this.handleTimeout(session, deviceId, 'history', context.selectToken);
        }, HISTORY_TIMEOUT_MS)
      );
    } else {
      const expectedToken = context.selectToken;
      pending.timers.push(
        setTimeout(() => {
          this.sendLiveResume(session, deviceId, expectedToken);
        }, LIVE_RESUME_DELAY_MS)
      );
    }

    pending.callbacks.onAckSent?.();
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

    if (!this.sendOnSession(session, historyMessages)) {
      gatewayWebSocketSendGuard.markStreamGap(session.activeCarrier);
      this.completeTransaction(session, deviceId);
      return;
    }

    pending.callbacks.onHistorySent?.();

    const expectedToken = context.selectToken;
    pending.timers.push(
      setTimeout(() => {
        this.sendLiveResume(session, deviceId, expectedToken);
      }, LIVE_RESUME_DELAY_MS)
    );
  }

  /**
   * 发送 LIVE_RESUME
   */
  sendLiveResume(session: GatewaySession, deviceId: string, expectedToken?: Uint8Array): void {
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

    for (const timer of pending.timers) {
      clearTimeout(timer);
    }
    pending.timers = [];

    if (!sessionStateStore.transitionSelectState(session, deviceId, 'LIVE')) {
      return;
    }

    const bufferedOutput = sessionStateStore.stopOutputBuffering(session, deviceId);

    const seq = borshState.seqGen();
    const liveResumeData = encodeLiveResume(
      {
        deviceId,
        paneId: context.paneId,
        selectToken: context.selectToken,
      },
      seq
    );

    if (!this.sendOnSession(session, liveResumeData)) {
      gatewayWebSocketSendGuard.markStreamGap(session.activeCarrier);
      this.completeTransaction(session, deviceId);
      return;
    }

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
      if (!this.sendOnSession(session, outputData)) {
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
      this.sendLiveResume(session, deviceId, expectedToken);
      sessionStateStore.stopOutputBuffering(session, deviceId);
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
