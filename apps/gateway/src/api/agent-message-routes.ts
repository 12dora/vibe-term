import { ensureSessionGrant } from '../agent/pane-grant/client';
import type { AgentSupervisor } from '../agent/supervisor';
import { getAgentSessionById, listAgentMessages, listQueuedAgentMessages } from '../db/agent';
import { t } from '../i18n';
import { mapSupervisorError, toMessageDto, toQueuedDto } from './agent-dtos';
import { json, readJsonObjectBody } from './http';
import { type ApiRoute, route } from './route';

function readMessageText(
  raw: Record<string, unknown>
): { ok: true; text: string } | { ok: false; response: Response } {
  const text = typeof raw.text === 'string' ? raw.text : '';
  if (!text.trim()) {
    return { ok: false, response: json({ error: t('apiError.agentMessageTextRequired') }, 400) };
  }
  return { ok: true, text };
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

/**
 * 远端窗格会话：这是唯一带着用户 cookie 的时机，缺授权或上一轮被目标节点拒收就在这里补签。
 * 浏览器没有目标节点的会话时把 401 透出去，前端既有的节点登录提示接手。
 */
async function ensureRemoteGrant(req: Request, id: string): Promise<Response | null> {
  const session = getAgentSessionById(id);
  if (!session) return null;
  const ensured = await ensureSessionGrant(req, session);
  return ensured.ok ? null : ensured.response;
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
  const text = readMessageText(raw);
  if (!text.ok) return text.response;
  const denied = await ensureRemoteGrant(req, id);
  if (denied) return denied;

  try {
    const result = supervisor.submitUserMessage(id, text.text);
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
  const text = readMessageText(raw);
  if (!text.ok) return text.response;
  const steer = raw.steer;
  if (steer !== undefined && typeof steer !== 'boolean') {
    return json({ error: t('apiError.invalidRequest') }, 400);
  }
  const denied = await ensureRemoteGrant(req, id);
  if (denied) return denied;

  try {
    const result = supervisor.submitUserMessage(id, text.text, steer === true);
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
  const text = readMessageText(raw);
  if (!text.ok) return text.response;

  try {
    const record = supervisor.editQueuedMessage(itemId, text.text);
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

export function createAgentMessageRoutes(supervisor: AgentSupervisor): ApiRoute[] {
  return [
    route({
      method: 'GET',
      path: '/api/agent/sessions/:id/messages',
      handler: (req, params) => handleListMessages(req, params.id),
    }),
    route({
      method: 'POST',
      path: '/api/agent/sessions/:id/messages',
      handler: (req, params) => handlePostMessage(req, params.id, supervisor),
    }),
    route({
      method: 'GET',
      path: '/api/agent/sessions/:id/queue',
      handler: (_req, params) => handleListQueued(params.id),
    }),
    route({
      method: 'POST',
      path: '/api/agent/sessions/:id/queue',
      handler: (req, params) => handleEnqueue(req, params.id, supervisor),
    }),
    route({
      method: 'PATCH',
      path: '/api/agent/queue/:id',
      handler: (req, params) => handleEditQueued(req, params.id, supervisor),
    }),
    route({
      method: 'DELETE',
      path: '/api/agent/queue/:id',
      handler: (_req, params) => handleWithdrawQueued(params.id, supervisor),
    }),
  ];
}
