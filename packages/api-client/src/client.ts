// REST 客户端核心：baseUrl 注入 + 可选 fetch-like transport + 统一错误解析。
// 端点函数一律以 `client: ApiClient = defaultApiClient` 收尾（单实例宿主零改动，多实例宿主按连接注入）。

import { NODE_LOGIN_REQUIRED } from './auth/types';

/** fetch-like：接收已拼好 baseUrl 的绝对/相对 URL 与原始 RequestInit。 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * 响应钩子上下文。
 *
 * `path` 是调用方传入的相对路径（**不含** `ApiClient.baseUrl`），`url` 是拼上 baseUrl 后的
 * 结果，`pathname` 则是把 `url` 规范化后的纯路径——401 归属判定必须用 `pathname`：
 * 每 node runtime 都以 `/n/<id>` 作 baseUrl 调 `client.fetch('/api/devices')`，只看 `path`
 * 会把该 node 的 401 误判成 entry 自身而把整页踢去登录页（见 F4-1 评审 Major）。
 */
export interface ResponseHookContext {
  path: string;
  url: string;
  pathname: string;
}

/** 响应钩子：只读观察，不得消费 body（需要读 body 请先 `res.clone()`）。 */
export type ResponseHook = (res: Response, ctx: ResponseHookContext) => void;

const responseHooks = new Set<ResponseHook>();

/** 取 URL 的 pathname；相对 URL 用一个占位 origin 解析，解析失败退化为去掉 query/hash 的原串。 */
export function urlPathname(url: string): string {
  try {
    return new URL(url, 'http://localhost').pathname;
  } catch {
    return url.split(/[?#]/)[0];
  }
}

/** 注册全局响应钩子（401 会话拦截等），返回反注册函数。 */
export function addResponseHook(hook: ResponseHook): () => void {
  responseHooks.add(hook);
  return () => {
    responseHooks.delete(hook);
  };
}

export function clearResponseHooks(): void {
  responseHooks.clear();
}

function runResponseHooks(res: Response, ctx: ResponseHookContext): void {
  for (const hook of responseHooks) {
    try {
      hook(res, ctx);
    } catch {
      // 钩子异常不得影响请求本身
    }
  }
}

export class ApiClient {
  constructor(
    readonly baseUrl: string = '',
    private readonly transport?: FetchLike
  ) {}

  url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  fetch(path: string, init?: RequestInit): Promise<Response> {
    const url = this.url(path);
    // 每次调用时读取 globalThis.fetch，禁止在模块加载或构造时捕获。
    const pending = this.transport ? this.transport(url, init) : globalThis.fetch(url, init);
    if (responseHooks.size === 0) {
      return pending;
    }
    return pending.then((res) => {
      runResponseHooks(res, { path, url, pathname: urlPathname(url) });
      return res;
    });
  }
}

export const defaultApiClient = new ApiClient();

type ErrorEnvelope = {
  error?: unknown;
  code?: unknown;
  nodeId?: unknown;
  reason?: unknown;
  message?: unknown;
};

async function readErrorEnvelope(res: Response): Promise<ErrorEnvelope | null> {
  try {
    const payload = (await res.json()) as unknown;
    return payload && typeof payload === 'object' ? (payload as ErrorEnvelope) : null;
  } catch {
    return null;
  }
}

/** `{error:"..."}` 与 `{error:{message}}` 两种信封里的人话；都没有则 null。 */
function envelopeMessage(payload: ErrorEnvelope | null): string | null {
  if (!payload) return null;
  if (typeof payload.error === 'string') return payload.error;
  // 兼容 `{error: {message}}` 形态的信封（如反向代理/网关层错误），
  // 避免把对象拼进 Error message 变成 "[object Object]"。
  if (payload.error && typeof payload.error === 'object') {
    const message = (payload.error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

export async function parseApiError(res: Response, fallback: string): Promise<string> {
  return envelopeMessage(await readErrorEnvelope(res)) ?? fallback;
}

/** mesh 转发层打不通目标 node（503）；`reason` 为后端给出的可安全展示的原因串。 */
export const NODE_UNREACHABLE = 'NODE_UNREACHABLE';

export interface ApiErrorFields {
  /** 契约错误码（`{code}` 顶层字段），如 `NODE_LOGIN_REQUIRED`。 */
  code?: string | null;
  /** 老形态 `{error:"..."}` 里的错误标识，如 `via_mismatch`。 */
  error?: string | null;
  /** 出错的目标 node（转发层附加）。 */
  nodeId?: string | null;
  /** 可直接展示给用户的原因串（转发层附加）。 */
  reason?: string | null;
}

/**
 * REST 非 2xx 的类型化错误：除人话之外保留 `status` 与契约错误体的顶层字段，
 * 调用方据此区分「该 node 要重新登录」「该 node 打不通」与其它失败。
 */
export class ApiError extends Error {
  readonly code: string | null;
  readonly error: string | null;
  readonly nodeId: string | null;
  readonly reason: string | null;

  constructor(
    readonly status: number,
    message: string,
    fields: ApiErrorFields = {}
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = fields.code ?? null;
    this.error = fields.error ?? null;
    this.nodeId = fields.nodeId ?? null;
    this.reason = fields.reason ?? null;
  }
}

/**
 * 把非 2xx 响应解析成 `ApiError`。展示用的 message 依次取 `error` / `error.message` /
 * `message` / `code` / `fallback`——`jsonError()` 只下发 `{code}`，退回 fallback 会把
 * 「节点打不通」显示成一句无关的兜底文案。
 */
export async function toApiError(res: Response, fallback: string): Promise<ApiError> {
  const payload = await readErrorEnvelope(res);
  const code = nonEmptyString(payload?.code);
  const message = envelopeMessage(payload) ?? nonEmptyString(payload?.message) ?? code ?? fallback;
  return new ApiError(res.status, message, {
    code,
    error: nonEmptyString(payload?.error),
    nodeId: nonEmptyString(payload?.nodeId),
    reason: nonEmptyString(payload?.reason),
  });
}

export function isApiErrorCode(error: unknown, code: string): boolean {
  return error instanceof ApiError && error.code === code;
}

export function isNodeLoginRequiredError(error: unknown): boolean {
  return isApiErrorCode(error, NODE_LOGIN_REQUIRED);
}

export function isNodeUnreachableError(error: unknown): boolean {
  return isApiErrorCode(error, NODE_UNREACHABLE);
}
