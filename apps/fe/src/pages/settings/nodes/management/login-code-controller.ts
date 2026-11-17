// 「登录命令」对话框的状态机：加载账户上下文、签发、轮询各节点状态、作废、释放句柄。
// 与 React 解耦（订阅式 store），定时器与时钟可注入，测试不需要 DOM。
// 签发模块只经 `loadModule` 动态引入，不进入口 / 设置页 chunk。

import type {
  IssueLoginCodeResult,
  LoginCodeContext,
  LoginCodeHandle,
  LoginCodeNodeOutcome,
  LoginCodeNodeState,
  LoginCodeProof,
  LoginCodeSkipped,
  LoginCodeTarget,
} from '@/auth/login-code-issue';

export type LoginCodeModule = Pick<
  typeof import('@/auth/login-code-issue'),
  | 'loadLoginCodeContext'
  | 'planLoginCodeTargets'
  | 'issueLoginCode'
  | 'pollLoginCodeStates'
  | 'revokeLoginCode'
  | 'disposeLoginCode'
>;
export type LoginCodeModuleLoader = () => Promise<LoginCodeModule>;

export const defaultLoginCodeLoader: LoginCodeModuleLoader = () =>
  import('@/auth/login-code-issue');

export const LOGIN_CODE_POLL_MS = 3_000;

export type LoginCodePhase = 'loading' | 'ready' | 'generating' | 'result';

export interface LoginCodeResultState {
  handle: LoginCodeHandle;
  nodes: LoginCodeNodeOutcome[];
  skipped: LoginCodeSkipped[];
  /** 每台成功签发的节点的最近已知状态；`unknown` 不覆盖旧值。 */
  states: Record<string, LoginCodeNodeState>;
  revoking: boolean;
}

export interface LoginCodeIssueError {
  code: string;
  retryAfterMs?: number;
}

export interface LoginCodeViewState {
  phase: LoginCodePhase;
  loadFailed: boolean;
  mod: LoginCodeModule | null;
  context: LoginCodeContext | null;
  error: LoginCodeIssueError | null;
  result: LoginCodeResultState | null;
}

export interface LoginCodeControllerDeps {
  loadModule: LoginCodeModuleLoader;
  pollMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
}

export interface LoginCodeGenerateInput {
  targets: LoginCodeTarget[];
  skipped: LoginCodeSkipped[];
  proof: LoginCodeProof;
}

export interface LoginCodeController {
  getState(): LoginCodeViewState;
  subscribe(listener: () => void): () => void;
  load(): Promise<void>;
  generate(input: LoginCodeGenerateInput): Promise<IssueLoginCodeResult | null>;
  clearError(): void;
  poll(): Promise<void>;
  revoke(): Promise<void>;
  dispose(): void;
}

const INITIAL: LoginCodeViewState = {
  phase: 'loading',
  loadFailed: false,
  mod: null,
  context: null,
  error: null,
  result: null,
};

/** 结果里还有没被使用的节点（仅统计签发成功的）。 */
export function hasPendingNodes(result: LoginCodeResultState): boolean {
  return result.nodes.some((node) => node.ok && result.states[node.meshId] === 'pending');
}

/** 控制器的可变内核：各操作都是接收它的小函数，`createLoginCodeController` 只负责组装。 */
interface Core {
  deps: LoginCodeControllerDeps;
  pollMs: number;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (id: unknown) => void;
  state: LoginCodeViewState;
  epoch: number;
  timer: unknown;
  abort: AbortController | null;
  polling: boolean;
  listeners: Set<() => void>;
}

function notify(core: Core): void {
  for (const listener of core.listeners) listener();
}

function setState(core: Core, patch: Partial<LoginCodeViewState>): void {
  core.state = { ...core.state, ...patch };
  notify(core);
}

function stopTimer(core: Core): void {
  if (core.timer !== null) core.clearTimer(core.timer);
  core.timer = null;
}

function scheduleNext(core: Core): void {
  stopTimer(core);
  const result = core.state.result;
  if (!result || !hasPendingNodes(result) || core.now() >= result.handle.expiresAt) return;
  const mine = core.epoch;
  core.timer = core.setTimer(() => {
    core.timer = null;
    if (mine === core.epoch) void pollOnce(core);
  }, core.pollMs);
}

async function loadContext(core: Core): Promise<void> {
  const mine = ++core.epoch;
  setState(core, { phase: 'loading', loadFailed: false, error: null });
  try {
    const mod = core.state.mod ?? (await core.deps.loadModule());
    const context = await mod.loadLoginCodeContext();
    if (mine !== core.epoch) return;
    setState(core, { mod, context, phase: 'ready', loadFailed: false });
  } catch {
    if (mine !== core.epoch) return;
    setState(core, { phase: 'loading', loadFailed: true });
  }
}

