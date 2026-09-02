import { describe, expect, test } from 'bun:test';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import {
  createEnrollment,
  createNodeCertificate,
  decodeBase64url,
  encodeAdmitNodePayload,
  encodeBase64url,
  encodeClearTotpPayload,
  encodeRevokeNodePayload,
  encodeRotateRootKeepPayload,
  encodeRotateRootPayload,
  generateEd25519KeyPair,
  generateKdfParams,
  generateX25519KeyPair,
  nodeIdToHex,
  randomBytes,
  rootKeyFromSeed,
  sha256,
  signEd25519,
} from '@tmex/shared/auth';
import { createInMemoryLinkPair } from '@tmex/shared/link';
import { HUB_NOT_WRITER } from '@tmex/shared/uplink';
import { MeshHubStore } from '../auth/mesh-hub-store';
import { encodePasskeyAssertionSig, verifyRegistration } from '../auth/passkey';
import { createMigratedAuthDb } from '../auth/test-db';
import { inspectHubAuthRecordCompat } from './hub-authorization';
import { HubRuntime, type HubTlsInfoProvider } from './hub-runtime';
import {
  createHubTestStack,
  ctlInbox,
  seedAdmittedNode,
  seedCertOnly,
  seedUser,
  sendCtl,
  signAuth,
  signUserRecord,
} from './hub-test-helpers';
import { encodeRedeemPopMessage } from './redeem-pop';
import type { HubRuntimeConfig } from './types';
import { HUB_UPLINK_PATH, HUB_UPLINK_WS_KIND } from './types';

const dummyServer = { upgrade: () => true };
const RP_ID = 'localhost';
const ORIGIN = 'http://localhost:19663';

function enrollmentJson(
  enrollment: Awaited<ReturnType<typeof createEnrollment>>,
  now: number,
  ttlMs = 10_000
): string {
  return JSON.stringify({
    enroll_pk: encodeBase64url(enrollment.enrollPk),
    authorization: encodeBase64url(enrollment.authorizationBytes),
    authorization_sig: encodeBase64url(enrollment.authorizationSig),
    exp: now + ttlMs,
  });
}

function redeemPop(edSk: Uint8Array, cert: ReturnType<typeof createNodeCertificate>): string {
  return encodeBase64url(
    signEd25519(
      edSk,
      encodeRedeemPopMessage({
        enrollmentId: encodeBase64url(cert.certificate.enroll_pk),
        nodeId: cert.nodeId,
        certBytes: cert.certificateBytes,
      })
    )
  );
}

function redeemJson(
  cert: ReturnType<typeof createNodeCertificate>,
  name: string,
  version?: string,
  pop?: string
): string {
  return JSON.stringify({
    certificate: encodeBase64url(cert.certificateBytes),
    cert_sig: encodeBase64url(cert.certSig),
    name,
    ...(version !== undefined ? { version } : {}),
    ...(pop !== undefined ? { pop } : {}),
  });
}

async function startAuthedHub(
  db: ReturnType<typeof createMigratedAuthDb>['db'],
  now: () => number,
  extra?: {
    tlsInfo?: HubTlsInfoProvider;
    config?: Partial<HubRuntimeConfig>;
    meshHubs?: MeshHubStore;
  }
) {
  const { userStore, keyLogSource, service } = createHubTestStack(db);
  const user = seedUser(userStore, { now: now() });
  const entry = seedAdmittedNode(userStore, user.id, { name: 'entry', now: now() });
  const hub = new HubRuntime({
    db,
    userStore,
    keyLogSource,
    config: { publicUrl: 'https://hub.example', stun: ['stun:x'], ...extra?.config },
    meshHubs: extra?.meshHubs,
    authenticate: () => ({
      userId: user.id,
      entryNodeId: entry.nodeId,
      sid: 'creator-sid',
    }),
    now,
    heartbeatIntervalMs: 60_000,
    tlsInfo: extra?.tlsInfo,
  });
  const [entryLink, hubLink] = createInMemoryLinkPair();
  const inbox = ctlInbox(entryLink);
  hub.attachLocalNode(hubLink);
  const challenge = await inbox.take();
  if (challenge.t !== 'auth.challenge') throw new Error('expected challenge');
  sendCtl(entryLink, {
    t: 'auth.response',
    node_id: entry.nodeId,
    sig: signAuth(entry.ed.secretKey, decodeBase64url(challenge.nonce)),
  });
  expect((await inbox.take()).t).toBe('auth.ok');
  expect((await inbox.take()).t).toBe('node.list');
  return { hub, user, entry, userStore, service, inbox };
}

