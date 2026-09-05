// 懒加载 chunk 的预热调度：设置页各标签、以及侧栏顶层导航的路由页。
//
// 每个标签都是独立 chunk（见 SettingsPage 的 lazyChunk），首次切过去要先下载再挂载，
// 之后才轮到面板自己的数据请求——隧道场景下这是两段串行 RTT，点一下要等好几百毫秒。
// 进设置页后趁空闲把还没加载的 chunk 逐个拉下来，切换时就只剩数据请求那一段。
//
// 两条预热路径：进页面后的空闲预热（逐个排队，别和当前标签抢带宽），
// 以及指针悬停/触摸标签时的即时预热。两条共用同一份「已发起」集合，只发一次。
// 顶层路由（设备 / 设置）走同一套：侧栏链接 hover 预热 + 首帧后空闲预热。
//
// 预热失败一律静默：lazyChunk 的重试卡片只在真正导航过去时才该出现，
// 这里既不计入它的失败次数，也不触发整页刷新。

/** 与 lazyChunk 共用同一个 loader 函数引用，预热命中的就是同一个 chunk（不要另写静态 import）。 */
export type ChunkPreloadTarget = () => Promise<unknown>;

export interface IdleHost {
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: never) => void;
}

export type IdleSchedule = (run: () => void) => () => void;

/** requestIdleCallback 的兜底期限：再忙也不能一直不预热 */
export const IDLE_TIMEOUT_MS = 3000;
/** 没有 requestIdleCallback（Safari 老版本）时的固定延迟，留给首帧和当前标签的请求 */
export const IDLE_FALLBACK_DELAY_MS = 1200;

export function scheduleIdle(run: () => void, host: IdleHost = globalThis as IdleHost): () => void {
  const idle = host.requestIdleCallback;
  if (typeof idle === 'function') {
    const handle = idle.call(host, run, { timeout: IDLE_TIMEOUT_MS });
    return () => host.cancelIdleCallback?.call(host, handle);
  }
  const timer = host.setTimeout(run, IDLE_FALLBACK_DELAY_MS);
  return () => host.clearTimeout(timer as never);
}

/** 已发起过预热的 loader，模块级：设置页重挂不该把七个 chunk 再拉一遍。 */
const startedPreloads = new Set<ChunkPreloadTarget>();

/** 悬停/触摸时的即时预热；同一个 loader 只发一次，失败静默。 */
export function preloadChunk(
  load: ChunkPreloadTarget,
  started: Set<ChunkPreloadTarget> = startedPreloads
): void {
  if (started.has(load)) return;
  started.add(load);
  void load().catch(() => undefined);
}

/**
 * 空闲逐个预热：每个空闲片只发起一个 chunk，落地（成功或失败）后再排下一个。
 * 一次性把剩下六个全发出去会和当前标签自己的 chunk、数据请求抢连接，隧道下反而更慢。
 * 返回取消函数：设置页卸载后不再排新的（已在途的请求让它自然结束，结果进浏览器 module map 也不亏）。
 */
export function startIdleChunkPreload(
  loaders: readonly ChunkPreloadTarget[],
  schedule: IdleSchedule = scheduleIdle,
  started: Set<ChunkPreloadTarget> = startedPreloads
): () => void {
  let index = 0;
  let cancelled = false;
  let cancelPending: (() => void) | undefined;

  const step = () => {
    if (cancelled) return;
    while (index < loaders.length && started.has(loaders[index] as ChunkPreloadTarget)) index += 1;
    const load = loaders[index];
    if (load === undefined) return;
    index += 1;
    started.add(load);
    void load().then(scheduleNext, scheduleNext);
  };

  const scheduleNext = () => {
    if (cancelled) return;
    cancelPending = schedule(step);
  };

  cancelPending = schedule(step);

  return () => {
    cancelled = true;
    cancelPending?.();
  };
}
