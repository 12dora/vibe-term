/** 源节点每次窗格 RPC 随体带上的授权引用。 */
export interface PaneGrantRef {
  grantId: string;
  token: string;
}

/**
 * RPC 侧取授权的入口：`load` 每次调用都重读（另一条请求可能刚补签过），
 * `reject` 标记这张已被目标节点拒收，等下一次带用户 cookie 的请求补签。
 */
export interface PaneGrantSource {
  load(): Promise<PaneGrantRef | null>;
  reject(): void;
}