describe('HubRuntime HTTP', () => {
  test('管理 API 需要鉴权', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const { userStore, keyLogSource } = createHubTestStack(db);
      seedUser(userStore);
      const hub = new HubRuntime({
        db,
        userStore,
        keyLogSource,
        config: { publicUrl: 'https://hub.example', stun: [] },
        authenticate: () => null,
      });
      const res = await hub.handleRequest(new Request('http://hub/api/hub/nodes'), dummyServer);
      expect(res?.status).toBe(401);
      const enroll = await hub.handleRequest(
        new Request('http://hub/api/hub/enrollments', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        }),
        dummyServer
      );
      expect(enroll?.status).toBe(401);
      hub.stop();
    } finally {
      close();
    }
  });

  test('enrollment-created includes ca_fingerprint and ca_cert_pem from tlsInfo', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const now = 2_000_000;
      const fingerprint = 'ab'.repeat(32);
      const pem = '-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----';
      const { hub, user } = await startAuthedHub(db, () => now, {
        tlsInfo: () => ({ caFingerprint: fingerprint, caPem: pem }),
      });
      const enrollment = await createEnrollment(user.root, {
        uid: user.id,
        rootEpoch: 0,
        now,
        ttlMs: 10_000,
      });
      const created = await hub.handleRequest(
        new Request('http://hub/api/hub/enrollments', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: enrollmentJson(enrollment, now),
        }),
        dummyServer
      );
      expect(created?.status).toBe(201);
      const body = (await created?.json()) as {
        ca_fingerprint: string | null;
        ca_cert_pem: string | null;
      };
      expect(body.ca_fingerprint).toBe(fingerprint);
      expect(body.ca_cert_pem).toBe(pem);
      hub.stop();
    } finally {
      close();
    }
  });

  test('GET /hub/uplink 走 upgrade', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const { userStore, keyLogSource } = createHubTestStack(db);
      const hub = new HubRuntime({
        db,
        userStore,
        keyLogSource,
        config: { publicUrl: 'https://hub.example', stun: [] },
        authenticate: () => null,
      });
      let data: unknown;
      const server = {
        upgrade(_req: Request, opts?: { data?: unknown }) {
          data = opts?.data;
          return true;
        },
      };
      const res = await hub.handleRequest(new Request(`http://hub${HUB_UPLINK_PATH}`), server);
      expect(res).toBeUndefined();
      expect(data).toEqual({ kind: HUB_UPLINK_WS_KIND });
      hub.stop();
    } finally {
      close();
    }
  });

  test('enrollment create → redeem 成功并推送 enroll.redeemed；错误 enroll_pk / 过期 / 重放拒绝', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      let now = 2_000_000;
      const { userStore, keyLogSource, service } = createHubTestStack(db);
      const user = seedUser(userStore, { now });
      const entry = seedAdmittedNode(userStore, user.id, { name: 'entry', now });
      const seededLog = signUserRecord(
        service,
        user.id,
        user.root,
        'clear-totp',
        encodeClearTotpPayload()
      );
      expect((await keyLogSource.append(user.id, seededLog)).ok).toBe(true);
      const hub = new HubRuntime({
        db,
        userStore,
        keyLogSource,
        config: { publicUrl: 'https://hub.example', stun: ['stun:x'] },
        authenticate: () => ({
          userId: user.id,
          entryNodeId: entry.nodeId,
          sid: 'creator-sid',
        }),
        now: () => now,
        heartbeatIntervalMs: 60_000,
      });

      const [entryLink, hubLink] = createInMemoryLinkPair();
      const inbox = ctlInbox(entryLink);
      hub.attachLocalNode(hubLink);
      const challenge = await inbox.take();
      if (challenge.t !== 'auth.challenge') throw new Error('expected challenge');
      sendCtl(entryLink, {
        t: 'auth.response',
        node_id: entry.nodeId,
        sig: signAuth(entry.ed.secretKey, decodeBase64url(challenge.nonce)),
      });
      expect((await inbox.take()).t).toBe('auth.ok');
      expect((await inbox.take()).t).toBe('node.list');

      const enrollment = await createEnrollment(user.root, {
        uid: user.id,
        rootEpoch: 0,
        now,
        ttlMs: 10_000,
      });
      const created = await hub.handleRequest(
        new Request('http://hub/api/hub/enrollments', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            enroll_pk: encodeBase64url(enrollment.enrollPk),
            authorization: encodeBase64url(enrollment.authorizationBytes),
            authorization_sig: encodeBase64url(enrollment.authorizationSig),
            exp: now + 10_000,
          }),
        }),
        dummyServer
      );
      expect(created?.status).toBe(201);
      const createdBody = (await created?.json()) as {
        id: string;
        public_url: string;
        expires_at: number;
        ca_fingerprint: string | null;
        ca_cert_pem: string | null;
      };
      expect(createdBody.public_url).toBe('https://hub.example');
      expect(createdBody.ca_fingerprint).toBeNull();
      expect(createdBody.ca_cert_pem).toBeNull();
      expect(createdBody.id.length).toBeGreaterThan(4);
      const pending = await hub.handleRequest(
        new Request(`http://hub/api/hub/enrollments/${createdBody.id}`),
        dummyServer
      );
      expect(pending?.status).toBe(200);
      expect(await pending?.json()).toEqual({
        status: 'pending',
        enroll_pk: encodeBase64url(enrollment.enrollPk),
        already_admitted: false,
      });

      const ed = generateEd25519KeyPair();
      const x = generateX25519KeyPair();
      const cert = createNodeCertificate(enrollment.enrollSk, {
        uid: user.id,
        edPk: ed.publicKey,
        x25519Pk: x.publicKey,
        enrollPk: enrollment.enrollPk,
        now,
      });
      const redeemReq = () =>
        hub.handleRequest(
          new Request('http://hub/api/hub/enrollments/redeem', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              certificate: encodeBase64url(cert.certificateBytes),
              cert_sig: encodeBase64url(cert.certSig),
              name: 'laptop',
              version: '2.0.0',
            }),
          }),
          dummyServer
        );

      const redeemed = await redeemReq();
      expect(redeemed).not.toBeUndefined();
      if (!redeemed) throw new Error('expected redeem response');
      expect(redeemed.status).toBe(200);
      const body = (await redeemed.json()) as {
        user: { id: string; username: string; root_public_key: string };
        user_key_log: unknown[];
        node_certs: unknown[];
      };
      expect(body.user.id).toBe(user.id);
      expect(body.user.username).toBe('alice');
      expect(body.user.root_public_key).toBe(encodeBase64url(user.root.publicKey));
      expect(body.user_key_log).toHaveLength(1);
      expect(userStore.getNode(nodeIdToHex(cert.nodeId))?.name).toBe('laptop');

      const pushed = await inbox.take();
      expect(pushed.t).toBe('enroll.redeemed');
      if (pushed.t === 'enroll.redeemed') {
        expect(pushed.enroll_pk).toBe(encodeBase64url(enrollment.enrollPk));
        expect(pushed.node_id).toBe(nodeIdToHex(cert.nodeId));
        expect(pushed.certificate).toBe(encodeBase64url(cert.certificateBytes));
        expect(pushed.entry_sid).toBe('creator-sid');
        expect(pushed.already_admitted).toBe(false);
      }

      const redeemedGet = await hub.handleRequest(
        new Request(`http://hub/api/hub/enrollments/${createdBody.id}`),
        dummyServer
      );
      expect(redeemedGet?.status).toBe(200);
      const enrollBody = (await redeemedGet?.json()) as {
        status: string;
        certificate?: string;
        cert_sig?: string;
        node_id?: string;
        already_admitted?: boolean;
      };
      expect(enrollBody.status).toBe('redeemed');
      expect(enrollBody.certificate).toBe(encodeBase64url(cert.certificateBytes));
      expect(enrollBody.cert_sig).toBe(encodeBase64url(cert.certSig));
      expect(enrollBody.node_id).toBe(nodeIdToHex(cert.nodeId));
      expect(enrollBody.already_admitted).toBe(false);

      const listed = await hub.handleRequest(new Request('http://hub/api/hub/nodes'), dummyServer);
      const listedBody = (await listed?.json()) as {
        nodes: Array<{ id: string; certificate?: string; cert_sig?: string }>;
      };
      const laptop = listedBody.nodes.find((n) => n.id === nodeIdToHex(cert.nodeId));
      expect(laptop?.certificate).toBe(encodeBase64url(cert.certificateBytes));
      expect(laptop?.cert_sig).toBe(encodeBase64url(cert.certSig));

      const replayed = await redeemReq();
      expect(replayed).not.toBeUndefined();
      if (!replayed) throw new Error('expected idempotent redeem response');
      expect(replayed.status).toBe(200);
      const replayedBody = (await replayed.json()) as {
        user: { id: string };
        user_key_log: unknown[];
      };
      expect(replayedBody.user.id).toBe(user.id);
      expect(replayedBody.user_key_log).toHaveLength(1);

      const otherCert = createNodeCertificate(enrollment.enrollSk, {
        uid: user.id,
        edPk: generateEd25519KeyPair().publicKey,
        x25519Pk: generateX25519KeyPair().publicKey,
        enrollPk: enrollment.enrollPk,
        now,
      });
      const different = await hub.handleRequest(
        new Request('http://hub/api/hub/enrollments/redeem', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            certificate: encodeBase64url(otherCert.certificateBytes),
            cert_sig: encodeBase64url(otherCert.certSig),
            name: 'other',
          }),
        }),
        dummyServer
      );
      expect(different?.status).toBe(400);
      expect(await different?.json()).toEqual({ error: 'reused' });

      const wrongEnroll = await createEnrollment(user.root, {
        uid: user.id,
        rootEpoch: 0,
        now,
        ttlMs: 10_000,
      });
      await hub.handleRequest(
        new Request('http://hub/api/hub/enrollments', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            enroll_pk: encodeBase64url(wrongEnroll.enrollPk),
            authorization: encodeBase64url(wrongEnroll.authorizationBytes),
            authorization_sig: encodeBase64url(wrongEnroll.authorizationSig),
            exp: now + 10_000,
          }),
        }),
        dummyServer
      );
      const otherKeys = generateEd25519KeyPair();
      const mismatched = createNodeCertificate(otherKeys.secretKey, {
        uid: user.id,
        edPk: ed.publicKey,
        x25519Pk: x.publicKey,
        enrollPk: otherKeys.publicKey,
        now,
      });
      const wrongPk = await hub.handleRequest(
        new Request('http://hub/api/hub/enrollments/redeem', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            certificate: encodeBase64url(mismatched.certificateBytes),
            cert_sig: encodeBase64url(mismatched.certSig),
            name: 'x',
            version: '1',
          }),
        }),
        dummyServer
      );
      expect(wrongPk?.status).toBe(400);

      const expiring = await createEnrollment(user.root, {
        uid: user.id,
        rootEpoch: 0,
        now,
        ttlMs: 5_000,
      });
      await hub.handleRequest(
        new Request('http://hub/api/hub/enrollments', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            enroll_pk: encodeBase64url(expiring.enrollPk),
            authorization: encodeBase64url(expiring.authorizationBytes),
            authorization_sig: encodeBase64url(expiring.authorizationSig),
            exp: now + 5_000,
          }),
        }),
        dummyServer
      );
      now = now + 8_000;
      const expiredCert = createNodeCertificate(expiring.enrollSk, {
        uid: user.id,
        edPk: ed.publicKey,
        x25519Pk: x.publicKey,
        enrollPk: expiring.enrollPk,
        now,
      });
      const expired = await hub.handleRequest(
        new Request('http://hub/api/hub/enrollments/redeem', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            certificate: encodeBase64url(expiredCert.certificateBytes),
            cert_sig: encodeBase64url(expiredCert.certSig),
            name: 'late',
            version: '1',
          }),
        }),
        dummyServer
      );
      expect(expired).not.toBeUndefined();
      if (!expired) throw new Error('expected expired response');
      expect(expired.status).toBe(400);
      expect(await expired.json()).toEqual({ error: 'expired' });

      hub.stop();
    } finally {
      close();
    }
  });

  test('同一公钥再次 redeem 覆盖 enrollment 且仅一行；不同公钥返回 409 node_exists', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const now = 3_000_000;
      const { hub, user, userStore, service, inbox } = await startAuthedHub(db, () => now);
      const ed = generateEd25519KeyPair();
      const x = generateX25519KeyPair();

      const firstEnroll = await createEnrollment(user.root, {
        uid: user.id,
        rootEpoch: 0,
        now,
        ttlMs: 10_000,
      });
      const createdFirst = await hub.handleRequest(
        new Request('http://hub/api/hub/enrollments', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: enrollmentJson(firstEnroll, now),
        }),
        dummyServer
      );
      expect(createdFirst?.status).toBe(201);

      const firstCert = createNodeCertificate(firstEnroll.enrollSk, {
        uid: user.id,
        edPk: ed.publicKey,
        x25519Pk: x.publicKey,
        enrollPk: firstEnroll.enrollPk,
        now,
      });
      const hexId = nodeIdToHex(firstCert.nodeId);
      const firstRedeem = await hub.handleRequest(
        new Request('http://hub/api/hub/enrollments/redeem', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: redeemJson(firstCert, 'home', '1.0.0'),
        }),
        dummyServer
      );
      expect(firstRedeem?.status).toBe(200);
      expect((await inbox.take()).t).toBe('enroll.redeemed');
      expect(userStore.getCert(hexId)).toBeNull();

      const secondEnroll = await createEnrollment(user.root, {
        uid: user.id,
        rootEpoch: 0,
        now,
        ttlMs: 10_000,
      });
      const createdSecond = await hub.handleRequest(
        new Request('http://hub/api/hub/enrollments', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: enrollmentJson(secondEnroll, now),
        }),
        dummyServer
      );
      expect(createdSecond?.status).toBe(201);
      const createdSecondBody = (await createdSecond?.json()) as { id: string };

      const secondCert = createNodeCertificate(secondEnroll.enrollSk, {
        uid: user.id,
        edPk: ed.publicKey,
        x25519Pk: x.publicKey,
        enrollPk: secondEnroll.enrollPk,
        now,
        nodeId: firstCert.nodeId,
      });
      const secondRedeem = await hub.handleRequest(
        new Request('http://hub/api/hub/enrollments/redeem', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: redeemJson(secondCert, 'home-2', '1.1.0', redeemPop(ed.secretKey, secondCert)),
        }),
        dummyServer
      );
      expect(secondRedeem?.status).toBe(200);
      const pushed = await inbox.take();
      expect(pushed.t).toBe('enroll.redeemed');
      if (pushed.t === 'enroll.redeemed') {
        expect(pushed.enroll_pk).toBe(encodeBase64url(secondEnroll.enrollPk));
        expect(pushed.node_id).toBe(hexId);
        expect(pushed.certificate).toBe(encodeBase64url(secondCert.certificateBytes));
        expect(pushed.already_admitted).toBe(false);
      }

      expect(userStore.listNodes().filter((n) => n.id === hexId)).toHaveLength(1);
      expect(userStore.getNode(hexId)?.name).toBe('home-2');
      expect(userStore.getNode(hexId)?.version).toBe('1.1.0');
      expect(userStore.getNode(hexId)?.status).toBe('enrolled');
      expect(
        userStore.getEnrollmentTokenByEnrollPublicKey(firstEnroll.enrollPk)?.nodeId
      ).toBeNull();
      expect(userStore.getEnrollmentTokenByEnrollPublicKey(secondEnroll.enrollPk)?.nodeId).toBe(
        hexId
      );

      const listed = await hub.handleRequest(new Request('http://hub/api/hub/nodes'), dummyServer);
      const listedBody = (await listed?.json()) as {
        nodes: Array<{ id: string; certificate?: string; cert_sig?: string }>;
      };
      const home = listedBody.nodes.find((n) => n.id === hexId);
      expect(home?.certificate).toBe(encodeBase64url(secondCert.certificateBytes));
      expect(home?.cert_sig).toBe(encodeBase64url(secondCert.certSig));

      const redeemedGet = await hub.handleRequest(
        new Request(`http://hub/api/hub/enrollments/${createdSecondBody.id}`),
        dummyServer
      );
      const enrollBody = (await redeemedGet?.json()) as {
        status: string;
        certificate?: string;
        node_id?: string;
        already_admitted?: boolean;
      };
      expect(enrollBody.status).toBe('redeemed');
      expect(enrollBody.certificate).toBe(encodeBase64url(secondCert.certificateBytes));
      expect(enrollBody.node_id).toBe(hexId);
      expect(enrollBody.already_admitted).toBe(false);

      const admitted = await service.signAndApply(user.id, user.root, {
        type: 'admit-node',
        payload: encodeAdmitNodePayload({
          authorization_bytes: secondEnroll.authorizationBytes,
          authorization_sig: secondEnroll.authorizationSig,
          certificate_bytes: secondCert.certificateBytes,
          cert_sig: secondCert.certSig,
        }),
      });
      expect(admitted.ok).toBe(true);
      expect(userStore.getCert(hexId)?.revokedLogSeq).toBeNull();

      const otherEnroll = await createEnrollment(user.root, {
        uid: user.id,
        rootEpoch: 0,
        now,
        ttlMs: 10_000,
      });
      await hub.handleRequest(
        new Request('http://hub/api/hub/enrollments', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: enrollmentJson(otherEnroll, now),
        }),
        dummyServer
      );
      const otherEd = generateEd25519KeyPair();
      const collide = createNodeCertificate(otherEnroll.enrollSk, {
        uid: user.id,
        edPk: otherEd.publicKey,
        x25519Pk: generateX25519KeyPair().publicKey,
        enrollPk: otherEnroll.enrollPk,
        now,
        nodeId: firstCert.nodeId,
      });
      const collided = await hub.handleRequest(
        new Request('http://hub/api/hub/enrollments/redeem', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: redeemJson(collide, 'intruder'),
        }),
        dummyServer
      );
      expect(collided?.status).toBe(409);
      expect(await collided?.json()).toEqual({ error: 'node_exists' });
      expect(userStore.listNodes().filter((n) => n.id === hexId)).toHaveLength(1);
      expect(userStore.getNode(hexId)?.name).toBe('home-2');

      hub.stop();
    } finally {
      close();
    }
  });

  test('已在线节点同身份 re-redeem 保持 registry 在线', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const now = 4_000_000;
      const { hub, user, entry, userStore, inbox } = await startAuthedHub(db, () => now);
      expect(hub.registry.get(entry.nodeId)?.authenticated).toBe(true);
      const lastSeen = userStore.getNode(entry.nodeId)?.lastSeenAt ?? null;

      const enrollment = await createEnrollment(user.root, {
        uid: user.id,
        rootEpoch: 0,
        now,
        ttlMs: 10_000,
      });
      await hub.handleRequest(
        new Request('http://hub/api/hub/enrollments', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: enrollmentJson(enrollment, now),
        }),
        dummyServer
      );
      const cert = createNodeCertificate(enrollment.enrollSk, {
        uid: user.id,
        edPk: entry.ed.publicKey,
        x25519Pk: entry.x25519.publicKey,
        enrollPk: enrollment.enrollPk,
        now,
        nodeId: entry.nodeIdBytes,
      });
      const redeemed = await hub.handleRequest(
        new Request('http://hub/api/hub/enrollments/redeem', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: redeemJson(cert, 'entry-renamed', '3.0.0', redeemPop(entry.ed.secretKey, cert)),
        }),
        dummyServer
      );
      expect(redeemed?.status).toBe(200);
      expect((await redeemed?.json()) as { already_admitted?: boolean }).toEqual(
        expect.objectContaining({ already_admitted: true })
      );
      const pushed = await inbox.take();
      expect(pushed.t).toBe('enroll.redeemed');
      if (pushed.t === 'enroll.redeemed') {
        expect(pushed.already_admitted).toBe(true);
        expect(pushed.certificate).toBe(encodeBase64url(entry.certBytes));
        expect(pushed.cert_sig).toBe(encodeBase64url(entry.certSig));
      }
      expect(hub.registry.get(entry.nodeId)?.authenticated).toBe(true);
      expect(hub.registry.get(entry.nodeId)?.meta.name).toBe('entry-renamed');
      expect(userStore.getNode(entry.nodeId)?.lastSeenAt).toBe(lastSeen);
      expect(userStore.getNode(entry.nodeId)?.status).toBe('enrolled');
      expect(userStore.listNodes().filter((n) => n.id === entry.nodeId)).toHaveLength(1);

      const listed = await hub.handleRequest(new Request('http://hub/api/hub/nodes'), dummyServer);
      const listedBody = (await listed?.json()) as {
        nodes: Array<{ id: string; certificate?: string; online?: boolean }>;
      };
      const row = listedBody.nodes.find((n) => n.id === entry.nodeId);
      expect(row?.online).toBe(true);
      expect(row?.certificate).toBe(encodeBase64url(cert.certificateBytes));

      hub.stop();
    } finally {
      close();
    }
  });

  test('已吊销节点同身份 re-redeem 拒绝 node_revoked', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const now = 5_000_000;
      const { userStore, keyLogSource } = createHubTestStack(db);
      const user = seedUser(userStore, { now });
      const revoked = seedAdmittedNode(userStore, user.id, {
        name: 'lost',
        now,
        revoked: true,
      });
      const hub = new HubRuntime({
        db,
        userStore,
        keyLogSource,
        config: { publicUrl: 'https://hub.example', stun: [] },
        authenticate: () => ({
          userId: user.id,
          entryNodeId: revoked.nodeId,
          sid: 'creator-sid',
        }),
        now: () => now,
        heartbeatIntervalMs: 60_000,
      });
      expect(userStore.getNode(revoked.nodeId)?.status).toBe('revoked');
      expect(userStore.getCert(revoked.nodeId)?.revokedLogSeq).toBe(9);

      const enrollment = await createEnrollment(user.root, {
        uid: user.id,
        rootEpoch: 0,
        now,
        ttlMs: 10_000,
      });
      await hub.handleRequest(
        new Request('http://hub/api/hub/enrollments', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: enrollmentJson(enrollment, now),
        }),
        dummyServer
      );
      const cert = createNodeCertificate(enrollment.enrollSk, {
        uid: user.id,
        edPk: revoked.ed.publicKey,
        x25519Pk: revoked.x25519.publicKey,
        enrollPk: enrollment.enrollPk,
        now,
        nodeId: revoked.nodeIdBytes,
      });
      const redeemed = await hub.handleRequest(
        new Request('http://hub/api/hub/enrollments/redeem', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: redeemJson(cert, 'home-again', undefined, redeemPop(revoked.ed.secretKey, cert)),
        }),
        dummyServer
      );
      expect(redeemed?.status).toBe(409);
      expect(await redeemed?.json()).toEqual({ error: 'node_revoked' });
      expect(userStore.getNode(revoked.nodeId)?.status).toBe('revoked');
      expect(userStore.getNode(revoked.nodeId)?.name).toBe('lost');
      expect(userStore.getCert(revoked.nodeId)?.revokedLogSeq).toBe(9);

      hub.stop();
    } finally {
      close();
    }
  });

  test('已 admit 的同身份再 redeem 标记 already_admitted 且不替换证书', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const now = 5_500_000;
      const { hub, user, userStore, service, inbox } = await startAuthedHub(db, () => now);
      const ed = generateEd25519KeyPair();
      const x = generateX25519KeyPair();
      const firstEnroll = await createEnrollment(user.root, {
        uid: user.id,
        rootEpoch: 0,
        now,
        ttlMs: 10_000,
      });
      await hub.handleRequest(
        new Request('http://hub/api/hub/enrollments', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: enrollmentJson(firstEnroll, now),
        }),
        dummyServer
      );
      const firstCert = createNodeCertificate(firstEnroll.enrollSk, {
        uid: user.id,
        edPk: ed.publicKey,
        x25519Pk: x.publicKey,
        enrollPk: firstEnroll.enrollPk,
        now,
      });
      const hexId = nodeIdToHex(firstCert.nodeId);
      const firstRedeem = await hub.handleRequest(
        new Request('http://hub/api/hub/enrollments/redeem', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: redeemJson(firstCert, 'home'),
        }),
        dummyServer
      );
      expect(firstRedeem?.status).toBe(200);
      expect((await firstRedeem?.json()) as { already_admitted?: boolean }).toEqual(
        expect.objectContaining({ already_admitted: false })
      );
      expect((await inbox.take()).t).toBe('enroll.redeemed');
      const admitted = await service.signAndApply(user.id, user.root, {
        type: 'admit-node',
        payload: encodeAdmitNodePayload({
          authorization_bytes: firstEnroll.authorizationBytes,
          authorization_sig: firstEnroll.authorizationSig,
          certificate_bytes: firstCert.certificateBytes,
          cert_sig: firstCert.certSig,
        }),
      });
      expect(admitted.ok).toBe(true);
      const admittedBytes = userStore.getCert(hexId)?.certificateBytes;
      expect(admittedBytes).toEqual(firstCert.certificateBytes);

      const secondEnroll = await createEnrollment(user.root, {
        uid: user.id,
        rootEpoch: 0,
        now,
        ttlMs: 10_000,
      });
      const createdSecond = await hub.handleRequest(
        new Request('http://hub/api/hub/enrollments', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: enrollmentJson(secondEnroll, now),
        }),
        dummyServer
      );
      const createdSecondBody = (await createdSecond?.json()) as { id: string };
      const secondCert = createNodeCertificate(secondEnroll.enrollSk, {
        uid: user.id,
        edPk: ed.publicKey,
        x25519Pk: x.publicKey,
        enrollPk: secondEnroll.enrollPk,
        now,
        nodeId: firstCert.nodeId,
      });
      const secondRedeem = await hub.handleRequest(
        new Request('http://hub/api/hub/enrollments/redeem', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: redeemJson(secondCert, 'home-2', '1.1.0', redeemPop(ed.secretKey, secondCert)),
        }),
        dummyServer
      );
      expect(secondRedeem?.status).toBe(200);
      const secondBody = (await secondRedeem?.json()) as {
        already_admitted?: boolean;
        node_certs: Array<{ node_id: string; certificate: string }>;
      };
      expect(secondBody.already_admitted).toBe(true);
      expect(secondBody.node_certs.find((c) => c.node_id === hexId)?.certificate).toBe(
        encodeBase64url(firstCert.certificateBytes)
      );
      const pushed = await inbox.take();
      expect(pushed.t).toBe('enroll.redeemed');
      if (pushed.t === 'enroll.redeemed') {
        expect(pushed.already_admitted).toBe(true);
        expect(pushed.certificate).toBe(encodeBase64url(firstCert.certificateBytes));
        expect(pushed.cert_sig).toBe(encodeBase64url(firstCert.certSig));
        expect(pushed.node_id).toBe(hexId);
      }
      const secondGet = await hub.handleRequest(
        new Request(`http://hub/api/hub/enrollments/${createdSecondBody.id}`),
        dummyServer
      );
      expect(secondGet?.status).toBe(200);
      const secondGetBody = (await secondGet?.json()) as {
        status: string;
        already_admitted?: boolean;
        certificate?: string;
        cert_sig?: string;
        node_id?: string;
      };
      expect(secondGetBody.status).toBe('redeemed');
      expect(secondGetBody.already_admitted).toBe(true);
      expect(secondGetBody.certificate).toBe(encodeBase64url(firstCert.certificateBytes));
      expect(secondGetBody.cert_sig).toBe(encodeBase64url(firstCert.certSig));
      expect(secondGetBody.node_id).toBe(hexId);
      expect(userStore.getCert(hexId)?.certificateBytes).toEqual(firstCert.certificateBytes);
      expect(userStore.listCertsByUser(user.id).filter((c) => c.nodeId === hexId)).toHaveLength(1);
      expect(userStore.getNode(hexId)?.name).toBe('home-2');

      hub.stop();
    } finally {
      close();
    }
  });

  test('绑定已有 nodeId 需要节点私钥 PoP：有效证明成功，缺/错证明返回 409 node_exists', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const now = 6_000_000;
      const { hub, user, userStore, inbox } = await startAuthedHub(db, () => now);
      const ed = generateEd25519KeyPair();
      const x = generateX25519KeyPair();

      const firstEnroll = await createEnrollment(user.root, {
        uid: user.id,
        rootEpoch: 0,
        now,
        ttlMs: 10_000,
      });
      expect(
        (
          await hub.handleRequest(
            new Request('http://hub/api/hub/enrollments', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: enrollmentJson(firstEnroll, now),
            }),
            dummyServer
          )
        )?.status
      ).toBe(201);
      const firstCert = createNodeCertificate(firstEnroll.enrollSk, {
        uid: user.id,
        edPk: ed.publicKey,
        x25519Pk: x.publicKey,
        enrollPk: firstEnroll.enrollPk,
        now,
      });
      const firstRedeem = await hub.handleRequest(
        new Request('http://hub/api/hub/enrollments/redeem', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: redeemJson(firstCert, 'home'),
        }),
        dummyServer
      );
      expect(firstRedeem?.status).toBe(200);
      expect((await inbox.take()).t).toBe('enroll.redeemed');
      const hexId = nodeIdToHex(firstCert.nodeId);

      const makeFollowup = async (pop?: string) => {
        const enroll = await createEnrollment(user.root, {
          uid: user.id,
          rootEpoch: 0,
          now,
          ttlMs: 10_000,
        });
        expect(
          (
            await hub.handleRequest(
              new Request('http://hub/api/hub/enrollments', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: enrollmentJson(enroll, now),
              }),
              dummyServer
            )
          )?.status
        ).toBe(201);
        const cert = createNodeCertificate(enroll.enrollSk, {
          uid: user.id,
          edPk: ed.publicKey,
          x25519Pk: x.publicKey,
          enrollPk: enroll.enrollPk,
          now,
          nodeId: firstCert.nodeId,
        });
        return hub.handleRequest(
          new Request('http://hub/api/hub/enrollments/redeem', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: redeemJson(cert, 'home-2', '1.1.0', pop),
          }),
          dummyServer
        );
      };

      const missing = await makeFollowup();
      expect(missing?.status).toBe(409);
      expect(await missing?.json()).toEqual({ error: 'node_exists' });
      expect(userStore.getNode(hexId)?.name).toBe('home');

      const badPop = await makeFollowup(encodeBase64url(new Uint8Array(64).fill(7)));
      expect(badPop?.status).toBe(409);
      expect(await badPop?.json()).toEqual({ error: 'node_exists' });
      expect(userStore.getNode(hexId)?.name).toBe('home');

      const otherEd = generateEd25519KeyPair();
      const otherEnroll = await createEnrollment(user.root, {
        uid: user.id,
        rootEpoch: 0,
        now,
        ttlMs: 10_000,
      });
      expect(
        (
          await hub.handleRequest(
            new Request('http://hub/api/hub/enrollments', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: enrollmentJson(otherEnroll, now),
            }),
            dummyServer
          )
        )?.status
      ).toBe(201);
      const otherCert = createNodeCertificate(otherEnroll.enrollSk, {
        uid: user.id,
        edPk: ed.publicKey,
        x25519Pk: x.publicKey,
        enrollPk: otherEnroll.enrollPk,
        now,
        nodeId: firstCert.nodeId,
      });
      const wrongKey = await hub.handleRequest(
        new Request('http://hub/api/hub/enrollments/redeem', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: redeemJson(
            otherCert,
            'intruder',
            undefined,
            redeemPop(otherEd.secretKey, otherCert)
          ),
        }),
        dummyServer
      );
      expect(wrongKey?.status).toBe(409);
      expect(await wrongKey?.json()).toEqual({ error: 'node_exists' });
      expect(userStore.getNode(hexId)?.name).toBe('home');

      const okEnroll = await createEnrollment(user.root, {
        uid: user.id,
        rootEpoch: 0,
        now,
        ttlMs: 10_000,
      });
      expect(
        (
          await hub.handleRequest(
            new Request('http://hub/api/hub/enrollments', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: enrollmentJson(okEnroll, now),
            }),
            dummyServer
          )
        )?.status
      ).toBe(201);
      const okCert = createNodeCertificate(okEnroll.enrollSk, {
        uid: user.id,
        edPk: ed.publicKey,
        x25519Pk: x.publicKey,
        enrollPk: okEnroll.enrollPk,
        now,
        nodeId: firstCert.nodeId,
      });
      const ok = await hub.handleRequest(
        new Request('http://hub/api/hub/enrollments/redeem', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: redeemJson(okCert, 'home-2', '1.1.0', redeemPop(ed.secretKey, okCert)),
        }),
        dummyServer
      );
      expect(ok?.status).toBe(200);
      expect((await inbox.take()).t).toBe('enroll.redeemed');
      expect(userStore.getNode(hexId)?.name).toBe('home-2');
      expect(userStore.getNode(hexId)?.version).toBe('1.1.0');

      hub.stop();
    } finally {
      close();
    }
  });

  test('同 nodeId 但 X25519 公钥不匹配时 redeem 返回 409 node_exists', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const now = 6_500_000;
      const { hub, user, userStore, service } = await startAuthedHub(db, () => now);
      const ed = generateEd25519KeyPair();
      const x = generateX25519KeyPair();
      const firstEnroll = await createEnrollment(user.root, {
        uid: user.id,
        rootEpoch: 0,
        now,
        ttlMs: 10_000,
      });
      expect(
        (
          await hub.handleRequest(
            new Request('http://hub/api/hub/enrollments', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: enrollmentJson(firstEnroll, now),
            }),
            dummyServer
          )
        )?.status
      ).toBe(201);
      const firstCert = createNodeCertificate(firstEnroll.enrollSk, {
        uid: user.id,
        edPk: ed.publicKey,
        x25519Pk: x.publicKey,
        enrollPk: firstEnroll.enrollPk,
        now,
      });
      expect(
        (
          await hub.handleRequest(
            new Request('http://hub/api/hub/enrollments/redeem', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: redeemJson(firstCert, 'home'),
            }),
            dummyServer
          )
        )?.status
      ).toBe(200);
      const hexId = nodeIdToHex(firstCert.nodeId);
      const secondEnroll = await createEnrollment(user.root, {
        uid: user.id,
        rootEpoch: 0,
        now,
        ttlMs: 10_000,
      });
      expect(
        (
          await hub.handleRequest(
            new Request('http://hub/api/hub/enrollments', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: enrollmentJson(secondEnroll, now),
            }),
            dummyServer
          )
        )?.status
      ).toBe(201);
      const rotatedX = generateX25519KeyPair();
      const rotatedCert = createNodeCertificate(secondEnroll.enrollSk, {
        uid: user.id,
        edPk: ed.publicKey,
        x25519Pk: rotatedX.publicKey,
        enrollPk: secondEnroll.enrollPk,
        now,
        nodeId: firstCert.nodeId,
      });
      const rotated = await hub.handleRequest(
        new Request('http://hub/api/hub/enrollments/redeem', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: redeemJson(
            rotatedCert,
            'home-rotated',
            undefined,
            redeemPop(ed.secretKey, rotatedCert)
          ),
        }),
        dummyServer
      );
      expect(rotated?.status).toBe(409);
      expect(await rotated?.json()).toEqual({ error: 'node_exists' });
      expect(userStore.getNode(hexId)?.name).toBe('home');

      const admitted = await service.signAndApply(user.id, user.root, {
        type: 'admit-node',
        payload: encodeAdmitNodePayload({
          authorization_bytes: firstEnroll.authorizationBytes,
          authorization_sig: firstEnroll.authorizationSig,
          certificate_bytes: firstCert.certificateBytes,
          cert_sig: firstCert.certSig,
        }),
      });
      expect(admitted.ok).toBe(true);
      const thirdEnroll = await createEnrollment(user.root, {
        uid: user.id,
        rootEpoch: 0,
        now,
        ttlMs: 10_000,
      });
      expect(
        (
          await hub.handleRequest(
            new Request('http://hub/api/hub/enrollments', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: enrollmentJson(thirdEnroll, now),
            }),
            dummyServer
          )
        )?.status
      ).toBe(201);
      const admittedRotated = createNodeCertificate(thirdEnroll.enrollSk, {
        uid: user.id,
        edPk: ed.publicKey,
        x25519Pk: rotatedX.publicKey,
        enrollPk: thirdEnroll.enrollPk,
        now,
        nodeId: firstCert.nodeId,
      });
      const admittedMismatch = await hub.handleRequest(
        new Request('http://hub/api/hub/enrollments/redeem', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: redeemJson(
            admittedRotated,
            'home-rotated-2',
            undefined,
            redeemPop(ed.secretKey, admittedRotated)
          ),
        }),
        dummyServer
      );
      expect(admittedMismatch?.status).toBe(409);
      expect(await admittedMismatch?.json()).toEqual({ error: 'node_exists' });
      expect(userStore.getCert(hexId)?.certificateBytes).toEqual(firstCert.certificateBytes);
      hub.stop();
    } finally {
      close();
    }
  });

  test('GET /api/hub/nodes 与 rename；revoke 必须带签名 revoke-node 记录', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const { userStore, keyLogSource, service } = createHubTestStack(db);
      const user = seedUser(userStore);
      const node = seedAdmittedNode(userStore, user.id, { name: 'old' });
      const hub = new HubRuntime({
        db,
        userStore,
        keyLogSource,
        config: { publicUrl: 'https://hub.example', stun: [] },
        authenticate: () => ({ userId: user.id, entryNodeId: node.nodeId }),
        heartbeatIntervalMs: 60_000,
      });

      const listed = await hub.handleRequest(new Request('http://hub/api/hub/nodes'), dummyServer);
      expect(listed).not.toBeUndefined();
      if (!listed) throw new Error('expected list response');
      expect(listed.status).toBe(200);
      const listedBody = (await listed.json()) as { nodes: { id: string; name: string }[] };
      expect(listedBody.nodes[0]?.name).toBe('old');

      const renamed = await hub.handleRequest(
        new Request(`http://hub/api/hub/nodes/${node.nodeId}/rename`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'studio' }),
        }),
        dummyServer
      );
      expect(renamed?.status).toBe(200);
      expect(userStore.getNode(node.nodeId)?.name).toBe('studio');

      const sessionOnly = await hub.handleRequest(
        new Request(`http://hub/api/hub/nodes/${node.nodeId}/revoke`, { method: 'POST' }),
        dummyServer
      );
      expect(sessionOnly?.status).toBe(400);
      expect(userStore.getNode(node.nodeId)?.status).toBe('enrolled');

      const [nodeLink, hubLink] = createInMemoryLinkPair();
      const inbox = ctlInbox(nodeLink);
      hub.attachLocalNode(hubLink);
      const challenge = await inbox.take();
      if (challenge.t !== 'auth.challenge') throw new Error('expected challenge');
      sendCtl(nodeLink, {
        t: 'auth.response',
        node_id: node.nodeId,
        sig: signAuth(node.ed.secretKey, decodeBase64url(challenge.nonce)),
      });
      await inbox.take();
      await inbox.take();
      const closed = hubLink.closed;
      const rec = signUserRecord(
        service,
        user.id,
        user.root,
        'revoke-node',
        encodeRevokeNodePayload({ node_id: node.nodeIdBytes, reason: 'lost' })
      );
      const revoked = await hub.handleRequest(
        new Request(`http://hub/api/hub/nodes/${node.nodeId}/revoke`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            bytes: encodeBase64url(rec.bytes),
            sig: encodeBase64url(rec.sig),
          }),
        }),
        dummyServer
      );
      expect(revoked?.status).toBe(200);
      expect(userStore.getNode(node.nodeId)?.status).toBe('revoked');
      expect(userStore.getCert(node.nodeId)?.revokedLogSeq).not.toBeNull();
      expect((await closed).reason).toBe('revoked');
      hub.stop();
    } finally {
      close();
    }
  });

  test('rotate-root 后旧 enrollment redeem 返回 epoch_mismatch 并作废未用 token', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const now = 3_000_000;
      const { userStore, keyLogSource, service } = createHubTestStack(db);
      const user = seedUser(userStore, { now });
      const hub = new HubRuntime({
        db,
        userStore,
        keyLogSource,
        config: { publicUrl: 'https://hub.example', stun: [] },
        authenticate: () => ({ userId: user.id, entryNodeId: 'entry' }),
        now: () => now,
      });
      const enrollment = await createEnrollment(user.root, {
        uid: user.id,
        rootEpoch: 0,
        now,
        ttlMs: 60_000,
      });
      const created = await hub.handleRequest(
        new Request('http://hub/api/hub/enrollments', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            enroll_pk: encodeBase64url(enrollment.enrollPk),
            authorization: encodeBase64url(enrollment.authorizationBytes),
            authorization_sig: encodeBase64url(enrollment.authorizationSig),
            exp: now + 60_000,
          }),
        }),
        dummyServer
      );
      expect(created?.status).toBe(201);

      const newRoot = rootKeyFromSeed(randomBytes(32));
      const rotated = signUserRecord(
        service,
        user.id,
        user.root,
        'rotate-root',
        encodeRotateRootPayload({
          root_public_key: newRoot.publicKey,
          kdf_params: generateKdfParams(),
        })
      );
      const applied = await keyLogSource.append(user.id, rotated);
      expect(applied.ok).toBe(true);
      if (applied.ok) {
        await hub.uplink.applyAppendEffects(user.id, applied);
      }
      expect(userStore.getEnrollmentTokenByEnrollPublicKey(enrollment.enrollPk)?.expiresAt).toBe(
        now
      );

      const ed = generateEd25519KeyPair();
      const x = generateX25519KeyPair();
      const cert = createNodeCertificate(enrollment.enrollSk, {
        uid: user.id,
        edPk: ed.publicKey,
        x25519Pk: x.publicKey,
        enrollPk: enrollment.enrollPk,
        now,
      });
      const redeem = await hub.handleRequest(
        new Request('http://hub/api/hub/enrollments/redeem', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            certificate: encodeBase64url(cert.certificateBytes),
            cert_sig: encodeBase64url(cert.certSig),
            name: 'stale',
            version: '1',
          }),
        }),
        dummyServer
      );
      expect(redeem?.status).toBe(400);
      expect(await redeem?.json()).toEqual({ error: 'epoch_mismatch' });
      hub.stop();
    } finally {
      close();
    }
  });

  test('rotate-root-keep 后旧 enrollment redeem 返回 epoch_mismatch 并作废未用 token', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const now = 3_000_000;
      const { userStore, keyLogSource, service } = createHubTestStack(db);
      const user = seedUser(userStore, { now });
      const hub = new HubRuntime({
        db,
        userStore,
        keyLogSource,
        config: { publicUrl: 'https://hub.example', stun: [] },
        authenticate: () => ({ userId: user.id, entryNodeId: 'entry' }),
        now: () => now,
      });
      const enrollment = await createEnrollment(user.root, {
        uid: user.id,
        rootEpoch: 0,
        now,
        ttlMs: 60_000,
      });
      const created = await hub.handleRequest(
        new Request('http://hub/api/hub/enrollments', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            enroll_pk: encodeBase64url(enrollment.enrollPk),
            authorization: encodeBase64url(enrollment.authorizationBytes),
            authorization_sig: encodeBase64url(enrollment.authorizationSig),
            exp: now + 60_000,
          }),
        }),
        dummyServer
      );
      expect(created?.status).toBe(201);

      const newRoot = rootKeyFromSeed(randomBytes(32));
      const rotated = signUserRecord(
        service,
        user.id,
        user.root,
        'rotate-root-keep',
        encodeRotateRootKeepPayload({
          root_public_key: newRoot.publicKey,
          kdf_params: generateKdfParams(),
          totp: null,
        })
      );
      const applied = await keyLogSource.append(user.id, rotated);
      expect(applied.ok).toBe(true);
      if (applied.ok) {
        await hub.uplink.applyAppendEffects(user.id, applied);
      }
      expect(userStore.getEnrollmentTokenByEnrollPublicKey(enrollment.enrollPk)?.expiresAt).toBe(
        now
      );

      const ed = generateEd25519KeyPair();
      const x = generateX25519KeyPair();
      const cert = createNodeCertificate(enrollment.enrollSk, {
        uid: user.id,
        edPk: ed.publicKey,
        x25519Pk: x.publicKey,
        enrollPk: enrollment.enrollPk,
        now,
      });
      const redeem = await hub.handleRequest(
        new Request('http://hub/api/hub/enrollments/redeem', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            certificate: encodeBase64url(cert.certificateBytes),
            cert_sig: encodeBase64url(cert.certSig),
            name: 'stale',
            version: '1',
          }),
        }),
        dummyServer
      );
      expect(redeem?.status).toBe(400);
      expect(await redeem?.json()).toEqual({ error: 'epoch_mismatch' });
      hub.stop();
    } finally {
      close();
    }
  });

  test('forwarded rotate-root-keep is blocked by old nodes even with x-tmex-force-keylog', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const { userStore, keyLogSource, service } = createHubTestStack(db);
      const user = seedUser(userStore);
      seedAdmittedNode(userStore, user.id, { name: 'old-node' });
      const hub = new HubRuntime({
        db,
        userStore,
        keyLogSource,
        config: { publicUrl: 'https://hub.example', stun: [] },
        authenticate: () => ({ userId: user.id, entryNodeId: 'entry' }),
      });
      const rec = signUserRecord(
        service,
        user.id,
        user.root,
        'rotate-root-keep',
        encodeRotateRootKeepPayload({
          root_public_key: new Uint8Array(32).fill(9),
          kdf_params: generateKdfParams(),
          totp: null,
        })
      );
      const ack = await hub.executeForwardedWrite('aa'.repeat(16), {
        t: 'hub.write-forward',
        id: 'keep-1',
        method: 'POST',
        path: '/api/auth/keylog',
        uid: user.id,
        headers: { 'content-type': 'application/json', 'x-tmex-force-keylog': '1' },
        body: JSON.stringify({
          bytes: encodeBase64url(rec.bytes),
          sig: encodeBase64url(rec.sig),
        }),
      });
      expect(ack.status).toBe(409);
      expect(JSON.parse(ack.body ?? '{}')).toMatchObject({
        code: 'KEYLOG_TYPE_UNSUPPORTED_BY_NODES',
      });
      hub.stop();
    } finally {
      close();
    }
  });

  test('forwarded rotate-root-keep is blocked by a cert without a nodes row; revoked cert does not block', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const { userStore, keyLogSource, service } = createHubTestStack(db);
      const user = seedUser(userStore);
      const certOnly = seedCertOnly(userStore, user.id);
      const hub = new HubRuntime({
        db,
        userStore,
        keyLogSource,
        config: { publicUrl: 'https://hub.example', stun: [] },
        authenticate: () => ({ userId: user.id, entryNodeId: 'entry' }),
      });
      const rec = signUserRecord(
        service,
        user.id,
        user.root,
        'rotate-root-keep',
        encodeRotateRootKeepPayload({
          root_public_key: new Uint8Array(32).fill(9),
          kdf_params: generateKdfParams(),
          totp: null,
        })
      );
      const body = JSON.stringify({
        bytes: encodeBase64url(rec.bytes),
        sig: encodeBase64url(rec.sig),
      });
      const blocked = await hub.executeForwardedWrite('aa'.repeat(16), {
        t: 'hub.write-forward',
        id: 'keep-cert',
        method: 'POST',
        path: '/api/auth/keylog',
        uid: user.id,
        headers: { 'content-type': 'application/json' },
        body,
      });
      expect(blocked.status).toBe(409);
      expect(JSON.parse(blocked.body ?? '{}')).toMatchObject({
        code: 'KEYLOG_TYPE_UNSUPPORTED_BY_NODES',
      });

      userStore.markCertRevoked(certOnly.nodeId, 9);
      expect(inspectHubAuthRecordCompat(userStore, rec.bytes, user.id)).toEqual({ ok: true });
      hub.stop();
    } finally {
      close();
    }
  });

  test('passkey signer 的 enrollment 通过 WebAuthn assertion 校验', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const now = 4_000_000;
      const { userStore, keyLogSource } = createHubTestStack(db);
      const user = seedUser(userStore, { now });
      const authenticator = await createEs256Authenticator();
      const challenge = randomBytes(32);
      const registration = await authenticator.register({
        challenge,
        rpId: RP_ID,
        origin: ORIGIN,
        counter: 0,
      });
      const payload = await verifyRegistration({
        response: registration,
        expectedChallenge: encodeBase64url(challenge),
        origin: ORIGIN,
        rpId: RP_ID,
      });
      expect(payload).not.toBeNull();
      if (!payload) throw new Error('registration failed');
      userStore.insertKey({
        id: 'key-1',
        userId: user.id,
        credentialId: decodeBase64url(payload.credential_id),
        publicKey: payload.public_key,
        rpId: payload.rp_id,
        origin: payload.origin,
        counter: payload.counter,
        transports: payload.transports,
        name: 'synth',
        logSeq: 1,
        now,
      });

      let counter = 1;
      const enrollment = await createEnrollment(
        {
          credentialId: payload.credential_id,
          async sign(message: Uint8Array) {
            const assertion = await authenticator.assert({
              challenge: sha256(message),
              rpId: RP_ID,
              origin: ORIGIN,
              counter: counter++,
            });
            return encodePasskeyAssertionSig(assertion);
          },
        },
        { uid: user.id, rootEpoch: 0, now, ttlMs: 10_000 }
      );
      const hub = new HubRuntime({
        db,
        userStore,
        keyLogSource,
        config: { publicUrl: 'https://hub.example', stun: [] },
        authenticate: () => ({ userId: user.id, entryNodeId: 'entry' }),
        now: () => now,
      });
      const created = await hub.handleRequest(
        new Request('http://hub/api/hub/enrollments', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            enroll_pk: encodeBase64url(enrollment.enrollPk),
            authorization: encodeBase64url(enrollment.authorizationBytes),
            authorization_sig: encodeBase64url(enrollment.authorizationSig),
            exp: now + 10_000,
          }),
        }),
        dummyServer
      );
      expect(created?.status).toBe(201);

      const rootEnrollment = await createEnrollment(user.root, {
        uid: user.id,
        rootEpoch: 0,
        now,
        ttlMs: 10_000,
      });
      const createdRoot = await hub.handleRequest(
        new Request('http://hub/api/hub/enrollments', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            enroll_pk: encodeBase64url(rootEnrollment.enrollPk),
            authorization: encodeBase64url(rootEnrollment.authorizationBytes),
            authorization_sig: encodeBase64url(rootEnrollment.authorizationSig),
            exp: now + 10_000,
          }),
        }),
        dummyServer
      );
      expect(createdRoot?.status).toBe(201);

      const badPasskey = await hub.handleRequest(
        new Request('http://hub/api/hub/enrollments', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            enroll_pk: encodeBase64url(enrollment.enrollPk),
            authorization: encodeBase64url(enrollment.authorizationBytes),
            authorization_sig: encodeBase64url(randomBytes(64)),
            exp: now + 10_000,
          }),
        }),
        dummyServer
      );
      expect(badPasskey?.status).toBe(400);
      hub.stop();
    } finally {
      close();
    }
  });
});

