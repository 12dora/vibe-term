// 元数据密钥欠账重发的外壳挂载点。
//
// 欠账（吊销 / 根轮换 / admit 之后那条没送上去的 `meta-key`）以前只在设置页的节点标签挂着时
// 才重试，页面一关就停在「欠着」的状态——被吊销的节点仍能解出中继转发的元数据块。
// 提到宿主级之后，只要应用开着、本机在 mesh 里，欠账就会在中继挂上之后自动重发。
//
// 回路本体走**动态** import：它牵出 key log 引擎与整套中继流程，不能进首屏 chunk
// （`i18n/core-coverage` 守卫的正是这条线）。

import type { AuthKdfParamsJson, AuthModeResponse } from '@tmex/api-client/auth/index';
import { useEffect, useMemo } from 'react';
import { useSharedAuthMode } from './mesh-nodes';
import type { RelayFlowMode } from './relay-enroll';

/** 签一条密钥日志记录所需的身份；缺 uid / kdf 参数（还没有主用户）时为 `null`。 */
export function relayFlowModeOf(mode: AuthModeResponse | null): RelayFlowMode | null {
  if (!mode?.uid || !mode.kdfParams) return null;
  return {
    ...mode,
    uid: mode.uid,
    kdfParams: mode.kdfParams as AuthKdfParamsJson,
  };
}

export function RelayMetaKeyResident() {
  const { mode, meshEnabled } = useSharedAuthMode();
  const flowMode = useMemo(() => relayFlowModeOf(mode), [mode]);

  useEffect(() => {
    if (!meshEnabled || !flowMode) return;
    let stop: (() => void) | null = null;
    let cancelled = false;
    void import('./relay-meta-key-retry').then((module) => {
      if (cancelled) return;
      stop = module.startRelayMetaKeyRetryForMode(flowMode);
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [flowMode, meshEnabled]);

  return null;
}
