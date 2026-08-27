// REST 客户端核心：baseUrl 注入 + 可选 fetch-like transport + 统一错误解析。
// 端点函数一律以 `client: ApiClient = defaultApiClient` 收尾（单实例宿主零改动，多实例宿主按连接注入）。

/** fetch-like：接收已拼好 baseUrl 的绝对/相对 URL 与原始 RequestInit。 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** 响应钩子：只读观察，不得消费 body（需要读 body 请先 `res.clone()`）。 */
export type ResponseHook = (res: Response, ctx: { path: string; url: string }) => void;

const responseHooks = new Set<ResponseHook>();

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

function runResponseHooks(res: Response, ctx: { path: string; url: string }): void {
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
      runResponseHooks(res, { path, url });
      return res;
    });
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
