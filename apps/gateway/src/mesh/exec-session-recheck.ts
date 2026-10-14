import type { NodeSessionStore } from '../auth/node-session-store';
import { bindExecSessionVerifier } from '../exec/channel/credential-check';
import { closeExecSessionsWithInvalidSession } from '../exec/channel/registry';

export const EXEC_SESSION_RECHECK_INTERVAL_MS = 30_000;

type SessionVerifier = Pick<NodeSessionStore, 'verify'>;

/**
 * 按节点会话真实状态复核依附会话的 exec 通道：会话过期、被撤销（单个 sid、passkey 吊销、
 * 全部登出）或行已删除的一律以 4401 终止。读库失败时不误杀，留给下一轮。
 */
export function closeExecSessionsWithInvalidNodeSession(
  store: SessionVerifier,
  now: number = Date.now()
): void {
  closeExecSessionsWithInvalidSession((ref) => {
    try {
      return store.verify(ref.sid, { viaNodeId: ref.viaNodeId, now }).ok;
    } catch {
      return true;
    }
  });
}

/**
 * 周期性复核 exec 通道的依附会话，返回停止函数；定时器 unref，不阻止进程退出。
 * 同一个会话库也绑给通道的 HELLO 复核（等待首个 HELLO 期间被撤销的会话不得再开 / 恢复会话）。
 */
export function startExecSessionRecheck(
  store: SessionVerifier,
  options: { intervalMs?: number; now?: () => number } = {}
): () => void {
  const unbind = bindExecSessionVerifier(store, options.now);
  const timer = setInterval(() => {
    try {
      closeExecSessionsWithInvalidNodeSession(store, options.now?.() ?? Date.now());
    } catch (err) {
      console.warn(`[exec] session recheck failed ${err instanceof Error ? err.name : ''}`);
    }
  }, options.intervalMs ?? EXEC_SESSION_RECHECK_INTERVAL_MS);
  timer.unref();
  return () => {
    clearInterval(timer);
    unbind();
  };
}
