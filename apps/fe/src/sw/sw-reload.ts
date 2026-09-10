// chunk 404 时的整页刷新，改成「先让 waiting 的 SW 接管，再刷新」，且每会话至多一次。
//
// 没有握手的话，节点升级换掉 fe-dist 后会卡死：旧 SW 还在控制页面，导航拿到的仍是它那代的壳，
// 而新 SW 因为没有 skipWaiting 一直停在 waiting——刷多少次都是同一个 404。
// 没有 once 守卫的话，「新版本也 404」会变成无限刷新，比停在一张重试卡片上糟得多。

import { activateWaitingWorker } from '@vibeterm/ui/sw-activation';

const RELOAD_GUARD_KEY = 'vibeterm.chunk-reloaded';

export interface ChunkReloadDeps {
  activate: () => Promise<void>;
  reload: () => void;
  readGuard: () => string | null;
  writeGuard: () => void;
}

/** 返回是否真的发起了刷新；本会话已经刷过就直接返回 false */
export async function reloadForNewChunks(deps: ChunkReloadDeps): Promise<boolean> {
  if (deps.readGuard() === '1') return false;
  deps.writeGuard();
  await deps.activate().catch(() => undefined);
  deps.reload();
  return true;
}

function browserChunkReloadDeps(): ChunkReloadDeps {
  const nav = (
    globalThis as { navigator?: { serviceWorker?: Parameters<typeof activateWaitingWorker>[0] } }
  ).navigator;
  return {
    activate: () => activateWaitingWorker(nav?.serviceWorker),
    reload: () => window.location.reload(),
    readGuard: () => {
      try {
        return globalThis.sessionStorage?.getItem(RELOAD_GUARD_KEY) ?? null;
      } catch {
        return null;
      }
    },
    writeGuard: () => {
      try {
        globalThis.sessionStorage?.setItem(RELOAD_GUARD_KEY, '1');
      } catch {
        // 隐私模式下 sessionStorage 不可用：最坏情况是多刷新一次，仍好过完全不刷
      }
    },
  };
}

/** lazy chunk 取不到时的默认刷新实现 */
export function reloadAfterServiceWorkerUpdate(): Promise<boolean> {
  return reloadForNewChunks(browserChunkReloadDeps());
}

/** 仅供测试：清掉「本会话已刷新过」的标记 */
export function resetChunkReloadGuardForTests(): void {
  try {
    globalThis.sessionStorage?.removeItem(RELOAD_GUARD_KEY);
  } catch {
    // 同上
  }
}
