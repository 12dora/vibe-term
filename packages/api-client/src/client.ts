// REST 客户端核心：baseUrl 注入 + 可选 fetch-like transport + 统一错误解析。
// 端点函数一律以 `client: ApiClient = defaultApiClient` 收尾（单实例宿主零改动，多实例宿主按连接注入）。

import { adaptiveDeadlineMs } from '@vibeterm/shared/net';
import { NODE_LOGIN_REQUIRED } from './auth/types';
import { type UploadInit, type XhrCtor, xhrUpload } from './xhr-upload';

export type { UploadInit } from './xhr-upload';

const LATENCY_EWMA_ALPHA = 0.2;
const REQUEST_TIMEOUT_MIN_MS = 8_000;
const REQUEST_TIMEOUT_MAX_MS = 45_000;
const FORWARDED_PATH = /(?:^|\/)n\/[0-9a-f]{32}(?:\/|$|\?)/i;

export function requestTimeoutMs(ewmaMs: number | null | undefined, forwarded = false): number {
  const base = adaptiveDeadlineMs({
    rttMs: ewmaMs,
    factor: 8,
    minMs: REQUEST_TIMEOUT_MIN_MS,
    maxMs: REQUEST_TIMEOUT_MAX_MS,
  });
  if (!forwarded) return base;
  return Math.min(Math.round(base * 1.5), Math.round(REQUEST_TIMEOUT_MAX_MS * 1.5));
}

export function sessionProbeTimeoutMs(latencyMs: number | null | undefined): number {
  return adaptiveDeadlineMs({ rttMs: latencyMs, factor: 8, minMs: 8_000, maxMs: 30_000 });
}

function isForwardedUrl(baseUrl: string, path: string): boolean {
  return (
    FORWARDED_PATH.test(baseUrl) ||
    FORWARDED_PATH.test(path) ||
    FORWARDED_PATH.test(`${baseUrl}${path}`)
  );
}

/** fetch-like：接收已拼好 baseUrl 的绝对/相对 URL 与原始 RequestInit。 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * `timeout: false` 跳过默认 `AbortSignal.timeout`：该 signal 会在期限到点后中止响应体，
 * NDJSON / 下载等长流必须显式关掉。调用方自带 `signal` 时同样不套默认期限。
 */
export type ApiFetchInit = RequestInit & { timeout?: false; purpose?: RequestPurpose };

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

/**
 * 请求用途。`transfer` = 文件传输自己的数据请求（上传 PUT / 状态查询、下载内容 GET、
 * prepare / commit 流）：它们有自己的重试与退避，不该被宿主的「按 node 退避」挡住，
 * 也不该因为一条 lane 断线就把整个 node 记成打不通。
 */
export type RequestPurpose = 'transfer';

export interface RequestMeta {
  method: string;
  purpose?: RequestPurpose;
}

/**
 * 请求门：同时挂在 `fetch()` 与 `upload()` 上，宿主据此做「按 node 退避」之类的记账，
 * 不必再包一层 transport（包了 transport，上传就退不到 XHR 的字节级进度）。
 */
export interface RequestGate {
  /** 发出前调用；抛错则请求不进网络（如退避窗口里的读）。 */
  admit?(req: RequestMeta): void;
  /** 拿到了 HTTP 响应（任意状态码）。 */
  onResponse?(res: Response, req: RequestMeta): void;
  /** 请求在拿到响应之前失败（含用户取消）。 */
  onFailure?(error: unknown, req: RequestMeta): void;
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
  private ewmaMs: number | null = null;

  constructor(
    readonly baseUrl: string = '',
    private readonly transport?: FetchLike,
    private readonly gate?: RequestGate
  ) {}

  url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  lastLatencyMs(): number | null {
    return this.ewmaMs;
  }

  fetch(path: string, init?: ApiFetchInit): Promise<Response> {
    const { timeout, purpose, ...request } = init ?? {};
    const skipDefault = timeout === false || request.signal != null;
    const nextInit: RequestInit = skipDefault
      ? request
      : {
          ...request,
          signal: AbortSignal.timeout(
            requestTimeoutMs(this.ewmaMs, isForwardedUrl(this.baseUrl, path))
          ),
        };
    const url = this.url(path);
    // 每次调用时读取 globalThis.fetch，禁止在模块加载或构造时捕获。
    return this.dispatch(path, { method: request.method ?? 'GET', purpose }, () =>
      this.transport ? this.transport(url, nextInit) : globalThis.fetch(url, nextInit)
    );
  }

  /**
   * 与 `fetch` 同语义（baseUrl、同源 cookie、请求门、延迟 EWMA、响应钩子、AbortError），
   * 额外通过 `onUploadProgress` 汇报请求体已发出的字节数。没有 XMLHttpRequest（CLI / 测试）
   * 或注入了自定义 transport 时退回 `fetch`，只在整个请求体送达后汇报一次。
   * 不套默认请求期限：大块上传的期限由调用方的 signal 管。
   */
  upload(path: string, init: UploadInit): Promise<Response> {
    const Xhr = this.transport
      ? undefined
      : (globalThis as { XMLHttpRequest?: XhrCtor }).XMLHttpRequest;
    if (!Xhr) return this.uploadViaFetch(path, init);
    const url = this.url(path);
    const meta: RequestMeta = { method: init.method ?? 'POST', purpose: init.purpose };
    return this.dispatch(path, meta, () => xhrUpload(Xhr, url, init));
  }

  private async uploadViaFetch(path: string, init: UploadInit): Promise<Response> {
    const { onUploadProgress, ...request } = init;
    const res = await this.fetch(path, { ...request, timeout: false });
    if (res.ok) onUploadProgress?.(init.body.size);
    return res;
  }

  /** 两条请求通道共用的收口：请求门 → 发送 → 延迟 EWMA → 响应钩子。 */
  private dispatch(
    path: string,
    meta: RequestMeta,
    send: () => Promise<Response>
  ): Promise<Response> {
    try {
      this.gate?.admit?.(meta);
    } catch (error) {
      return Promise.reject(error);
    }
    const url = this.url(path);
    const started = performance.now();
    return send().then(
      (res) => {
        this.gate?.onResponse?.(res, meta);
        this.noteLatency(performance.now() - started);
        if (responseHooks.size > 0) {
          runResponseHooks(res, { path, url, pathname: urlPathname(url) });
        }
        return res;
      },
      (error: unknown) => {
        this.gate?.onFailure?.(error, meta);
        throw error;
      }
    );
  }

  private noteLatency(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.ewmaMs =
      this.ewmaMs == null
        ? ms
        : Math.round(LATENCY_EWMA_ALPHA * ms + (1 - LATENCY_EWMA_ALPHA) * this.ewmaMs);
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
