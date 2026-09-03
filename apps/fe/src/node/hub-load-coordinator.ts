// `useHubNode` 的取数时序：初次加载、轮询、手动刷新三条来源共用一份协调器。
//
// 两件事：
//  1. **代号（generation）**：每次真正开跑的请求领一个递增代号，只有最新一代的响应能写状态。
//     慢的旧响应（换 hub、刷新与轮询交错）到得再晚也不会盖掉新结果。
//  2. **单飞（single-flight）**：同一个请求闭包在飞时，后来的调用方共享同一个 promise，
//     不再叠加一轮 `/n/<hub>/api/hub/nodes`。
//
// 「已卸载」与「过期响应」是两回事，分别判定：前者永不写状态（组件没了），
// 后者只是被更新的一代取代。

import { HubApiError, type HubNodeRow } from './hub-api';

export type HubRequest = () => Promise<HubNodeRow[]>;

/**
 * 加载失败的性质。`auth` = hub 应答了、只是不认这次身份（须重新登录）；
 * `unreachable` = 根本没拿到有意义的应答。两者的处置完全不同，界面必须分开说。
 */
export type HubFailureReason =
  | { kind: 'auth'; code: string; message: string }
  | { kind: 'unreachable'; code: string | null; message: string };

export interface HubLoadSink {
  /** 请求开始 / 结束时的 loading 翻转。 */
  loading: (value: boolean) => void;
  /** 没有可用 hub（未启用或定位不到）：清空列表并结束 loading。 */
  reset: () => void;
  rows: (rows: HubNodeRow[]) => void;
  failed: (reason: HubFailureReason) => void;
}

/** 节点登录被拒的业务码：拿到其中任何一个都说明 hub 是通的，只是这次身份没过。 */
const HUB_AUTH_CODES = new Set([
  'PASSKEY_REQUIRED',
  'PASSKEY_INVALID',
  'TOTP_REQUIRED',
  'NODE_LOGIN_REQUIRED',
  'INVALID_CREDENTIALS',
]);

export function isHubAuthCode(code: string | null | undefined): code is string {
  return typeof code === 'string' && HUB_AUTH_CODES.has(code);
}

/**
 * 唯一的失败分类入口：401（任何码）与上面那组码算鉴权失败，其余一律算不可达。
 * 转发链把状态码改写掉时单看码仍然判得出，反之亦然。
 */
export function classifyHubFailure(err: unknown): HubFailureReason {
  const message = errorMessage(err);
  if (err instanceof HubApiError) {
    if (err.status === 401 || isHubAuthCode(err.code)) {
      return { kind: 'auth', code: err.code, message };
    }
    return { kind: 'unreachable', code: err.code, message };
  }
  return { kind: 'unreachable', code: null, message };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class HubLoadCoordinator {
  private generation = 0;
  private active = true;
  private inFlight: { request: HubRequest; promise: Promise<void> } | null = null;

  constructor(private readonly sink: HubLoadSink) {}

  /** 挂载（含 StrictMode 的二次挂载）：恢复写状态。 */
  activate(): void {
    this.active = true;
  }

  /** 卸载：之后到达的响应一律不写状态。 */
  dispose(): void {
    this.active = false;
    this.inFlight = null;
  }

  /**
   * 发起一次加载。`request` 为 `null` 表示当前没有可用 hub。
   * 同一个 `request` 正在飞时直接返回在飞的 promise（并发调用方合并成一次请求）。
   */
  load(request: HubRequest | null): Promise<void> {
    const current = this.inFlight;
    if (current && current.request === request) return current.promise;
    const generation = ++this.generation;
    if (!request) {
      this.inFlight = null;
      if (this.active) this.sink.reset();
      return Promise.resolve();
    }
    if (this.active) this.sink.loading(true);
    const promise = this.run(request, generation).finally(() => {
      if (this.inFlight?.promise === promise) this.inFlight = null;
    });
    this.inFlight = { request, promise };
    return promise;
  }

  private async run(request: HubRequest, generation: number): Promise<void> {
    try {
      const rows = await request();
      if (this.canApply(generation)) this.sink.rows(rows);
    } catch (err) {
      if (this.canApply(generation)) this.sink.failed(classifyHubFailure(err));
    } finally {
      // loading 只由最新一代收尾：过期响应结束时新请求还在飞，不该让转圈提前停。
      if (this.canApply(generation)) this.sink.loading(false);
    }
  }

  /** 已卸载 → 忽略；代号落后 → 更新的请求已经开跑，这次是过期响应。 */
  private canApply(generation: number): boolean {
    return this.active && generation === this.generation;
  }
}
