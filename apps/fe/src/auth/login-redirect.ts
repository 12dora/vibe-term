// 全局 401 → `/login` 这一跳的守卫。
//
// 会话拦截器只知道「这个请求 401 了」，判断不了此刻应不应该把整页踢去登录页。两类窗口
// 里必须压住：
//   * 退出 mesh（`isAuthTransitionActive()`）：本机会话是我们自己清掉的，在途请求的 401
//     全是预期内的，跳走会把还在等网关重启的编排一起卸载掉；
//   * 两阶段会话替换（常规改密后用新密码重新登录）：旧会话仍然有效、盘上那条也还在，
//     这段窗口里的 401 多半来自仪式本身或一次赶巧的在途请求。先把这一跳挂起，等替换落定
//     之后再看还需不需要——那时手上真没有会话了才跳。

import {
  hasSessionKey,
  isSessionReplacementPending,
  whenSessionReplacementSettled,
} from './session-key-store';

export interface LoginRedirectDeps {
  navigate: (to: string) => void;
  authTransitionActive: () => boolean;
  /**
   * 挂起的那一跳最终被判定为不需要跳（替换落定后手上仍有会话）时调用。
   *
   * 触发这一跳的信号（业务端点 401、WS 4401）可能已经把这条 WS 拆了，而它不会自己回来：
   * 会话既然还在，就让宿主把连接重新拉起来，否则页面留在原地但再也收不到事件。
   */
  onSessionKept?: () => void;
  replacementPending?: () => boolean;
  replacementSettled?: () => Promise<void>;
  sessionPresent?: () => boolean;
}

/** 造一个可以直接交给 `installSessionInterceptor({ navigate })` 的跳转实现。 */
export function createLoginRedirect(deps: LoginRedirectDeps): (to: string) => void {
  const pending = deps.replacementPending ?? isSessionReplacementPending;
  const settled = deps.replacementSettled ?? whenSessionReplacementSettled;
  const present = deps.sessionPresent ?? hasSessionKey;

  const go = (to: string): void => {
    if (deps.authTransitionActive()) return;
    deps.navigate(to);
  };

  return (to) => {
    if (deps.authTransitionActive()) return;
    if (!pending()) {
      deps.navigate(to);
      return;
    }
    void settled().then(() => {
      // 替换落定后手上还有会话（新的被接受，或旧的原样装回）就不必跳；
      // 真的什么都不剩了（用户登出 / 会话被判失效）才补这一跳。
      if (present()) {
        deps.onSessionKept?.();
        return;
      }
      go(to);
    });
  };
}
