import { promises as dnsPromises } from 'node:dns';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { eq } from 'drizzle-orm';
import { config } from '../config';
import { getDb } from '../db/client';
import { tlsConfig } from '../db/schema';
import { DEFAULT_TLS_PORT, TLS_CONFIG_ROW_ID } from '../tls/types';
import { PortMapError } from './types';

export type TargetForbiddenReason = 'self_service' | 'link_local' | 'metadata' | 'invalid_address';

export type TargetVerdict = { allowed: true } | { allowed: false; reason: TargetForbiddenReason };

export type TargetResolver = (host: string) => Promise<string[]>;

export type TargetPolicyOptions = {
  resolver?: TargetResolver;
  localAddresses?: () => readonly string[];
  selfPorts?: () => readonly number[];
};

type ParsedIp = { family: 4; bytes: number[] } | { family: 6; words: number[] };

/** 本机 HTTPS 监听端口也不能被映射占用，否则下次重启时监听会失败。 */
function tlsListenPort(): number | null {
  try {
    const row = getDb()
      .select({ tlsPort: tlsConfig.tlsPort })
      .from(tlsConfig)
      .where(eq(tlsConfig.id, TLS_CONFIG_ROW_ID))
      .get();
    return row?.tlsPort ?? DEFAULT_TLS_PORT;
  } catch {
    return DEFAULT_TLS_PORT;
  }
}

/** VibeTerm 自身占用的端口：网关、peer、HTTPS、TURN。既不能被映射监听占用，也不能作为放行目标。 */
export function selfServicePorts(): number[] {
  const ports = [config.port, config.peerPort];
  const tls = tlsListenPort();
  if (tls !== null) ports.push(tls);
  if (config.turnPort !== 0) ports.push(config.turnPort);
  return ports.filter((port) => port > 0);
}

export function localInterfaceAddresses(): string[] {
  const addresses: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) addresses.push(entry.address);
  }
  return addresses;
}

async function systemResolve(host: string): Promise<string[]> {
  const entries = await dnsPromises.lookup(host, { all: true });
  return entries.map((entry) => entry.address);
}

function parseIpv4(text: string): number[] | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  const bytes: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    bytes.push(value);
  }
  return bytes;
}

function ipv4TailWords(group: string): [number, number] | null {
  const v4 = parseIpv4(group);
  if (!v4) return null;
  return [((v4[0] ?? 0) << 8) | (v4[1] ?? 0), ((v4[2] ?? 0) << 8) | (v4[3] ?? 0)];
}

function parseIpv6Groups(text: string, allowV4Tail: boolean): number[] | null {
  if (text === '') return [];
  const groups = text.split(':');
  const words: number[] = [];
  for (let i = 0; i < groups.length; i += 1) {
    const group = groups[i] ?? '';
    if (allowV4Tail && i === groups.length - 1 && group.includes('.')) {
      const v4Words = ipv4TailWords(group);
      if (!v4Words) return null;
      words.push(v4Words[0], v4Words[1]);
      continue;
    }
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    words.push(Number.parseInt(group, 16));
  }
  return words;
}

function parseIpv6(text: string): number[] | null {
  const zone = text.indexOf('%');
  const raw = zone >= 0 ? text.slice(0, zone) : text;
  const gap = raw.indexOf('::');
  if (gap < 0) {
    const words = parseIpv6Groups(raw, true);
    return words && words.length === 8 ? words : null;
  }
  if (raw.indexOf('::', gap + 1) >= 0) return null;
  const head = parseIpv6Groups(raw.slice(0, gap), false);
  const tail = parseIpv6Groups(raw.slice(gap + 2), true);
  if (!head || !tail || head.length + tail.length > 7) return null;
  return [...head, ...new Array<number>(8 - head.length - tail.length).fill(0), ...tail];
}

/** IPv4 映射地址（::ffff:a.b.c.d）按 IPv4 处理。 */
function parseIp(address: string): ParsedIp | null {
  if (!address.includes(':')) {
    const bytes = parseIpv4(address);
    return bytes ? { family: 4, bytes } : null;
  }
  const words = parseIpv6(address);
  if (!words) return null;
  const mapped = words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff;
  if (mapped) {
    const hi = words[6] ?? 0;
    const lo = words[7] ?? 0;
    return { family: 4, bytes: [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff] };
  }
  return { family: 6, words };
}

