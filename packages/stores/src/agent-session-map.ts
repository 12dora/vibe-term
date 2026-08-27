// sessions 映射的纯函数工具：排序、派生 sessionOrder、列表拉取结果与本地写入的合并。

import type { AgentSessionDto } from '@tmex/shared';

export type SessionMap = Record<string, AgentSessionDto | undefined>;

/** 按 updatedAt 倒序；同一时间戳用 id 升序兜底，保证比较函数反对称与排序稳定 */
export function sortSessionOrder(sessions: SessionMap): string[] {
  return Object.values(sessions)
    .filter((session): session is AgentSessionDto => Boolean(session))
    .sort((a, b) => {
      if (a.updatedAt !== b.updatedAt) {
        return a.updatedAt < b.updatedAt ? 1 : -1;
      }
      if (a.id === b.id) return 0;
      return a.id < b.id ? -1 : 1;
    })
    .map((session) => session.id);
}

/** 任何替换 sessions 的路径都必须经此重算 sessionOrder，否则新的 updatedAt 不会反映到列表顺序 */
export function withSessionOrder(sessions: SessionMap): {
  sessions: SessionMap;
  sessionOrder: string[];
} {
  return { sessions, sessionOrder: sortSessionOrder(sessions) };
}

/**
 * 合并列表拉取结果与请求在途期间发生的本地写入。
 *
 * 本地写入（创建/重命名/删除/WS 状态推送）散落在多个模块，无法统一维护写入版本号，
 * 因此以「请求发起时的快照」为基线，用条目引用是否变化判定该会话在途期间是否被本地改写：
 * 所有写入方都以 `{ ...session, ... }` 产出新对象，引用不变即代表无本地写入。
 */
export function mergeFetchedSessions(
  before: SessionMap,
  current: SessionMap,
  fetched: readonly AgentSessionDto[]
): SessionMap {
  const merged: SessionMap = {};
  const fetchedIds = new Set<string>();

  for (const session of fetched) {
    fetchedIds.add(session.id);
    const local = current[session.id];
    if (local === undefined) {
      // 在途期间被本地删除的会话不复活；此前就不存在的才是别端新建
      if (before[session.id] === undefined) merged[session.id] = session;
      continue;
    }
    merged[session.id] = local === before[session.id] ? session : local;
  }

  for (const [sessionId, session] of Object.entries(current)) {
    if (session === undefined || fetchedIds.has(sessionId)) continue;
    // 在途期间无本地写入 → 该会话确已被别端删除；有本地写入 → 保留本地新鲜状态
    if (before[sessionId] === session) continue;
    merged[sessionId] = session;
  }

  return merged;
}
