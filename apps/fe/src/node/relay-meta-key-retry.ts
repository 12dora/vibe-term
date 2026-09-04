// 元数据密钥欠账重发的回路本体（外壳挂载见 `relay-meta-key-resident.tsx`）。
//
// 欠账（吊销 / 根轮换 / admit 之后那条没送上去的 `meta-key`）以前只在设置页的节点标签挂着时
// 才重试，页面一关就停在「欠着」的状态——被吊销的节点仍能解出中继转发的元数据块。
// 因此把重试提到外壳：只要应用开着、本机在 mesh 里，欠账就会在中继挂上之后自动重发。
//
// 手上没有已签字节的那一条必须重新签，需要用户凭据；这里不弹窗，交给设置页的告警条。

import type { CancelableSchedule } from '@/node/create-polling-store';
import { withKeyLogLock } from '@/node/enrollment-engine';
import {
  acquireMeshRelayPolling,
  attachedRelay,
  getMeshRelayState,
  refreshMeshRelay,
  subscribeMeshRelay,
} from '@/node/mesh-relay';
import type { RelayFlowDeps, RelayFlowMode } from '@/node/relay-enroll';
import {
  listPendingMetaKeys,
  retryPendingMetaKeys,
  subscribePendingMetaKeys,
} from '@/node/relay-meta-key-pending';
import { defaultAuthApi } from '@tmex/api-client/auth/index';
import { defaultRelayTenantApi } from '@tmex/api-client/relay/tenant-api';

/** 一批欠账的退避梯度：走完仍未落账就停手，等下一次挂上中继或欠账变化再来一轮。 */
export const RELAY_META_KEY_RETRY_BACKOFF_MS: readonly number[] = [1_000, 5_000, 20_000, 60_000];

const timeoutDelay: CancelableSchedule = (fn, ms) => {
  const timer = setTimeout(fn, ms);
  return () => clearTimeout(timer);
};

export interface RelayMetaKeyRetryOptions {
  deps: RelayFlowDeps;
  backoffMs?: readonly number[];
  delay?: CancelableSchedule;
  /** 欠账存在期间取用中继链路轮询（否则设置页不开就看不到「挂上了」）。 */
  acquirePolling?: () => () => void;
  retry?: (deps: RelayFlowDeps) => Promise<number>;
  onSettled?: () => void;
}

/** 当前挂着哪条链路、它在不在线；没挂上为空串。 */
function stampOf(): string {
  const link = attachedRelay(getMeshRelayState());
  return link === null ? '' : `${link.url}|${link.online ? 'on' : 'off'}`;
}

/**
 * 武装键把链路也算进去：只按欠账 id 记的话，四档退避走完之后，同一条链路恢复在线或无缝
 * 切到另一台中继都不会重开一轮，安全敏感的欠账只能等用户手动处理。
 */
function armOf(stamp: string): string {
  if (stamp === '') return '';
  const ids = listPendingMetaKeys()
    .filter((row) => row.record)
    .map((row) => row.id);
  return ids.length > 0 ? `${stamp}|${ids.join(',')}` : '';
}

/**
 * 重发回路。挂上中继且**手上有已签字节**时才算「可自动重发」；武装键不变就不重开退避，
 * 避免每次 store 通知都把计时器往前拽。
 */
export function startRelayMetaKeyRetry(options: RelayMetaKeyRetryOptions): () => void {
  const backoff = options.backoffMs ?? RELAY_META_KEY_RETRY_BACKOFF_MS;
  const delay = options.delay ?? timeoutDelay;
  const retry = options.retry ?? ((deps: RelayFlowDeps) => retryPendingMetaKeys(deps));
  const acquire = options.acquirePolling ?? (() => acquireMeshRelayPolling());

  let releasePolling: (() => void) | null = null;
  let cancelTimer: (() => void) | null = null;
  let armKey = '';
  let linkStamp = '';
  let step = 0;
  let running = false;
  let stopped = false;

  const clearTimer = () => {
    cancelTimer?.();
    cancelTimer = null;
  };

  const schedule = () => {
    const ms = backoff[step];
    if (ms === undefined) return;
    step += 1;
    cancelTimer = delay(() => {
      cancelTimer = null;
      void attempt();
    }, ms);
  };

  const attempt = async () => {
    if (stopped || running) return;
    running = true;
    try {
      if ((await retry(options.deps)) === 0) options.onSettled?.();
    } catch {
      // 网络抖动：交给下一档退避
    } finally {
      running = false;
    }
    if (stopped) return;
    const stamp = stampOf();
    linkStamp = stamp;
    const key = armOf(stamp);
    if (key === '') {
      armKey = '';
      step = 0;
      return;
    }
    if (key !== armKey) {
      armKey = key;
      step = 0;
    }
    schedule();
  };

  const syncPolling = () => {
    const wants = listPendingMetaKeys().length > 0;
    if (wants && !releasePolling) releasePolling = acquire();
    else if (!wants && releasePolling) {
      releasePolling();
      releasePolling = null;
    }
  };

  const sync = () => {
    if (stopped) return;
    syncPolling();
    if (running) return;
    const stamp = stampOf();
    // 链路换了（offline→online、或无缝切到另一台中继）：退避从头来，并且立刻试一次，
    // 不必再等第一档。首次挂上不算「换」，照常按退避起步。
    const switched = stamp !== '' && linkStamp !== '' && stamp !== linkStamp;
    linkStamp = stamp;
    const key = armOf(stamp);
    if (key === '') {
      clearTimer();
      armKey = '';
      step = 0;
      return;
    }
    if (key === armKey) return;
    armKey = key;
    step = 0;
    clearTimer();
    if (switched) void attempt();
    else schedule();
  };

  const stopRelay = subscribeMeshRelay(sync);
  const stopPending = subscribePendingMetaKeys(sync);
  sync();

  return () => {
    if (stopped) return;
    stopped = true;
    stopRelay();
    stopPending();
    clearTimer();
    releasePolling?.();
    releasePolling = null;
  };
}

/** 外壳的启动入口：依赖在这里就地拼，宿主只管有没有可签名的身份。 */
export function startRelayMetaKeyRetryForMode(mode: RelayFlowMode): () => void {
  return startRelayMetaKeyRetry({
    deps: {
      api: defaultAuthApi,
      relayApi: defaultRelayTenantApi,
      mode,
      lock: withKeyLogLock,
    },
    onSettled: () => void refreshMeshRelay(),
  });
}
