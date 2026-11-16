import { count } from 'drizzle-orm';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { getAgentSessionsByStatus } from './db/agent';
import { getDb as getOrmDb } from './db/client';
import { portMaps, tunnelAccess, tunnelConfig } from './db/schema';
import { getAllTelegramBots } from './db/telegram';
import { getEnabledWatchRules } from './db/watch';
import { getAllWeixinAccounts } from './db/weixin';

export type LiveStartGates = {
  telegram: () => boolean;
  weixin: () => boolean;
  agent: () => boolean;
  watch: () => boolean;
  tunnel: () => boolean;
  portMaps: () => boolean;
};

let liveEnabled = false;

/** 启动期 live 子系统是否允许运行（非纯 relay）；路由懒加载据此决定是否顺带 start。 */
export function setLiveServicesEnabled(enabled: boolean): void {
  liveEnabled = enabled;
}

export function liveServicesEnabled(): boolean {
  return liveEnabled;
}

/** 门闩读库失败时按“已配置”处理，保持旧行为（照常启动）。 */
export function guardGate(check: () => boolean): () => boolean {
  return () => {
    try {
      return check();
    } catch {
      return true;
    }
  };
}

function hasRow(table: SQLiteTable): boolean {
  const row = getOrmDb().select({ total: count() }).from(table).get();
  return Number(row?.total ?? 0) > 0;
}

export const defaultLiveStartGates: LiveStartGates = {
  telegram: guardGate(() => getAllTelegramBots().some((bot) => bot.enabled)),
  weixin: guardGate(() => getAllWeixinAccounts().length > 0),
  agent: guardGate(
    () =>
      getAgentSessionsByStatus('running').length > 0 ||
      getAgentSessionsByStatus('waiting_confirmation').length > 0
  ),
  watch: guardGate(() => getEnabledWatchRules().length > 0),
  tunnel: guardGate(() => hasRow(tunnelConfig) || hasRow(tunnelAccess)),
  portMaps: guardGate(() => hasRow(portMaps)),
};
