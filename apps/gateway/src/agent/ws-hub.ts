// Agent/Watch WS 订阅 hub
// 维护 sessionId -> 订阅客户端 集合，负责 AGENT_EVENT/WATCH_EVENT 的 borsh 编码与广播。
// 事件来源：agent runtime（Task 5）与 watch service（Task 6）。

import { wsBorsh } from '@tmex/shared';
import type {
  AgentEventPayloadMap,
  AgentSyncEventPayload,
  WatchEventPayloadMap,
} from '@tmex/shared';
import {
  getAgentSessionById,
  getMaxAgentMessageSeq,
  listPendingAgentConfirmations,
  listQueuedAgentMessages,
} from '../db/agent';
import { encodePayloadFrames, sendToClient } from '../ws/borsh/codec-borsh';
import type { GatewaySession } from '../ws/gateway-session';
import { gatewayWebSocketSendGuard } from '../ws/websocket-send-guard';

export type AgentSyncProvider = (sessionId: string) => Promise<AgentSyncEventPayload | null>;

// 默认 syncProvider：从 DB 读取 status / pending confirmations / queuedMessages / lastMessageSeq。
// 边界：进行中回合的累积文本（inProgressText/inProgressReasoning）只存在于 agent runtime 内存中，
// Task 5 会通过 setSyncProvider 注入包含这些字段的真实实现，本实现恒为空串。
async function dbSyncProvider(sessionId: string): Promise<AgentSyncEventPayload | null> {
  const session = getAgentSessionById(sessionId);
  if (!session) return null;

  const pending = listPendingAgentConfirmations(sessionId);

  return {
    status: session.status,
    lastError: session.lastError,
    inProgressText: '',
    inProgressReasoning: '',
    pendingConfirmations: pending.map((c) => ({
      confirmationId: c.id,
      toolCallId: c.toolCallId,
      toolName: c.toolName,
      input: c.inputJson,
      createdAt: c.createdAt,
    })),
    queuedMessages: listQueuedAgentMessages(sessionId).map((item) => ({
      id: item.id,
      seq: item.seq,
      text: item.text,
      createdAt: item.createdAt,
    })),
    lastMessageSeq: getMaxAgentMessageSeq(sessionId),
  };
}

export const AGENT_WS_MAX_SESSION_ID_LENGTH = 128;
export const AGENT_WS_MAX_SUBSCRIPTIONS_PER_CLIENT = 64;

interface AgentWsHubOptions {
  syncProvider?: AgentSyncProvider;
}

export class AgentWsHub {
  private clients = new Set<GatewaySession>();
  private subscriptions = new Map<string, Set<GatewaySession>>();
  private inflightSubscribes = new Map<string, Map<GatewaySession, number>>();
  private establishedSubs = new Map<string, Set<GatewaySession>>();
  private syncProvider: AgentSyncProvider;

  constructor(options: AgentWsHubOptions = {}) {
    this.syncProvider = options.syncProvider ?? dbSyncProvider;
  }

  setSyncProvider(provider: AgentSyncProvider): void {
    this.syncProvider = provider;
  }

  registerClient(session: GatewaySession): void {
    this.clients.add(session);
  }

  removeClient(session: GatewaySession): void {
    this.clients.delete(session);
    for (const [sessionId, subscribers] of this.subscriptions) {
      subscribers.delete(session);
      this.clearEstablished(session, sessionId);
      if (subscribers.size === 0) {
        this.subscriptions.delete(sessionId);
      }
    }
  }

  async subscribe(session: GatewaySession, sessionId: string): Promise<void> {
    if (!isValidAgentSessionId(sessionId)) return;
    if (
      !this.hasSubscription(session, sessionId) &&
      this.countClientSubscriptions(session) >= AGENT_WS_MAX_SUBSCRIPTIONS_PER_CLIENT
    ) {
      return;
    }

    this.addSubscription(session, sessionId);
    this.bumpInflight(session, sessionId, 1);
    let outcome: 'ok' | 'missing' | 'error' = 'ok';
    try {
      const sync = await this.syncProvider(sessionId);
      if (!sync) {
        outcome = 'missing';
        return;
      }
      if (!this.hasSubscription(session, sessionId)) return;
      this.markEstablished(session, sessionId);
      this.sendAgentEvent(session, sessionId, wsBorsh.AGENT_EVENT_SYNC, sync, 0);
    } catch (err) {
      outcome = 'error';
      console.error(`[agent-ws-hub] sync for session ${sessionId} failed:`, err);
    } finally {
      this.finishSubscribeAttempt(session, sessionId, outcome);
    }
  }

  unsubscribe(session: GatewaySession, sessionId: string): void {
    const subscribers = this.subscriptions.get(sessionId);
    if (!subscribers) return;
    subscribers.delete(session);
    this.clearEstablished(session, sessionId);
    if (subscribers.size === 0) {
      this.subscriptions.delete(sessionId);
    }
  }

  broadcastAgentEvent<K extends keyof AgentEventPayloadMap>(
    sessionId: string,
    eventType: K,
    payload: AgentEventPayloadMap[K],
    seq: number
  ): void {
    const subscribers = this.subscriptions.get(sessionId);
    if (!subscribers?.size) return;

    const payloadBytes = encodeAgentEventPayload(sessionId, eventType, payload, seq);
    for (const session of subscribers) {
      this.sendPayload(session, wsBorsh.KIND_AGENT_EVENT, payloadBytes);
    }
  }

