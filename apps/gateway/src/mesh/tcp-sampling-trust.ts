import type { TcpProbeVerdict } from './port-reach-probe';

/**
 * 金丝雀端口：TCP 1（tcpmux）在现实中不会开放。Surge / mihomo 一类 TUN 会替本机就地完成
 * 任何目标的三次握手，再去拨真实对端，所以连它也「握手成功」就说明本机的 TCP connect 耗时
 * 不是路径样本，整个进程的 TCP 路径抽样都不可信。
 */
export const TCP_CANARY_PORT = 1;
export const TCP_CANARY_DEADLINE_MS = 1_500;
/** 判定结果的保鲜期：过期后下一次抽样重新探一次金丝雀。 */
export const TCP_TRUST_TTL_MS = 30 * 60 * 1000;

type TrustState = { trusted: boolean; at: number; host: string };

let state: TrustState | null = null;
let announced = false;

export type CanaryProbe = (
  host: string,
  port: number,
  deadlineMs: number
) => Promise<{ verdict: TcpProbeVerdict; connectMs: number | null }>;

export function tcpSamplingTrustSnapshot(): TrustState | null {
  return state;
}

export function resetTcpSamplingTrustForTest(): void {
  state = null;
  announced = false;
}

/** 判定是否仍在保鲜期内；过期返回 null 让调用方重探。 */
export function tcpSamplingTrusted(now: number): boolean | null {
  if (!state || now - state.at > TCP_TRUST_TTL_MS) return null;
  return state.trusted;
}

/**
 * 对目标主机的金丝雀端口探一次：握手成功 = 本机就地终结 → 不可信；refused / timeout 说明
 * 握手真的走到了对端或被网络拦下 → 可信。结果进程内共享，两个抽样器都用。
 */
export async function ensureTcpSamplingTrust(
  host: string,
  now: number,
  probe: CanaryProbe,
  log?: (line: string) => void
): Promise<boolean> {
  const cached = tcpSamplingTrusted(now);
  if (cached !== null) return cached;
  let trusted = true;
  let connectMs: number | null = null;
  try {
    const result = await probe(host, TCP_CANARY_PORT, TCP_CANARY_DEADLINE_MS);
    trusted = result.verdict !== 'ok';
    connectMs = result.connectMs;
  } catch {
    trusted = true;
  }
  state = { trusted, at: now, host };
  if (!trusted && !announced) {
    announced = true;
    log?.(
      `[mesh] tcp path sampling disabled: local stack completes handshakes itself (canary host=${host} port=${TCP_CANARY_PORT} connect_ms=${connectMs === null ? '-' : Math.round(connectMs)})`
    );
  }
  if (trusted) announced = false;
  return trusted;
}
