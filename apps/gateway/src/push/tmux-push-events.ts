import type { Device, SiteSettings, TmuxNotificationEventData } from '@tmex/shared';
import type { TmuxEvent } from '../tmux-client/events';
import type { PaneLocationContext } from '../tmux/bell-context';

export interface TmuxPushEventContext {
  event: TmuxEvent;
  device: Device;
  settings: SiteSettings;
  paneContext: PaneLocationContext;
  notifyBell: (context: {
    device: Device;
    settings: SiteSettings;
    bell: PaneLocationContext;
  }) => Promise<void>;
  notifyNotification: (context: {
    device: Device;
    settings: SiteSettings;
    notification: TmuxNotificationEventData;
  }) => Promise<void>;
}

const NOTIFICATION_SOURCE_BY_VALUE: Record<string, TmuxNotificationEventData['source']> = {
  osc9: 'osc9',
  osc777: 'osc777',
  osc1337: 'osc1337',
};

function asObjectRecord(data: unknown): Record<string, unknown> {
  if (data !== null && typeof data === 'object') {
    return data as Record<string, unknown>;
  }
  return {};
}

function parseOptionalNonEmptyString(value: unknown): string | undefined {
  if (typeof value === 'string' && value) return value;
  return undefined;
}

function parseNotificationSource(value: unknown): TmuxNotificationEventData['source'] {
  if (typeof value !== 'string') return 'osc9';
  return NOTIFICATION_SOURCE_BY_VALUE[value] ?? 'osc9';
}

export function parseTmuxNotificationPayload(
  data: unknown
): Pick<TmuxNotificationEventData, 'source' | 'title' | 'body'> | null {
  const raw = asObjectRecord(data);
  const title = parseOptionalNonEmptyString(raw.title);
  const body = typeof raw.body === 'string' ? raw.body : '';
  if (!title && !body) return null;
  return {
    source: parseNotificationSource(raw.source),
    title,
    body,
  };
}

async function handleBellPushEvent(ctx: TmuxPushEventContext): Promise<void> {
  await ctx.notifyBell({
    device: ctx.device,
    settings: ctx.settings,
    bell: ctx.paneContext,
  });
}

async function handleNotificationPushEvent(ctx: TmuxPushEventContext): Promise<void> {
  const parsed = parseTmuxNotificationPayload(ctx.event.data);
  if (!parsed) return;
  await ctx.notifyNotification({
    device: ctx.device,
    settings: ctx.settings,
    notification: {
      ...ctx.paneContext,
      ...parsed,
    },
  });
}

const TMUX_PUSH_EVENT_HANDLERS: Partial<
  Record<TmuxEvent['type'], (ctx: TmuxPushEventContext) => Promise<void>>
> = {
  bell: handleBellPushEvent,
  notification: handleNotificationPushEvent,
};

export async function dispatchTmuxPushEvent(ctx: TmuxPushEventContext): Promise<void> {
  const handler = TMUX_PUSH_EVENT_HANDLERS[ctx.event.type];
  if (!handler) return;
  await handler(ctx);
}
