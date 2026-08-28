import { DEFAULT_AGENT_SESSION_TITLE } from '@tmex/shared';
import type { AgentSupervisor } from '../agent/supervisor';
import { getDeviceById } from '../db';
import {
  type AgentSessionRecord,
  createAgentSession,
  deleteAgentSession,
  getAgentSessionById,
  getAllAgentSessions,
  updateAgentSession,
} from '../db/agent';
import { t } from '../i18n';
import { tmuxRuntimeRegistry } from '../tmux-client/registry';
import { mapSupervisorError, toSessionDto } from './agent-dtos';
import { parseAgentSessionConfig } from './agent-session-config';
import { type ConfigFieldSpec, type FieldParseResult, applyConfigFields } from './config-field';
import { json, readJsonObjectBody } from './http';
import { type ApiRoute, route } from './route';

type SessionIdentityPatch = Partial<Pick<AgentSessionRecord, 'title' | 'paneId'>>;

function parseRequiredTrimmed(raw: unknown, error: string): FieldParseResult<string> {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return { ok: false, error };
  return { ok: true, value };
}

const SESSION_IDENTITY_FIELDS: ConfigFieldSpec<unknown>[] = [
  {
    name: 'title',
    parse: (raw) => parseRequiredTrimmed(raw, t('apiError.invalidRequest')),
  },
  {
    name: 'paneId',
    parse: (raw) => parseRequiredTrimmed(raw, t('apiError.agentPaneRequired')),
  },
];

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

  const deviceId = typeof raw.deviceId === 'string' ? raw.deviceId.trim() : '';
  if (!deviceId) {
    return json({ error: t('apiError.agentDeviceRequired') }, 400);
  }
  if (!getDeviceById(deviceId)) {
    return json({ error: t('apiError.deviceNotFound') }, 404);
  }

  const paneId = typeof raw.paneId === 'string' ? raw.paneId.trim() : '';
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
    typeof raw.originPaneTitle === 'string' ? raw.originPaneTitle : null
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

  const identity = applyConfigFields<SessionIdentityPatch>(raw, SESSION_IDENTITY_FIELDS, undefined);
  if (!identity.ok) {
    return json({ error: identity.error }, 400);
  }

  const parsed = parseAgentSessionConfig(raw, existing);
  if (!parsed.ok) {
    return json({ error: parsed.error }, 400);
  }

  const session = updateAgentSession(id, { ...identity.fields, ...parsed.config });
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

async function handleStopSession(id: string, supervisor: AgentSupervisor): Promise<Response> {
  try {
    await supervisor.stopSession(id);
    const session = getAgentSessionById(id);
    return json({ session: session ? toSessionDto(session) : null });
  } catch (error) {
    return mapSupervisorError(error);
  }
}

export function createAgentSessionRoutes(supervisor: AgentSupervisor): ApiRoute[] {
  return [
    route({
      method: 'GET',
      path: '/api/agent/sessions',
      handler: (req) => handleListSessions(req),
    }),
    route({
      method: 'POST',
      path: '/api/agent/sessions',
      handler: (req) => handleCreateSession(req),
    }),
    route({
      method: 'GET',
      path: '/api/agent/sessions/:id',
      handler: (_req, params) => handleGetSession(params.id),
    }),
    route({
      method: 'PATCH',
      path: '/api/agent/sessions/:id',
      handler: (req, params) => handleUpdateSession(req, params.id),
    }),
    route({
      method: 'DELETE',
      path: '/api/agent/sessions/:id',
      handler: (_req, params) => handleDeleteSession(params.id, supervisor),
    }),
    route({
      method: 'POST',
      path: '/api/agent/sessions/:id/stop',
      handler: (_req, params) => handleStopSession(params.id, supervisor),
    }),
  ];
}
