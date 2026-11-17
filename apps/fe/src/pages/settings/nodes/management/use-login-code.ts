// 把 `LoginCodeController` 接进 React：每次挂载建一个，卸载即释放（含命令句柄）。

import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  type LoginCodeController,
  type LoginCodeModuleLoader,
  type LoginCodeViewState,
  createLoginCodeController,
  defaultLoginCodeLoader,
} from './login-code-controller';

export function useLoginCode(loadModule: LoginCodeModuleLoader = defaultLoginCodeLoader): {
  controller: LoginCodeController;
  state: LoginCodeViewState;
} {
  const [controller] = useState(() => createLoginCodeController({ loadModule }));
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getState,
    controller.getState
  );
  useEffect(() => {
    void controller.load();
    return () => controller.dispose();
  }, [controller]);
  return { controller, state };
}

/** 每秒刷新的当前时间；`active` 为假时停表。 */
export function useNow(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs]);
  return now;
}
