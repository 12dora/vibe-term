import { describe, expect, test } from 'bun:test';
import {
  decodeJoinToken,
  encodeBase64url,
  generateKdfParams,
  rootKeyFromSeed,
} from '../../../shared/src/auth';
import type { JoinError } from '../commands/hub';
import { requestEnrollmentByPassword, resolveHubJoinToken } from './hub-password-join';
import { deriveRootKey } from './password';

const HEAD = new Uint8Array(32).fill(3);
const UID = 'user-1';
const PASSWORD = 'tmex-test-pass';

function kdfJson(params: ReturnType<typeof generateKdfParams>) {
  return {
    salt: encodeBase64url(params.salt),
    memory_kib: 8,
    iterations: 1,
    parallelism: 1,
  };
}

describe('resolveHubJoinToken', () => {
  test('token path returns the token', async () => {
    expect(
      await resolveHubJoinToken({
        token: 'abc',
        hubUrl: 'https://hub.example',
        resolvePassword: async () => {
          throw new Error('should not prompt');
        },
      })
    ).toBe('abc');
  });

  test('token and password are mutually exclusive', async () => {
    await expect(
      resolveHubJoinToken({
        token: 'abc',
        password: true,
        hubUrl: 'https://hub.example',
        resolvePassword: async () => 'x',
      })
    ).rejects.toThrow('mutually exclusive');
  });

  test('neither token nor password is an error', async () => {
    await expect(
      resolveHubJoinToken({
        hubUrl: 'https://hub.example',
        resolvePassword: async () => 'x',
      })
    ).rejects.toThrow('--token or --password');
  });
});

describe('requestEnrollmentByPassword', () => {
  test('exchanges password for a join token', async () => {
    const kdf = generateKdfParams();
    kdf.memory_kib = 8;
    kdf.iterations = 1;
    const rootKey = await deriveRootKey(PASSWORD, kdf);
    const calls: string[] = [];
    const material = await requestEnrollmentByPassword({
      hubUrl: 'https://hub.example',
      password: PASSWORD,
      now: () => 1_700_000_000_000,
      fetcher: async (input) => {
        const url = String(input);
        calls.push(url);
        if (url.endsWith('/api/auth/mode')) {
          return Response.json({
            uid: UID,
            kdfParams: kdfJson(kdf),
            rootEpoch: 0,
            caFingerprint: 'ab'.repeat(32),
          });
        }
        if (url.endsWith('/api/hub/enrollments/by-password')) {
          return Response.json({
            ok: true,
            id: 'enroll-1',
            key_log_head_hash: encodeBase64url(HEAD),
            ca_fingerprint: 'ab'.repeat(32),
            public_url: 'https://hub.example',
          });
        }
        return new Response('nope', { status: 404 });
      },
    });
    expect(calls.some((u) => u.endsWith('/api/auth/mode'))).toBe(true);
    expect(calls.some((u) => u.endsWith('/api/hub/enrollments/by-password'))).toBe(true);
    const decoded = decodeJoinToken(material.token);
    expect(decoded.caFingerprint).toBe('ab'.repeat(32));
    expect(new Uint8Array(decoded.keyLogHeadHash)).toEqual(HEAD);
    expect(new Uint8Array(decoded.rootPublicKey)).toEqual(new Uint8Array(rootKey.publicKey));
    expect(material.enrollmentId).toBe('enroll-1');
  });

  test('wrong-password response becomes JoinError', async () => {
    const kdf = generateKdfParams();
    kdf.memory_kib = 8;
    kdf.iterations = 1;
    await expect(
      requestEnrollmentByPassword({
        hubUrl: 'https://hub.example',
        password: PASSWORD,
        fetcher: async (input) => {
          const url = String(input);
          if (url.endsWith('/api/auth/mode')) {
            return Response.json({ uid: UID, kdfParams: kdfJson(kdf), rootEpoch: 0 });
          }
          return Response.json({ error: 'invalid_proof' }, { status: 401 });
        },
      })
    ).rejects.toMatchObject({ code: 'join_failed' } satisfies Partial<JoinError>);
  });

  test('rejects kdf params outside the client budget', async () => {
    await expect(
      requestEnrollmentByPassword({
        hubUrl: 'https://hub.example',
        password: PASSWORD,
        fetcher: async (input) => {
          const url = String(input);
          if (url.endsWith('/api/auth/mode')) {
            return Response.json({
              uid: UID,
              kdfParams: {
                salt: encodeBase64url(new Uint8Array(16).fill(1)),
                memory_kib: 262_145,
                iterations: 1,
                parallelism: 1,
              },
              rootEpoch: 0,
            });
          }
          return new Response('nope', { status: 404 });
        },
      })
    ).rejects.toMatchObject({ code: 'join_failed' });
  });
});
