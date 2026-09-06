// `POST /api/mesh/relay/resolve`：地址没写端口时替浏览器探候选端口。
//
// 浏览器不能直接探中继（跨域 + 混合内容），一律由本机 gateway 代探；enroll proof 绑的是
// `hubHostFromUrl(url)`（含端口），所以端口必须在 `proof-material` 之前定下来。

import { type PortProbeResult, parseProbeTarget, probeAddressPorts } from '@tmex/shared/net';
import { normalizeRelayUrl } from '@tmex/shared/relay';
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

/**
 * 候选端口与本机中继公网地址的端口不同，`resolveRelayDialUrl` 按 host（含端口）比对会漏判，
 * 这里先把候选端口换成公网地址的端口再比，`relay,node` 探自己时仍走回环。
 */
export function relayProbeDialUrl(candidate: string, ctx: RelayDialContext): string {
  const publicUrl = ctx.relayPublicUrl?.trim();
  if (!ctx.roles.relay || !publicUrl) return candidate;
  try {
    const probe = new URL(candidate);
    const own = new URL(publicUrl);
    if (probe.hostname !== own.hostname) return candidate;
    return resolveRelayDialUrl(publicUrl, ctx);
  } catch {
    return resolveRelayDialUrl(candidate, ctx);
  }
}

function normalizedOrNull(raw: string): string | null {
  try {
    return normalizeRelayUrl(parseProbeTarget(raw).base);
  } catch {
    return null;
  }
}

export async function resolveRelayAddress(
  raw: string,
  deps: RelayResolveDeps
): Promise<PortProbeResult> {
  const ctx = deps.dial ?? relayDialContextFromEnv();
  return await probeAddressPorts(raw, {
    kind: 'relay',
    timeoutMs: deps.timeoutMs ?? RELAY_RESOLVE_TIMEOUT_MS,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    resolveDialUrl: (base) => relayProbeDialUrl(base, ctx),
  });
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
