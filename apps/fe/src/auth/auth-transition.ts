// 「有意为之的鉴权切换」标记。
//
// 退出 mesh（`POST /api/local/leave`）会当场清掉本机的全部 node 会话，但页面还挂着：
// 在途的 self 请求、mesh 轮询、WebSocket 重连都会立刻收到 401 / 4401，全局会话拦截器
// 随即把整页导航到 `/login`，把还在等重启的编排一起卸载掉。
//
// 这类 401 是预期内的，必须压住。标记从「发起 leave 之前」一直保持到整页硬跳转为止
// （硬跳转会换掉整个 JS 环境，模块级状态自然归零），只有在退出被明确拒绝时才撤销。

let active = false;

export function beginAuthTransition(): void {
  active = true;
}

export function endAuthTransition(): void {
  active = false;
}

export function isAuthTransitionActive(): boolean {
  return active;
}
