export class DirectAuthorizeError extends Error {
  constructor(
    message: string,
    readonly fatal: boolean
  ) {
    super(message);
    this.name = 'DirectAuthorizeError';
  }
}

/** 等 primary 的两种姿势：等它连上（`open`）/ 等它重连过一次（`reconnect`）。 */
export type PrimaryWaitMode = 'open' | 'reconnect';

export class DirectPrimaryWaitError extends Error {
  constructor(
    message: string,
    readonly mode: PrimaryWaitMode
  ) {
    super(message);
    this.name = 'DirectPrimaryWaitError';
  }
}

/**
 * 只认**带明确 code** 的那两个状态：老 node 上 `/api/mesh/connection` 落到
 * `/api/mesh/*` 的 405、或路由缺失的裸 404，都不该被误判成「等 primary」而永久挂起。
 */
export async function throwIfPrimaryWait(res: Response, label: string): Promise<void> {
  const code = await readErrorCode(res);
  const mode: PrimaryWaitMode | null =
    res.status === 404 && code === 'NO_CONNECTION'
      ? 'open'
      : res.status === 409 && code === 'MULTIPLE_CONNECTIONS'
        ? 'reconnect'
        : null;
  if (mode) throw new DirectPrimaryWaitError(`${label}: ${code}`, mode);
}

async function readErrorCode(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { code?: unknown; error?: unknown };
    if (typeof body?.code === 'string') return body.code;
    if (typeof body?.error === 'string') return body.error;
  } catch {
    // 非 JSON 或空 body
  }
  return '';
}
