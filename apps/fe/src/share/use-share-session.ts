// 被分享页的会话编排：取分享信息 → 输密码 → 建专用运行时 → 断开 / 结束时收摊。

import { nodePathPrefix } from '@tmex/api-client';
import { useOptionalRuntime } from '@tmex/stores/react';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  ShareAccessError,
  type ShareAccessErrorCode,
  type ShareFetch,
  getShareAccess,
  loginShareAccess,
  logoutShareAccess,
} from './access-client';
import {
  SHARE_WS_ENDED_CODE,
  SHARE_WS_LOGIN_REQUIRED_CODE,
  type ShareRuntimeHandle,
  createShareRuntime,
} from './share-runtime';
import { INITIAL_SHARE_VIEW_STATE, type ShareViewState, shareViewReducer } from './share-state';

export function shareErrorCode(error: unknown): ShareAccessErrorCode {
  return error instanceof ShareAccessError ? error.code : 'SHARE_REQUEST_FAILED';
}

function shareRetryAfterMs(error: unknown): number | null {
  return error instanceof ShareAccessError ? error.retryAfterMs : null;
}

export interface ShareSessionOptions {
  nodeId: string;
  shareId: string;
  /** 测试注入 */
  fetchImpl?: ShareFetch;
}

export interface ShareSession {
  state: ShareViewState;
  /** 已认证时的专用运行时；其余状态为 null */
  handle: ShareRuntimeHandle | null;
  submitPassword: (password: string) => void;
  disconnect: () => void;
}

/** 运行时与在途请求都按这个身份记账：换分享（或换节点）必须整套重来。 */
export function shareSessionKey(nodeId: string, shareId: string): string {
  return `${nodeId}\u0000${shareId}`;
}

export function useShareSession({ nodeId, shareId, fetchImpl }: ShareSessionOptions): ShareSession {
  const nodeBase = useMemo(() => nodePathPrefix(nodeId), [nodeId]);
  const [state, dispatch] = useReducer(shareViewReducer, INITIAL_SHARE_VIEW_STATE);
  const [handle, setHandle] = useState<ShareRuntimeHandle | null>(null);
  const handleRef = useRef<{ key: string; handle: ShareRuntimeHandle } | null>(null);
  // 主题 / 字号 / 输入模式是宿主级偏好，和外壳共用同一份 store（key 仍为 tmex-ui）。
  const uiStore = useOptionalRuntime()?.stores.ui;

  // 卸载或换分享后到达的响应一律丢弃：否则一发迟到的 access 能把已经收摊的页面重新点亮。
  const sessionKey = shareSessionKey(nodeId, shareId);
  const liveKeyRef = useRef<string | null>(sessionKey);
  useEffect(() => {
    liveKeyRef.current = sessionKey;
    return () => {
      liveKeyRef.current = null;
    };
  }, [sessionKey]);
  const dispatchIfCurrent = useCallback((key: string, action: Parameters<typeof dispatch>[0]) => {
    if (liveKeyRef.current === key) dispatch(action);
  }, []);

  const refresh = useCallback(async () => {
    const key = shareSessionKey(nodeId, shareId);
    try {
      const info = await getShareAccess(nodeBase, shareId, fetchImpl);
      dispatchIfCurrent(key, { type: 'access', info });
    } catch (error) {
      dispatchIfCurrent(key, { type: 'access-failed', code: shareErrorCode(error) });
    }
  }, [dispatchIfCurrent, fetchImpl, nodeBase, nodeId, shareId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const submitPassword = useCallback(
    (password: string) => {
      const key = shareSessionKey(nodeId, shareId);
      dispatch({ type: 'submit' });
      void (async () => {
        try {
          await loginShareAccess(nodeBase, shareId, password, fetchImpl);
        } catch (error) {
          dispatchIfCurrent(key, {
            type: 'login-failed',
            code: shareErrorCode(error),
            retryAfterMs: shareRetryAfterMs(error),
            now: Date.now(),
          });
          return;
        }
        await refresh();
      })();
    },
    [dispatchIfCurrent, fetchImpl, nodeBase, nodeId, refresh, shareId]
  );

  const disconnect = useCallback(() => {
    void logoutShareAccess(nodeBase, shareId, fetchImpl).catch(() => undefined);
    dispatch({ type: 'ended' });
  }, [fetchImpl, nodeBase, shareId]);

  // 运行时跟着 terminal 状态生灭：离开该状态（结束 / 凭证失效 / 卸载）即停重连并释放。
  // 身份变了也必须重建——运行时的 WS 握手、storagePrefix、appPath 都钉死在那一个 shareId 上。
  useEffect(() => {
    const key = shareSessionKey(nodeId, shareId);
    const existing = handleRef.current;
    if (state.status !== 'terminal' || (existing && existing.key !== key)) {
      if (!existing) return;
      existing.handle.dispose();
      handleRef.current = null;
      setHandle(null);
      if (state.status !== 'terminal') return;
    }
    if (handleRef.current) return;
    const created = createShareRuntime({
      nodeId,
      shareId,
      ...(uiStore ? { uiStore } : {}),
      onClose: (code) => {
        if (code === SHARE_WS_ENDED_CODE) dispatchIfCurrent(key, { type: 'ended' });
        else if (code === SHARE_WS_LOGIN_REQUIRED_CODE)
          dispatchIfCurrent(key, { type: 'login-required' });
      },
    });
    handleRef.current = { key, handle: created };
    setHandle(created);
  }, [dispatchIfCurrent, nodeId, shareId, state.status, uiStore]);

  useEffect(
    () => () => {
      handleRef.current?.handle.dispose();
      handleRef.current = null;
    },
    []
  );

  return { state, handle, submitPassword, disconnect };
}
