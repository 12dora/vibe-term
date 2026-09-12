import dgram from 'node:dgram';
import { isIP } from 'node:net';
import os from 'node:os';

const UDP_PROBE_HOST = '1.1.1.1';
const UDP_PROBE_PORT = 53;

export type LocalAddressDeps = {
  connectUdp?: (host: string, port: number) => Promise<string | null>;
  listInterfaces?: () => NodeJS.Dict<os.NetworkInterfaceInfo[]>;
  warn?: (line: string) => void;
};

/** `auto`（缺省）| `0.0.0.0` | IPv4 字面量。 */
export function parseTurnBindHost(raw: string | undefined): string {
  const value = raw?.trim() ?? '';
  if (!value || value.toLowerCase() === 'auto') return 'auto';
  if (value === '0.0.0.0') return '0.0.0.0';
  if (isIP(value) === 4) return value;
  throw new Error('VIBETERM_TURN_BIND_HOST must be auto, 0.0.0.0, or an IPv4 address');
}

export async function resolveTurnListenHost(
  bindHost: string,
  deps: LocalAddressDeps = {}
): Promise<string> {
  if (bindHost === 'auto') return discoverPrimaryOutboundIPv4(deps);
  return bindHost;
}

export async function discoverPrimaryOutboundIPv4(deps: LocalAddressDeps = {}): Promise<string> {
  const connect = deps.connectUdp ?? connectUdpProbe;
  const routed = await connect(UDP_PROBE_HOST, UDP_PROBE_PORT);
  if (routed && isUsableOutboundIPv4(routed)) return routed;
  const fromIfaces = firstNonInternalIPv4((deps.listInterfaces ?? os.networkInterfaces)());
  if (fromIfaces) return fromIfaces;
  deps.warn?.('turn: no primary outbound IPv4; binding 0.0.0.0');
  return '0.0.0.0';
}

function firstNonInternalIPv4(ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>): string | null {
  for (const addrs of Object.values(ifaces)) {
    if (!addrs) continue;
    for (const info of addrs) {
      if (info.internal) continue;
      if (!isIpv4Family(info.family)) continue;
      if (!isUsableOutboundIPv4(info.address)) continue;
      return info.address;
    }
  }
  return null;
}

function isIpv4Family(family: string | number): boolean {
  return family === 'IPv4' || family === 4;
}

/** 丢弃未指定、回环、以及代理 TUN 的 fake-IP（198.18/15），避免 auto 绑到不可达地址。 */
function isUsableOutboundIPv4(ip: string): boolean {
  if (isIP(ip) !== 4) return false;
  if (ip === '0.0.0.0') return false;
  const octets = ip.split('.');
  const a = Number(octets[0]);
  const b = Number(octets[1]);
  if (a === 127) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  return true;
}

function connectUdpProbe(host: string, port: number): Promise<string | null> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    socket.unref();
    let settled = false;
    const done = (addr: string | null): void => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      try {
        socket.close();
      } catch {
        // already closed
      }
      resolve(addr);
    };
    socket.once('error', () => done(null));
    try {
      socket.connect(port, host, () => {
        try {
          done(socket.address().address);
        } catch {
          done(null);
        }
      });
    } catch {
      done(null);
    }
  });
}