const WRITER_HUB = 'ab'.repeat(16);
const STANDBY_HUB = 'cd'.repeat(16);

const WRITER_ERROR_BODY = {
  code: HUB_NOT_WRITER,
  writerHubId: WRITER_HUB,
  writerPublicUrl: 'https://writer.example',
  writerEpoch: 5,
};

function seedWriterHub(db: ReturnType<typeof createMigratedAuthDb>['db']): MeshHubStore {
  const meshHubs = new MeshHubStore(db);
  meshHubs.upsert(
    {
      hubNodeId: WRITER_HUB,
      publicUrl: 'https://writer.example',
      name: 'writer',
      mode: 'active',
      priority: 50,
      writerEpoch: 5,
      caFingerprint: null,
      online: true,
      lastSeenAt: 1,
    },
    1
  );
  return meshHubs;
}

describe('HubRuntime multi-hub', () => {
  test('mode()/setMode()/writerEpoch() 与默认 active', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const { userStore, keyLogSource } = createHubTestStack(db);
      const defaultHub = new HubRuntime({
        db,
        userStore,
        keyLogSource,
        config: { publicUrl: 'https://hub.example', stun: [] },
        authenticate: () => null,
      });
      expect(defaultHub.mode()).toBe('active');
      expect(defaultHub.writerEpoch()).toBe(1);
      const hub = new HubRuntime({
        db,
        userStore,
        keyLogSource,
        config: {
          publicUrl: 'https://hub.example',
          stun: [],
          mode: 'active',
          writerEpoch: 4,
          priority: 80,
          hubNodeId: STANDBY_HUB,
        },
        authenticate: () => null,
      });
      expect(hub.mode()).toBe('active');
      expect(hub.writerEpoch()).toBe(4);
      hub.setMode('standby');
      expect(hub.mode()).toBe('standby');
      expect(hub.meshHubs.get(STANDBY_HUB)?.mode).toBe('standby');
      defaultHub.stop();
      hub.stop();
    } finally {
      close();
    }
  });

  test('standby 四条写路由返回 409 HUB_NOT_WRITER；读路由仍 200', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const now = () => 4_000;
      const meshHubs = seedWriterHub(db);
      const { hub, user, entry, userStore, service } = await startAuthedHub(db, now, {
        meshHubs,
        config: {
          publicUrl: 'https://hub.example',
          mode: 'standby',
          priority: 200,
          writerEpoch: 1,
          hubNodeId: STANDBY_HUB,
          authorizedHubIds: [WRITER_HUB],
        },
      });
      expect(hub.mode()).toBe('standby');

      const enroll = await hub.handleRequest(
        new Request('http://hub/api/hub/enrollments', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        }),
        dummyServer
      );
      expect(enroll?.status).toBe(409);
      expect(await enroll?.json()).toEqual(WRITER_ERROR_BODY);

      const redeem = await hub.handleRequest(
        new Request('http://hub/api/hub/enrollments/redeem', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        }),
        dummyServer
      );
      expect(redeem?.status).toBe(409);
      expect(await redeem?.json()).toEqual(WRITER_ERROR_BODY);

      const rename = await hub.handleRequest(
        new Request(`http://hub/api/hub/nodes/${entry.nodeId}/rename`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'nope' }),
        }),
        dummyServer
      );
      expect(rename?.status).toBe(409);
      expect(await rename?.json()).toEqual(WRITER_ERROR_BODY);

      const rec = signUserRecord(
        service,
        user.id,
        user.root,
        'revoke-node',
        encodeRevokeNodePayload({ node_id: entry.nodeIdBytes, reason: 'lost' })
      );
      const revoke = await hub.handleRequest(
        new Request(`http://hub/api/hub/nodes/${entry.nodeId}/revoke`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            bytes: encodeBase64url(rec.bytes),
            sig: encodeBase64url(rec.sig),
          }),
        }),
        dummyServer
      );
      expect(revoke?.status).toBe(409);
      expect(await revoke?.json()).toEqual(WRITER_ERROR_BODY);
      expect(userStore.getNode(entry.nodeId)?.status).toBe('enrolled');

      const listed = await hub.handleRequest(new Request('http://hub/api/hub/nodes'), dummyServer);
      expect(listed?.status).toBe(200);
      const listedBody = (await listed?.json()) as { nodes: { id: string }[] };
      expect(listedBody.nodes.some((n) => n.id === entry.nodeId)).toBe(true);

      const token = userStore.createEnrollmentToken({
        id: 'enroll-read',
        userId: user.id,
        enrollPublicKey: randomBytes(32),
        authorizationJson: JSON.stringify({ authorization_b64: 'x', entry_node_id: entry.nodeId }),
        authorizationSig: randomBytes(64),
        expiresAt: now() + 10_000,
      });
      const got = await hub.handleRequest(
        new Request(`http://hub/api/hub/enrollments/${token.id}`),
        dummyServer
      );
      expect(got?.status).toBe(200);
      hub.stop();
    } finally {
      close();
    }
  });

  test('standby 且未知 writer 时 409 字段为 null', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const { userStore, keyLogSource } = createHubTestStack(db);
      seedUser(userStore);
      const hub = new HubRuntime({
        db,
        userStore,
        keyLogSource,
        config: {
          publicUrl: 'https://standby.example',
          stun: [],
          mode: 'standby',
          hubNodeId: STANDBY_HUB,
          writerEpoch: 1,
          priority: 200,
        },
        authenticate: () => ({ userId: 'user-1', entryNodeId: STANDBY_HUB }),
      });
      const enroll = await hub.handleRequest(
        new Request('http://hub/api/hub/enrollments', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        }),
        dummyServer
      );
      expect(enroll?.status).toBe(409);
      expect(await enroll?.json()).toEqual({
        code: HUB_NOT_WRITER,
        writerHubId: null,
        writerPublicUrl: null,
        writerEpoch: null,
      });
      hub.stop();
    } finally {
      close();
    }
  });

  test('active 但不是 writer（store 中有更高 epoch 的授权 active）拒绝写入', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const now = () => 4_000;
      const { hub, entry } = await startAuthedHub(db, now, {
        config: {
          publicUrl: 'https://hub.example',
          mode: 'active',
          priority: 100,
          writerEpoch: 1,
          hubNodeId: STANDBY_HUB,
          authorizedHubIds: [WRITER_HUB],
        },
      });
      expect(hub.mode()).toBe('active');
      hub.meshHubs.upsert(
        {
          hubNodeId: WRITER_HUB,
          publicUrl: 'https://writer.example',
          name: 'writer',
          mode: 'active',
          priority: 50,
          writerEpoch: 5,
          caFingerprint: null,
          online: true,
          lastSeenAt: 1,
        },
        1
      );
      const enroll = await hub.handleRequest(
        new Request('http://hub/api/hub/enrollments', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        }),
        dummyServer
      );
      expect(enroll?.status).toBe(409);
      expect(await enroll?.json()).toEqual(WRITER_ERROR_BODY);

      const redeem = await hub.handleRequest(
        new Request('http://hub/api/hub/enrollments/redeem', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        }),
        dummyServer
      );
      expect(redeem?.status).toBe(409);

      const rename = await hub.handleRequest(
        new Request(`http://hub/api/hub/nodes/${entry.nodeId}/rename`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'nope' }),
        }),
        dummyServer
      );
      expect(rename?.status).toBe(409);
      hub.stop();
    } finally {
      close();
    }
  });
});

