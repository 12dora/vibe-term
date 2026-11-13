import { isIP } from 'node:net';
import os from 'node:os';

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

type Parsed = { family: 4 | 6; value: bigint; bits: number };
type Rule = Parsed;

function parseV4(value: string): bigint {
  const parts = value.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255))
    throw new Error(`Invalid IPv4 address: ${value}`);
  return parts.reduce((n, part) => (n << 8n) | BigInt(Number(part)), 0n);
}

function parseV6(value: string): bigint {
  const plain = value.split('%')[0];
  const halves = plain.split('::');
  if (halves.length > 2) throw new Error(`Invalid IPv6 address: ${value}`);
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const expand = (arr: string[]) =>
    arr.flatMap((part) =>
      part.includes('.')
        ? [parseV4(part) >> 16n, parseV4(part) & 0xffffn]
        : [BigInt(`0x${part || '0'}`)]
    );
  const leftGroups = expand(left);
  const rightGroups = expand(right);
  const groups = [
    ...leftGroups,
    ...(halves.length === 2 ? Array(8 - leftGroups.length - rightGroups.length).fill(0n) : []),
    ...rightGroups,
  ];
  if (groups.length !== 8 || groups.some((g) => g < 0 || g > 0xffffn))
    throw new Error(`Invalid IPv6 address: ${value}`);
  return groups.reduce((n, g) => (n << 16n) | g, 0n);
}

function parseAddress(value: string): Parsed {
  const family = isIP(value.split('%')[0]);
  if (family === 4) return { family: 4, value: parseV4(value), bits: 32 };
  if (family === 6) return { family: 6, value: parseV6(value), bits: 128 };
  throw new Error(`Invalid IP address: ${value}`);
}

function mappedV4(value: bigint): bigint | null {
  return value >> 32n === 0xffffn ? value & 0xffffffffn : null;
}

function parseRule(text: string): Rule {
  const slash = text.lastIndexOf('/');
  const addressText = slash < 0 ? text : text.slice(0, slash);
  const parsed = parseAddress(addressText);
  const prefix = slash < 0 ? parsed.bits : Number(text.slice(slash + 1));
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > parsed.bits)
    throw new Error(`Invalid CIDR prefix: ${text}`);
  if (parsed.family === 6) {
    const mapped = mappedV4(parsed.value);
    if (mapped !== null && prefix >= 96) return { family: 4, value: mapped, bits: prefix - 96 };
  }
  return { family: parsed.family, value: parsed.value, bits: prefix };
}

function matches(address: Parsed, rule: Rule): boolean {
  if (address.family !== rule.family) return false;
  const shift = BigInt(address.bits - rule.bits);
  return shift < 0n ? false : address.value >> shift === rule.value >> shift;
}

function compressV6(value: bigint): string {
  const groups = Array.from({ length: 8 }, (_, i) =>
    Number((value >> BigInt((7 - i) * 16)) & 0xffffn).toString(16)
  );
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== '0') {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === '0') j++;
    if (j - i > bestLen && j - i > 1) {
      bestStart = i;
      bestLen = j - i;
    }
    i = j;
  }
  if (bestStart < 0) return groups.join(':');
  return `${groups.slice(0, bestStart).join(':') || ''}::${groups.slice(bestStart + bestLen).join(':') || ''}`;
}

export function normalizePeerAddress(address: string): string {
  const parsed = parseAddress(address);
  const mapped = parsed.family === 6 ? mappedV4(parsed.value) : null;
  if (mapped !== null)
    return [
      Number(mapped >> 24n),
      Number((mapped >> 16n) & 255n),
      Number((mapped >> 8n) & 255n),
      Number(mapped & 255n),
    ].join('.');
  return parsed.family === 4
    ? [
        Number(parsed.value >> 24n),
        Number((parsed.value >> 16n) & 255n),
        Number((parsed.value >> 8n) & 255n),
        Number(parsed.value & 255n),
      ].join('.')
    : compressV6(parsed.value);
}

export function createPeerPolicy(
  cidrs: readonly string[] = DEFAULT_DENIED_PEER_CIDRS
): (address: string) => boolean {
  const set = new PeerDenySet({ cidrs, denySelf: false });
  return (address: string) => set.has(address);
}

function matchesAny(rules: readonly Rule[], address: Parsed): boolean {
  if (rules.some((rule) => matches(address, rule))) return true;
  const mapped = address.family === 6 ? mappedV4(address.value) : null;
  return (
    mapped !== null && rules.some((rule) => matches({ family: 4, value: mapped, bits: 32 }, rule))
  );
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
    const key = normalizePeerAddress(address);
    return key === '0.0.0.0' || key === '::' ? null : key;
  } catch {
    return null;
  }
}

export class PeerDenySet {
  private readonly rules: Rule[];
  private readonly denySelf: boolean;
  private readonly listInterfaces: InterfaceLister;
  private self = new Set<string>();

  constructor(opts: PeerDenySetOptions = {}) {
    this.rules = (opts.cidrs ?? DEFAULT_DENIED_PEER_CIDRS).map(parseRule);
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
    if (this.self.has(normalizePeerAddress(address))) return true;
    return matchesAny(this.rules, parseAddress(address));
  }
}
