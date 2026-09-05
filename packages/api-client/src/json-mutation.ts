// REST 端点的公共请求模板：拼 init → 非 2xx 交给错误工厂 → 解析 JSON 并按需拆信封。
//
// 各端点族抛出的异常类型不同（`Error`、`FileApiError`、`TlsApiError`/`LocalApiError`），
// 由 `toError` 承载，所以收敛模板不改变任何调用方看到的错误形状。

import { type ApiClient, parseApiError } from './client';

export const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

/** 非 2xx 时构造要抛出的异常。 */
export type ResponseErrorFactory = (res: Response) => Error | Promise<Error>;

export interface JsonRequestOptions {
  method?: string;
  /** 非 undefined 时自动附 JSON 头并序列化。 */
  body?: unknown;
  signal?: AbortSignal;
  /** 缺省用 `new Error(await parseApiError(res, errorFallback))`。 */
  toError?: ResponseErrorFactory;
  errorFallback?: string;
  /** 这些非 2xx 状态码不抛错，由调用方按业务语义处理（如 404 → null、409 → conflict）。 */
  allowStatus?: readonly number[];
}

function buildInit(options: JsonRequestOptions): RequestInit | undefined {
  const { method, body, signal } = options;
  if (method === undefined && body === undefined && signal === undefined) return undefined;
  const init: RequestInit = {};
  if (method !== undefined) init.method = method;
  if (body !== undefined) {
    init.headers = JSON_HEADERS;
    init.body = JSON.stringify(body);
  }
  if (signal !== undefined) init.signal = signal;
  return init;
}

async function toResponseError(res: Response, options: JsonRequestOptions): Promise<Error> {
  if (options.toError) return await options.toError(res);
  return new Error(await parseApiError(res, options.errorFallback ?? `HTTP ${res.status}`));
}

/** 发起请求，非 2xx 抛错；返回原始 Response，供无响应体或流式调用方使用。 */
export async function requestOk(
  client: ApiClient,
  path: string,
  options: JsonRequestOptions = {}
): Promise<Response> {
  const res = await client.fetch(path, buildInit(options));
  if (!res.ok && !options.allowStatus?.includes(res.status)) {
    throw await toResponseError(res, options);
  }
  return res;
}

/** 请求并解析 JSON；`pick` 从 `{ device }` 一类信封里取值，缺省整体返回。 */
export async function requestJson<TWire, TResult = TWire>(
  client: ApiClient,
  path: string,
  options: JsonRequestOptions & { pick?: (wire: TWire) => TResult } = {}
): Promise<TResult> {
  const res = await requestOk(client, path, options);
  const wire = (await res.json()) as TWire;
  return options.pick ? options.pick(wire) : (wire as unknown as TResult);
}

/**
 * `{ error: { code, message } }` 契约错误体；兼容反代 / 网关层给出的 `{ error: "..." }` 老形态。
 *
 * `pick` 用于端点自有的错误体形状（如非 `error` 键包信封、需要额外字段拼 message/details）：
 * 拿到已解析的 JSON body（解析失败时为 `undefined`）与状态码，命中就直接返回完整的 `T`；
 * 返回 `undefined` 则退回上面的默认契约解析，仍解不出再退到 `make(fallback, fallback, status)`。
 * 不传 `pick` 时行为与之前完全一致。
 */
export async function readCodedError<T>(
  res: Response,
  fallback: string,
  make: (code: string, message: string, status: number) => T,
  pick?: (body: unknown, status: number) => T | undefined
): Promise<T> {
  let body: unknown;
  let parsed = true;
  try {
    body = await res.json();
  } catch {
    parsed = false;
  }
  if (pick) {
    const picked = pick(parsed ? body : undefined, res.status);
    if (picked !== undefined) return picked;
  }
  // 合法 JSON 也可能是 `null` 或裸标量：直接读 `.error` 会抛 TypeError，只能走 fallback。
  if (parsed && typeof body === 'object' && body !== null) {
    const error = (body as { error?: unknown }).error;
    if (error && typeof error === 'object') {
      const { code, message } = error as { code?: unknown; message?: unknown };
      if (typeof code === 'string') {
        return make(code, typeof message === 'string' ? message : code, res.status);
      }
    }
    if (typeof error === 'string') return make(error, error, res.status);
  }
  return make(fallback, fallback, res.status);
}