function ipKey(ip: ParsedIp): string {
  return ip.family === 4 ? ip.bytes.join('.') : ip.words.map((word) => word.toString(16)).join(':');
}

function isLinkLocal(ip: ParsedIp): boolean {
  if (ip.family === 4) return ip.bytes[0] === 169 && ip.bytes[1] === 254;
  return ((ip.words[0] ?? 0) & 0xffc0) === 0xfe80;
}

function isMetadata(ip: ParsedIp): boolean {
  if (ip.family === 4) return ip.bytes.join('.') === '100.100.100.200';
  return ipKey(ip) === 'fd00:ec2:0:0:0:0:0:254';
}

function isLoopbackOrUnspecified(ip: ParsedIp): boolean {
  if (ip.family === 4) return ip.bytes[0] === 127 || ip.bytes[0] === 0;
  const leadingZero = ip.words.slice(0, 7).every((word) => word === 0);
  return leadingZero && (ip.words[7] === 0 || ip.words[7] === 1);
}

export function classifyTargetAddress(
  address: string,
  port: number,
  selfPorts: readonly number[],
  localAddresses: readonly string[]
): TargetVerdict {
  const ip = parseIp(address);
  if (!ip) return { allowed: false, reason: 'invalid_address' };
  if (isLinkLocal(ip)) return { allowed: false, reason: 'link_local' };
  if (isMetadata(ip)) return { allowed: false, reason: 'metadata' };
  if (!selfPorts.includes(port)) return { allowed: true };
  if (isLoopbackOrUnspecified(ip)) return { allowed: false, reason: 'self_service' };
  const key = ipKey(ip);
  for (const local of localAddresses) {
    const parsed = parseIp(local);
    if (parsed && ipKey(parsed) === key) return { allowed: false, reason: 'self_service' };
  }
  return { allowed: true };
}

function isLocalhostName(host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, '');
  return name === 'localhost' || name.endsWith('.localhost');
}

/**
 * 解析目标并逐个检查全部地址，任一被禁即整体拒绝；返回值就是要直连的地址，
 * 调用方不得再按主机名解析，避免 DNS 重绑定绕过检查。
 */
export async function resolveAllowedTargets(
  host: string,
  port: number,
  opts: TargetPolicyOptions = {}
): Promise<string[]> {
  const addresses = isIP(host) ? [host] : await (opts.resolver ?? systemResolve)(host);
  if (addresses.length === 0) throw new Error('portmap-target-unresolved');
  const checked = isLocalhostName(host) ? [...addresses, '127.0.0.1', '::1'] : addresses;
  const selfPorts = (opts.selfPorts ?? selfServicePorts)();
  const localAddresses = (opts.localAddresses ?? localInterfaceAddresses)();
  for (const address of checked) {
    const verdict = classifyTargetAddress(address, port, selfPorts, localAddresses);
    if (!verdict.allowed) {
      throw new PortMapError(
        'target_forbidden',
        `${host}:${port} is not an allowed port map target (${verdict.reason})`
      );
    }
  }
  return addresses;
}

export async function resolveAllowedTarget(
  host: string,
  port: number,
  opts: TargetPolicyOptions = {}
): Promise<string> {
  const [first] = await resolveAllowedTargets(host, port, opts);
  if (first === undefined) throw new Error('portmap-target-unresolved');
  return first;
}

/** 只拦被禁的目标；解析失败放过，拨号时还会再查一次。 */
export async function assertTargetAllowed(
  host: string,
  port: number,
  opts: TargetPolicyOptions = {}
): Promise<void> {
  try {
    await resolveAllowedTargets(host, port, opts);
  } catch (err) {
    if (isTargetForbiddenError(err)) throw err;
  }
}

export function isTargetForbiddenError(err: unknown): boolean {
  return err instanceof PortMapError && err.code === 'target_forbidden';
}
