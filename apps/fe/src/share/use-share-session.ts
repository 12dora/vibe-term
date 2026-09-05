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

export function useShareSession({ nodeId, shareId, fetchImpl }: ShareSessionOptions): ShareSession {
  const nodeBase = useMemo(() => nodePathPrefix(nodeId), [nodeId]);
  const [state, dispatch] = useReducer(shareViewReducer, INITIAL_SHARE_VIEW_STATE);
  const [handle, setHandle] = useState<ShareRuntimeHandle | null>(null);
  const handleRef = useRef<ShareRuntimeHandle | null>(null);
  // 主题 / 字号 / 输入模式是宿主级偏好，和外壳共用同一份 store（key 仍为 tmex-ui）。
  const uiStore = useOptionalRuntime()?.stores.ui;

  const refresh = useCallback(async () => {
    try {
      dispatch({ type: 'access', info: await getShareAccess(nodeBase, shareId, fetchImpl) });
    } catch (error) {
      dispatch({ type: 'access-failed', code: shareErrorCode(error) });
    }
  }, [fetchImpl, nodeBase, shareId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const submitPassword = useCallback(
    (password: string) => {
      dispatch({ type: 'submit' });
      void (async () => {
        try {
          await loginShareAccess(nodeBase, shareId, password, fetchImpl);
        } catch (error) {
          dispatch({
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
    [fetchImpl, nodeBase, refresh, shareId]
  );

  const disconnect = useCallback(() => {
    void logoutShareAccess(nodeBase, shareId, fetchImpl).catch(() => undefined);
    dispatch({ type: 'ended' });
  }, [fetchImpl, nodeBase, shareId]);

  // 运行时跟着 terminal 状态生灭：离开该状态（结束 / 凭证失效 / 卸载）即停重连并释放。
  useEffect(() => {
    if (state.status !== 'terminal') {
      if (!handleRef.current) return;
      handleRef.current.dispose();
      handleRef.current = null;
      setHandle(null);
      return;
    }
    if (handleRef.current) return;
    const created = createShareRuntime({
      nodeId,
      shareId,
      ...(uiStore ? { uiStore } : {}),
      onClose: (code) => {
        if (code === SHARE_WS_ENDED_CODE) dispatch({ type: 'ended' });
        else if (code === SHARE_WS_LOGIN_REQUIRED_CODE) dispatch({ type: 'login-required' });
      },
    });
    handleRef.current = created;
    setHandle(created);
  }, [nodeId, shareId, state.status, uiStore]);

  useEffect(
    () => () => {
      handleRef.current?.dispose();
      handleRef.current = null;
    },
    []
  );

  return { state, handle, submitPassword, disconnect };
}
