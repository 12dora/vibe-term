import { describe, expect, test } from 'bun:test';
import {
  HUB_ENROLL_PROOF_MAX_SKEW_MS,
  createEnrollment,
  encodeBase64url,
  hubHostFromUrl,
  signHubEnrollProof,
} from '@tmex/shared/auth';
import { HUB_NOT_WRITER } from '@tmex/shared/uplink';
import { createMigratedAuthDb } from '../auth/test-db';
import { HUB_ENROLL_FAIL_LIMIT, HUB_ENROLL_SUCCESS_LIMIT } from './hub-enroll-limiter';
import { HubRuntime, type HubTlsInfoProvider } from './hub-runtime';
import { createHubTestStack, seedAdmittedNode, seedUser } from './hub-test-helpers';
import type { HubRuntimeConfig } from './types';

const dummyServer = { upgrade: () => true };
const STANDBY_HUB = 'aa'.repeat(16);
const WRITER_HUB = 'bb'.repeat(16);

function passwordBody(
  enrollment: Awaited<ReturnType<typeof createEnrollment>>,
  signed: { bytes: Uint8Array; sig: Uint8Array },
  exp: number
): string {
  return JSON.stringify({
    proof: { bytes: encodeBase64url(signed.bytes), sig: encodeBase64url(signed.sig) },
    enroll_pk: encodeBase64url(enrollment.enrollPk),
    authorization: encodeBase64url(enrollment.authorizationBytes),
    authorization_sig: encodeBase64url(enrollment.authorizationSig),
    exp,
  });
}

async function startHub(
  db: ReturnType<typeof createMigratedAuthDb>['db'],
  now: () => number,
  extra?: { tlsInfo?: HubTlsInfoProvider; config?: Partial<HubRuntimeConfig> }
) {
  const { userStore, keyLogSource } = createHubTestStack(db);
  const user = seedUser(userStore, { now: now() });
  const hub = new HubRuntime({
    db,
    userStore,
    keyLogSource,
    config: { publicUrl: 'https://hub.example', stun: [], ...extra?.config },
    authenticate: () => null,
    now,
    heartbeatIntervalMs: 60_000,
    tlsInfo: extra?.tlsInfo,
  });
  return { hub, user, userStore };
}

