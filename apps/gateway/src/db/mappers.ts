import {
  DEFAULT_LOCALE,
  DEFAULT_TERMINAL_SHORTCUTS,
  type Device,
  type EventType,
  type LocaleCode,
  type SiteSettings,
  type TelegramBotChat,
  type TelegramChatStatus,
  type TelegramChatType,
  type TerminalShortcutSettings,
  type ThemeMode,
  type WebhookEndpoint,
  type WeixinAccountUser,
  type WeixinUserStatus,
} from '@tmex/shared';
import type {
  devices,
  siteSettings,
  telegramBotChats,
  telegramBots,
  terminalShortcutSettings,
  webhookEndpoints,
  weixinAccountUsers,
  weixinAccounts,
} from './schema';
import type { TelegramBotConfigRecord, WeixinAccountConfigRecord } from './types';

export function optional<T>(value: T | null | undefined): T | undefined {
  return value ?? undefined;
}

export function normalizeLocale(value: string | null | undefined): LocaleCode {
  return value === 'zh_CN' ? 'zh_CN' : DEFAULT_LOCALE;
}

export function toDevice(row: typeof devices.$inferSelect): Device {
  return {
    id: row.id,
    name: row.name,
    type: row.type as Device['type'],
    host: optional(row.host),
    port: optional(row.port),
    username: optional(row.username),
    sshConfigRef: optional(row.sshConfigRef),
    session: row.session ?? 'tmex',
    authMode: row.authMode as Device['authMode'],
    passwordEnc: optional(row.passwordEnc),
    privateKeyEnc: optional(row.privateKeyEnc),
    privateKeyPassphraseEnc: optional(row.privateKeyPassphraseEnc),
    defaultWorkingDir: optional(row.defaultWorkingDir),
    sortOrder: row.sortOrder,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toSiteSettings(row: typeof siteSettings.$inferSelect): SiteSettings {
  return {
    siteName: row.siteName,
    siteUrl: row.siteUrl,
    bellThrottleSeconds: row.bellThrottleSeconds,
    notificationThrottleSeconds: row.notificationThrottleSeconds,
    enableBrowserNotificationToast: row.enableBrowserNotificationToast,
    enableNotificationPush: row.enableNotificationPush,
    enableBellPush: row.enableBellPush,
    enableBellSound: row.enableBellSound,
    sshReconnectMaxRetries: row.sshReconnectMaxRetries,
    sshReconnectDelaySeconds: row.sshReconnectDelaySeconds,
    language: normalizeLocale(row.language),
    theme: row.theme as ThemeMode,
    disabledNotificationChannels: Array.isArray(row.disabledNotificationChannels)
      ? row.disabledNotificationChannels
      : [],
    updatedAt: row.updatedAt,
  };
}

export function toTelegramBotConfigRecord(
  row: typeof telegramBots.$inferSelect
): TelegramBotConfigRecord {
  return {
    id: row.id,
    name: row.name,
    tokenEnc: row.tokenEnc,
    enabled: row.enabled,
    allowAuthRequests: row.allowAuthRequests,
    allowCommands: row.allowCommands,
    lastUpdateId: row.lastUpdateId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toTelegramChat(row: typeof telegramBotChats.$inferSelect): TelegramBotChat {
  return {
    id: row.id,
    botId: row.botId,
    chatId: row.chatId,
    chatType: (row.chatType || 'unknown') as TelegramChatType,
    displayName: row.displayName,
    userId: row.userId ?? null,
    status: row.status as TelegramChatStatus,
    appliedAt: row.appliedAt,
    authorizedAt: row.authorizedAt ?? null,
    updatedAt: row.updatedAt,
  };
}

export function toWeixinAccountRecord(
  row: typeof weixinAccounts.$inferSelect
): WeixinAccountConfigRecord {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    allowAuthRequests: row.allowAuthRequests,
    allowCommands: row.allowCommands,
    loggedIn: row.botTokenEnc != null,
    weixinUin: row.weixinUin ?? null,
    botTokenEnc: row.botTokenEnc ?? null,
    baseUrl: row.baseUrl ?? null,
    syncBuf: row.syncBuf ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toWeixinAccountUser(
  row: typeof weixinAccountUsers.$inferSelect
): WeixinAccountUser {
  return {
    id: row.id,
    accountId: row.accountId,
    userId: row.userId,
    displayName: row.displayName,
    status: row.status as WeixinUserStatus,
    needsReactivation: row.needsReactivation,
    lastInboundAt: row.lastInboundAt ?? null,
    appliedAt: row.appliedAt,
    authorizedAt: row.authorizedAt ?? null,
    updatedAt: row.updatedAt,
  };
}

export function toWebhookEndpoint(row: typeof webhookEndpoints.$inferSelect): WebhookEndpoint {
  return {
    id: row.id,
    enabled: row.enabled,
    url: row.url,
    secret: row.secret,
    eventMask: Array.isArray(row.eventMask) ? (row.eventMask as EventType[]) : [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toTerminalShortcutSettings(
  row: typeof terminalShortcutSettings.$inferSelect
): TerminalShortcutSettings {
  return {
    items: Array.isArray(row.items) ? row.items : DEFAULT_TERMINAL_SHORTCUTS,
    useIcons: row.useIcons,
    updatedAt: row.updatedAt,
  };
}
