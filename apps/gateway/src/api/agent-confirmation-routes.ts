import type { AgentSupervisor } from '../agent/supervisor';
import { getAgentSessionById, listPendingAgentConfirmations } from '../db/agent';
import { t } from '../i18n';
import { mapSupervisorError, toConfirmationDto } from './agent-dtos';
import { json, readJsonObjectBody } from './http';
import { type ApiRoute, route } from './route';

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

  if (typeof raw.approved !== 'boolean') {
    return json({ error: t('apiError.invalidRequest') }, 400);
  }
  if (raw.reason !== undefined && typeof raw.reason !== 'string') {
    return json({ error: t('apiError.invalidRequest') }, 400);
  }

  try {
    const decided = supervisor.resolveConfirmation(
      id,
      raw.approved,
      typeof raw.reason === 'string' ? raw.reason : undefined
    );
    return json({ confirmation: toConfirmationDto(decided) });
  } catch (error) {
    return mapSupervisorError(error);
  }
}

export function createAgentConfirmationRoutes(supervisor: AgentSupervisor): ApiRoute[] {
  return [
    route({
      method: 'GET',
      path: '/api/agent/sessions/:id/confirmations',
      handler: (_req, params) => handleListConfirmations(params.id),
    }),
    route({
      method: 'POST',
      path: '/api/agent/confirmations/:id/decide',
      handler: (req, params) => handleDecideConfirmation(req, params.id, supervisor),
    }),
  ];
}
