import type { FetchLike } from '../lib/fetch-like';
import { requireProbedAddress } from '../lib/probe-address';

/** 拉 Hub 自签 CA 的超时：端口被丢包时不能把整条 join 卡死。 */
export const HUB_CA_FETCH_TIMEOUT_MS = 15_000;

export type HubJoinProbeIo = { fetcher?: FetchLike; log?: (message: string) => void };

/** 地址没写端口时探 443 与内置候选端口；`--insecure-local` 与回环地址不探。 */
export function probeHubJoinUrl(
  urlRaw: string,
  io: HubJoinProbeIo,
  insecureLocal: boolean
): Promise<string> {
  return requireProbedAddress(urlRaw, {
    kind: 'hub',
    fetcher: io.fetcher,
    skip: insecureLocal,
    log: (message) => (io.log ?? console.log)(message),
  });
}
