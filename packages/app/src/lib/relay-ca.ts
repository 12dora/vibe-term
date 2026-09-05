import { HubTrustStore } from '../../../../apps/gateway/src/auth/hub-trust-store';
import type { AuthDb } from '../../../../apps/gateway/src/auth/types';
import { RELAY_REQUEST_TIMEOUT_MS } from '../commands/relay-shared';
import { errorMessage } from './error-message';
import type { FetchLike } from './fetch-like';
import { isNetworkFetchError } from './hub-client';
import { parseAndValidateCaPem, readBoundedResponseText } from './pem';

export type RelayCaErrorCode =
  | 'ca_unavailable'
  | 'ca_invalid'
  | 'ca_response_too_large'
  | 'ca_fingerprint_mismatch';

export class RelayCaError extends Error {
  readonly code: RelayCaErrorCode;
  /** 传输层失败可以换下一台中继；指纹不符/证书非法是明确拒绝，换一台也是同样的答案。 */
  readonly transport: boolean;

  constructor(code: RelayCaErrorCode, message: string, transport = false) {
    super(message);
    this.name = 'RelayCaError';
    this.code = code;
    this.transport = transport;
  }
}

/**
 * 自签中继的 CA：先用**不校验**的连接取 `/api/tls/ca.crt`，按 join 串里的指纹核对后才认。
 * 与 hub join 同一套流程（`fetchPinnedHubCa`），指纹不符一律拒绝，绝不退回系统 CA。
 */
export async function fetchPinnedRelayCa(input: {
  relayUrl: string;
  fingerprint: string;
  fetcher?: FetchLike;
  timeoutMs?: number;
}): Promise<string> {
  const fetcher = input.fetcher ?? fetch;
  const timeoutMs = input.timeoutMs ?? RELAY_REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetcher(`${input.relayUrl.replace(/\/+$/, '')}/api/tls/ca.crt`, {
        redirect: 'error',
        signal: controller.signal,
        tls: { rejectUnauthorized: false },
      });
    } catch (error) {
      const message = errorMessage(error);
      throw new RelayCaError(
        'ca_unavailable',
        `relay ca download failed: ${timedOut ? `timed out after ${timeoutMs}ms` : message}`,
        timedOut || isNetworkFetchError(error)
      );
    }
    if (!response.ok) {
      throw new RelayCaError('ca_unavailable', `relay ca download failed: HTTP ${response.status}`);
    }
    let raw: string;
    try {
      raw = await readBoundedResponseText(response);
    } catch (error) {
      const message = errorMessage(error);
      if (message === 'ca_response_too_large') {
        throw new RelayCaError('ca_response_too_large', 'relay ca response is too large');
      }
      throw new RelayCaError('ca_unavailable', `relay ca could not be read: ${message}`, true);
    }
    let parsed: Awaited<ReturnType<typeof parseAndValidateCaPem>>;
    try {
      parsed = await parseAndValidateCaPem(raw);
    } catch {
      throw new RelayCaError('ca_invalid', 'relay ca is not a valid CA certificate');
    }
    if (parsed.fingerprint !== input.fingerprint) {
      throw new RelayCaError(
        'ca_fingerprint_mismatch',
        'relay ca fingerprint does not match the join token'
      );
    }
    return parsed.canonicalPem;
  } finally {
    clearTimeout(timer);
  }
}

export function pinRelayCa(inner: FetchLike | undefined, pem: string): FetchLike {
  const fetcher = inner ?? fetch;
  return (url, init) => fetcher(url, { ...init, tls: { ca: [pem] } });
}

/**
 * 落到 `hub_trust`：`UplinkPool.spawn` 就是按候选 url 在这张表里取 pin 的，所以之后的
 * relay uplink 会自动用同一张 CA，不必再下载。
 */
export function storeRelayCaPin(
  db: AuthDb,
  input: { relayUrl: string; caPem: string; fingerprint: string }
): void {
  new HubTrustStore(db).put({
    hubUrl: input.relayUrl,
    caPem: input.caPem,
    fingerprint: input.fingerprint,
  });
}
