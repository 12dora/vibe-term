import { describe, expect, test } from 'bun:test';
import { buildKeyLogRecord, encodeKeyLogRecord, randomBytes } from '../../../shared/src/auth';
import { RelayApiError } from '../commands/relay-shared';
import type { FetchLike } from './fetch-like';
import {
  RELAY_JOIN_APPEND_ATTEMPTS,
  appendAdmitThenMeta,
  appendAdmitThenMetaRetrying,
  isRelaySeqMismatch,
} from './relay-password-join-append';

const rec = {
  bytes: encodeKeyLogRecord(
    buildKeyLogRecord({ seq: 0n, hash: new Uint8Array(32) }, 0, {
      uid: 'alice',
      type: 'set-relays',
      payload: new Uint8Array(8),
      signer: 'root',
      credential_id: null,
    })
  ),
  sig: randomBytes(64),
};

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('isRelaySeqMismatch', () => {
  test('recognizes SEQ_MISMATCH code and message', () => {
    expect(isRelaySeqMismatch(new RelayApiError(409, 'SEQ_MISMATCH', 'nope'))).toBe(true);
    expect(
      isRelaySeqMismatch(new RelayApiError(409, 'RELAY_KEYLOG_SEQ_MISMATCH', 'SEQ_MISMATCH'))
    ).toBe(true);
    expect(isRelaySeqMismatch(new Error('other'))).toBe(false);
  });
});

describe('appendAdmitThenMeta', () => {
  test('first append rejected → no meta POST', async () => {
    const urls: string[] = [];
    const fetcher: FetchLike = async (input) => {
      urls.push(String(input));
      return jsonRes({ error: { code: 'UNAUTHORIZED', message: 'bad' } }, 401);
    };
    const result = await appendAdmitThenMeta({
      relayUrl: 'https://relay.example',
      tenantId: 'aa'.repeat(16),
      token: randomBytes(32),
      logKey: randomBytes(32),
      admit: rec,
      meta: rec,
      fetcher,
    });
    expect(result).toMatchObject({ ok: false, kind: 'admit_failed' });
    expect(urls).toHaveLength(1);
  });

  test('member_ignored on admit is a hard failure and does not append meta', async () => {
    const urls: string[] = [];
    const fetcher: FetchLike = async (input) => {
      urls.push(String(input));
      return jsonRes({ ok: true, member_ignored: true });
    };
    const result = await appendAdmitThenMeta({
      relayUrl: 'https://relay.example',
      tenantId: 'aa'.repeat(16),
      token: randomBytes(32),
      logKey: randomBytes(32),
      admit: rec,
      meta: rec,
      fetcher,
    });
    expect(result).toEqual({ ok: false, kind: 'member_ignored' });
    expect(urls).toHaveLength(1);
  });

  test('second append failure after admit succeeded', async () => {
    let n = 0;
    const fetcher: FetchLike = async () => {
      n += 1;
      if (n === 1) return jsonRes({ ok: true });
      return jsonRes({ error: { code: 'SEQ_MISMATCH', message: 'SEQ_MISMATCH' } }, 409);
    };
    const result = await appendAdmitThenMeta({
      relayUrl: 'https://relay.example',
      tenantId: 'aa'.repeat(16),
      token: randomBytes(32),
      logKey: randomBytes(32),
      admit: rec,
      meta: rec,
      fetcher,
    });
    expect(result).toEqual({ ok: false, kind: 'meta_failed', error: expect.any(RelayApiError) });
    expect(n).toBe(2);
  });
});

describe('appendAdmitThenMetaRetrying', () => {
  test('head race → rebuild and retry succeeds', async () => {
    const loads: number[] = [];
    const kinds: string[] = [];
    const dummy = { bytes: new Uint8Array([1]), sig: new Uint8Array(64) };
    const result = await appendAdmitThenMetaRetrying({
      relayUrl: 'https://relay.example',
      tenantId: 'aa'.repeat(16),
      token: randomBytes(32),
      logKey: randomBytes(32),
      load: async () => {
        loads.push(1);
        return { admit: dummy, meta: dummy, nodeId: 'n1' };
      },
      append: async () => {
        kinds.push(loads.length === 1 ? 'seq' : 'ok');
        if (loads.length === 1) return { ok: false, kind: 'seq_mismatch' };
        return { ok: true };
      },
    });
    expect(result).toEqual({ ok: true, nodeId: 'n1' });
    expect(loads).toHaveLength(2);
    expect(kinds).toEqual(['seq', 'ok']);
  });

  test('member_ignored does not retry', async () => {
    let loads = 0;
    const dummy = { bytes: new Uint8Array([1]), sig: new Uint8Array(64) };
    const result = await appendAdmitThenMetaRetrying({
      relayUrl: 'https://relay.example',
      tenantId: 'aa'.repeat(16),
      token: randomBytes(32),
      logKey: randomBytes(32),
      load: async () => {
        loads += 1;
        return { admit: dummy, meta: dummy, nodeId: 'pending-node' };
      },
      append: async () => ({ ok: false, kind: 'member_ignored' }),
    });
    expect(result).toEqual({ ok: false, kind: 'member_ignored', nodeId: 'pending-node' });
    expect(loads).toBe(1);
  });

  test(`caps retries at ${RELAY_JOIN_APPEND_ATTEMPTS}`, async () => {
    let loads = 0;
    const dummy = { bytes: new Uint8Array([1]), sig: new Uint8Array(64) };
    const result = await appendAdmitThenMetaRetrying({
      relayUrl: 'https://relay.example',
      tenantId: 'aa'.repeat(16),
      token: randomBytes(32),
      logKey: randomBytes(32),
      load: async () => {
        loads += 1;
        return { admit: dummy, meta: dummy, nodeId: 'n1' };
      },
      append: async () => ({ ok: false, kind: 'seq_mismatch' }),
    });
    expect(result.ok).toBe(false);
    expect(loads).toBe(RELAY_JOIN_APPEND_ATTEMPTS);
  });
});
