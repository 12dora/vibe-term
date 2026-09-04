import { describe, expect, test } from 'bun:test';
import {
  DOMAIN_AUTHORIZATION,
  decodeAdmitNodePayload,
  decodeAuthorization,
  decodeBase64url,
  decodeKeyLogRecord,
  encodeAuthorization,
  encodeBase64url,
  randomBytes,
  rootKeyFromSeed,
  verifyEd25519,
} from '../../../shared/src/auth';
import type { LocalAuthContext } from './local-auth';
import { type RelayTenantSession, reaffirmStaleMembers } from './relay-session';

const UID = 'user-1';
const ROOT_EPOCH = 4;

function passkeyAuthorization(): Uint8Array {
  return encodeAuthorization({
    domain: DOMAIN_AUTHORIZATION,
    uid: UID,
    enroll_pk: randomBytes(32),
    exp: 1n,
    root_epoch: 0,
    signer: 'passkey',
    credential_id: 'cred-1',
  });
}

describe('reaffirmStaleMembers', () => {
  test('re-encodes a passkey-admitted member as a root-signed authorization', async () => {
    const rootKey = rootKeyFromSeed(new Uint8Array(32).fill(3));
    const original = passkeyAuthorization();
    const certificate = randomBytes(16);
    const certSig = randomBytes(64);
    const appends: Record<string, unknown>[] = [];
    let headSeq = 0;
    const fetcher = (async (input: unknown, init?: RequestInit) => {
      const url = new URL(String(input));
      const path = `${url.pathname}${url.search}`;
      const body =
        typeof init?.body === 'string'
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : undefined;
      const json = (payload: unknown) =>
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      if (path === '/api/mesh/relay/readmit/prepare') {
        return json({
          rootEpoch: ROOT_EPOCH,
          entries: [
            {
              nodeId: 'ab'.repeat(16),
              name: 'studio',
              admitSeq: 2,
              admitRootEpoch: 0,
              authorization_bytes: encodeBase64url(original),
              certificate_bytes: encodeBase64url(certificate),
              cert_sig: encodeBase64url(certSig),
            },
          ],
        });
      }
      if (path === '/api/auth/keylog/head') {
        return json({
          seq: headSeq,
          hash: encodeBase64url(new Uint8Array(32).fill(1)),
          rootEpoch: ROOT_EPOCH,
          uid: UID,
        });
      }
      if (path === '/api/auth/keylog?hub=sync') {
        appends.push(body ?? {});
        headSeq += 1;
        return json({ seq: headSeq, hash: encodeBase64url(randomBytes(32)) });
      }
      return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;

    const session: RelayTenantSession = {
      ctx: {} as LocalAuthContext,
      baseUrl: 'http://127.0.0.1:19993',
      cookieHeader: 'sid=1',
      userId: UID,
      rootKey,
      fetcher,
    };
    const result = await reaffirmStaleMembers(session);
    expect(result).toEqual({ count: 1, rootEpoch: ROOT_EPOCH });
    expect(appends).toHaveLength(1);
    const record = decodeKeyLogRecord(decodeBase64url(String(appends[0]?.bytes)));
    expect(record.type).toBe('readmit-node');
    const payload = decodeAdmitNodePayload(record.payload);
    const rebuilt = decodeAuthorization(payload.authorization_bytes);
    expect(rebuilt.signer).toBe('root');
    expect(rebuilt.credential_id).toBeNull();
    expect(rebuilt.root_epoch).toBe(ROOT_EPOCH);
    expect(rebuilt.uid).toBe(UID);
    expect(payload.authorization_bytes).not.toEqual(original);
    expect(payload.certificate_bytes).toEqual(certificate);
    expect(
      verifyEd25519(payload.authorization_sig, payload.authorization_bytes, rootKey.publicKey)
    ).toBe(true);
  });
});
