// React 绑定：按子树注入 AppRuntime（多实例宿主每实例包一层；缺省为默认 runtime）

import { type ReactNode, createContext, useContext } from 'react';
import type { AppRuntime } from './app-runtime';
import { defaultRuntime } from './default-runtime';

const RuntimeContext = createContext<AppRuntime>(defaultRuntime);

export function RuntimeProvider({
  runtime,
  children,
}: {
  runtime: AppRuntime;
  children: ReactNode;
}) {
  return <RuntimeContext.Provider value={runtime}>{children}</RuntimeContext.Provider>;
}

export function useRuntime(): AppRuntime {
  return useContext(RuntimeContext);
}
