import { describe, expect, test } from 'bun:test';
import {
  createEnrollment,
  createNodeCertificate,
  decodeBase64url,
  encodeBase64url,
  generateEd25519KeyPair,
  generateX25519KeyPair,
  nodeIdToHex,
} from '@tmex/shared/auth';
import { createInMemoryLinkPair } from '@tmex/shared/link';
import { createMigratedAuthDb } from '../auth/test-db';
import { UserStore } from '../auth/user-store';
import { HubRuntime } from './hub-runtime';
import {
  MemoryHubKeyLog,
  ctlInbox,
  seedAdmittedNode,
  seedUser,
  sendCtl,
  signAuth,
} from './hub-test-helpers';
import { HUB_UPLINK_PATH, HUB_UPLINK_WS_KIND } from './types';

const dummyServer = { upgrade: () => true };

describe('HubRuntime HTTP', () => {
  test('管理 API 需要鉴权', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const store = new UserStore(db);
      seedUser(store);
      const hub = new HubRuntime({
        db,
        userStore: store,
        keyLogSource: new MemoryHubKeyLog(),
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
      const store = new UserStore(db);
      const hub = new HubRuntime({
        db,
        userStore: store,
        keyLogSource: new MemoryHubKeyLog(),
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
      const store = new UserStore(db);
      const user = seedUser(store, { now });
      const entry = seedAdmittedNode(store, user.id, { name: 'entry', now });
      const keyLog = new MemoryHubKeyLog();
      keyLog.seed(user.id, [{ bytes: new Uint8Array([1]), sig: new Uint8Array(64) }]);
      const hub = new HubRuntime({
        db,
        userStore: store,
        keyLogSource: keyLog,
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
      expect(store.getNode(nodeIdToHex(cert.nodeId))?.name).toBe('laptop');

      const pushed = await inbox.take();
      expect(pushed.t).toBe('enroll.redeemed');
      if (pushed.t === 'enroll.redeemed') {
        expect(pushed.enroll_pk).toBe(encodeBase64url(enrollment.enrollPk));
      }

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

  test('GET /api/hub/nodes 与 rename / revoke', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const store = new UserStore(db);
      const user = seedUser(store);
      const node = seedAdmittedNode(store, user.id, { name: 'old' });
      const hub = new HubRuntime({
        db,
        userStore: store,
        keyLogSource: new MemoryHubKeyLog(),
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
      expect(store.getNode(node.nodeId)?.name).toBe('studio');

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
      const revoked = await hub.handleRequest(
        new Request(`http://hub/api/hub/nodes/${node.nodeId}/revoke`, { method: 'POST' }),
        dummyServer
      );
      expect(revoked?.status).toBe(200);
      expect(store.getNode(node.nodeId)?.status).toBe('revoked');
      expect((await closed).reason).toBe('revoked');
      hub.stop();
    } finally {
      close();
    }
  });
});
