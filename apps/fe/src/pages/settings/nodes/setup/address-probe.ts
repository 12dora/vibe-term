// 地址端口探测：Hub / 中继架在高位端口上时，用户手里往往只有一个不带端口的域名。
//
// 浏览器不跨域拨 Hub / 中继（`/api/relay/health` 没有 CORS，HTTPS 页面也拨不动 http 候选），
// 探测一律由本机网关完成，这里只管界面侧的状态机：在途提示、结果回填、过期结果丢弃。
// 显式端口永远不动——用户写了什么就用什么。

import { createStateStore } from '@/node/create-polling-store';
import type { ApiClient } from '@vibeterm/api-client';
import { SetupApi } from '@vibeterm/api-client/local/setup-api';
import type { SetupPrecheckKind } from '@vibeterm/api-client/local/types';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { isLocalHostname } from './validation';

/**
 * 只拆 authority，不重建整条地址：`new URL()` 会补路径、吞默认端口、改大小写，
 * 而这里要的是「除端口以外一个字节都不变」。
 */
const ADDRESS_RE =
  /^(?<scheme>[a-zA-Z][a-zA-Z0-9+.-]*:\/\/)?(?<userinfo>[^/?#@]*@)?(?<host>\[[^\]]*\]|[^/?#:]*)(?::(?<port>\d*))?(?<rest>[/?#].*)?$/;

export interface AddressParts {
  scheme: string;
  userinfo: string;
  host: string;
  port: number | null;
  rest: string;
}

export function splitAddress(raw: string): AddressParts | null {
  const groups = ADDRESS_RE.exec(raw.trim())?.groups;
  const host = groups?.host ?? '';
  if (!groups || !host) return null;
  const port = groups.port ?? '';
  return {
    scheme: groups.scheme ?? '',
    userinfo: groups.userinfo ?? '',
    host,
    port: port ? Number(port) : null,
    rest: groups.rest ?? '',
  };
}

export function formatAddress(parts: AddressParts): string {
  const port = parts.port === null ? '' : `:${parts.port}`;
  return `${parts.scheme}${parts.userinfo}${parts.host}${port}${parts.rest}`;
}

export function readAddressPort(raw: string): number | null {
  return splitAddress(raw)?.port ?? null;
}

/** 只改写端口一段，其余原样保留；地址还拆不开时原样返回。 */
export function replaceAddressPort(raw: string, port: number | null): string {
  const parts = splitAddress(raw);
  if (!parts) return raw;
  return formatAddress({ ...parts, port });
}

/** 协议的默认端口：探到它等于地址不用改。 */
function defaultPortOf(raw: string): number {
  return splitAddress(raw)?.scheme.toLowerCase() === 'http://' ? 80 : 443;
}

/** 只有「拆得开、没写端口、不是回环」的地址才值得探。 */
export function shouldProbeAddress(raw: string): boolean {
  const parts = splitAddress(raw);
  if (!parts || parts.port !== null) return false;
  return !isLocalHostname(parts.host);
}

export interface AddressProbeOutcome {
  /** 探通的地址；探不通为 `null`。 */
  url: string | null;
  /** 后端确实探测过；旧网关不给结论时为 `false`，界面保持沉默。 */
  probed: boolean;
}

export type AddressProbe = (url: string) => Promise<AddressProbeOutcome>;

export type AddressProbePhase = 'idle' | 'probing' | 'resolved' | 'failed';

export interface AddressProbeState {
  phase: AddressProbePhase;
  /** `resolved` 时的端口。 */
  port: number | null;
}

export interface AddressProbeCore {
  getState: () => AddressProbeState;
  subscribe: (listener: () => void) => () => void;
  /** 探一次；返回应当写回输入框的地址，无须改写时为 `null`。 */
  run: (raw: string, probe: AddressProbe) => Promise<string | null>;
  /** 地址被改动或组件卸载：结论作废，在途结果一并丢弃。 */
  reset: () => void;
}

const IDLE: AddressProbeState = { phase: 'idle', port: null };

export function createAddressProbeCore(): AddressProbeCore {
  const store = createStateStore<AddressProbeState>(IDLE);
  // 每次 run / reset 都换一张票：迟到的结果对不上票就丢掉。
  let ticket = 0;

  const run = async (raw: string, probe: AddressProbe): Promise<string | null> => {
    if (!shouldProbeAddress(raw)) {
      store.set(IDLE);
      return null;
    }
    const mine = ++ticket;
    store.set({ phase: 'probing', port: null });
    let outcome: AddressProbeOutcome;
    try {
      outcome = await probe(raw.trim());
    } catch {
      outcome = { url: null, probed: true };
    }
    if (mine !== ticket) return null;
    return settle(store, outcome);
  };

  return {
    getState: store.get,
    subscribe: store.subscribe,
    run,
    reset: () => {
      ticket += 1;
      store.set(IDLE);
    },
  };
}

function settle(
  store: { set: (state: AddressProbeState) => void },
  outcome: AddressProbeOutcome
): string | null {
  if (!outcome.probed) {
    store.set(IDLE);
    return null;
  }
  if (!outcome.url) {
    store.set({ phase: 'failed', port: null });
    return null;
  }
  const port = readAddressPort(outcome.url);
  // 默认端口直接通：地址不用改，也没什么可说的。
  if (port === null || port === defaultPortOf(outcome.url)) {
    store.set(IDLE);
    return null;
  }
  store.set({ phase: 'resolved', port });
  return outcome.url;
}

export interface AddressProbeHandle extends AddressProbeState {
  run: (raw: string, probe: AddressProbe) => Promise<string | null>;
  reset: () => void;
}

export function useAddressProbe(): AddressProbeHandle {
  const core = useMemo(createAddressProbeCore, []);
  const state = useSyncExternalStore(core.subscribe, core.getState, core.getState);
  // 卸载也算作废：在途探测回来时不要再往已经消失的表单里写地址。
  useEffect(() => core.reset, [core]);
  return { ...state, run: core.run, reset: core.reset };
}

/**
 * 向导只有 `/api/setup/precheck` 可用：standalone 实例没有 node-session，够不到 `/api/mesh/relay/*`。
 * `kind` 必须如实传：Hub 与中继共用一套网关端口，只看 `/healthz` 的话，443 被封时
 * 另一台非中继实例可能先答话而抢走候选端口。
 */
export function precheckProbe(client: ApiClient, kind: SetupPrecheckKind): AddressProbe {
  return async (url) => {
    const data = await new SetupApi(client).precheck(url, kind);
    if (data.probed !== true) return { url: null, probed: false };
    return { url: typeof data.resolvedUrl === 'string' ? data.resolvedUrl : null, probed: true };
  };
}
