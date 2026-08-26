// Agent session REST API
// 用户消息 / 停止 / 确认决策统一走 REST（确认可能来自通知链接等非 WS 渠道）。

import type {
  AgentConfirmationDto,
  AgentMessageDto,
  AgentQueuedMessageDto,
  AgentSessionDto,
  CreateAgentSessionRequest,
  DecideAgentConfirmationRequest,
  EditQueuedAgentMessageRequest,
  EnqueueAgentMessageRequest,
  PostAgentMessageRequest,
  UpdateAgentSessionRequest,
} from '@tmex/shared';
import { DEFAULT_AGENT_SESSION_TITLE } from '@tmex/shared';
import {
  AgentAwaitingConfirmationError,
  AgentConfirmationAlreadyDecidedError,
  AgentConfirmationNotFoundError,
  AgentQueuedMessageNotFoundError,
  AgentSessionBusyError,
  AgentSessionNotFoundError,
  AgentSessionOrphanedError,
  type AgentSupervisor,
  agentSupervisor,
} from '../agent/supervisor';
import { getDeviceById } from '../db';
import {
  type AgentConfirmationRecord,
  type AgentMessageRecord,
  type AgentQueuedMessageRecord,
  type AgentSessionRecord,
  createAgentSession,
  deleteAgentSession,
  getAgentSessionById,
  getAllAgentSessions,
  listAgentMessages,
  listPendingAgentConfirmations,
  listQueuedAgentMessages,
  updateAgentSession,
} from '../db/agent';
import { t } from '../i18n';
import { tmuxRuntimeRegistry } from '../tmux-client/registry';
import { parseAgentSessionConfig } from './agent-session-config';

export function handleAgentApiRequest(
  req: Request,
  path: string,
  supervisor: AgentSupervisor = agentSupervisor
): Response | Promise<Response> | null {
  if (path === '/api/agent/sessions' && req.method === 'GET') {
    return handleListSessions(req);
  }
  if (path === '/api/agent/sessions' && req.method === 'POST') {
    return handleCreateSession(req);
  }
  if (path.match(/^\/api\/agent\/sessions\/[^/]+$/) && req.method === 'GET') {
    return handleGetSession(path.split('/')[4]);
  }
  if (path.match(/^\/api\/agent\/sessions\/[^/]+$/) && req.method === 'PATCH') {
    return handleUpdateSession(req, path.split('/')[4]);
  }
  if (path.match(/^\/api\/agent\/sessions\/[^/]+$/) && req.method === 'DELETE') {
    return handleDeleteSession(path.split('/')[4], supervisor);
  }
  if (path.match(/^\/api\/agent\/sessions\/[^/]+\/messages$/) && req.method === 'GET') {
    return handleListMessages(req, path.split('/')[4]);
  }
  if (path.match(/^\/api\/agent\/sessions\/[^/]+\/messages$/) && req.method === 'POST') {
    return handlePostMessage(req, path.split('/')[4], supervisor);
  }
  if (path.match(/^\/api\/agent\/sessions\/[^/]+\/queue$/) && req.method === 'GET') {
    return handleListQueued(path.split('/')[4]);
  }
  if (path.match(/^\/api\/agent\/sessions\/[^/]+\/queue$/) && req.method === 'POST') {
    return handleEnqueue(req, path.split('/')[4], supervisor);
  }
  if (path.match(/^\/api\/agent\/queue\/[^/]+$/) && req.method === 'PATCH') {
    return handleEditQueued(req, path.split('/')[4], supervisor);
  }
  if (path.match(/^\/api\/agent\/queue\/[^/]+$/) && req.method === 'DELETE') {
    return handleWithdrawQueued(path.split('/')[4], supervisor);
  }
  if (path.match(/^\/api\/agent\/sessions\/[^/]+\/stop$/) && req.method === 'POST') {
    return handleStopSession(path.split('/')[4], supervisor);
  }
  if (path.match(/^\/api\/agent\/sessions\/[^/]+\/confirmations$/) && req.method === 'GET') {
    return handleListConfirmations(path.split('/')[4]);
  }
  if (path.match(/^\/api\/agent\/confirmations\/[^/]+\/decide$/) && req.method === 'POST') {
    return handleDecideConfirmation(req, path.split('/')[4], supervisor);
  }

  return null;
}