describe('POST /api/hub/enrollments/by-password', () => {
  test('happy path returns enrollment material without node-session', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const now = 2_000_000;
      const fingerprint = 'ab'.repeat(32);
      const pem = '-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----';
      const { hub, user } = await startHub(db, () => now, {
        tlsInfo: () => ({ caFingerprint: fingerprint, caPem: pem }),
      });
      const enrollment = await createEnrollment(user.root, {
        uid: user.id,
        rootEpoch: 0,
        now,
        ttlMs: 10_000,
      });
      const signed = signHubEnrollProof(user.root, {
        hubHost: hubHostFromUrl('https://hub.example'),
        uid: user.id,
        enrollPk: enrollment.enrollPk,
        ts: now,
      });
      const res = await hub.handleRequest(
        new Request('http://hub/api/hub/enrollments/by-password', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: passwordBody(enrollment, signed, now + 10_000),
        }),
        dummyServer
      );
      expect(res?.status).toBe(201);
      const body = (await res?.json()) as {
        ok: boolean;
        id: string;
        public_url: string;
        ca_fingerprint: string;
        ca_cert_pem: string;
        key_log_head_hash: string;
        root_public_key: string;
      };
      expect(body.ok).toBe(true);
      expect(body.public_url).toBe('https://hub.example');
      expect(body.ca_fingerprint).toBe(fingerprint);
      expect(body.ca_cert_pem).toBe(pem);
      expect(body.key_log_head_hash).toBe(encodeBase64url(new Uint8Array(32)));
      expect(body.root_public_key).toBe(encodeBase64url(user.root.publicKey));
      expect(typeof body.id).toBe('string');
      hub.stop();
    } finally {
      close();
    }
  });

  test('wrong password (other root key) is 401 invalid_proof', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const now = 2_000_000;
      const { hub, user } = await startHub(db, () => now);
      const other = seedUser(hub.userStore, { id: 'other', username: 'bob', now });
      const enrollment = await createEnrollment(other.root, {
        uid: user.id,
        rootEpoch: 0,
        now,
        ttlMs: 10_000,
      });
      const signed = signHubEnrollProof(other.root, {
        hubHost: hubHostFromUrl('https://hub.example'),
        uid: user.id,
        enrollPk: enrollment.enrollPk,
        ts: now,
      });
      const res = await hub.handleRequest(
        new Request('http://hub/api/hub/enrollments/by-password', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: passwordBody(enrollment, signed, now + 10_000),
        }),
        dummyServer
      );
      expect(res?.status).toBe(401);
      expect(await res?.json()).toEqual({ error: 'invalid_proof' });
      hub.stop();
    } finally {
      close();
    }
  });

  test('expired ts is 400 ts_skew', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const now = 2_000_000;
      const { hub, user } = await startHub(db, () => now);
      const enrollment = await createEnrollment(user.root, {
        uid: user.id,
        rootEpoch: 0,
        now,
        ttlMs: 10_000,
      });
      const signed = signHubEnrollProof(user.root, {
        hubHost: hubHostFromUrl('https://hub.example'),
        uid: user.id,
        enrollPk: enrollment.enrollPk,
        ts: now - HUB_ENROLL_PROOF_MAX_SKEW_MS - 1,
      });
      const res = await hub.handleRequest(
        new Request('http://hub/api/hub/enrollments/by-password', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: passwordBody(enrollment, signed, now + 10_000),
        }),
        dummyServer
      );
      expect(res?.status).toBe(400);
      expect(await res?.json()).toEqual({ error: 'ts_skew' });
      hub.stop();
    } finally {
      close();
    }
  });

  test('proof failures trip the limiter', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const now = 2_000_000;
      const { hub, user } = await startHub(db, () => now);
      const other = seedUser(hub.userStore, { id: 'forger', username: 'forger', now });
      for (let n = 0; n < HUB_ENROLL_FAIL_LIMIT; n += 1) {
        const enrollment = await createEnrollment(other.root, {
          uid: user.id,
          rootEpoch: 0,
          now,
          ttlMs: 10_000,
        });
        const signed = signHubEnrollProof(other.root, {
          hubHost: hubHostFromUrl('https://hub.example'),
          uid: user.id,
          enrollPk: enrollment.enrollPk,
          ts: now,
        });
        const res = await hub.handleRequest(
          new Request('http://hub/api/hub/enrollments/by-password', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: passwordBody(enrollment, signed, now + 10_000),
          }),
          dummyServer
        );
        expect(res?.status).toBe(401);
      }
      const enrollment = await createEnrollment(user.root, {
        uid: user.id,
        rootEpoch: 0,
        now,
        ttlMs: 10_000,
      });
      const signed = signHubEnrollProof(user.root, {
        hubHost: hubHostFromUrl('https://hub.example'),
        uid: user.id,
        enrollPk: enrollment.enrollPk,
        ts: now,
      });
      const limited = await hub.handleRequest(
        new Request('http://hub/api/hub/enrollments/by-password', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: passwordBody(enrollment, signed, now + 10_000),
        }),
        dummyServer
      );
      expect(limited?.status).toBe(429);
      expect(await limited?.json()).toEqual({ error: 'rate_limited' });
      hub.stop();
    } finally {
      close();
    }
  });

  test('successful creations cap per uid per hour', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const now = 2_000_000;
      const { hub, user } = await startHub(db, () => now);
      for (let n = 0; n < HUB_ENROLL_SUCCESS_LIMIT; n += 1) {
        const enrollment = await createEnrollment(user.root, {
          uid: user.id,
          rootEpoch: 0,
          now,
          ttlMs: 10_000,
        });
        const signed = signHubEnrollProof(user.root, {
          hubHost: hubHostFromUrl('https://hub.example'),
          uid: user.id,
          enrollPk: enrollment.enrollPk,
          ts: now,
        });
        const res = await hub.handleRequest(
          new Request('http://hub/api/hub/enrollments/by-password', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: passwordBody(enrollment, signed, now + 10_000),
          }),
          dummyServer
        );
        expect(res?.status).toBe(201);
      }
      const enrollment = await createEnrollment(user.root, {
        uid: user.id,
        rootEpoch: 0,
        now,
        ttlMs: 10_000,
      });
      const signed = signHubEnrollProof(user.root, {
        hubHost: hubHostFromUrl('https://hub.example'),
        uid: user.id,
        enrollPk: enrollment.enrollPk,
        ts: now,
      });
      const limited = await hub.handleRequest(
        new Request('http://hub/api/hub/enrollments/by-password', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: passwordBody(enrollment, signed, now + 10_000),
        }),
        dummyServer
      );
      expect(limited?.status).toBe(429);
      hub.stop();
    } finally {
      close();
    }
  });

  test('standby returns 409 HUB_NOT_WRITER', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const { userStore, keyLogSource } = createHubTestStack(db);
      const user = seedUser(userStore);
      seedAdmittedNode(userStore, user.id, { name: 'entry' });
      const hub = new HubRuntime({
        db,
        userStore,
        keyLogSource,
        config: {
          publicUrl: 'https://hub.example',
          stun: [],
          mode: 'standby',
          hubNodeId: STANDBY_HUB,
          writerEpoch: 1,
          priority: 200,
          authorizedHubIds: [WRITER_HUB],
        },
        authenticate: () => null,
      });
      const enrollment = await createEnrollment(user.root, {
        uid: user.id,
        rootEpoch: 0,
        now: 1_000,
        ttlMs: 10_000,
      });
      const signed = signHubEnrollProof(user.root, {
        hubHost: hubHostFromUrl('https://hub.example'),
        uid: user.id,
        enrollPk: enrollment.enrollPk,
        ts: 1_000,
      });
      const res = await hub.handleRequest(
        new Request('http://hub/api/hub/enrollments/by-password', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: passwordBody(enrollment, signed, 11_000),
        }),
        dummyServer
      );
      expect(res?.status).toBe(409);
      const body = (await res?.json()) as { code: string };
      expect(body.code).toBe(HUB_NOT_WRITER);
      hub.stop();
    } finally {
      close();
    }
  });
});
