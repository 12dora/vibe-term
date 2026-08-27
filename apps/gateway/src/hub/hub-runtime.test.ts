import { describe, expect, test } from 'bun:test';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import {
  createEnrollment,
  createNodeCertificate,
  decodeBase64url,
  encodeBase64url,
  encodeClearTotpPayload,
  encodeRevokeNodePayload,
  encodeRotateRootPayload,
  generateEd25519KeyPair,
  generateKdfParams,
  generateX25519KeyPair,
  nodeIdToHex,
  randomBytes,
  rootKeyFromSeed,
  sha256,
} from '@tmex/shared/auth';
import { createInMemoryLinkPair } from '@tmex/shared/link';
import { encodePasskeyAssertionSig, verifyRegistration } from '../auth/passkey';
import { createMigratedAuthDb } from '../auth/test-db';
import { HubRuntime } from './hub-runtime';
import {
  createHubTestStack,
  ctlInbox,
  seedAdmittedNode,
  seedUser,
  sendCtl,
  signAuth,
  signUserRecord,
} from './hub-test-helpers';
import { HUB_UPLINK_PATH, HUB_UPLINK_WS_KIND } from './types';

const dummyServer = { upgrade: () => true };
const RP_ID = 'localhost';
const ORIGIN = 'http://localhost:19663';

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
        authenticate: () => ({ userId: user.id, entryNodeId: entry.nodeId }),
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
      };
      expect(createdBody.public_url).toBe('https://hub.example');
      expect(createdBody.id.length).toBeGreaterThan(4);
      const pending = await hub.handleRequest(
        new Request(`http://hub/api/hub/enrollments/${createdBody.id}`),
        dummyServer
      );
      expect(pending?.status).toBe(200);
      expect(await pending?.json()).toEqual({
        status: 'pending',
        enroll_pk: encodeBase64url(enrollment.enrollPk),
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
      };
      expect(enrollBody.status).toBe('redeemed');
      expect(enrollBody.certificate).toBe(encodeBase64url(cert.certificateBytes));
      expect(enrollBody.cert_sig).toBe(encodeBase64url(cert.certSig));
      expect(enrollBody.node_id).toBe(nodeIdToHex(cert.nodeId));

      const listed = await hub.handleRequest(new Request('http://hub/api/hub/nodes'), dummyServer);
      const listedBody = (await listed?.json()) as {
        nodes: Array<{ id: string; certificate?: string; cert_sig?: string }>;
      };
      const laptop = listedBody.nodes.find((n) => n.id === nodeIdToHex(cert.nodeId));
      expect(laptop?.certificate).toBe(encodeBase64url(cert.certificateBytes));
      expect(laptop?.cert_sig).toBe(encodeBase64url(cert.certSig));

      const reused = await redeemReq();
      expect(reused).not.toBeUndefined();
      if (!reused) throw new Error('expected reused response');
      expect(reused.status).toBe(400);
      expect(await reused.json()).toEqual({ error: 'reused' });

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