function toSessionDto(record: AgentSessionRecord): AgentSessionDto {
  return {
    id: record.id,
    title: record.title,
    deviceId: record.deviceId,
    paneId: record.paneId,
    providerId: record.providerId,
    modelId: record.modelId,
    systemPrompt: record.systemPrompt,
    writeMode: record.writeMode,
    useProviderWebSearch: record.useProviderWebSearch,
    providerHostedTools: record.providerHostedTools ?? [],
    allowControlChars: record.allowControlChars,
    originPaneTitle: record.originPaneTitle,
    originProcessName: record.originProcessName,
    status: record.status,
    lastError: record.lastError,
    maxStepsPerTurn: record.maxStepsPerTurn,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function toMessageDto(record: AgentMessageRecord): AgentMessageDto {
  return {
    id: record.id,
    sessionId: record.sessionId,
    seq: record.seq,
    role: record.role,
    content: record.content,
    createdAt: record.createdAt,
  };
}

function toQueuedDto(record: AgentQueuedMessageRecord): AgentQueuedMessageDto {
  return {
    id: record.id,
    sessionId: record.sessionId,
    seq: record.seq,
    text: record.text,
    createdAt: record.createdAt,
  };
}

function toConfirmationDto(record: AgentConfirmationRecord): AgentConfirmationDto {
  return {
    id: record.id,
    sessionId: record.sessionId,
    toolName: record.toolName,
    toolCallId: record.toolCallId,
    input: record.inputJson,
    status: record.status,
    reason: record.reason,
    decidedAt: record.decidedAt,
    createdAt: record.createdAt,
  };
}

async function readJsonObjectBody(req: Request): Promise<Record<string, unknown> | null> {
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

/**
 * 创建会话时采集起源元数据（D1）：进程名经 tmux runtime 的 getPaneInfo 取 currentCommand；
 * 标题用前端传入的 snapshot 标题兜底（PaneInfo 不含标题）。任何失败静默降级为 null，不阻塞建会话。
 */
async function captureSessionOrigin(
  deviceId: string,
  paneId: string,
  fallbackTitle: string | null
): Promise<{ title: string | null; processName: string | null }> {
  let processName: string | null = null;
  try {
    const runtime = await tmuxRuntimeRegistry.acquire(deviceId);
    try {
      const info = await runtime.getPaneInfo(paneId);
      processName = info.currentCommand ?? null;
    } finally {
      await tmuxRuntimeRegistry.release(deviceId, runtime);
    }
  } catch (error) {
    console.warn(`[api/agent] capture session origin failed for ${deviceId}/${paneId}:`, error);
  }
  return { title: fallbackTitle?.trim() ? fallbackTitle.trim() : null, processName };
}

async function handleListSessions(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const deviceId = url.searchParams.get('deviceId');
  const paneId = url.searchParams.get('paneId');

  let sessions = getAllAgentSessions();
  if (deviceId) {
    sessions = sessions.filter((s) => s.deviceId === deviceId);
  }
  if (paneId) {
    sessions = sessions.filter((s) => s.paneId === paneId);
  }

  return json({ sessions: sessions.map(toSessionDto) });
}

async function handleCreateSession(req: Request): Promise<Response> {
  const raw = await readJsonObjectBody(req);
  if (!raw) {
    return json({ error: t('apiError.invalidRequest') }, 400);
  }
  const body = raw as unknown as CreateAgentSessionRequest;

  const deviceId = typeof body.deviceId === 'string' ? body.deviceId.trim() : '';
  if (!deviceId) {
    return json({ error: t('apiError.agentDeviceRequired') }, 400);
  }
  if (!getDeviceById(deviceId)) {
    return json({ error: t('apiError.deviceNotFound') }, 404);
  }

  const paneId = typeof body.paneId === 'string' ? body.paneId.trim() : '';
  if (!paneId) {
    return json({ error: t('apiError.agentPaneRequired') }, 400);
  }

  const parsed = parseAgentSessionConfig(raw);
  if (!parsed.ok) {
    return json({ error: parsed.error }, 400);
  }

  const origin = await captureSessionOrigin(
    deviceId,
    paneId,
    typeof body.originPaneTitle === 'string' ? body.originPaneTitle : null
  );

  const session = createAgentSession({
    title: DEFAULT_AGENT_SESSION_TITLE,
    deviceId,
    paneId,
    ...parsed.config,
    originPaneTitle: origin.title,
    originProcessName: origin.processName,
  });

  return json({ session: toSessionDto(session) }, 201);
}

async function handleGetSession(id: string): Promise<Response> {
  const session = getAgentSessionById(id);
  if (!session) {
    return json({ error: t('apiError.agentSessionNotFound') }, 404);
  }
  return json({ session: toSessionDto(session) });
}

async function handleUpdateSession(req: Request, id: string): Promise<Response> {
  const existing = getAgentSessionById(id);
  if (!existing) {
    return json({ error: t('apiError.agentSessionNotFound') }, 404);
  }

  const raw = await readJsonObjectBody(req);
  if (!raw) {
    return json({ error: t('apiError.invalidRequest') }, 400);
  }
  const body = raw as UpdateAgentSessionRequest;
  const updates: Partial<
    Pick<
      AgentSessionRecord,
      | 'title'
      | 'paneId'
      | 'providerId'
      | 'modelId'
      | 'systemPrompt'
      | 'writeMode'
      | 'useProviderWebSearch'
      | 'providerHostedTools'
      | 'allowControlChars'
      | 'maxStepsPerTurn'
    >
  > = {};

  if (body.title !== undefined) {
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title) {
      return json({ error: t('apiError.invalidRequest') }, 400);
    }
    updates.title = title;
  }

  if (body.paneId !== undefined) {
    const paneId = typeof body.paneId === 'string' ? body.paneId.trim() : '';
    if (!paneId) {
      return json({ error: t('apiError.agentPaneRequired') }, 400);
    }
    updates.paneId = paneId;
  }

  const parsed = parseAgentSessionConfig(raw, existing);
  if (!parsed.ok) {
    return json({ error: parsed.error }, 400);
  }
  Object.assign(updates, parsed.config);

  const session = updateAgentSession(id, updates);
  if (!session) {
    return json({ error: t('apiError.agentSessionNotFound') }, 404);
  }
  return json({ session: toSessionDto(session) });
}

async function handleDeleteSession(id: string, supervisor: AgentSupervisor): Promise<Response> {
  const existing = getAgentSessionById(id);
  if (!existing) {
    return json({ error: t('apiError.agentSessionNotFound') }, 404);
  }

  if (supervisor.isSessionActive(id)) {
    await supervisor.stopSession(id);
  }

  deleteAgentSession(id);
  return json({ success: true });
}

async function handleListMessages(req: Request, id: string): Promise<Response> {
  const session = getAgentSessionById(id);
  if (!session) {
    return json({ error: t('apiError.agentSessionNotFound') }, 404);
  }

  const url = new URL(req.url);
  const afterSeqRaw = url.searchParams.get('afterSeq');
  let afterSeq: number | undefined;
  if (afterSeqRaw !== null) {
    const parsed = Number(afterSeqRaw);
    if (!Number.isInteger(parsed)) {
      return json({ error: t('apiError.invalidRequest') }, 400);
    }
    afterSeq = parsed;
  }

  const messages = listAgentMessages(id, { afterSeq });
  return json({ messages: messages.map(toMessageDto) });
}

async function handlePostMessage(
  req: Request,
  id: string,
  supervisor: AgentSupervisor
): Promise<Response> {
  const raw = await readJsonObjectBody(req);
  if (!raw) {
    return json({ error: t('apiError.invalidRequest') }, 400);
  }
  const body = raw as unknown as PostAgentMessageRequest;

  const text = typeof body.text === 'string' ? body.text : '';
  if (!text.trim()) {
    return json({ error: t('apiError.agentMessageTextRequired') }, 400);
  }

  try {
    const result = supervisor.submitUserMessage(id, text);
    if (result.kind === 'queued') {
      return json({ queued: toQueuedDto(result.record) }, 201);
    }
    return json({ message: toMessageDto(result.record) }, 201);
  } catch (error) {
    return mapSupervisorError(error);
  }
}

async function handleListQueued(id: string): Promise<Response> {
  const session = getAgentSessionById(id);
  if (!session) {
    return json({ error: t('apiError.agentSessionNotFound') }, 404);
  }
  return json({ queued: listQueuedAgentMessages(id).map(toQueuedDto) });
}

async function handleEnqueue(
  req: Request,
  id: string,
  supervisor: AgentSupervisor
): Promise<Response> {
  const raw = await readJsonObjectBody(req);
  if (!raw) {
    return json({ error: t('apiError.invalidRequest') }, 400);
  }
  const body = raw as unknown as EnqueueAgentMessageRequest;

  const text = typeof body.text === 'string' ? body.text : '';
  if (!text.trim()) {
    return json({ error: t('apiError.agentMessageTextRequired') }, 400);
  }
  if (body.steer !== undefined && typeof body.steer !== 'boolean') {
    return json({ error: t('apiError.invalidRequest') }, 400);
  }

  try {
    const result = supervisor.submitUserMessage(id, text, body.steer ?? false);
    if (result.kind === 'queued') {
      return json({ queued: toQueuedDto(result.record) }, 201);
    }
    return json({ message: toMessageDto(result.record) }, 201);
  } catch (error) {
    return mapSupervisorError(error);
  }
}

async function handleEditQueued(
  req: Request,
  itemId: string,
  supervisor: AgentSupervisor
): Promise<Response> {
  const raw = await readJsonObjectBody(req);
  if (!raw) {
    return json({ error: t('apiError.invalidRequest') }, 400);
  }
  const body = raw as unknown as EditQueuedAgentMessageRequest;
  const text = typeof body.text === 'string' ? body.text : '';
  if (!text.trim()) {
    return json({ error: t('apiError.agentMessageTextRequired') }, 400);
  }

  try {
    const record = supervisor.editQueuedMessage(itemId, text);
    return json({ queued: toQueuedDto(record) });
  } catch (error) {
    return mapSupervisorError(error);
  }
}

async function handleWithdrawQueued(
  itemId: string,
  supervisor: AgentSupervisor
): Promise<Response> {
  try {
    supervisor.withdrawQueuedMessage(itemId);
    return json({ success: true });
  } catch (error) {
    return mapSupervisorError(error);
  }
}

async function handleStopSession(id: string, supervisor: AgentSupervisor): Promise<Response> {
  try {
    await supervisor.stopSession(id);
    const session = getAgentSessionById(id);
    return json({ session: session ? toSessionDto(session) : null });
  } catch (error) {
    return mapSupervisorError(error);
  }
}

async function handleListConfirmations(id: string): Promise<Response> {
  const session = getAgentSessionById(id);
  if (!session) {
    return json({ error: t('apiError.agentSessionNotFound') }, 404);
  }

  const confirmations = listPendingAgentConfirmations(id);
  return json({ confirmations: confirmations.map(toConfirmationDto) });
}

async function handleDecideConfirmation(
  req: Request,
  id: string,
  supervisor: AgentSupervisor
): Promise<Response> {
  const raw = await readJsonObjectBody(req);
  if (!raw) {
    return json({ error: t('apiError.invalidRequest') }, 400);
  }
  const body = raw as unknown as DecideAgentConfirmationRequest;

  if (typeof body.approved !== 'boolean') {
    return json({ error: t('apiError.invalidRequest') }, 400);
  }
  if (body.reason !== undefined && typeof body.reason !== 'string') {
    return json({ error: t('apiError.invalidRequest') }, 400);
  }

  try {
    const decided = supervisor.resolveConfirmation(id, body.approved, body.reason);
    return json({ confirmation: toConfirmationDto(decided) });
  } catch (error) {
    return mapSupervisorError(error);
  }
}

function mapSupervisorError(error: unknown): Response {
  if (error instanceof AgentSessionNotFoundError) {
    return json({ error: error.message }, 404);
  }
  if (error instanceof AgentConfirmationNotFoundError) {
    return json({ error: error.message }, 404);
  }
  if (error instanceof AgentSessionBusyError) {
    return json({ error: error.message }, 409);
  }
  if (error instanceof AgentAwaitingConfirmationError) {
    return json({ error: error.message }, 409);
  }
  if (error instanceof AgentConfirmationAlreadyDecidedError) {
    return json({ error: error.message }, 409);
  }
  if (error instanceof AgentQueuedMessageNotFoundError) {
    return json({ error: error.message }, 404);
  }
  if (error instanceof AgentSessionOrphanedError) {
    return json({ error: error.message }, 409);
  }
  console.error('[api/agent] unexpected error:', error);
  return json(
    { error: error instanceof Error ? error.message : t('apiError.invalidRequest') },
    500
  );
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  });
}
