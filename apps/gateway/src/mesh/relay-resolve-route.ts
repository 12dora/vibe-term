// `POST /api/mesh/relay/resolve`：地址没写端口时替浏览器探候选端口。
//
// 浏览器不能直接探中继（跨域 + 混合内容），一律由本机 gateway 代探；enroll proof 绑的是
// `hubHostFromUrl(url)`（含端口），所以端口必须在 `proof-material` 之前定下来。

import { type PortProbeResult, parseProbeTarget, probeAddressPorts } from '@vibeterm/shared/net';
import { normalizeRelayUrl } from '@vibeterm/shared/relay';
import { readJsonObjectBody } from '../api/http';
import { type RelayDialContext, relayDialContextFromEnv, resolveRelayDialUrl } from './relay-dial';
import { jsonBody, jsonError } from './session-middleware';

/** 单个候选端口的探测超时；八个候选交错发完仍在数秒内。 */
export const RELAY_RESOLVE_TIMEOUT_MS = 4_000;

export type RelayResolveDeps = {
  fetchImpl?: typeof fetch;
  dial?: RelayDialContext;
  /** 单个候选端口的探测超时；只在测试里下调。 */
  timeoutMs?: number;
};

export type RelayResolveResult = {
  url: string | null;
  port: number | null;
  explicit: boolean;
  triedPorts: number[];
};

function normalizedOrNull(raw: string): string | null {
  try {
    return normalizeRelayUrl(parseProbeTarget(raw).base);
  } catch {
    return null;
  }
}

/**
 * 本机就是中继（`relay,node`）且用户填的是本机中继的主机名但没写端口时，端口不能靠候选表去
 * 「发现」：`resolveRelayDialUrl` 会把这台机器的请求改写到回环 gateway，任何候选端口都会答话，
 * 443 必然抢先胜出，随后 enroll 又按精确 host 比对不走回环，直接打到错误的公网端口上。
 * 这种情况下地址是已知的——就是 `VIBETERM_RELAY_PUBLIC_URL`——只需回环确认一次。
 */
function selfRelayUrl(raw: string, ctx: RelayDialContext): string | null {
  const publicUrl = ctx.relayPublicUrl?.trim();
  if (!ctx.roles.relay || !publicUrl) return null;
  const own = normalizedOrNull(publicUrl);
  if (!own) return null;
  try {
    const target = parseProbeTarget(raw);
    if (target.explicitPort !== null) return null;
    return new URL(target.base).hostname === new URL(own).hostname ? own : null;
  } catch {
    return null;
  }
}

export async function resolveRelayAddress(
  raw: string,
  deps: RelayResolveDeps
): Promise<PortProbeResult> {
  const ctx = deps.dial ?? relayDialContextFromEnv();
  const self = selfRelayUrl(raw, ctx);
  const options = {
    kind: 'relay' as const,
    timeoutMs: deps.timeoutMs ?? RELAY_RESOLVE_TIMEOUT_MS,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    // 候选端口的拨号改写保持精确比对（host 含端口）：只有真正等于本机公网地址的那一条
    // 才走回环，其余候选照常走网络，回环的回答不会被算到别的端口头上。
    resolveDialUrl: (base: string) => resolveRelayDialUrl(base, ctx),
  };
  if (!self) return await probeAddressPorts(raw, options);
  // 只确认这一条地址（`ports: []` 关掉候选表），端口取自公网地址本身。
  const confirmed = await probeAddressPorts(self, { ...options, ports: [] });
  return { ...confirmed, explicit: false };
}

export async function handleRelayResolve(req: Request, deps: RelayResolveDeps): Promise<Response> {
  const body = await readJsonObjectBody(req);
  const raw = typeof body?.url === 'string' ? body.url.trim() : '';
  // 探测前先按中继地址规则卡一遍：非 https（回环除外）的地址不该被探，更不该被返回。
  if (!raw || !normalizedOrNull(raw)) return jsonError('INVALID_URL', 400);
  const probed = await resolveRelayAddress(raw, deps);
  const url = probed.url ? normalizedOrNull(probed.url) : null;
  const result: RelayResolveResult = {
    url,
    port: url ? probed.port : null,
    explicit: probed.explicit,
    triedPorts: probed.triedPorts,
  };
  return jsonBody(result);
}
