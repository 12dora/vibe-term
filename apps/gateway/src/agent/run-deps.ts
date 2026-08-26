import type { AgentEventPayloadMap, EventType, WebhookEvent } from '@tmex/shared';
import { wsBorsh } from '@tmex/shared';
import type { LanguageModel, Tool } from 'ai';
import { generateText } from 'ai';
import { deleteAllQueuedAgentMessages, listQueuedAgentMessages } from '../db/agent';
import { eventNotifier } from '../events';
import {
  resolveLanguageModel,
  resolveProviderHostedTools,
  resolveProviderWebSearchTool,
} from '../llm/provider-registry';
import { tmuxRuntimeRegistry } from '../tmux-client/registry';
import type { TerminalRuntimeLike } from './tools/terminal';
import { createFetchUrlTool, createWebSearchTool } from './tools/web';
import { agentWsHub } from './ws-hub';

export interface AgentRunDeps {
  resolveModel: (providerId: string | null, modelId: string | null) => Promise<LanguageModel>;
  resolveProviderWebSearchTool: (providerId: string | null) => Promise<Tool | null>;
  resolveProviderHostedTools: (
    providerId: string | null,
    keys: readonly string[]
  ) => Promise<Record<string, Tool>>;
  createWebSearchTool: () => Promise<Tool | null>;
  createFetchUrlTool: () => Tool;
  hasQueuedMessages: (sessionId: string) => boolean;
  drainQueuedMessages: (sessionId: string) => string[];
  acquireRuntime: (deviceId: string) => Promise<TerminalRuntimeLike>;
  releaseRuntime: (deviceId: string, runtime?: TerminalRuntimeLike) => Promise<void>;
  broadcast: <K extends keyof AgentEventPayloadMap>(
    sessionId: string,
    eventType: K,
    payload: AgentEventPayloadMap[K],
    seq: number
  ) => void;
  notify: (
    eventType: EventType,
    event: Omit<WebhookEvent, 'eventType' | 'timestamp'>
  ) => Promise<void>;
  generateTitle: (model: LanguageModel, prompt: string) => Promise<string>;
  sleepMs: (ms: number) => Promise<void>;
  deltaFlushIntervalMs: number;
  deltaFlushMaxBytes: number;
  retryDelaysMs: number[];
  llmMaxRetries: number;
  streamIdleTimeoutMs: number;
  notifyTurnFinished: boolean;
}

export const defaultAgentRunDeps: AgentRunDeps = {
  resolveModel: resolveLanguageModel,
  resolveProviderWebSearchTool,
  resolveProviderHostedTools,
  createWebSearchTool: () => createWebSearchTool(),
  createFetchUrlTool: () => createFetchUrlTool(),
  hasQueuedMessages: (sessionId) => listQueuedAgentMessages(sessionId).length > 0,
  drainQueuedMessages: (sessionId) => {
    const items = listQueuedAgentMessages(sessionId);
    if (items.length === 0) {
      return [];
    }
    deleteAllQueuedAgentMessages(sessionId);
    agentWsHub.broadcastAgentEvent(sessionId, wsBorsh.AGENT_EVENT_QUEUE_UPDATED, { queued: [] }, 0);
    return items.map((item) => item.text);
  },
  acquireRuntime: (deviceId) => tmuxRuntimeRegistry.acquire(deviceId),
  releaseRuntime: (deviceId, runtime) => tmuxRuntimeRegistry.release(deviceId, runtime),
  broadcast: (sessionId, eventType, payload, seq) =>
    agentWsHub.broadcastAgentEvent(sessionId, eventType, payload, seq),
  notify: (eventType, event) => eventNotifier.notify(eventType, event),
  generateTitle: async (model, prompt) => {
    const result = await generateText({ model, prompt, maxRetries: 1 });
    return result.text;
  },
  sleepMs: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  deltaFlushIntervalMs: 40,
  deltaFlushMaxBytes: 2048,
  retryDelaysMs: [1000, 2000, 4000],
  llmMaxRetries: 3,
  streamIdleTimeoutMs: 90_000,
  notifyTurnFinished: true,
};
