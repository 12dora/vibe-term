// 「接入更多设备」面板要展示的本机地址线索：监听地址 + 局域网 IPv4 候选。
// 隧道地址由前端从 tunnel status 取；中继入口在这里给——它要探测结论，前端拿不到。

import { networkInterfaces } from 'node:os';
import type { AccessAddressesResponse, LanAddressCandidate } from '@vibeterm/shared';
import { config } from '../config';
import { collectLanCandidates, readDefaultIface } from './lan-interfaces';

type InterfaceMap = ReturnType<typeof networkInterfaces>;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

export function isLoopbackBindHost(bindHost: string): boolean {
  const host = bindHost.replace(/^\[|\]$/g, '');
  return LOOPBACK_HOSTS.has(host) || host.startsWith('127.');
}

export interface AccessAddressesDeps {
  bindHost?: string;
  port?: number;
  interfaces?: () => InterfaceMap;
  /** 默认路由网卡；不传时现读（自带 1 min 缓存） */
  defaultIface?: () => string | null;
  /** 中继入口 `<relay>/n/<self>`；探不通或不是中继上联时为 null */
  relayAccessUrl?: () => string | null;
}

/** 候选 IP 列表，等价于 `collectLanCandidates(...).map((c) => c.ip)`。 */
export function collectLanAddresses(
  interfaces: InterfaceMap,
  options: { defaultIface?: string | null; bindHost?: string | null } = {}
): string[] {
  return collectLanCandidates(interfaces, options).map((candidate) => candidate.ip);
}

function readRelayAccessUrl(deps: AccessAddressesDeps): string | null {
  if (!deps.relayAccessUrl) return null;
  try {
    return deps.relayAccessUrl();
  } catch {
    return null;
  }
}

/** 中继入口探测的等待上限：首次打开面板时探测刚发出，多等一小会儿好过让公网槽空着。 */
export const RELAY_ENTRY_WAIT_MS = 300;

export interface AsyncAccessAddressesDeps extends AccessAddressesDeps {
  /** 等在途的中继入口探测落地（不自带超时，上限由本模块把） */
  awaitRelayProbe?: () => Promise<void>;
  relayProbeWaitMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });
}

/**
 * 与 `getAccessAddresses` 相同，但中继入口未探通时会等在途探测一小会儿。
 * 首次打开面板时探测才刚发出，同步读一定是 null；前端查询 60 s 不刷新，等不到就永远看不到中继入口。
 */
export async function getAccessAddressesAsync(
  deps: AsyncAccessAddressesDeps = {}
): Promise<AccessAddressesResponse> {
  const res = getAccessAddresses(deps);
  if (res.relayAccessUrl || !deps.awaitRelayProbe) return res;
  try {
    await Promise.race([
      deps.awaitRelayProbe(),
      sleep(deps.relayProbeWaitMs ?? RELAY_ENTRY_WAIT_MS),
    ]);
  } catch {
    return res;
  }
  return { ...res, relayAccessUrl: readRelayAccessUrl(deps) };
}

export function getAccessAddresses(deps: AccessAddressesDeps = {}): AccessAddressesResponse {
  const bindHost = deps.bindHost ?? config.bindHost;
  const port = deps.port ?? config.port;
  const loopbackOnly = isLoopbackBindHost(bindHost);
  const lanCandidates: LanAddressCandidate[] = loopbackOnly
    ? []
    : collectLanCandidates((deps.interfaces ?? networkInterfaces)(), {
        defaultIface: (deps.defaultIface ?? readDefaultIface)(),
        bindHost,
      });
  return {
    bindHost,
    port,
    loopbackOnly,
    lanAddresses: lanCandidates.map((candidate) => candidate.ip),
    lanCandidates,
    relayAccessUrl: readRelayAccessUrl(deps),
  };
}
