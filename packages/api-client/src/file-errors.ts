// 文件 API 的错误类型与响应解析，供 REST 端点与两段式传输共用。

import type { FileErrorCode } from '@vibeterm/shared';

export class FileApiError extends Error {
  status: number;
  code?: FileErrorCode;
  /** 网关随错误码附带的细分原因（如 `cross_device`） */
  detail?: string;
  constructor(status: number, message: string, code?: FileErrorCode, detail?: string) {
    super(message);
    this.name = 'FileApiError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

export async function parseError(res: Response): Promise<FileApiError> {
  let message = `HTTP ${res.status}`;
  let code: FileErrorCode | undefined;
  let detail: string | undefined;
  try {
    const body = (await res.json()) as { error?: string; code?: FileErrorCode; detail?: unknown };
    if (body.error) message = body.error;
    code = body.code;
    if (typeof body.detail === 'string') detail = body.detail;
  } catch {
    // 非 JSON 响应
  }
  return new FileApiError(res.status, message, code, detail);
}
