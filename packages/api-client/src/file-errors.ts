// 文件 API 的错误类型与响应解析，供 REST 端点与两段式传输共用。

import type { FileErrorCode } from '@tmex/shared';

export class FileApiError extends Error {
  status: number;
  code?: FileErrorCode;
  constructor(status: number, message: string, code?: FileErrorCode) {
    super(message);
    this.name = 'FileApiError';
    this.status = status;
    this.code = code;
  }
}

export async function parseError(res: Response): Promise<FileApiError> {
  let message = `HTTP ${res.status}`;
  let code: FileErrorCode | undefined;
  try {
    const body = (await res.json()) as { error?: string; code?: FileErrorCode };
    if (body.error) message = body.error;
    code = body.code;
  } catch {
    // 非 JSON 响应
  }
  return new FileApiError(res.status, message, code);
}
