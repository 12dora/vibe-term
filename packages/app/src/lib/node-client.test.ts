import { describe, expect, test } from 'bun:test';
import type { FetchLike } from './fetch-like';
import {
  cliPasswordLoginBlockedByPasskey,
  fetchAuthMode,
  isNetworkFetchError,
  parseSecondFactorPolicy,
} from './node-client';

describe('fetchAuthMode', () => {
  test('parses passkeySecondFactor as boolean and defaults to false', async () => {
    const fetcher: FetchLike = async () =>
      Response.json({
        mode: 'mesh',
        nodeId: 'self',
        uid: 'u1',
        totpEnabled: false,
        passkeySecondFactor: true,
      });
    const on = await fetchAuthMode('https://node.example', fetcher);
    expect(on.passkeySecondFactor).toBe(true);

    const off = await fetchAuthMode('https://node.example', async () =>
      Response.json({ mode: 'mesh', nodeId: 'self', uid: 'u1', totpEnabled: false })
    );
    expect(off.passkeySecondFactor).toBe(false);
    expect(off.secondFactorPolicy).toBeNull();
  });
});

describe('cliPasswordLoginBlockedByPasskey', () => {
  test('aborts only for passkey policy; old nodes fall back to passkey && !totp', () => {
    expect(parseSecondFactorPolicy('either')).toBe('either');
    expect(parseSecondFactorPolicy('nope')).toBeNull();
    expect(
      cliPasswordLoginBlockedByPasskey({
        secondFactorPolicy: 'passkey',
        passkeySecondFactor: true,
        totpEnabled: true,
      })
    ).toBe(true);
  });
});

describe('isNetworkFetchError', () => {
  test('treats generic errors as network and skips mapped HTTP failures', () => {
    expect(isNetworkFetchError(new Error('ECONNRESET'))).toBe(true);
    expect(isNetworkFetchError(new Error('redeem failed: HTTP 400'))).toBe(false);
    expect(isNetworkFetchError(new Error('auth mode failed: HTTP 500'))).toBe(false);
    expect(isNetworkFetchError('nope')).toBe(false);
  });
});
