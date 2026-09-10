// TLS 信任设置：`--ca <pem>` 追加信任锚，`--insecure` 不校验服务端证书。
//
// **绝不动 `NODE_TLS_REJECT_UNAUTHORIZED`**——那是整个进程的全局开关，还会被子进程继承。
// 两个运行时各有一条显式通道：
//   Bun  每个请求的 `init.tls`（`{ca, rejectUnauthorized}`），fetch 与 ws 都认；
//   Node fetch 不吃 per-request TLS 选项，改用 `tls.setDefaultCACertificates()` 在**本进程**
//        内扩展默认信任库（Node ≥ 22.15 才有；更早的版本只能用 `NODE_EXTRA_CA_CERTS`）。
// ws 两个运行时都走 `tls.connect`，直接传 `{ca, rejectUnauthorized}` 即可。

import { readFileSync } from 'node:fs';
import * as nodeTls from 'node:tls';
import type { DetailedPeerCertificate } from 'node:tls';
import { CliError, NetworkError, UsageError } from './errors';

/**
 * `tls.getCACertificates()` / `setDefaultCACertificates()` 是 Node ≥ 22.15 的运行时 API，
 * 仓库里的 `@types/node` 还没有它们；Bun 只有前者。一律按「可能不存在」处理。
 */
interface TrustStoreApi {
  getCACertificates?: (kind?: string) => string[];
  setDefaultCACertificates?: (certs: readonly (string | Uint8Array)[]) => void;
}

const trustStore = nodeTls as unknown as TrustStoreApi;

export interface TlsSettings {
  /** `--ca` 读进来的 PEM 全文；未给为 null。 */
  ca: string | null;
  /** `--insecure`：不校验服务端证书。 */
  insecure: boolean;
}

export const DEFAULT_TLS: TlsSettings = { ca: null, insecure: false };

export interface TlsConnectOptions {
  ca?: string;
  rejectUnauthorized?: boolean;
}

const PEM_HEADER = '-----BEGIN CERTIFICATE-----';

export function loadTlsSettings(caFile: string | undefined, insecure: boolean): TlsSettings {
  if (!caFile) return { ca: null, insecure };
  let pem: string;
  try {
    pem = readFileSync(caFile, 'utf8');
  } catch (error) {
    throw new UsageError(
      `--ca cannot read ${caFile}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!pem.includes(PEM_HEADER)) {
    throw new UsageError(`--ca file is not a PEM certificate bundle: ${caFile}`);
  }
  return { ca: pem, insecure };
}

export function isTlsCustomized(settings: TlsSettings): boolean {
  return settings.ca !== null || settings.insecure;
}

/** ws / tls.connect 的选项（两个运行时通用）。 */
export function wsTlsOptions(settings: TlsSettings): TlsConnectOptions {
  const options: TlsConnectOptions = {};
  if (settings.ca) options.ca = settings.ca;
  if (settings.insecure) options.rejectUnauthorized = false;
  return options;
}

/** fetch 的 per-request TLS 选项：Bun 认，Node 忽略（由信任库那条路径兜底）。 */
export function fetchTlsInit(settings: TlsSettings): { tls?: TlsConnectOptions } {
  if (!isTlsCustomized(settings)) return {};
  return { tls: wsTlsOptions(settings) };
}

function runtimeIsBun(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';
}

function derToPem(der: Uint8Array): string {
  const base64 = Buffer.from(der).toString('base64');
  const lines = base64.match(/.{1,64}/g) ?? [];
  return `${PEM_HEADER}\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`;
}

/** SNI 不允许填 IP 字面量；裸 IP 的入口只能不带 servername 去连。 */
function sniName(hostname: string): string | undefined {
  const bare = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname;
  const isIp = /^[0-9.]+$/.test(bare) || bare.includes(':');
  return isIp ? undefined : hostname;
}

/** 把服务端出示的整条链取回来（`--insecure` 在 Node 上的落地方式）。 */
async function probePresentedChain(entry: URL): Promise<string[]> {
  const port = entry.port ? Number(entry.port) : 443;
  const servername = sniName(entry.hostname);
  return await new Promise<string[]>((resolve, reject) => {
    const socket = nodeTls.connect(
      {
        host: entry.hostname,
        port,
        rejectUnauthorized: false,
        ...(servername ? { servername } : {}),
      },
      () => {
        const chain: string[] = [];
        const seen = new Set<string>();
        let current: DetailedPeerCertificate | undefined = socket.getPeerCertificate(true);
        while (current?.raw && !seen.has(current.fingerprint256)) {
          seen.add(current.fingerprint256);
          chain.push(derToPem(current.raw));
          current = current.issuerCertificate;
        }
        socket.destroy();
        resolve(chain);
      }
    );
    socket.once('error', (error: Error) => reject(error));
  });
}

function requireTrustStoreApi(): void {
  if (typeof trustStore.setDefaultCACertificates === 'function') return;
  throw new CliError(
    'this Node build cannot install extra TLS trust anchors at runtime (needs node >= 22.15)',
    1,
    'restart the command with NODE_EXTRA_CA_CERTS=<pem-file>, or run it under bun'
  );
}

/**
 * 把 `--ca` / `--insecure` 落到本进程。
 *
 * Bun 上是空操作（每个请求自己带 TLS 选项）。Node 上扩展**本进程**的默认信任库：
 * `--ca` 直接加进去；`--insecure` 先连一次目标、把它出示的整条链当作信任锚装上（TOFU）。
 * 后者仍会校验主机名，因此证书 SAN 与访问地址不符时依旧失败——这是有意的，
 * 用 `--ca` 指定正确的 CA 才是长久做法。
 */
export async function prepareProcessTls(entry: string, settings: TlsSettings): Promise<void> {
  if (!isTlsCustomized(settings) || runtimeIsBun()) return;
  const url = new URL(entry);
  if (url.protocol !== 'https:') return;
  requireTrustStoreApi();

  const anchors = [...(trustStore.getCACertificates?.('default') ?? [])];
  if (settings.ca) anchors.push(settings.ca);
  if (settings.insecure) {
    try {
      anchors.push(...(await probePresentedChain(url)));
    } catch (error) {
      throw new NetworkError(
        `--insecure could not read the certificate presented by ${url.origin}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
  trustStore.setDefaultCACertificates?.(anchors);
}

/**
 * `mode.caFingerprint`（自签 CA 的 SPKI sha256）**未做钉扎**：Node 的 fetch 不把证书链交给
 * 调用方，只有 ws 那条路径拿得到，只钉一半反而给人一种全都钉住了的错觉。要严格校验请用
 * `--ca <该 CA 的 pem>`，那条路径由 TLS 栈本身完成验证。
 */
export const CA_FINGERPRINT_PINNING_SUPPORTED = false;
