import type { Database } from 'bun:sqlite';
import { getSqliteClient } from './client';

export function getDb(): Database {
  return getSqliteClient();
}

export type { DeviceTreeOrderRecord } from './devices';
export {
  DEFAULT_LOCAL_DEVICE_SEED_KEY,
  createDevice,
  deleteDevice,
  ensureDefaultLocalDeviceSeeded,
  getAllDevices,
  getDeviceById,
  getDeviceRuntimeStatus,
  getDeviceTreeOrder,
  reorderDevices,
  setPaneOrder,
  setWindowOrder,
  updateDevice,
  updateDeviceRuntimeStatus,
} from './devices';

export { getGatewayKv, setGatewayKv } from './kv';

export {
  ensureSiteSettingsInitialized,
  getSiteSettings,
  updateSiteSettings,
} from './site-settings';

export {
  ensureTerminalShortcutSettingsInitialized,
  getTerminalShortcutSettings,
  updateTerminalShortcutSettings,
} from './terminal-shortcuts';

export {
  createWebhookEndpoint,
  deleteWebhookEndpoint,
  getAllWebhookEndpoints,
} from './webhooks';

export type { TelegramBotConfigRecord } from './telegram';
export {
  approveTelegramChat,
  createOrUpdatePendingTelegramChat,
  createTelegramBot,
  deleteTelegramBot,
  deleteTelegramChat,
  getAllTelegramBots,
  getTelegramBotById,
  getTelegramBotsWithStats,
  getTelegramChatByBotAndChatId,
  listAuthorizedTelegramChatsByBot,
  listTelegramChatsByBot,
  updateTelegramBot,
} from './telegram';

export type { WeixinAccountConfigRecord } from './weixin';
export {
  approveWeixinUser,
  createWeixinAccount,
  deleteWeixinAccount,
  deleteWeixinUser,
  getAllWeixinAccounts,
  getWeixinAccountById,
  getWeixinAccountsWithStats,
  getWeixinUserByAccountAndUserId,
  getWeixinUserContextTokens,
  listAuthorizedWeixinUsersByAccount,
  listWeixinUsersByAccount,
  setWeixinUserNeedsReactivation,
  updateWeixinAccount,
  upsertWeixinUserOnInbound,
} from './weixin';
