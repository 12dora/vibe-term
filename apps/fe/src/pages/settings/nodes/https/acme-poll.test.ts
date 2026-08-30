// ACME 轮询节奏：只有签发在途时才轮询。

import { describe, expect, test } from 'bun:test';
import type {
  TlsAcmeState,
  TlsAcmeStatus,
  TlsStatusResponse,
} from '@tmex/api-client/local/tls-types';
import { ACME_POLL_INTERVAL_MS, acmePollInterval } from './tls-form';

function statusWithAcme(state: TlsAcmeState | null): TlsStatusResponse {
  const acme: TlsAcmeStatus | null =
    state === null
      ? null
      : {
          email: 'a@example.com',
          domain: 'example.com',
          challenge: 'http-01',
          staging: false,
          status: state,
          lastError: null,
          lastAttemptAt: null,
          nextRenewAt: null,
          hasCloudflareToken: false,
        };
  return { mode: 'acme', acme } as TlsStatusResponse;
}

describe('acmePollInterval', () => {
  test('pending 期间每 3 秒拉一次', () => {
    expect(acmePollInterval(statusWithAcme('pending'))).toBe(ACME_POLL_INTERVAL_MS);
  });

  test('签发结束或未开始都不轮询', () => {
    expect(acmePollInterval(statusWithAcme('ok'))).toBe(false);
    expect(acmePollInterval(statusWithAcme('error'))).toBe(false);
    expect(acmePollInterval(statusWithAcme('idle'))).toBe(false);
    expect(acmePollInterval(statusWithAcme(null))).toBe(false);
  });

  test('还没拿到状态时不轮询', () => {
    expect(acmePollInterval(null)).toBe(false);
    expect(acmePollInterval(undefined)).toBe(false);
  });
});
