// REST 客户端核心：baseUrl 注入 + 可选 fetch-like transport + 统一错误解析。
// 端点函数一律以 `client: ApiClient = defaultApiClient` 收尾（单实例宿主零改动，多实例宿主按连接注入）。

/** fetch-like：接收已拼好 baseUrl 的绝对/相对 URL 与原始 RequestInit。 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

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
    if (this.transport) {
      return this.transport(url, init);
    }
    // 每次调用时读取 globalThis.fetch，禁止在模块加载或构造时捕获。
    return globalThis.fetch(url, init);
  }
}

export const defaultApiClient = new ApiClient();

export async function parseApiError(res: Response, fallback: string): Promise<string> {
  try {
    const payload = (await res.json()) as { error?: unknown };
    if (typeof payload.error === 'string') return payload.error;
    // 兼容 `{error: {message}}` 形态的信封（如反向代理/网关层错误），
    // 避免把对象拼进 Error message 变成 "[object Object]"。
    if (payload.error && typeof payload.error === 'object') {
      const message = (payload.error as { message?: unknown }).message;
      if (typeof message === 'string') return message;
    }
    return fallback;
  } catch {
    return fallback;
  }
}
