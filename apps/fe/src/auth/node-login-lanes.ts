// 单 node 登录的扇出闸：同一会话钥下同时在途的 challenge+login 不超过 `NODE_LOGIN_FANOUT` 条。
//
// 与「同一 nodeId 的并发调用共享在途 Promise」是两件事——那条去重在 store 里，这里管的是
// 不同 node 之间的总量：challenge 与 login 都要经入口转发，一次点亮一屏节点会把入口打满。

/** 同一会话钥下多 node 登录的并发上限：challenge+login 都是转发 REST。 */
export const NODE_LOGIN_FANOUT = 3;

let lanes = 0;
const waiters: Array<() => void> = [];

export function acquireLoginLane(): Promise<void> {
  if (lanes < NODE_LOGIN_FANOUT) {
    lanes += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    waiters.push(resolve);
  });
}

export function releaseLoginLane(): void {
  const next = waiters.shift();
  // 名额直接交棒给下一个，中途不还回池子，免得插队冲破上限。
  if (next) next();
  else lanes = Math.max(0, lanes - 1);
}

/** 仅测试使用：放空闸门，避免用例之间互相串。 */
export function resetLoginLanesForTest(): void {
  lanes = 0;
  waiters.length = 0;
}
