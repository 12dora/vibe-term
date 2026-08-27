import { type EventType, type SiteSettings, type WebhookEvent, toBCP47 } from '@tmex/shared';
import { t } from '../../i18n';
import { buildPaneUrl, normalizeHttpUrl } from './pane-url';

export const EVENT_EMOJI: Record<EventType, string> = {
  terminal_bell: '🔔',
  terminal_notification: '🔔',
  tmux_window_close: '🪟',
  tmux_pane_close: '📱',
  device_tmux_missing: '⚠️',
  device_disconnect: '🔌',
  session_created: '🆕',
  session_closed: '🚪',
  agent_confirmation_pending: '🤖',
  agent_turn_finished: '🤖',
  agent_error: '🤖',
  watch_triggered: '👁️',
  watch_model_unavailable: '👁️',
  watch_rule_error: '👁️',
};

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
    paneMetaLines: buildPaneMetaLines(event),
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
    paneMetaLines: buildPaneMetaLines(event),
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

export function buildGenericRawView(event: WebhookEvent, settings: SiteSettings): GenericRawView {
  const eventTypeLabel = t(`notification.eventType.${event.eventType}` as const);
  const lines = [
    `${EVENT_EMOJI[event.eventType] ?? '📢'} ${eventTypeLabel}`,
    `${t('notification.site')}：${event.site.name}`,
    `${t('notification.time')}：${new Date(event.timestamp).toLocaleString(toBCP47(settings.language))}`,
    `${t('notification.device')}：${event.device.name} (${event.device.type})`,
    `${t('notification.window')}：${formatIndexAndId(event.tmux?.windowIndex, event.tmux?.windowId)}`,
    `${t('notification.pane')}：${formatIndexAndId(event.tmux?.paneIndex, event.tmux?.paneId)}`,
  ];
  lines.push(...buildPaneMetaLines(event));
  if (typeof event.payload?.message === 'string') {
    lines.push(`${t('notification.message')}：${event.payload.message}`);
  }
  return {
    lines,
    paneUrl: normalizeHttpUrl(buildPaneUrl(event)),
    directLinkLabel: t('notification.directLink'),
  };
}
