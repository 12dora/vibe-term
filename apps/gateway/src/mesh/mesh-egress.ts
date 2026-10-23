// mesh / 中继 / 对端出站：默认直连；`meshProxy=system` 时仅公网走环境代理。
// 私网字面量与 NO_PROXY 一律直连。策略读 KV 缓存，改设置后新连接立即采用，已建立链路不拆。

import { DEFAULT_MESH_PROXY_MODE, type MeshProxyMode } from '@vibeterm/shared/net';
import { type MeshFetchInit, nodeMeshFetch } from './mesh-egress-node-fetch';
import { shouldBypassProxy } from './mesh-egress-noproxy';
import { httpProxyUrlFor } from './mesh-egress-proxy';
import { getMeshProxyStore } from './mesh-proxy-store';

export type { MeshFetchInit, MeshFetchTls } from './mesh-egress-node-fetch';

export type MeshFetch = (input: RequestInfo | URL, init?: MeshFetchInit) => Promise<Response>;

let testFetch: MeshFetch | null = null;
let testPolicy: MeshProxyMode | null = null;

export function installMeshFetchForTests(fn: MeshFetch | null): void {
  testFetch = fn;
}

export function setMeshProxyPolicyForTests(mode: MeshProxyMode | null): void {
  testPolicy = mode;
}

export function meshProxyPolicy(): MeshProxyMode {
  if (testPolicy !== null) return testPolicy;
  try {
    return getMeshProxyStore().get();
  } catch {
    return DEFAULT_MESH_PROXY_MODE;
  }
}

export async function meshFetch(input: RequestInfo | URL, init?: MeshFetchInit): Promise<Response> {
  if (testFetch) return testFetch(input, init);
  if (usesEnvProxy(input)) return fetch(input as RequestInfo, init as RequestInit);
  return nodeMeshFetch(input, init);
}

function usesEnvProxy(input: RequestInfo | URL): boolean {
  if (meshProxyPolicy() !== 'system') return false;
  const url = inputUrl(input);
  return !url || !shouldBypassProxy(url);
}

function inputUrl(input: RequestInfo | URL): URL | null {
  try {
    if (input instanceof URL) return input;
    if (typeof input === 'string') return new URL(input);
    return new URL(input.url);
  } catch {
    return null;
  }
}

/** 直连省略 proxy；system 且环境有 http(s) 代理时才带上。 */
export function resolveMeshWebSocketProxy(url: string): string | null {
  if (meshProxyPolicy() !== 'system') return null;
  try {
    return httpProxyUrlFor(new URL(url));
  } catch {
    return null;
  }
}

export function meshWebSocket(
  url: string,
  protocolsOrOpts?: string | string[] | Record<string, unknown>
): WebSocket {
  const opts = asWsOpts(protocolsOrOpts);
  const proxy = resolveMeshWebSocketProxy(url);
  if (!proxy) {
    return opts ? new WebSocket(url, opts as never) : new WebSocket(url);
  }
  return new WebSocket(url, { ...(opts ?? {}), proxy } as never);
}

function asWsOpts(arg: unknown): Record<string, unknown> | undefined {
  if (arg == null) return undefined;
  if (typeof arg === 'string') return { protocol: arg };
  if (Array.isArray(arg)) return { protocols: arg };
  if (typeof arg === 'object') return arg as Record<string, unknown>;
  return undefined;
}