async function runIssue(
  mod: LoginCodeModule,
  context: LoginCodeContext,
  input: LoginCodeGenerateInput,
  signal: AbortSignal
): Promise<IssueLoginCodeResult> {
  try {
    return await mod.issueLoginCode({
      context,
      targets: input.targets,
      proof: input.proof,
      signal,
    });
  } catch {
    return { ok: false, code: 'NETWORK_ERROR', nodes: [] };
  }
}

function showIssued(
  core: Core,
  res: Extract<IssueLoginCodeResult, { ok: true }>,
  skipped: LoginCodeSkipped[]
): void {
  const states: Record<string, LoginCodeNodeState> = {};
  for (const node of res.nodes) if (node.ok) states[node.meshId] = 'pending';
  setState(core, {
    phase: 'result',
    result: { handle: res.handle, nodes: res.nodes, skipped, states, revoking: false },
  });
  scheduleNext(core);
}

async function generateCode(
  core: Core,
  input: LoginCodeGenerateInput
): Promise<IssueLoginCodeResult | null> {
  const { mod, context } = core.state;
  if (!mod || !context || core.state.phase !== 'ready') return null;
  const mine = core.epoch;
  core.abort = new AbortController();
  setState(core, { phase: 'generating', error: null });
  const res = await runIssue(mod, context, input, core.abort.signal);
  if (mine !== core.epoch) {
    // 对话框在签发期间已被释放：命令没人看到，立刻销毁密钥。
    if (res.ok) mod.disposeLoginCode(res.handle);
    return res;
  }
  if (res.ok) showIssued(core, res, input.skipped);
  else
    setState(core, { phase: 'ready', error: { code: res.code, retryAfterMs: res.retryAfterMs } });
  return res;
}

/** 合并一次轮询结果：`unknown` 不覆盖旧值。 */
function mergeStates(
  prev: Record<string, LoginCodeNodeState>,
  next: Record<string, LoginCodeNodeState>
): Record<string, LoginCodeNodeState> {
  const merged = { ...prev };
  for (const [meshId, value] of Object.entries(next)) {
    if (value !== 'unknown') merged[meshId] = value;
  }
  return merged;
}

async function pollOnce(core: Core): Promise<void> {
  const { mod, result } = core.state;
  if (!mod || !result || core.polling) return;
  const mine = core.epoch;
  core.polling = true;
  try {
    const next = await mod.pollLoginCodeStates(result.handle);
    const latest = core.state.result;
    if (mine !== core.epoch || !latest) return;
    setState(core, { result: { ...latest, states: mergeStates(latest.states, next) } });
  } catch {
    // 轮询失败保持旧状态，下一拍再试。
  } finally {
    core.polling = false;
  }
  if (mine === core.epoch) scheduleNext(core);
}

async function revokeCode(core: Core): Promise<void> {
  const { mod, result } = core.state;
  if (!mod || !result || result.revoking) return;
  const mine = core.epoch;
  stopTimer(core);
  setState(core, { result: { ...result, revoking: true } });
  try {
    await mod.revokeLoginCode(result.handle);
  } catch {
    // 尽力而为：随后的一次轮询会如实反映各节点状态。
  }
  const latest = core.state.result;
  if (mine !== core.epoch || !latest) return;
  setState(core, { result: { ...latest, revoking: false } });
  await pollOnce(core);
}

function disposeCore(core: Core): void {
  core.epoch += 1;
  stopTimer(core);
  core.abort?.abort();
  core.abort = null;
  core.polling = false;
  const { mod, result } = core.state;
  if (mod && result) {
    try {
      mod.disposeLoginCode(result.handle);
    } catch {
      // 释放失败不应阻止关闭。
    }
  }
  core.state = { ...INITIAL, mod };
  notify(core);
}

export function createLoginCodeController(deps: LoginCodeControllerDeps): LoginCodeController {
  const core: Core = {
    deps,
    pollMs: deps.pollMs ?? LOGIN_CODE_POLL_MS,
    now: deps.now ?? Date.now,
    setTimer: deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms)),
    clearTimer: deps.clearTimer ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>)),
    state: INITIAL,
    epoch: 0,
    timer: null,
    abort: null,
    polling: false,
    listeners: new Set(),
  };
  return {
    getState: () => core.state,
    subscribe(listener) {
      core.listeners.add(listener);
      return () => {
        core.listeners.delete(listener);
      };
    },
    load: () => loadContext(core),
    generate: (input) => generateCode(core, input),
    clearError() {
      if (core.state.error) setState(core, { error: null });
    },
    poll: () => pollOnce(core),
    revoke: () => revokeCode(core),
    dispose: () => disposeCore(core),
  };
}
