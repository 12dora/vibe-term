import { type EventType, type SiteSettings, type WebhookEvent, toBCP47 } from '@tmex/shared';
import { eq } from 'drizzle-orm';
import { isRelayOnly, resolveLiveRoles } from '../../config';
import { getSiteSettings } from '../../db';
import { getDb } from '../../db/client';
import { nodeIdentity } from '../../db/schema';
import { t } from '../../i18n';
import { buildPaneUrl, normalizeHttpUrl } from './pane-url';
import { CREDENTIAL_WARNING_KIND } from './types';

export const EVENT_EMOJI: Record<EventType, string> = {
  terminal_bell: '🔔',
  terminal_notification: '🔔',
  tmux_window_close: '🪟',
  tmux_pane_close: '📱',
  device_tmux_missing: '⚠️',
  device_disconnect: '🔌',
  device_connection_error: '⚠️',
  session_created: '🆕',
  session_closed: '🚪',
  agent_confirmation_pending: '🤖',
  agent_turn_finished: '🤖',
  agent_error: '🤖',
  watch_triggered: '👁️',
  watch_model_unavailable: '👁️',
  watch_rule_error: '👁️',
};

const IDENTITY_ROW_ID = 1;

type NodeNameProvider = () => string | null;

let nodeNameProvider: NodeNameProvider | null = null;

export function setNotificationNodeNameProvider(provider: NodeNameProvider | null): void {
  nodeNameProvider = provider;
}

function readNodeIdentityName(): string | null {
  try {
    const row = getDb()
      .select({ name: nodeIdentity.name })
      .from(nodeIdentity)
      .where(eq(nodeIdentity.id, IDENTITY_ROW_ID))
      .get();
    const name = row?.name?.trim() ?? '';
    return name.length > 0 ? name : null;
  } catch {
    return null;
  }
}

function readSiteNameFallback(): string | null {
  try {
    const name = getSiteSettings().siteName?.trim() ?? '';
    return name.length > 0 ? name : null;
  } catch {
    return null;
  }
}

function defaultNotificationNodeName(): string | null {
  try {
    const roles = resolveLiveRoles();
    if (isRelayOnly(roles) || (!roles.hub && !roles.node)) {
      return null;
    }
    return readNodeIdentityName() ?? readSiteNameFallback();
  } catch {
    return null;
  }
}

export function resolveNotificationNodeName(): string | null {
  return (nodeNameProvider ?? defaultNotificationNodeName)();
}

function nodeLabelLine(): string | null {
  const name = resolveNotificationNodeName();
  if (!name) return null;
  return `${t('notification.node', { defaultValue: 'Node' })}：${name}`;
}

function withNodeLine(lines: string[]): string[] {
  const nodeLine = nodeLabelLine();
  return nodeLine ? [nodeLine, ...lines] : lines;
}

export function buildTerminalTopbarLabel(event: WebhookEvent): string {
  const windowLabel =
    typeof event.tmux?.windowIndex === 'number'
      ? `${event.tmux.windowIndex}`
      : (event.tmux?.windowId ?? '?');
  const paneLabel =
    typeof event.tmux?.paneIndex === 'number'
      ? `${event.tmux.paneIndex}`
      : (event.tmux?.paneId ?? '?');

  return t('notification.telegramBell.terminalTopbarLabel', {
    window: windowLabel,
    pane: paneLabel,
    device: event.device.name,
  });
}

export function buildPaneMetaLines(event: WebhookEvent): string[] {
  const lines: string[] = [];
  if (event.tmux?.paneTitle) {
    lines.push(`${t('notification.paneTitle')}：${event.tmux.paneTitle}`);
  }
  if (event.tmux?.paneCurrentCommand) {
    lines.push(`${t('notification.process')}：${event.tmux.paneCurrentCommand}`);
  }
  return lines;
}

export interface BellRawView {
  title: string;
  paneMetaLines: string[];
  paneUrl: string | null;
  viewLinkLabel: string;
}

