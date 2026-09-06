import { DEFAULT_AGENT_SESSION_TITLE } from '@vibeterm/shared';
import {
  type StoredPaneGrant,
  commitPreparedGrant,
  encryptPaneGrant,
  ensureSessionGrant,
  loadSessionGrant,
  markSessionGrantStale,
  prepareSessionGrant,
  revokeGrantLater,
  revokeSessionGrant,
} from '../agent/pane-grant/client';
import type { AgentSupervisor } from '../agent/supervisor';
import { getDeviceById } from '../db';
import {
  type AgentSessionRecord,
  createAgentSession,
  deleteAgentSession,
  getAgentSessionById,
  getAllAgentSessions,
  updateAgentSession,
  updateAgentSessionIfUnchanged,
} from '../db/agent';
import { t } from '../i18n';
import { tmuxRuntimeRegistry } from '../tmux-client/registry';
import { mapSupervisorError, toSessionDto } from './agent-dtos';
import { createRemotePaneRuntime, prepareRemotePane } from './agent-remote-pane';
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

function parseSessionNodeId(raw: unknown): { ok: true; value: string | null } | { ok: false } {
  if (raw === undefined || raw === null || raw === '' || raw === 'self') {
    return { ok: true, value: null };
  }
  if (typeof raw !== 'string') {
    return { ok: false };
  }
  const value = raw.trim();
  if (!value || value === 'self') {
    return { ok: true, value: null };
  }
  return { ok: true, value };
}

/**
 * 创建会话时采集起源元数据（D1）：进程名经 tmux runtime 的 getPaneInfo 取 currentCommand；
 * 标题用前端传入的 snapshot 标题兜底（PaneInfo 不含标题）。任何失败静默降级为 null，不阻塞建会话。
 */
async function captureSessionOrigin(
  deviceId: string,
  paneId: string,
  fallbackTitle: string | null,
  nodeId: string | null,
  grant: StoredPaneGrant | null = null
): Promise<{ title: string | null; processName: string | null }> {
  let processName: string | null = null;
  try {
    if (nodeId) {
      const runtime = createRemotePaneRuntime(nodeId, deviceId, grant);
      if (runtime) {
        const info = await runtime.getPaneInfo(paneId);
        processName = info.currentCommand ?? info.title ?? null;
      }
    } else {
      const runtime = await tmuxRuntimeRegistry.acquire(deviceId);
      try {
        const info = await runtime.getPaneInfo(paneId);
        processName = info.currentCommand ?? null;
      } finally {
        await tmuxRuntimeRegistry.release(deviceId, runtime);
      }
    }
  } catch (error) {
    console.warn(`[api/agent] capture session origin failed for ${deviceId}/${paneId}:`, error);
  }
  return { title: fallbackTitle?.trim() ? fallbackTitle.trim() : null, processName };
}

async function handleListSessions(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const nodeId = url.searchParams.get('nodeId') ?? undefined;
  const deviceId = url.searchParams.get('deviceId');
  const paneId = url.searchParams.get('paneId');

  let sessions = getAllAgentSessions(nodeId ? { nodeId } : {});
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

  const nodeIdParsed = parseSessionNodeId(raw.nodeId);
  if (!nodeIdParsed.ok) {
    return json({ error: t('apiError.invalidRequest') }, 400);
  }
  const nodeId = nodeIdParsed.value;

  const deviceId = typeof raw.deviceId === 'string' ? raw.deviceId.trim() : '';
  if (!deviceId) {
    return json({ error: t('apiError.agentDeviceRequired') }, 400);
  }
  if (!nodeId && !getDeviceById(deviceId)) {
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

  let grant: StoredPaneGrant | null = null;
  if (nodeId) {
    const prepared = await prepareRemotePane(req, { nodeId, deviceId, paneId });
    if (!prepared.ok) {
      return prepared.response;
    }
    grant = prepared.grant;
  }

  const origin = await captureSessionOrigin(
    deviceId,
    paneId,
    typeof raw.originPaneTitle === 'string' ? raw.originPaneTitle : null,
    nodeId,
    grant
  );

  const session = createAgentSession({
    title: DEFAULT_AGENT_SESSION_TITLE,
    nodeId,
    deviceId,
    paneId,
    ...parsed.config,
    originPaneTitle: origin.title,
    originProcessName: origin.processName,
    remoteGrant: grant ? await encryptPaneGrant(grant) : null,
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

  const fields = { ...identity.fields, ...parsed.config };
  const rebound = identity.fields.paneId;
  // 改绑窗格：授权必须按**将要写入**的窗格先签好，再与绑定一起提交；
  // 授权没签下来时会话一个字段都不能动，否则前端认为失败、后端却已经换了绑定。
  if (existing.nodeId && typeof rebound === 'string' && rebound !== existing.paneId) {
    return commitPaneRebind(req, existing, fields, rebound);
  }

  const session = updateAgentSession(id, fields);
  if (!session) {
    return json({ error: t('apiError.agentSessionNotFound') }, 404);
  }
  return json({ session: toSessionDto(session) });
}

async function commitPaneRebind(
  req: Request,
  existing: AgentSessionRecord,
  fields: Record<string, unknown>,
  paneId: string
): Promise<Response> {
  const prepared = await prepareSessionGrant(req, existing, paneId);
  if (!prepared.ok) {
    return prepared.response;
  }
  const previous = await loadSessionGrant(existing.id);
  const session = updateAgentSessionIfUnchanged(
    existing.id,
    {
      updatedAt: existing.updatedAt,
      nodeId: existing.nodeId,
      deviceId: existing.deviceId,
      paneId: existing.paneId,
    },
    { ...fields, remoteGrant: prepared.cipher }
  );
  if (!session) {
    if (prepared.grant) revokeGrantLater(prepared.grant);
    return json({ error: t('apiError.agentSessionChanged') }, 409);
  }
  if (prepared.grant && prepared.cipher) {
    commitPreparedGrant(session.id, prepared.cipher, prepared.grant, previous);
  } else {
    // 目标节点旧版本或一时够不着：旧授权已不匹配新窗格，标记待补签
    if (previous) revokeGrantLater(previous);
    markSessionGrantStale(session.id);
  }
  return json({ session: toSessionDto(session) });
}

async function handleDeleteSession(
  req: Request,
  id: string,
  supervisor: AgentSupervisor
): Promise<Response> {
  const existing = getAgentSessionById(id);
  if (!existing) {
    return json({ error: t('apiError.agentSessionNotFound') }, 404);
  }

  if (supervisor.isSessionActive(id)) {
    await supervisor.stopSession(id);
  }

  revokeSessionGrant(req, existing);
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
      handler: (req, params) => handleDeleteSession(req, params.id, supervisor),
    }),
    route({
      method: 'POST',
      path: '/api/agent/sessions/:id/stop',
      handler: (_req, params) => handleStopSession(params.id, supervisor),
    }),
  ];
}
