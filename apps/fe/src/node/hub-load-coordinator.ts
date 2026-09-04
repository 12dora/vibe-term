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
  /**
   * 请求开始 / 结束时的 loading 翻转。`switched` 表示这一次开始的是**换了目标**的加载
   * （切 hub、候选集变化、启停），上一台 hub 的失败态到此为止，不该压在新目标的加载上；
   * 同一目标的轮询 / 手动刷新则保留失败态，否则每一拍都要把提示闪成另一句。
   */
  loading: (value: boolean, switched?: boolean) => void;
  /** 没有可用 hub（未启用或定位不到）：清空列表、失败态并结束 loading。 */
  reset: () => void;
  rows: (rows: HubNodeRow[]) => void;
  failed: (reason: HubFailureReason) => void;
}

/**
 * 静默登录里属于**本地 / 传输层**的结论：请求压根没走到 hub（没有会话钥、发不出去、
 * mesh 列表里没有这台 node、列表拉不回来），谈不上「hub 拒登」。
 */
const LOCAL_LOGIN_FAILURE_CODES = new Set([
  'NO_SESSION_KEY',
  'UNKNOWN_NODE',
  'NETWORK_ERROR',
  'NODE_LIST_FAILED',
]);

/**
 * 静默登录的失败码是不是 hub 的拒登结论。**用排除法**：除上面那几个本地 / 传输码，其余
 * （`PASSKEY_*`、`TOTP_*`、`DELEGATION_*`、`RATE_LIMITED`、`INVALID_CREDENTIALS`…）都是
 * 服务端下的判断。允许清单每漏一个后端新码，界面就把一次「hub 拒登」说成「hub 不可达」。
 */
export function isHubAuthCode(code: string | null | undefined): code is string {
  return typeof code === 'string' && code !== '' && !LOCAL_LOGIN_FAILURE_CODES.has(code);
}

/**
 * hub 列表请求（而非登录）的错误码里明确属于鉴权的那些。列表错误**不能**用排除法：
 * `hub_nodes_failed` 这类传输失败同样带码，反过来判会把「打不通」说成「拒登」。
 */
const HUB_AUTH_ERROR_CODES = new Set([
  'NODE_LOGIN_REQUIRED',
  'PASSKEY_REQUIRED',
  'PASSKEY_INVALID',
  'TOTP_REQUIRED',
  'TOTP_INVALID',
  'INVALID_CREDENTIALS',
  'BAD_SIGNATURE',
]);

function isHubAuthErrorCode(code: string): boolean {
  return HUB_AUTH_ERROR_CODES.has(code) || code.startsWith('DELEGATION_');
}

/**
 * 唯一的失败分类入口：401（任何码）与上面那组码算鉴权失败，其余一律算不可达。
 * 转发链把状态码改写掉时单看码仍然判得出，反之亦然。
 */
export function classifyHubFailure(err: unknown): HubFailureReason {
  const message = errorMessage(err);
  if (err instanceof HubApiError) {
    if (err.status === 401 || isHubAuthErrorCode(err.code)) {
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
  /** 上一次 `load()` 的目标；用来区分「换了 hub」与「同一目标的轮询 / 刷新」。 */
  private target: HubRequest | null = null;
  private inFlight: { request: HubRequest; promise: Promise<void> } | null = null;
  /** 已排队的尾随刷新；期间重复调用 `refresh()` 只合并成同一次。 */
  private trailing: Promise<void> | null = null;

  constructor(private readonly sink: HubLoadSink) {}

  /** 挂载（含 StrictMode 的二次挂载）：恢复写状态。 */
  activate(): void {
    this.active = true;
  }

  /** 卸载：之后到达的响应一律不写状态。 */
  dispose(): void {
    this.active = false;
    this.inFlight = null;
    this.trailing = null;
  }

  /**
   * 发起一次加载。`request` 为 `null` 表示当前没有可用 hub。
   * 同一个 `request` 正在飞时直接返回在飞的 promise（并发调用方合并成一次请求）。
   */
  load(request: HubRequest | null): Promise<void> {
    const current = this.inFlight;
    if (current && current.request === request) return current.promise;
    const switched = request !== this.target;
    this.target = request;
    const generation = ++this.generation;
    if (!request) {
      this.inFlight = null;
      if (this.active) this.sink.reset();
      return Promise.resolve();
    }
    if (this.active) this.sink.loading(true, switched);
    const promise = this.run(request, generation).finally(() => {
      if (this.inFlight?.promise === promise) this.inFlight = null;
    });
    this.inFlight = { request, promise };
    return promise;
  }

  /**
   * 「一定要拿到比现在更新的一份列表」。变更（批准 / 吊销 / 切换）之后的刷新**只能**走这里：
   * `load()` 遇到在飞的同一个请求会直接复用它，而那次请求可能早于变更就发出去了，
   * 复用它拿回的仍是变更前的旧快照（待批准行不消失、新成员不出现）。
   * 这里改成排一次尾随请求，等在飞的落地后再发一次；期间重复调用合并成同一次。
   */
  refresh(request: HubRequest | null): Promise<void> {
    const current = this.inFlight;
    if (!current || current.request !== request) return this.load(request);
    if (this.trailing) return this.trailing;
    const trailing = current.promise.then(() => {
      if (this.trailing === trailing) this.trailing = null;
      // 排队期间换了 hub（或停用）：补这一拍只会把新目标的结果顶成过期响应。
      if (!this.active || this.target !== request) return;
      return this.load(request);
    });
    this.trailing = trailing;
    return trailing;
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