export function buildBellRawView(event: WebhookEvent): BellRawView {
  return {
    title: t('notification.telegramBell.title', {
      siteName: event.site.name,
      terminalTopbarLabel: buildTerminalTopbarLabel(event),
    }),
    paneMetaLines: withNodeLine(buildPaneMetaLines(event)),
    paneUrl: normalizeHttpUrl(buildPaneUrl(event)),
    viewLinkLabel: t('notification.telegramBell.viewLink'),
  };
}

export interface NotificationRawView {
  title: string;
  body: string;
  paneMetaLines: string[];
  footer: string;
  paneUrl: string | null;
}

export function buildNotificationRawView(event: WebhookEvent): NotificationRawView {
  return {
    title: typeof event.payload?.title === 'string' ? event.payload.title : '',
    body: typeof event.payload?.message === 'string' ? event.payload.message : '',
    paneMetaLines: withNodeLine(buildPaneMetaLines(event)),
    footer: `from ${event.site.name}: ${buildTerminalTopbarLabel(event)}`,
    paneUrl: normalizeHttpUrl(buildPaneUrl(event)),
  };
}

export interface GenericRawView {
  lines: string[];
  paneUrl: string | null;
  directLinkLabel: string;
}

function formatIndexAndId(index: number | undefined, id: string | undefined): string {
  if (index !== undefined) return `${index} (${id ?? '-'})`;
  return id ?? '-';
}

export function buildConnectionErrorText(event: WebhookEvent): string {
  const category = typeof event.payload?.category === 'string' ? event.payload.category : '';
  const error = typeof event.payload?.message === 'string' ? event.payload.message : '';
  return t('telegram.deviceConnectionError', {
    siteName: event.site.name,
    deviceName: event.device.name,
    host: event.device.host ?? '-',
    category,
    error,
  });
}

export function buildCredentialWarningText(event: WebhookEvent): string {
  const types = Array.isArray(event.payload?.types)
    ? event.payload.types.filter((item): item is string => typeof item === 'string').join(', ')
    : '';
  const sessionTitle =
    typeof event.payload?.agentSessionTitle === 'string' ? event.payload.agentSessionTitle : '';
  const lines = [
    t('telegram.agentCredentialWarning', {
      siteName: event.site.name,
      sessionTitle,
      types,
    }),
  ];
  const nodeLine = nodeLabelLine();
  if (nodeLine) lines.push(nodeLine);
  return lines.join('\n');
}

export function isCredentialWarningEvent(event: WebhookEvent): boolean {
  return event.payload?.kind === CREDENTIAL_WARNING_KIND;
}

export function buildGenericRawView(event: WebhookEvent, settings: SiteSettings): GenericRawView {
  const eventTypeLabel = t(`notification.eventType.${event.eventType}` as const, {
    defaultValue: event.eventType,
  });
  const lines = [
    `${EVENT_EMOJI[event.eventType] ?? '📢'} ${eventTypeLabel}`,
    `${t('notification.site')}：${event.site.name}`,
  ];
  const nodeLine = nodeLabelLine();
  if (nodeLine) lines.push(nodeLine);
  lines.push(
    `${t('notification.time')}：${new Date(event.timestamp).toLocaleString(toBCP47(settings.language))}`,
    `${t('notification.device')}：${event.device.name} (${event.device.type})`,
    `${t('notification.window')}：${formatIndexAndId(event.tmux?.windowIndex, event.tmux?.windowId)}`,
    `${t('notification.pane')}：${formatIndexAndId(event.tmux?.paneIndex, event.tmux?.paneId)}`
  );
  lines.push(...buildPaneMetaLines(event));
  const message = event.payload?.message;
  if (typeof message === 'string' && message.length > 0) {
    lines.push(`${t('notification.message')}：${message}`);
  }
  return {
    lines,
    paneUrl: normalizeHttpUrl(buildPaneUrl(event)),
    directLinkLabel: t('notification.directLink'),
  };
}