describe('GET /api/hub/status', () => {
  test('无需鉴权，返回 ownHubSnapshot 元数据', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const { userStore, keyLogSource } = createHubTestStack(db);
      seedUser(userStore);
      const hub = new HubRuntime({
        db,
        userStore,
        keyLogSource,
        config: {
          publicUrl: 'https://hub.example',
          stun: [],
          hubNodeId: STANDBY_HUB,
          siteName: 'hub-site',
          mode: 'active',
          priority: 80,
          writerEpoch: 3,
        },
        authenticate: () => null,
        now: () => 12_345,
      });
      const res = await hub.handleRequest(new Request('http://hub/api/hub/status'), dummyServer);
      expect(res?.status).toBe(200);
      const body = (await res?.json()) as Record<string, unknown>;
      expect(body.hubNodeId).toBe(STANDBY_HUB);
      expect(body.publicUrl).toBe('https://hub.example');
      expect(body.mode).toBe('active');
      expect(body.priority).toBe(80);
      expect(body.writerEpoch).toBe(3);
      expect(body.name).toBe('hub-site');
      expect(body).toHaveProperty('caFingerprint');
      expect(body.now).toBe(12_345);
      expect(body.peerPollFast).toBe(false);
      await hub.stop();
    } finally {
      close();
    }
  });
});

