// `VIBETERM_TRUST_PROXY` 与 `VIBETERM_CLIENT_IP_HEADER` 这一对键的唯一写入规则，隧道开关与
// TLS 外部模式共用。隧道写入的 `cf-connecting-ip` 只由本机制删除；用户自己设的其它值不动。

import { DEFAULT_CLIENT_IP_HEADER } from '../mesh/client-ip-header';

export type HostEnv = Record<string, string>;
export type HostEnvUpdate = (env: HostEnv) => HostEnv;
export type PatchHostEnv = (update: HostEnvUpdate) => Promise<void>;
export type ReadHostEnv = () => Promise<HostEnv | null>;

/** tunnel：只经 cloudflared 进来；proxy：本机反代（TLS 外部模式）；off：不信任代理。 */
export type TrustProxyEnvMode = 'tunnel' | 'proxy' | 'off';

export type TrustProxySetting = { trustProxy: boolean; clientIpHeader: string };

const TUNNEL_CLIENT_IP_HEADER = 'cf-connecting-ip';

export function patchTrustProxyEnv(env: HostEnv, mode: TrustProxyEnvMode): HostEnv {
  const { VIBETERM_CLIENT_IP_HEADER: header, ...rest } = env;
  const next: HostEnv = { ...rest, VIBETERM_TRUST_PROXY: mode === 'off' ? 'false' : 'true' };
  if (mode === 'tunnel') return { ...next, VIBETERM_CLIENT_IP_HEADER: TUNNEL_CLIENT_IP_HEADER };
  const tunnelWritten = header?.trim().toLowerCase() === TUNNEL_CLIENT_IP_HEADER;
  return header === undefined || tunnelWritten
    ? next
    : { ...next, VIBETERM_CLIENT_IP_HEADER: header };
}

export function parseTrustProxyFlag(raw: string | undefined): boolean | null {
  if (raw === undefined) return null;
  const value = raw.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

/** app.env 里配置的那一对值；文件或 `VIBETERM_TRUST_PROXY` 缺失时退回 `fallback`（当前进程值）。 */
export function trustProxySettingFromEnv(
  env: HostEnv | null,
  fallback: TrustProxySetting
): TrustProxySetting {
  const trustProxy = parseTrustProxyFlag(env?.VIBETERM_TRUST_PROXY);
  if (!env || trustProxy === null) return fallback;
  const header = env.VIBETERM_CLIENT_IP_HEADER?.trim().toLowerCase();
  return { trustProxy, clientIpHeader: header || DEFAULT_CLIENT_IP_HEADER };
}

export function trustProxyRestartRequired(
  running: TrustProxySetting,
  configured: TrustProxySetting
): boolean {
  return (
    running.trustProxy !== configured.trustProxy ||
    running.clientIpHeader !== configured.clientIpHeader
  );
}

/** 隧道管理器持有的「运行值 vs app.env 配置值」；两者任一键不同即需要重启。 */
export class TrustProxyEnvState {
  patch: PatchHostEnv | null;
  read: ReadHostEnv | null;
  private configured: TrustProxySetting;

  constructor(
    private readonly running: TrustProxySetting,
    opts: {
      configuredTrustProxy?: boolean;
      patchHostEnv?: PatchHostEnv | null;
      readHostEnv?: ReadHostEnv | null;
    }
  ) {
    this.patch = opts.patchHostEnv ?? null;
    this.read = opts.readHostEnv ?? null;
    this.configured = { ...running, trustProxy: opts.configuredTrustProxy ?? running.trustProxy };
  }

  async refresh(): Promise<void> {
    if (this.read) this.configured = trustProxySettingFromEnv(await this.read(), this.running);
  }

  /** 隧道开关；未注入写入器时返回 false。 */
  async set(trustProxy: boolean): Promise<boolean> {
    if (!this.patch) return false;
    let written: HostEnv | null = null;
    await this.patch((env) => {
      written = patchTrustProxyEnv(env, trustProxy ? 'tunnel' : 'off');
      return written;
    });
    this.configured = trustProxySettingFromEnv(written, this.running);
    return true;
  }

  view(): { trustProxy: boolean; configuredTrustProxy: boolean; restartRequired: boolean } {
    return {
      trustProxy: this.running.trustProxy,
      configuredTrustProxy: this.configured.trustProxy,
      restartRequired: trustProxyRestartRequired(this.running, this.configured),
    };
  }
}
