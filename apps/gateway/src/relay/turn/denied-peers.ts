import { isIP } from 'node:net';

export const DEFAULT_DENIED_PEER_CIDRS = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '198.18.0.0/15',
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
  const rules = cidrs.map(parseRule);
  return (address: string) => {
    const parsed = parseAddress(address);
    if (rules.some((rule) => matches(parsed, rule))) return true;
    const mapped = parsed.family === 6 ? mappedV4(parsed.value) : null;
    return (
      mapped !== null && rules.some((rule) => matches({ family: 4, value: mapped, bits: 32 }, rule))
    );
  };
}
