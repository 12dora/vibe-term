// 「链接中包含密码」的数据面：刚创建的分享直接用手上的明文，已有分享等勾选那一刻才去取。
//
// 不预取：多数人只是想复制一条裸链接，为此把每条分享的明文密码提前拉到前端不划算。
// 关窗、换分享一律作废（含在途请求），状态机见 share-link-password-state.ts。

import { getSharePassword } from '@vibeterm/api-client';
import { shareErrorKey } from '@vibeterm/api-client/share-errors';
import type { ShareRecord } from '@vibeterm/shared/share';
import { useRuntime } from '@vibeterm/stores/react';
import { useCallback, useState } from 'react';
import type { ShareLinkPassword } from './share-dialog-model';
import {
  type LinkPasswordState,
  claimLinkPassword,
  claimOf,
  idleLinkPassword,
  linkPasswordKey,
  projectLinkPassword,
} from './share-link-password-state';

export interface ShareLinkPasswordInput {
  open: boolean;
  activeShare: ShareRecord | null;
  /** 刚创建那一次拿得到的明文；已有分享为 `null`。 */
  createdPassword: string | null;
}

export function useShareLinkPassword({
  open,
  activeShare,
  createdPassword,
}: ShareLinkPasswordInput): ShareLinkPassword {
  const { apiClient } = useRuntime();
  const shareId = activeShare?.id ?? null;
  const key = linkPasswordKey(open, shareId);
  const [state, setState] = useState<LinkPasswordState>(() => idleLinkPassword(key));

  // 换分享（或开关弹窗）一律回到未勾选，并且把旧状态真的丢掉：只做投影的话，重开同一条分享
  // 会把上次的勾选与（可能已被改掉的）明文原样复活。渲染期 setState 会立刻重跑本组件，
  // 不像 effect 那样要等一帧——中间那一帧的链接是错的。
  const current: LinkPasswordState = projectLinkPassword(state, key);
  if (current !== state) setState(current);
  const password = createdPassword ?? current.fetched;

  const setInclude = useCallback(
    (next: boolean) => {
      const needFetch = next && password === null && shareId !== null;
      setState({ ...current, include: next, error: null, loading: needFetch });
      if (!needFetch || shareId === null) return;
      const claim = claimOf(current);
      getSharePassword(apiClient, shareId).then(
        (value) =>
          setState((prev) =>
            claimLinkPassword(prev, claim, { fetched: value.password, loading: false })
          ),
        (cause) =>
          setState((prev) =>
            // 取不到就退回未勾选：否则复选框勾着、链接却还是裸的，等于骗人。
            claimLinkPassword(prev, claim, {
              include: false,
              loading: false,
              error: shareErrorKey(cause),
            })
          )
      );
    },
    [apiClient, current, password, shareId]
  );

  return {
    include: current.include,
    password,
    loading: current.loading,
    error: current.error,
    setInclude,
  };
}
