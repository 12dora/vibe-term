import {
  closeExecSessionsForToken,
  closeExecSessionsWithInactiveToken,
} from '../exec/channel/registry';
import { isAccessTokenActive, onAccessTokenRevoked, pruneAccessTokens } from './access-tokens';

const PRUNE_INTERVAL_MS = 6 * 3_600_000;
const SESSION_RECHECK_INTERVAL_MS = 30_000;

type Lifecycle = { stop: () => void };

let running: Lifecycle | null = null;

function guarded(run: () => void): () => void {
  return () => {
    try {
      run();
    } catch (err) {
      console.warn(`[access-token] maintenance failed ${err instanceof Error ? err.name : ''}`);
    }
  };
}

/**
 * 访问令牌的后台维护：撤销即关掉该令牌的 exec 会话；周期性复核长连接（过期、行被级联删除，
 * 如退出 mesh 清库）；周期性清理旧行。定时器 unref，不阻止进程退出。
 */
export function startAccessTokenLifecycle(): void {
  if (running) return;
  const offRevoke = onAccessTokenRevoked(closeExecSessionsForToken);
  const recheck = setInterval(
    guarded(() => closeExecSessionsWithInactiveToken(isAccessTokenActive)),
    SESSION_RECHECK_INTERVAL_MS
  );
  const prune = setInterval(guarded(pruneAccessTokens), PRUNE_INTERVAL_MS);
  recheck.unref();
  prune.unref();
  guarded(pruneAccessTokens)();
  running = {
    stop() {
      offRevoke();
      clearInterval(recheck);
      clearInterval(prune);
    },
  };
}

export function stopAccessTokenLifecycle(): void {
  running?.stop();
  running = null;
}
