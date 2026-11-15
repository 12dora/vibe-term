import { isIP } from 'node:net';
import os from 'node:os';
import {
  type CidrRule,
  cidrMatchesAny,
  normalizeIpAddress,
  parseCidrAddress,
  parseCidrRule,
} from '../../ip-cidr';

export { normalizeIpAddress as normalizePeerAddress } from '../../ip-cidr';

export const DEFAULT_DENIED_PEER_CIDRS = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4',
  '::1/128',
  'fc00::/7',
  'fe80::/10',
] as const;

export function createPeerPolicy(
  cidrs: readonly string[] = DEFAULT_DENIED_PEER_CIDRS
): (address: string) => boolean {
  const set = new PeerDenySet({ cidrs, denySelf: false });
  return (address: string) => set.has(address);
}

/** 运维追加名单：逗号或空白分隔的 IPv4 CIDR，裸 IPv4 视为 /32。 */
export function parseDeniedPeerList(raw: string | undefined): {
  cidrs: string[];
  invalid: string[];
} {
  const cidrs: string[] = [];
  const invalid: string[] = [];
  for (const entry of (raw ?? '').split(/[\s,]+/)) {
    if (!entry) continue;
    const [address, prefix, extra] = entry.split('/');
    const validPrefix = prefix === undefined || (/^\d{1,2}$/.test(prefix) && Number(prefix) <= 32);
    if (extra === undefined && isIP(address ?? '') === 4 && validPrefix) {
      cidrs.push(prefix === undefined ? `${address}/32` : entry);
    } else {
      invalid.push(entry);
    }
  }
  return { cidrs, invalid };
}

export type InterfaceLister = () => NodeJS.Dict<os.NetworkInterfaceInfo[]>;

export type PeerDenySetOptions = {
  cidrs?: readonly string[];
  /** 拒绝本机：外网 IP、监听地址与全部网卡地址（含 IPv6）。 */
  denySelf?: boolean;
  listInterfaces?: InterfaceLister;
};

function interfaceAddresses(list: InterfaceLister): string[] {
  try {
    return Object.values(list()).flatMap((infos) => (infos ?? []).map((info) => info.address));
  } catch {
    return [];
  }
}

function selfKey(address: string | null | undefined): string | null {
  if (!address) return null;
  try {
    const key = normalizeIpAddress(address);
    return key === '0.0.0.0' || key === '::' ? null : key;
  } catch {
    return null;
  }
}

export class PeerDenySet {
  private readonly rules: CidrRule[];
  private readonly denySelf: boolean;
  private readonly listInterfaces: InterfaceLister;
  private self = new Set<string>();

  constructor(opts: PeerDenySetOptions = {}) {
    this.rules = (opts.cidrs ?? DEFAULT_DENIED_PEER_CIDRS).map(parseCidrRule);
    this.denySelf = opts.denySelf ?? true;
    this.listInterfaces = opts.listInterfaces ?? os.networkInterfaces;
  }

  /** 外网 IP 每次（重新）解析后调用：整组重算，旧地址不再命中本机规则。 */
  refresh(selfAddresses: readonly (string | null | undefined)[]): void {
    if (!this.denySelf) return;
    const next = new Set<string>();
    for (const address of [...selfAddresses, ...interfaceAddresses(this.listInterfaces)]) {
      const key = selfKey(address);
      if (key) next.add(key);
    }
    this.self = next;
  }

  selfAddresses(): string[] {
    return [...this.self];
  }

  /** 非法地址抛错，调用方按拒绝处理。 */
  has(address: string): boolean {
    if (this.self.has(normalizeIpAddress(address))) return true;
    return cidrMatchesAny(this.rules, parseCidrAddress(address));
  }
}
