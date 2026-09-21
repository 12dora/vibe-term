import { STUN_MAPPED_ADVERTISE_TTL_MS, usablePublicIpv4 } from './peer-endpoints';
import { normalizeUplinkEndpointUrl } from './uplink-pool-url';

/** 与 STUN mapped 同级：漏 drop 时 30 min 后失效；在线 uplink 每次 status 会 touch。 */
export const RELAY_OBSERVED_IPV4_TTL_MS = STUN_MAPPED_ADVERTISE_TTL_MS;

export type RelayObservedIpv4Sink = {
  note(url: string, ipv4: string | undefined, now?: number): void;
  drop(url: string): void;
  touch(url: string, now?: number): void;
  snapshot(now?: number): string[];
};

/**
 * 按中继 URL 记住已认证 uplink 回告的公网 IPv4。
 * 回环 / 私网在 `note` 时丢掉（`relay,node` 自探走 127.0.0.1）。
 */
export class RelayObservedIpv4Store implements RelayObservedIpv4Sink {
  private readonly byUrl = new Map<string, { ipv4: string; at: number }>();

  note(url: string, ipv4: string | undefined, now = Date.now()): void {
    const key = normalizeUplinkEndpointUrl(url);
    const usable = usablePublicIpv4(ipv4);
    if (!usable) {
      this.byUrl.delete(key);
      return;
    }
    this.byUrl.set(key, { ipv4: usable, at: now });
  }

  drop(url: string): void {
    this.byUrl.delete(normalizeUplinkEndpointUrl(url));
  }

  touch(url: string, now = Date.now()): void {
    const row = this.byUrl.get(normalizeUplinkEndpointUrl(url));
    if (row) row.at = now;
  }

  snapshot(now = Date.now()): string[] {
    const out: string[] = [];
    for (const [url, row] of [...this.byUrl]) {
      if (now - row.at > RELAY_OBSERVED_IPV4_TTL_MS) {
        this.byUrl.delete(url);
        continue;
      }
      out.push(row.ipv4);
    }
    return out;
  }
}
