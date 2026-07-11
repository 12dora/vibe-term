// Agent 会话 REST 端点（错误分支语义与调用方 store 的既有行为一一对应）

import type {
  AgentConfirmationDto,
  AgentMessageDto,
  AgentQueuedMessageDto,
  AgentSessionDto,
  AgentWriteMode,
} from '@tmex/shared';
import { type ApiClient, defaultApiClient, parseApiError } from './client';

export interface CreateAgentSessionRequest {
  deviceId: string;
  paneId: string;
  providerId?: string | null;
  modelId?: string;
  providerHostedTools?: string[];
  originPaneTitle?: string | null;
  writeMode: AgentWriteMode;
}

export interface UpdateAgentSessionPatch {
  title?: string;
  writeMode?: AgentWriteMode;
  allowControlChars?: boolean;
  providerId?: string | null;
  modelId?: string | null;
  paneId?: string;
}

export async function fetchAgentSessions(
  client: ApiClient = defaultApiClient
): Promise<AgentSessionDto[]> {
  const res = await client.fetch('/api/agent/sessions');
  if (!res.ok) {
    throw new Error(await parseApiError(res, 'Failed to load agent sessions'));
  }
  const payload = (await res.json()) as { sessions: AgentSessionDto[] };
  return payload.sessions;
}

/** 404 返回 null（session 已被别端删除），其余非 2xx 抛错 */
export async function fetchAgentSession(
  sessionId: string,
  client: ApiClient = defaultApiClient
): Promise<AgentSessionDto | null> {
  const res = await client.fetch(`/api/agent/sessions/${sessionId}`);
  if (res.status === 404) {
    return null;
  }
  if (!res.ok) {
    throw new Error(await parseApiError(res, 'Failed to load agent session'));
  }
  const payload = (await res.json()) as { session: AgentSessionDto };
  return payload.session;
}

export async function createAgentSession(
  body: CreateAgentSessionRequest,
  client: ApiClient = defaultApiClient
): Promise<AgentSessionDto> {
  const res = await client.fetch('/api/agent/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(await parseApiError(res, 'Failed to create agent session'));
  }
  const payload = (await res.json()) as { session: AgentSessionDto };
  return payload.session;
}

export async function updateAgentSession(
  sessionId: string,
  patch: UpdateAgentSessionPatch,
  errorFallback = 'Failed to update agent session',
  client: ApiClient = defaultApiClient
): Promise<AgentSessionDto> {
  const res = await client.fetch(`/api/agent/sessions/${sessionId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    throw new Error(await parseApiError(res, errorFallback));
  }
  const payload = (await res.json()) as { session: AgentSessionDto };
  return payload.session;
}

export async function deleteAgentSession(
  sessionId: string,
  client: ApiClient = defaultApiClient
): Promise<void> {
  const res = await client.fetch(`/api/agent/sessions/${sessionId}`, { method: 'DELETE' });
  if (!res.ok) {
    throw new Error(await parseApiError(res, 'Failed to delete agent session'));
  }
}

/** afterSeq >= 0 时按增量拉取 */
export async function fetchAgentMessages(
  sessionId: string,
  afterSeq: number,
  client: ApiClient = defaultApiClient
): Promise<AgentMessageDto[]> {
  const query = afterSeq >= 0 ? `?afterSeq=${afterSeq}` : '';
  const res = await client.fetch(`/api/agent/sessions/${sessionId}/messages${query}`);
  if (!res.ok) {
    throw new Error(await parseApiError(res, 'Failed to load agent messages'));
  }
  const payload = (await res.json()) as { messages: AgentMessageDto[] };
  return payload.messages;
}

export interface SendAgentMessageResponse {
  message?: AgentMessageDto;
  queued?: AgentQueuedMessageDto;
}

export async function sendAgentMessage(
  sessionId: string,
  text: string,
  client: ApiClient = defaultApiClient
): Promise<SendAgentMessageResponse> {
  const res = await client.fetch(`/api/agent/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    throw new Error(await parseApiError(res, 'Failed to send message'));
  }
  return (await res.json()) as SendAgentMessageResponse;
}

export async function enqueueAgentMessage(
  sessionId: string,
  text: string,
  steer: boolean,
  client: ApiClient = defaultApiClient
): Promise<void> {
  const res = await client.fetch(`/api/agent/sessions/${sessionId}/queue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, steer }),
  });
  if (!res.ok) {
    throw new Error(await parseApiError(res, 'Failed to queue message'));
  }
}

export async function editQueuedAgentMessage(
  itemId: string,
  text: string,
  client: ApiClient = defaultApiClient
): Promise<void> {
  const res = await client.fetch(`/api/agent/queue/${itemId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    throw new Error(await parseApiError(res, 'Failed to edit queued message'));
  }
}

export async function withdrawQueuedAgentMessage(
  itemId: string,
  client: ApiClient = defaultApiClient
): Promise<void> {
  const res = await client.fetch(`/api/agent/queue/${itemId}`, { method: 'DELETE' });
  if (!res.ok) {
    throw new Error(await parseApiError(res, 'Failed to withdraw queued message'));
  }
}

export async function stopAgentSession(
  sessionId: string,
  client: ApiClient = defaultApiClient
): Promise<AgentSessionDto | null> {
  const res = await client.fetch(`/api/agent/sessions/${sessionId}/stop`, { method: 'POST' });
  if (!res.ok) {
    throw new Error(await parseApiError(res, 'Failed to stop agent session'));
  }
  const payload = (await res.json()) as { session: AgentSessionDto | null };
  return payload.session;
}

/** 409（已被别端决定）返回 'conflict'，调用方自行刷新 pending 列表 */
export async function decideAgentConfirmation(
  confirmationId: string,
  approved: boolean,
  reason: string | undefined,
  client: ApiClient = defaultApiClient
): Promise<'ok' | 'conflict'> {
  const res = await client.fetch(`/api/agent/confirmations/${confirmationId}/decide`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(reason === undefined ? { approved } : { approved, reason }),
  });
  if (res.status === 409) {
    return 'conflict';
  }
  if (!res.ok) {
    throw new Error(await parseApiError(res, 'Failed to decide confirmation'));
  }
  return 'ok';
}

export async function fetchAgentConfirmations(
  sessionId: string,
  client: ApiClient = defaultApiClient
): Promise<AgentConfirmationDto[]> {
  const res = await client.fetch(`/api/agent/sessions/${sessionId}/confirmations`);
  if (!res.ok) {
    throw new Error(await parseApiError(res, 'Failed to load confirmations'));
  }
  const payload = (await res.json()) as { confirmations: AgentConfirmationDto[] };
  return payload.confirmations;
}
