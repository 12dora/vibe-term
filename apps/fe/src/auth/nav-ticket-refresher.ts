// 导航凭证续期：`<img>` / `<video>` / 下载链接 / `window.open` 发出的 GET 带不了 `x-vibeterm-pop`，
// PoP 会话改用服务端签发的导航凭证 cookie（10 分钟有效）。这里对每个持有 PoP 会话的 node
// 定时换发：登录后立即、冷启动先于首个文件预览、每 4 分钟、页面重新可见且距上次超过 4 分钟。
// 旧版 node 没有这个端点（404）= 功能不存在，不再续。失败只退避重试，绝不登出。

import { defaultApiClient, resolveNodeUrl } from '@vibeterm/api-client';
import { loadPopState, onPopNodesChange, popNodeIds } from './session-pop-client';

export const NAV_REFRESH_INTERVAL_MS = 4 * 60 * 1000;
const NAV_RETRY_BASE_MS = 5_000;
const NAV_RETRY_FACTOR = 3;
/** 冷启动等首轮续期的上限：续不上也不能卡住界面。 */
const NAV_READY_TIMEOUT_MS = 3_000;
const NAV_PATH = '/api/auth/nav';

export type NavRefreshOutcome = 'ok' | 'absent' | 'failed';

export interface NavRefresherDeps {
  /** PoP 状态已读出（冷启动时要先读盘才知道有哪些 node）。 */
  loaded(): Promise<void>;
  nodeIds(): string[];
  onNodesChange(listener: (addedNodeId: string | null) => Promise<void> | void): () => void;
  refresh(nodeId: string): Promise<NavRefreshOutcome>;
  setTimer(run: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  now(): number;
  onVisible(listener: () => void): () => void;
}

export interface NavTicketRefresher {
  start(): void;
  stop(): void;
  /** 首轮续期（或没有可续的 node）完成。 */
  ready(): Promise<void>;
}

export function retryDelayMs(failures: number): number {
  if (failures <= 0) return NAV_REFRESH_INTERVAL_MS;
  return Math.min(NAV_RETRY_BASE_MS * NAV_RETRY_FACTOR ** (failures - 1), NAV_REFRESH_INTERVAL_MS);
}

export function createNavTicketRefresher(deps: NavRefresherDeps): NavTicketRefresher {
  const absent = new Set<string>();
  const failures = new Map<string, number>();
  let timer: unknown = null;
  let lastRun = Number.NEGATIVE_INFINITY;
  let running: Promise<void> | null = null;
  let firstRun: Promise<void> | null = null;
  let detach: Array<() => void> = [];

  const eligible = (): string[] => deps.nodeIds().filter((id) => !absent.has(id));

  async function refreshNode(nodeId: string): Promise<void> {
    const outcome = await deps.refresh(nodeId).catch((): NavRefreshOutcome => 'failed');
    if (outcome === 'absent') absent.add(nodeId);
    if (outcome === 'failed') failures.set(nodeId, (failures.get(nodeId) ?? 0) + 1);
    else failures.delete(nodeId);
  }

  function schedule(): void {
    if (timer !== null) deps.clearTimer(timer);
    timer = null;
    const ids = eligible();
    if (ids.length === 0) return;
    const worst = Math.max(...ids.map((id) => failures.get(id) ?? 0));
    timer = deps.setTimer(() => void runAll(), retryDelayMs(worst));
  }

  function runAll(): Promise<void> {
    if (running) return running;
    lastRun = deps.now();
    running = Promise.all(eligible().map(refreshNode)).then(() => {
      running = null;
      schedule();
    });
    return running;
  }

  async function onNodeAdded(nodeId: string): Promise<void> {
    absent.delete(nodeId);
    failures.delete(nodeId);
    await refreshNode(nodeId);
    schedule();
  }

  return {
    start() {
      if (detach.length > 0) return;
      detach = [
        deps.onNodesChange((added) => (added === null ? schedule() : onNodeAdded(added))),
        deps.onVisible(() => {
          if (deps.now() - lastRun > NAV_REFRESH_INTERVAL_MS) void runAll();
        }),
      ];
      firstRun = deps.loaded().then(runAll);
    },
    stop() {
      for (const off of detach) off();
      detach = [];
      if (timer !== null) deps.clearTimer(timer);
      timer = null;
    },
    ready() {
      return firstRun ?? Promise.resolve();
    },
  };
}

async function refreshViaApi(nodeId: string): Promise<NavRefreshOutcome> {
  const res = await defaultApiClient.fetch(resolveNodeUrl(nodeId, NAV_PATH), { method: 'POST' });
  if (res.ok) return 'ok';
  return res.status === 404 ? 'absent' : 'failed';
}

function onDocumentVisible(listener: () => void): () => void {
  const doc = (
    globalThis as {
      document?: {
        visibilityState?: string;
        addEventListener(type: string, cb: () => void): void;
        removeEventListener(type: string, cb: () => void): void;
      };
    }
  ).document;
  if (!doc) return () => undefined;
  const handler = (): void => {
    if (doc.visibilityState === 'visible') listener();
  };
  doc.addEventListener('visibilitychange', handler);
  return () => doc.removeEventListener('visibilitychange', handler);
}

const refresher = createNavTicketRefresher({
  loaded: loadPopState,
  nodeIds: popNodeIds,
  onNodesChange: onPopNodesChange,
  refresh: refreshViaApi,
  setTimer: (run, ms) => setTimeout(run, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
  onVisible: onDocumentVisible,
});

/** 幂等：挂上监听，并在读到 PoP 状态后立刻续一轮。 */
export function startNavTicketRefresher(): void {
  refresher.start();
}

/**
 * 冷启动门：等 PoP 状态读出来、首轮导航凭证续上（最多 3 秒），之后工作区里的图片 / 预览才不会因为
 * 没有 cookie 而 401。没有 PoP 会话时立刻返回。
 */
export async function whenNavTicketsReady(): Promise<void> {
  await loadPopState();
  if (popNodeIds().length === 0) return;
  startNavTicketRefresher();
  await Promise.race([
    refresher.ready(),
    new Promise<void>((resolve) => setTimeout(resolve, NAV_READY_TIMEOUT_MS)),
  ]);
}
