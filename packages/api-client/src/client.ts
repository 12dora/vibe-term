// REST 客户端核心：baseUrl 注入 + 统一错误解析。
// 端点函数一律以 `client: ApiClient = defaultApiClient` 收尾（单实例宿主零改动，多实例宿主按连接注入）。

export class ApiClient {
  constructor(readonly baseUrl: string = '') {}

  url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  fetch(path: string, init?: RequestInit): Promise<Response> {
    return fetch(this.url(path), init);
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