async function createEs256Authenticator() {
  const keyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const jwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
  const x = decodeBase64url(jwk.x ?? '');
  const y = decodeBase64url(jwk.y ?? '');
  const credentialId = randomBytes(16);
  const coseKey = encodeCoseEs256(x, y);

  return {
    credentialId,
    async register(input: {
      challenge: Uint8Array;
      rpId: string;
      origin: string;
      counter: number;
    }): Promise<RegistrationResponseJSON> {
      const authData = makeAuthData({
        rpId: input.rpId,
        flags: 0x45,
        counter: input.counter,
        attested: {
          aaguid: new Uint8Array(16),
          credentialId,
          coseKey,
        },
      });
      const clientData = makeClientData('webauthn.create', input.challenge, input.origin);
      const attestationObject = cborMap([
        ['fmt', 'none'],
        ['attStmt', EMPTY_MAP],
        ['authData', authData],
      ]);
      const id = encodeBase64url(credentialId);
      return {
        id,
        rawId: id,
        type: 'public-key',
        response: {
          clientDataJSON: encodeBase64url(clientData),
          attestationObject: encodeBase64url(attestationObject),
          transports: ['internal'],
        },
        clientExtensionResults: {},
      };
    },
    async assert(input: {
      challenge: Uint8Array;
      rpId: string;
      origin: string;
      counter: number;
    }): Promise<AuthenticationResponseJSON> {
      const authData = makeAuthData({
        rpId: input.rpId,
        flags: 0x05,
        counter: input.counter,
      });
      const clientData = makeClientData('webauthn.get', input.challenge, input.origin);
      const signed = concatBytes(authData, sha256(clientData));
      const raw = new Uint8Array(
        await crypto.subtle.sign(
          { name: 'ECDSA', hash: 'SHA-256' },
          keyPair.privateKey,
          signed.slice()
        )
      );
      const id = encodeBase64url(credentialId);
      return {
        id,
        rawId: id,
        type: 'public-key',
        response: {
          clientDataJSON: encodeBase64url(clientData),
          authenticatorData: encodeBase64url(authData),
          signature: encodeBase64url(ieeeP1363ToDer(raw)),
        },
        clientExtensionResults: {},
      };
    },
  };
}

