// 汇聚声明的投影：把本机密钥日志里的 `notification-sink` 记录回放成「哪些节点是汇聚机」。
//
// 密钥日志是全网复制的（hub 下发 / 中继同步都走同一条链），因此每台节点都能独立算出同一份
// 集合，不需要新表也不需要迁移。判据只有用户签过的记录：节点自述的 inventory 一律不采信，
// 被攻陷的节点无法把自己塞进汇聚集合，也无法替别人撤销。

import { decodeKeyLogRecord, decodeNotificationSinkPayload, nodeIdToHex } from '@tmex/shared/auth';
import { and, asc, eq } from 'drizzle-orm';
import type { AuthDb } from '../auth/types';
import { getDb } from '../db/client';
import { userKeyLog } from '../db/schema';

const RECORD_TYPE = 'notification-sink';

/**
 * 按 seq 递增回放，后写的赢。记录条数与用户的开关次数同量级（个位数到几十条），
 * 每次现算而不缓存：缓存要跟着密钥日志同步、join 重放、reset 清库一起失效，得不偿失。
 */
export function projectNotificationSinks(db: AuthDb, userId: string): Map<string, boolean> {
  const sinks = new Map<string, boolean>();
  const rows = db
    .select({ recordBytes: userKeyLog.recordBytes })
    .from(userKeyLog)
    .where(and(eq(userKeyLog.userId, userId), eq(userKeyLog.type, RECORD_TYPE)))
    .orderBy(asc(userKeyLog.seq))
    .all();
  for (const row of rows) {
    try {
      const record = decodeKeyLogRecord(new Uint8Array(row.recordBytes));
      const payload = decodeNotificationSinkPayload(record.payload);
      sinks.set(nodeIdToHex(payload.node_id), payload.enabled);
    } catch {
      // 损坏的历史记录不该让整份集合读不出来。
    }
  }
  return sinks;
}

/** 已被用户声明为汇聚机的节点编号集合。读库失败（裸库 / 迁移前）按空集处理。 */
export function listNotificationSinkNodeIds(userId: string, db?: AuthDb): ReadonlySet<string> {
  const ids = new Set<string>();
  try {
    for (const [nodeId, enabled] of projectNotificationSinks(db ?? getDb(), userId)) {
      if (enabled) ids.add(nodeId);
    }
  } catch {
    return ids;
  }
  return ids;
}
