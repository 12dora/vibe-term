import {
  isLoopbackHostname,
  parseProbeTarget,
  probeAddressPorts,
} from '../../../shared/src/net/port-candidates';
import { t } from '../i18n';
import type { FetchInit, FetchLike } from './fetch-like';

/** CLI 侧单个候选端口的探测超时。 */
export const CLI_PROBE_TIMEOUT_MS = 4_000;

export type ProbeAddressKind = 'relay' | 'hub';

export type ProbeAddressOptions = {
  kind: ProbeAddressKind;
  fetcher?: FetchLike;
  log?: (message: string) => void;
  /** 显式跳过探测（`--insecure-local` 等）。 */
  skip?: boolean;
  timeoutMs?: number;
};

export type ProbedAddress = {
  /** 应当使用的地址：探到就带上端口，未探测或没探到时为原地址。 */
  url: string;
  /** 是否真的发起了候选端口探测。 */
  probed: boolean;
  found: boolean;
  triedPorts: number[];
};

export function probeNotFoundMessage(triedPorts: number[]): string {
  return t('port.probe.notFound', { ports: triedPorts.join(', ') });
}

/** 探不到就报错的版本；需要自定义错误类型的调用方直接用 `probeAddressForCli`。 */
export async function requireProbedAddress(
  raw: string,
  options: ProbeAddressOptions
): Promise<string> {
  const probed = await probeAddressForCli(raw, options);
  if (probed.probed && !probed.found) {
    throw new Error(probeNotFoundMessage(probed.triedPorts));
  }
  return probed.url;
}

function shouldProbe(raw: string, options: ProbeAddressOptions): boolean {
  if (options.skip) return false;
  let target: ReturnType<typeof parseProbeTarget>;
  try {
    target = parseProbeTarget(raw);
  } catch {
    return false;
  }
  if (target.explicitPort !== null || target.protocol !== 'https:') return false;
  try {
    return !isLoopbackHostname(new URL(target.base).hostname);
  } catch {
    return false;
  }
}

/**
 * 端口探测只为选出一个能答话的端口，不传任何凭据，所以放过证书校验——
 * 自签中继（`--ca-fingerprint`）在非标端口上也要能被探到；随后的正式请求仍走完整校验。
 */
function probeFetch(
  fetcher: FetchLike | undefined
): (input: string, init: RequestInit) => Promise<Response> {
  const impl = fetcher ?? fetch;
  return (input, init) => impl(input, { ...init, tls: { rejectUnauthorized: false } } as FetchInit);
}

/**
 * 地址没写端口时探 443 与内置候选端口。显式端口、回环地址、非 https 一律原样返回。
 * 探不到不抛错——由调用方按各自的错误类型决定怎么报。
 */
export async function probeAddressForCli(
  raw: string,
  options: ProbeAddressOptions
): Promise<ProbedAddress> {
  if (!shouldProbe(raw, options)) {
    return { url: raw, probed: false, found: false, triedPorts: [] };
  }
  const log = options.log;
  log?.(t('port.probe.searching'));
  const result = await probeAddressPorts(raw, {
    kind: options.kind,
    fetchImpl: probeFetch(options.fetcher),
    timeoutMs: options.timeoutMs ?? CLI_PROBE_TIMEOUT_MS,
  });
  if (!result.url || result.port === null) {
    return { url: raw, probed: true, found: false, triedPorts: result.triedPorts };
  }
  log?.(
    t(options.kind === 'relay' ? 'port.probe.foundRelay' : 'port.probe.foundHub', {
      port: result.port,
      url: result.url,
    })
  );
  return { url: result.url, probed: true, found: true, triedPorts: result.triedPorts };
}
