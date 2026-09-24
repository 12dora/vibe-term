/** 转发器打不通目标 node（mesh 链路问题，与直连本身无关）。 */
export const NODE_UNREACHABLE_CODE = 'NODE_UNREACHABLE';
/** 目标 node 自己答：它给不出直连（没有原生栈 / 被关掉）。 */
export const DIRECT_UNAVAILABLE_CODE = 'DIRECT_UNAVAILABLE';
/** 目标 node 自己答：这次没给出来（超时、被打断、内部失败、名额满），过会儿再试。 */
export const DIRECT_BUSY_CODE = 'DIRECT_BUSY';

/** 老 node 把一过性失败也答成 `DIRECT_UNAVAILABLE`，只能靠 `reason` 认出来。 */
const TRANSIENT_DIRECT_REASONS: ReadonlySet<string> = new Set([
  'timeout',
  'aborted',
  'failed',
  'capacity',
]);

/** `unavailable`：整段停放；`busy`：走 authorize 熔断；`null`：不是目标 node 的直连结论。 */
export type DirectAuthorizeVerdict = 'unavailable' | 'busy' | null;

export function classifyDirectAuthorizeFailure(
  code: string,
  reason: string | null
): DirectAuthorizeVerdict {
  if (code === DIRECT_BUSY_CODE) return 'busy';
  if (code !== DIRECT_UNAVAILABLE_CODE) return null;
  return reason !== null && TRANSIENT_DIRECT_REASONS.has(reason) ? 'busy' : 'unavailable';
}

export interface ErrorBody {
  code: string;
  reason: string | null;
  retryAfterMs: number | null;
}

export class DirectAuthorizeError extends Error {
  constructor(
    message: string,
    readonly fatal: boolean,
    readonly code: string = ''
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
export function throwIfPrimaryWaitCode(status: number, code: string, label: string): void {
  const mode: PrimaryWaitMode | null =
    status === 404 && code === 'NO_CONNECTION'
      ? 'open'
      : status === 409 && code === 'MULTIPLE_CONNECTIONS'
        ? 'reconnect'
        : null;
  if (mode) throw new DirectPrimaryWaitError(`${label}: ${code}`, mode);
}

export async function throwIfPrimaryWait(res: Response, label: string): Promise<void> {
  throwIfPrimaryWaitCode(res.status, await readErrorCode(res), label);
}

function pickCode(body: { code?: unknown; error?: unknown } | null): string {
  if (typeof body?.code === 'string') return body.code;
  if (typeof body?.error === 'string') return body.error;
  return '';
}

function pickRetryAfter(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

export async function readErrorBody(res: Response): Promise<ErrorBody> {
  let body: { code?: unknown; error?: unknown; reason?: unknown; retryAfterMs?: unknown } | null;
  try {
    body = (await res.json()) as typeof body;
  } catch {
    // 非 JSON 或空 body
    body = null;
  }
  return {
    code: pickCode(body),
    reason: typeof body?.reason === 'string' ? body.reason : null,
    retryAfterMs: pickRetryAfter(body?.retryAfterMs),
  };
}

export async function readErrorCode(res: Response): Promise<string> {
  return (await readErrorBody(res)).code;
}
