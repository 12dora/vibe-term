// standalone 实例的初始化（become hub / join hub）客户端。
//
// 这些端点只在 standalone 注册，成功后网关会写 env 并退出进程等待守护重启；
// 因此调用前必须先读一次 `/healthz.startedAt`，用它区分「同一个进程」与「重启后的新进程」。

import { type ApiClient, defaultApiClient } from '../client';
import type {
  SetupHubRequest,
  SetupHubResponse,
  SetupJoinRequest,
  SetupJoinResponse,
  SetupPrecheckResponse,
  SetupRelayJoinRequest,
  SetupRelayJoinResponse,
  SetupRelayRequest,
  SetupRelayResponse,
} from './types';

/** 后端错误信封 `{error:{code,message}}` 的解包结果。 */
export class SetupApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'SetupApiError';
  }
}

async function readError(res: Response, fallbackCode: string): Promise<SetupApiError> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === 'string') {
      return new SetupApiError(body.error, body.error, res.status);
    }
    if (body.error && typeof body.error === 'object') {
      const { code, message } = body.error as { code?: unknown; message?: unknown };
      if (typeof code === 'string') {
        return new SetupApiError(code, typeof message === 'string' ? message : code, res.status);
      }
    }
  } catch {
    // 落到 fallback
  }
  return new SetupApiError(fallbackCode, fallbackCode, res.status);
}

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

export interface HealthProbeResult {
  /** HTTP 层是否拿到 2xx；进程不在时为 false。 */
  ok: boolean;
  /** `/healthz.startedAt`；不可达或字段缺失为 null。 */
  startedAt: number | null;
}

/** 探活：网络错误与非 2xx 都不抛，交给调用方按状态机处理。 */
export async function probeHealth(
  client: ApiClient = defaultApiClient
): Promise<HealthProbeResult> {
  let res: Response;
  try {
    res = await client.fetch('/healthz', { cache: 'no-store' });
  } catch {
    return { ok: false, startedAt: null };
  }
  if (!res.ok) return { ok: false, startedAt: null };
  try {
    const body = (await res.json()) as { startedAt?: unknown };
    return { ok: true, startedAt: typeof body.startedAt === 'number' ? body.startedAt : null };
  } catch {
    return { ok: true, startedAt: null };
  }
}

/** 读 `/healthz.startedAt`；不可达或字段缺失返回 null。 */
export async function readHealthStartedAt(
  client: ApiClient = defaultApiClient
): Promise<number | null> {
  return (await probeHealth(client)).startedAt;
}

export class SetupApi {
  constructor(private readonly client: ApiClient = defaultApiClient) {}

  async precheck(url: string): Promise<SetupPrecheckResponse> {
    const res = await this.client.fetch('/api/setup/precheck', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ url }),
    });
    if (!res.ok) throw await readError(res, 'precheck_failed');
    return (await res.json()) as SetupPrecheckResponse;
  }

  async becomeHub(req: SetupHubRequest): Promise<SetupHubResponse> {
    const res = await this.client.fetch('/api/setup/hub', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(req),
    });
    if (!res.ok) throw await readError(res, 'setup_hub_failed');
    return (await res.json()) as SetupHubResponse;
  }

  async joinHub(req: SetupJoinRequest): Promise<SetupJoinResponse> {
    const res = await this.client.fetch('/api/setup/join', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(req),
    });
    if (!res.ok) throw await readError(res, 'setup_join_failed');
    return (await res.json()) as SetupJoinResponse;
  }

  async relayJoin(req: SetupRelayJoinRequest): Promise<SetupRelayJoinResponse> {
    const res = await this.client.fetch('/api/setup/relay-join', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(req),
    });
    if (!res.ok) throw await readError(res, 'setup_relay_join_failed');
    return (await res.json()) as SetupRelayJoinResponse;
  }

  async setupRelay(req: SetupRelayRequest): Promise<SetupRelayResponse> {
    const res = await this.client.fetch('/api/setup/relay', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(req),
    });
    if (!res.ok) throw await readError(res, 'setup_relay_failed');
    return (await res.json()) as SetupRelayResponse;
  }
}
