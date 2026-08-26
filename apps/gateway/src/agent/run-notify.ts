import type { EventType, WebhookEvent } from '@tmex/shared';
import { getDeviceById, getSiteSettings } from '../db';
import type { AgentSessionRecord } from '../db/agent';
import { resolvePaneContext } from '../tmux/bell-context';
import { getDeviceSnapshot } from '../tmux/snapshot-directory';

export async function notifyAgentEvent(params: {
  notify: (
    eventType: EventType,
    event: Omit<WebhookEvent, 'eventType' | 'timestamp'>
  ) => Promise<void>;
  session: AgentSessionRecord;
  eventType: EventType;
  payload: Record<string, unknown>;
}): Promise<void> {
  try {
    const settings = getSiteSettings();
    const device = params.session.deviceId ? getDeviceById(params.session.deviceId) : null;
    const paneContext =
      params.session.deviceId && params.session.paneId
        ? resolvePaneContext({
            deviceId: params.session.deviceId,
            siteUrl: settings.siteUrl,
            snapshot: getDeviceSnapshot(params.session.deviceId),
            rawData: { paneId: params.session.paneId },
          })
        : null;
    await params.notify(params.eventType, {
      site: {
        name: settings.siteName,
        url: settings.siteUrl,
      },
      device: {
        id: device?.id ?? params.session.deviceId ?? '-',
        name: device?.name ?? 'unknown',
        type: device?.type ?? 'local',
        host: device?.host,
      },
      tmux: {
        sessionName: device?.session,
        ...(paneContext ?? {}),
        paneId: params.session.paneId ?? undefined,
      },
      payload: {
        ...params.payload,
        agentSessionId: params.session.id,
        agentSessionTitle: params.session.title,
      },
    });
  } catch (error) {
    console.error(`[agent-run] notify ${params.eventType} failed for ${params.session.id}:`, error);
  }
}