const EMPTY_MAP = Symbol('empty-map');

function encodeCoseEs256(x: Uint8Array, y: Uint8Array): Uint8Array {
  return cborMap([
    [1, 2],
    [3, -7],
    [-1, 1],
    [-2, x],
    [-3, y],
  ]);
}

function makeClientData(type: string, challenge: Uint8Array, origin: string): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      type,
      challenge: encodeBase64url(challenge),
      origin,
      crossOrigin: false,
    })
  );
}

function makeAuthData(opts: {
  rpId: string;
  flags: number;
  counter: number;
  attested?: { aaguid: Uint8Array; credentialId: Uint8Array; coseKey: Uint8Array };
}): Uint8Array {
  const rpIdHash = sha256(new TextEncoder().encode(opts.rpId));
  const count = new Uint8Array(4);
  new DataView(count.buffer).setUint32(0, opts.counter >>> 0, false);
  const parts: Uint8Array[] = [rpIdHash, Uint8Array.of(opts.flags), count];
  if (opts.attested) {
    const idLen = new Uint8Array(2);
    new DataView(idLen.buffer).setUint16(0, opts.attested.credentialId.length, false);
    parts.push(opts.attested.aaguid, idLen, opts.attested.credentialId, opts.attested.coseKey);
  }
  return concatBytes(...parts);
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function cborHead(major: number, n: number): Uint8Array {
  if (n < 24) {
    return Uint8Array.of((major << 5) | n);
  }
  if (n < 256) {
    return Uint8Array.of((major << 5) | 24, n);
  }
  if (n < 65536) {
    return Uint8Array.of((major << 5) | 25, (n >> 8) & 0xff, n & 0xff);
  }
  throw new Error('cbor length too large');
}

function cborInt(n: number): Uint8Array {
  if (n >= 0) {
    return cborHead(0, n);
  }
  return cborHead(1, -1 - n);
}

function cborBytes(bytes: Uint8Array): Uint8Array {
  return concatBytes(cborHead(2, bytes.length), bytes);
}

function cborText(value: string): Uint8Array {
  const encoded = new TextEncoder().encode(value);
  return concatBytes(cborHead(3, encoded.length), encoded);
}

function cborValue(value: unknown): Uint8Array {
  if (value === EMPTY_MAP) {
    return cborHead(5, 0);
  }
  if (value instanceof Uint8Array) {
    return cborBytes(value);
  }
  if (typeof value === 'string') {
    return cborText(value);
  }
  if (typeof value === 'number') {
    return cborInt(value);
  }
  throw new Error('unsupported cbor value');
}

function cborMap(entries: Array<[number | string, unknown]>): Uint8Array {
  const parts: Uint8Array[] = [cborHead(5, entries.length)];
  for (const [key, value] of entries) {
    parts.push(typeof key === 'string' ? cborText(key) : cborInt(key));
    parts.push(cborValue(value));
  }
  return concatBytes(...parts);
}

function ieeeP1363ToDer(raw: Uint8Array): Uint8Array {
  const half = raw.length / 2;
  const r = derInt(raw.subarray(0, half));
  const s = derInt(raw.subarray(half));
  const body = concatBytes(Uint8Array.of(0x02, r.length), r, Uint8Array.of(0x02, s.length), s);
  return concatBytes(Uint8Array.of(0x30, body.length), body);
}

function derInt(bytes: Uint8Array): Uint8Array {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
  const trimmed = bytes.subarray(start);
  if ((trimmed[0] ?? 0) & 0x80) {
    return concatBytes(Uint8Array.of(0), trimmed);
  }
  return trimmed;
}