  broadcastWatchEvent<K extends keyof WatchEventPayloadMap>(
    ruleId: string,
    deviceId: string,
    paneId: string,
    eventType: K,
    payload: WatchEventPayloadMap[K]
  ): void {
    if (this.clients.size === 0) return;

    assertU8EventType(eventType);
    const payloadBytes = wsBorsh.encodePayload(wsBorsh.schema.WatchEventSchema, {
      ruleId,
      deviceId,
      paneId,
      eventType,
      payload: encodeJsonBytes(payload),
    });

    for (const session of this.clients) {
      this.sendPayload(session, wsBorsh.KIND_WATCH_EVENT, payloadBytes);
    }
  }

  private hasSubscription(session: GatewaySession, sessionId: string): boolean {
    return this.subscriptions.get(sessionId)?.has(session) === true;
  }

  private addSubscription(session: GatewaySession, sessionId: string): Set<GatewaySession> {
    let subscribers = this.subscriptions.get(sessionId);
    if (!subscribers) {
      subscribers = new Set();
      this.subscriptions.set(sessionId, subscribers);
    }
    subscribers.add(session);
    return subscribers;
  }

  private countClientSubscriptions(session: GatewaySession): number {
    let count = 0;
    for (const subscribers of this.subscriptions.values()) {
      if (subscribers.has(session)) count++;
    }
    return count;
  }

  private finishSubscribeAttempt(
    session: GatewaySession,
    sessionId: string,
    outcome: 'ok' | 'missing' | 'error'
  ): void {
    const remaining = this.bumpInflight(session, sessionId, -1);
    if (outcome === 'missing') {
      this.unsubscribe(session, sessionId);
      return;
    }
    if (
      outcome === 'error' &&
      remaining === 0 &&
      !this.isEstablished(session, sessionId) &&
      this.hasSubscription(session, sessionId)
    ) {
      this.unsubscribe(session, sessionId);
    }
  }

  private bumpInflight(session: GatewaySession, sessionId: string, delta: number): number {
    let bySession = this.inflightSubscribes.get(sessionId);
    if (!bySession) {
      bySession = new Map();
      this.inflightSubscribes.set(sessionId, bySession);
    }
    const next = (bySession.get(session) ?? 0) + delta;
    if (next <= 0) {
      bySession.delete(session);
      if (bySession.size === 0) this.inflightSubscribes.delete(sessionId);
      return 0;
    }
    bySession.set(session, next);
    return next;
  }

  private markEstablished(session: GatewaySession, sessionId: string): void {
    let set = this.establishedSubs.get(sessionId);
    if (!set) {
      set = new Set();
      this.establishedSubs.set(sessionId, set);
    }
    set.add(session);
  }

  private isEstablished(session: GatewaySession, sessionId: string): boolean {
    return this.establishedSubs.get(sessionId)?.has(session) === true;
  }

  private clearEstablished(session: GatewaySession, sessionId: string): void {
    const set = this.establishedSubs.get(sessionId);
    if (!set) return;
    set.delete(session);
    if (set.size === 0) this.establishedSubs.delete(sessionId);
  }

  private sendAgentEvent<K extends keyof AgentEventPayloadMap>(
    session: GatewaySession,
    sessionId: string,
    eventType: K,
    payload: AgentEventPayloadMap[K],
    seq: number
  ): void {
    this.sendPayload(
      session,
      wsBorsh.KIND_AGENT_EVENT,
      encodeAgentEventPayload(sessionId, eventType, payload, seq)
    );
  }

  private sendPayload(session: GatewaySession, kind: number, payloadBytes: Uint8Array): void {
    try {
      const carrier = session.activeCarrier;
      if (!gatewayWebSocketSendGuard.canSend(carrier)) {
        return;
      }
      const state = session.borshState;
      sendToClient(
        carrier,
        encodePayloadFrames(kind, payloadBytes, state.seqGen, state.maxFrameBytes),
        state.maxFrameBytes
      );
    } catch (err) {
      console.error('[agent-ws-hub] failed to send payload:', err);
    }
  }
}

function isValidAgentSessionId(sessionId: string): boolean {
  return sessionId.length > 0 && sessionId.length <= AGENT_WS_MAX_SESSION_ID_LENGTH;
}

function encodeJsonBytes(payload: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(payload ?? null));
}

function assertU8EventType(eventType: number): void {
  if (!Number.isInteger(eventType) || eventType < 0 || eventType > 255) {
    throw new RangeError(`eventType out of u8 range: ${eventType}`);
  }
}

function encodeAgentEventPayload(
  sessionId: string,
  eventType: number,
  payload: unknown,
  seq: number
): Uint8Array {
  assertU8EventType(eventType);
  return wsBorsh.encodePayload(wsBorsh.schema.AgentEventSchema, {
    sessionId,
    seq,
    eventType,
    payload: encodeJsonBytes(payload),
  });
}

export const agentWsHub = new AgentWsHub();
