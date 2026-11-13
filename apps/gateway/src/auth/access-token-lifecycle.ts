import {
  closeExecSessionsForToken,
  closeExecSessionsWithInactiveToken,
} from '../exec/channel/registry';
import { removePortMapsForRevocation, removePortMapsOfInactiveTokens } from '../portmap/store';
import {
  getAccessTokenService,
  isAccessTokenActive,
  onAccessTokenRevoked,
  pruneAccessTokens,
} from './access-tokens';
import type { AuthDb } from './types';

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

/** 令牌撤销：关掉它的 exec 会话，删掉它建的端口映射 / 放行（连同监听）。`db` 为令牌行所在连接。 */
export function teardownRevokedToken(tokenId: string, db: AuthDb): void {
  closeExecSessionsForToken(tokenId);
  removePortMapsForRevocation(db, { createdByTokenId: tokenId });
}

/** 复核：已失效（过期、行被级联删除）令牌的 exec 会话与端口映射一并收掉。 */
export function teardownInactiveTokens(): void {
  closeExecSessionsWithInactiveToken(isAccessTokenActive);
  removePortMapsOfInactiveTokens(getAccessTokenService().db, isAccessTokenActive);
}

/**
 * 访问令牌的后台维护：撤销即收掉该令牌的 exec 会话与端口映射；周期性复核（过期、行被级联删除，
 * 如退出 mesh 清库）；周期性清理旧行。定时器 unref，不阻止进程退出。
 */
export function startAccessTokenLifecycle(): void {
  if (running) return;
  const offRevoke = onAccessTokenRevoked(guardedRevoke);
  const recheck = setInterval(guarded(teardownInactiveTokens), SESSION_RECHECK_INTERVAL_MS);
  const prune = setInterval(guarded(pruneAccessTokens), PRUNE_INTERVAL_MS);
  recheck.unref();
  prune.unref();
  guarded(teardownInactiveTokens)();
  guarded(pruneAccessTokens)();
  running = {
    stop() {
      offRevoke();
      clearInterval(recheck);
      clearInterval(prune);
    },
  };
}

function guardedRevoke(tokenId: string, db: AuthDb): void {
  guarded(() => teardownRevokedToken(tokenId, db))();
}

export function stopAccessTokenLifecycle(): void {
  running?.stop();
  running = null;
}
