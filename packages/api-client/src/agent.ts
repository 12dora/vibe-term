// Agent 会话 REST 端点（错误分支语义与调用方 store 的既有行为一一对应）

import type {
  AgentConfirmationDto,
  AgentMessageDto,
  AgentQueuedMessageDto,
  AgentSessionDto,
  AgentWriteMode,
} from '@tmex/shared';
import { type ApiClient, defaultApiClient } from './client';
import { requestJson, requestOk } from './json-mutation';

export interface CreateAgentSessionRequest {
  /** 绑定 pane 所在的 mesh node；缺省 / null / 'self' 均表示本 gateway */
  nodeId?: string | null;
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

/**
 * 列出 agent sessions。`nodeId` 缺省返回全部；`'self'` 只返回绑定本 gateway pane 的；
 * 其他值只返回绑定该远端 node 的。
 */
export async function fetchAgentSessions(
  client: ApiClient = defaultApiClient,
  options: { nodeId?: string } = {}
): Promise<AgentSessionDto[]> {
  const query = options.nodeId ? `?nodeId=${encodeURIComponent(options.nodeId)}` : '';
  return requestJson<{ sessions: AgentSessionDto[] }, AgentSessionDto[]>(
    client,
    `/api/agent/sessions${query}`,
    {
      errorFallback: 'Failed to load agent sessions',
      pick: (payload) => payload.sessions,
    }
  );
}

/** 404 返回 null（session 已被别端删除），其余非 2xx 抛错 */
export async function fetchAgentSession(
  sessionId: string,
  client: ApiClient = defaultApiClient
): Promise<AgentSessionDto | null> {
  const res = await requestOk(client, `/api/agent/sessions/${sessionId}`, {
    errorFallback: 'Failed to load agent session',
    allowStatus: [404],
  });
  if (res.status === 404) {
    return null;
  }
  return ((await res.json()) as { session: AgentSessionDto }).session;
}

export async function createAgentSession(
  body: CreateAgentSessionRequest,
  client: ApiClient = defaultApiClient
): Promise<AgentSessionDto> {
  return requestJson<{ session: AgentSessionDto }, AgentSessionDto>(client, '/api/agent/sessions', {
    method: 'POST',
    body,
    errorFallback: 'Failed to create agent session',
    pick: (payload) => payload.session,
  });
}

export async function updateAgentSession(
  sessionId: string,
  patch: UpdateAgentSessionPatch,
  errorFallback = 'Failed to update agent session',
  client: ApiClient = defaultApiClient
): Promise<AgentSessionDto> {
  return requestJson<{ session: AgentSessionDto }, AgentSessionDto>(
    client,
    `/api/agent/sessions/${sessionId}`,
    {
      method: 'PATCH',
      body: patch,
      errorFallback,
      pick: (payload) => payload.session,
    }
  );
}

export async function deleteAgentSession(
  sessionId: string,
  client: ApiClient = defaultApiClient
): Promise<void> {
  await requestOk(client, `/api/agent/sessions/${sessionId}`, {
    method: 'DELETE',
    errorFallback: 'Failed to delete agent session',
  });
}

/** afterSeq >= 0 时按增量拉取 */
export async function fetchAgentMessages(
  sessionId: string,
  afterSeq: number,
  client: ApiClient = defaultApiClient
): Promise<AgentMessageDto[]> {
  const query = afterSeq >= 0 ? `?afterSeq=${afterSeq}` : '';
  return requestJson<{ messages: AgentMessageDto[] }, AgentMessageDto[]>(
    client,
    `/api/agent/sessions/${sessionId}/messages${query}`,
    {
      errorFallback: 'Failed to load agent messages',
      pick: (payload) => payload.messages,
    }
  );
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
  return requestJson<SendAgentMessageResponse>(
    client,
    `/api/agent/sessions/${sessionId}/messages`,
    {
      method: 'POST',
      body: { text },
      errorFallback: 'Failed to send message',
    }
  );
}

export async function enqueueAgentMessage(
  sessionId: string,
  text: string,
  steer: boolean,
  client: ApiClient = defaultApiClient
): Promise<void> {
  await requestOk(client, `/api/agent/sessions/${sessionId}/queue`, {
    method: 'POST',
    body: { text, steer },
    errorFallback: 'Failed to queue message',
  });
}

export async function editQueuedAgentMessage(
  itemId: string,
  text: string,
  client: ApiClient = defaultApiClient
): Promise<void> {
  await requestOk(client, `/api/agent/queue/${itemId}`, {
    method: 'PATCH',
    body: { text },
    errorFallback: 'Failed to edit queued message',
  });
}

export async function withdrawQueuedAgentMessage(
  itemId: string,
  client: ApiClient = defaultApiClient
): Promise<void> {
  await requestOk(client, `/api/agent/queue/${itemId}`, {
    method: 'DELETE',
    errorFallback: 'Failed to withdraw queued message',
  });
}

export async function stopAgentSession(
  sessionId: string,
  client: ApiClient = defaultApiClient
): Promise<AgentSessionDto | null> {
  return requestJson<{ session: AgentSessionDto | null }, AgentSessionDto | null>(
    client,
    `/api/agent/sessions/${sessionId}/stop`,
    {
      method: 'POST',
      errorFallback: 'Failed to stop agent session',
      pick: (payload) => payload.session,
    }
  );
}

/** 409（已被别端决定）返回 'conflict'，调用方自行刷新 pending 列表 */
export async function decideAgentConfirmation(
  confirmationId: string,
  approved: boolean,
  reason: string | undefined,
  client: ApiClient = defaultApiClient
): Promise<'ok' | 'conflict'> {
  const res = await requestOk(client, `/api/agent/confirmations/${confirmationId}/decide`, {
    method: 'POST',
    body: reason === undefined ? { approved } : { approved, reason },
    errorFallback: 'Failed to decide confirmation',
    allowStatus: [409],
  });
  return res.status === 409 ? 'conflict' : 'ok';
}

export async function fetchAgentConfirmations(
  sessionId: string,
  client: ApiClient = defaultApiClient
): Promise<AgentConfirmationDto[]> {
  return requestJson<{ confirmations: AgentConfirmationDto[] }, AgentConfirmationDto[]>(
    client,
    `/api/agent/sessions/${sessionId}/confirmations`,
    {
      errorFallback: 'Failed to load confirmations',
      pick: (payload) => payload.confirmations,
    }
  );
}
