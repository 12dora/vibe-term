// 同一页上并排摆着好几条设置路径（本机作 Hub / 加入 Hub / 加入中继 / 本机作中继），但后端
// 只允许走通一条：`withSetupTransition` 一提交成功就锁死，其余请求一律 409。
//
// 因此提交态必须提到共同父级：任意一路提交成功（或正在等重启）之后，兄弟表单与角色选择器
// 全部禁用，不让用户发出一条注定失败的请求。

import { type ReactNode, createContext, useCallback, useContext, useMemo, useState } from 'react';

export interface SetupTransition {
  /** 已提交成功的那条路径的归属标记；`null` 表示还没有任何一路提交。 */
  committedBy: string | null;
  /** 提交成功时认领；先到先得，后来者不覆盖。 */
  commit: (owner: string) => void;
}

/** 没有 Provider 时（单独渲染某个表单的测试）不锁任何东西。 */
const NO_TRANSITION: SetupTransition = { committedBy: null, commit: () => undefined };

/** 导出是为了让测试与特殊场景能直接注入一份现成的状态。 */
export const SetupTransitionContext = createContext<SetupTransition>(NO_TRANSITION);

export function SetupTransitionProvider({ children }: { children: ReactNode }) {
  const [committedBy, setCommittedBy] = useState<string | null>(null);
  const commit = useCallback((owner: string) => {
    setCommittedBy((previous) => previous ?? owner);
  }, []);
  const value = useMemo<SetupTransition>(() => ({ committedBy, commit }), [committedBy, commit]);
  return (
    <SetupTransitionContext.Provider value={value}>{children}</SetupTransitionContext.Provider>
  );
}

export function useSetupTransition(): SetupTransition {
  return useContext(SetupTransitionContext);
}

/** 已经有一路提交成功：角色选择器与路径卡都该锁上。 */
export function useSetupCommitted(): boolean {
  return useSetupTransition().committedBy !== null;
}

/** 本条路径是否被**别处**的提交锁住（自己提交的那条照常展示结果与重启进度）。 */
export function isSetupBlocked(transition: SetupTransition, owner: string): boolean {
  return transition.committedBy !== null && transition.committedBy !== owner;
}
