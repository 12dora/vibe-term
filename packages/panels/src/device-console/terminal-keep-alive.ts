// 单屏视图的终端保活池：当前设备最近看过的 N 个 pane 保持 Terminal 挂载（隐藏但仍订阅），
// 切回时无需重建 WASM 终端、也无需重放 history。
//
// 池由 terminal-stage 的组件实例持有（ref），**不是**可变全局：StrictMode 下
// effect 会「setup → cleanup → setup」跑一遍，若在 cleanup 里清一个全局单例，
// 首次挂载后池就空了，而 render 期的 retain 不会重跑，保活等于没生效。
// 这里只在提交阶段把只读快照发布给 select 下发侧读，并按 owner 判定归属，
// 迟到的 cleanup 不会清掉后来者发布的快照。
//
// panes 按最近可见排序：可见实例恒为第一个，DOM 里也就排在最前，
// 让按文档序取终端的探针（e2e 的 `.xterm canvas`）拿到的仍是可见实例。
// visibleIsWarm 记录「本次切换发生前目标是否已在池中」，供 select 下发决定 wantHistory。

export const KEEP_ALIVE_LIMIT = 3;

export interface KeepAlivePool {
  deviceId: string | null;
  /** 最近可见优先；第一个即当前可见 pane */
  panes: readonly string[];
  limit: number;
  visiblePaneId: string | null;
  visibleIsWarm: boolean;
  /**
   * 每个 pane 各自的化身号，进它自己的 React key。**只有**被快照确认删除的那个 pane 会自增：
   * 同一个 id 再出现（tmux 复用、同一提交内先删后加）时拿到新 key，重挂一个空终端。
   * 绝不因为别的 pane 被删、或流中断恢复就换掉可见实例的 key——那会在冷 history 到达前
   * 把可见终端卸掉，必然闪一屏空白。
   */
  incarnations: Readonly<Record<string, number>>;
  /** 当前是否处于流中断态（断线 / 重连中） */
  streamInterrupted: boolean;
}

export function createKeepAlivePool(limit: number = KEEP_ALIVE_LIMIT): KeepAlivePool {
  return {
    deviceId: null,
    panes: [],
    limit: Math.max(1, limit),
    visiblePaneId: null,
    visibleIsWarm: false,
    incarnations: {},
    streamInterrupted: false,
  };
}

/**
 * 把 paneId 置为可见 pane。目标已是可见 pane 时原样返回，
 * 因此可以在 render 期间调用而不受 StrictMode 双渲染影响。
 */
export function retainKeepAlivePane(
  pool: KeepAlivePool,
  deviceId: string,
  paneId: string
): KeepAlivePool {
  const base = pool.deviceId === deviceId ? pool : createKeepAlivePool(pool.limit);
  if (base.deviceId === deviceId && base.visiblePaneId === paneId) {
    return base;
  }

  return {
    ...base,
    deviceId,
    panes: [paneId, ...base.panes.filter((id) => id !== paneId)].slice(0, base.limit),
    visiblePaneId: paneId,
    visibleIsWarm: base.panes.includes(paneId),
  };
}

/**
 * 设备流状态迁移（断线 / 重连中 ↔ 已连接），纯函数、可重复调用。
 * 两个方向都只动 panes 与 warm 资格，**不碰任何 pane 的 key**：
 *
 * - 进入中断：隐藏实例错过的输出永远补不回来，直接弃掉；可见实例虽然还挂着，
 *   但它同样错过了那段输出，一并取消 warm 资格（断线期间保持挂载以便看清已有内容）；
 * - 恢复：仍然只取消 warm 资格。可见终端继续挂着，由缺口账本保证的那次冷 select
 *   用 reset + history 原子地换掉内容——先卸载再等 history 只会白闪一屏。
 */
export function applyKeepAliveStreamState(
  pool: KeepAlivePool,
  interrupted: boolean
): KeepAlivePool {
  if (pool.streamInterrupted === interrupted) {
    return pool;
  }
  if (interrupted) {
    return {
      ...pool,
      streamInterrupted: true,
      panes: pool.panes.slice(0, 1),
      visibleIsWarm: false,
    };
  }
  return { ...pool, streamInterrupted: false, visibleIsWarm: false };
}

/**
 * 快照确认还活着的 pane 集合：隐藏实例里已经不存在的直接卸载，并**只**把它自己的化身号 +1，
 * 避免同一提交里「先删后加」让 React 复用旧实例。可见 pane 永远不裁——
 * 它的失效由路由对账处理（快照可能只是还没追上）。
 */
export function retainLiveKeepAlivePanes(
  pool: KeepAlivePool,
  livePaneIds: ReadonlySet<string>
): KeepAlivePool {
  const removed = pool.panes.filter((id) => id !== pool.visiblePaneId && !livePaneIds.has(id));
  if (removed.length === 0) {
    return pool;
  }
  const incarnations = { ...pool.incarnations };
  for (const paneId of removed) {
    incarnations[paneId] = (incarnations[paneId] ?? 0) + 1;
  }
  return {
    ...pool,
    panes: pool.panes.filter((id) => !removed.includes(id)),
    incarnations,
  };
}

export function keepAlivePaneIds(pool: KeepAlivePool): readonly string[] {
  return pool.panes;
}

/** 目标已是可见 pane，且这次切换前它就在池里：可以走 warm select（不拉 history） */
export function isKeepAliveWarmTarget(
  pool: KeepAlivePool,
  deviceId: string,
  paneId: string
): boolean {
  return pool.deviceId === deviceId && pool.visiblePaneId === paneId && pool.visibleIsWarm;
}

/** 目标当前挂载中（还未被置为可见时的查询口） */
/** React key：设备 + pane + 该 pane 自己的化身号，化身号一变才重挂 */
export function keepAlivePaneKey(pool: KeepAlivePool, paneId: string): string {
  return `${pool.deviceId ?? ''}:${paneId}#${pool.incarnations[paneId] ?? 0}`;
}

export function isKeepAliveRetained(
  pool: KeepAlivePool,
  deviceId: string,
  paneId: string
): boolean {
  return pool.deviceId === deviceId && pool.panes.includes(paneId);
}

// ---------- 提交阶段发布的只读快照：stage 写，select 下发侧读 ----------

export type KeepAlivePoolOwner = symbol;

let publishedOwner: KeepAlivePoolOwner | null = null;
let publishedPool: KeepAlivePool = createKeepAlivePool();

export function publishKeepAlivePool(owner: KeepAlivePoolOwner, pool: KeepAlivePool): void {
  publishedOwner = owner;
  publishedPool = pool;
}

/** 只有当前归属者能撤销：迟到的 cleanup 不会清掉后来者刚发布的快照 */
export function unpublishKeepAlivePool(owner: KeepAlivePoolOwner): void {
  if (publishedOwner !== owner) return;
  publishedOwner = null;
  publishedPool = createKeepAlivePool();
}

export function readKeepAlivePool(): KeepAlivePool {
  return publishedPool;
}

export function isWarmSelectTarget(deviceId: string, paneId: string): boolean {
  return isKeepAliveWarmTarget(publishedPool, deviceId, paneId);
}

export function isRetainedPane(deviceId: string, paneId: string): boolean {
  return isKeepAliveRetained(publishedPool, deviceId, paneId);
}

export function resetKeepAlivePublicationForTest(): void {
  publishedOwner = null;
  publishedPool = createKeepAlivePool();
}
