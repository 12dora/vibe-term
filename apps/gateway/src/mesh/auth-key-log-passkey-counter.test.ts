// `POST /api/auth/keylog?hub=sync` 会把同一条记录验两次：先预演（确认本地能接受再发给上级），
// 上级确认后再本地落账。计数器会自增的认证器上，预演若把计数器写进库，第二次验签就会因为
// 「新计数器不大于已存计数器」失败——记录在上级已经落库，本机却报错回退。
//
// 因此预演必须无副作用，计数器推进只发生一次，且与记录落库同一个事务。

import { describe, expect, test } from 'bun:test';
import {
  buildKeyLogRecord,
  buildRenameNodePayload,
  encodeAddPasskeyPayload,
  encodeBase64url,
  encodeKeyLogRecord,
  hexToBytes,
  randomBytes,
  sha256,
  signKeyLogRecordWithRoot,
} from '@tmex/shared/auth';
import { ChallengeStore } from '../auth/challenge-store';
import { KeyLogStore } from '../auth/key-log-store';
import { MeshHubStore } from '../auth/mesh-hub-store';
import { ensureNodeIdentity } from '../auth/node-identity-service';
import { NodeIdentityStore } from '../auth/node-identity-store';
import { NodeSessionStore } from '../auth/node-session-store';
import {
  encodePasskeyAssertionSig,
  makeDeferredVerifyPasskeyAssertion,
  verifyRegistration,
} from '../auth/passkey';
import { createEs256Authenticator } from '../auth/passkey-test-fixtures';
import { createMigratedAuthDb } from '../auth/test-db';
import { UserKeyService } from '../auth/user-key-service';
import { UserStore } from '../auth/user-store';
import type { AuthKeyLogPublisher } from './auth-routes';
import { challengeAndLogin } from './auth-routes.test';
import { MeshHttpRuntime } from './mesh-http';

const PASSWORD = 'passkey-counter-1234';
const RP_ID = 'localhost';
const ORIGIN = 'http://localhost';
const START_COUNTER = 7;

function livePublisher(): AuthKeyLogPublisher {
  return {
    publish() {},
    async publishAndAck() {
      return { ok: true as const, seq: 0n };
    },
  };
}

async function boot() {
  const { db, close } = createMigratedAuthDb();
  const userStore = new UserStore(db);
  const nodeSessionStore = new NodeSessionStore(db);
  const keyLogService = new UserKeyService({
    db,
    userStore,
    keyLogStore: new KeyLogStore(db),
    nodeSessionStore,
    // 与 mesh-runtime 同一条接线：验签只累积计数器，落库时才提交。
    deferredPasskeyVerifier: () => makeDeferredVerifyPasskeyAssertion(userStore),
  });
  const identity = await ensureNodeIdentity(new NodeIdentityStore(db));
  const user = await keyLogService.bootstrapUserWithSelfAdmit({
    username: 'passkey-user',
    password: PASSWORD,
    identity,
  });
  userStore.createNode({
    id: identity.nodeIdHex,
    userId: user.userId,
    name: 'self',
    version: '1.1.39',
    now: 1,
  });
  const runtime = new MeshHttpRuntime({
    roles: { hub: false, node: true, relay: false },
    nodeId: identity.nodeIdHex,
    nodePk: identity.edPublicKey,
    userStore,
    keyLogService,
    challengeStore: new ChallengeStore(),
    nodeSessionStore,
    publisher: livePublisher(),
    primaryUserId: user.userId,
    hubStore: new MeshHubStore(db),
  });
  const { sid } = await challengeAndLogin(runtime, user, {
    target: identity.nodeIdHex,
    targetPk: identity.edPublicKey,
  });
  return { db, close, userStore, keyLogService, identity, user, runtime, sid };
}

type Booted = Awaited<ReturnType<typeof boot>>;

/** 注册一把计数器会自增的 ES256 认证器，并用根钥把 `add-passkey` 记录落账。 */
async function addPasskey(b: Booted) {
  const authenticator = await createEs256Authenticator();
  const challenge = randomBytes(32);
  const registration = await authenticator.register({
    challenge,
    rpId: RP_ID,
    origin: ORIGIN,
    counter: START_COUNTER,
  });
  const payload = await verifyRegistration({
    response: registration,
    expectedChallenge: encodeBase64url(challenge),
    origin: ORIGIN,
    rpId: RP_ID,
  });
  if (!payload) throw new Error('registration rejected');
  const state = b.keyLogService.currentState(b.user.userId);
  const record = buildKeyLogRecord(state.head, state.rootEpoch, {
    uid: b.user.userId,
    type: 'add-passkey',
    payload: encodeAddPasskeyPayload({ ...payload, name: 'key' }),
    signer: 'root',
    credential_id: null,
  });
  const bytes = encodeKeyLogRecord(record);
  const applied = await b.keyLogService.apply(b.user.userId, {
    bytes,
    sig: signKeyLogRecordWithRoot(b.user.rootKey, bytes),
  });
  if (!applied.ok) throw new Error(`add-passkey failed: ${applied.error}`);
  return { authenticator, credentialId: payload.credential_id };
}

function storedCounter(b: Booted, credentialId: string): number {
  const row = b.userStore.getKeyByCredentialId(
    Uint8Array.from(Buffer.from(credentialId, 'base64url'))
  );
  if (!row) throw new Error('passkey row missing');
  return row.counter;
}

/** 用 passkey 签一条 rename-node 并按 `hub=sync` 提交。 */
async function postPasskeyRecord(
  b: Booted,
  input: { authenticator: Awaited<ReturnType<typeof createEs256Authenticator>>; counter: number },
  name: string
): Promise<Response> {
  const credentialId = encodeBase64url(input.authenticator.credentialId);
  const state = b.keyLogService.currentState(b.user.userId);
  const record = buildKeyLogRecord(state.head, state.rootEpoch, {
    uid: b.user.userId,
    type: 'rename-node',
    payload: buildRenameNodePayload({ nodeId: hexToBytes(b.identity.nodeIdHex), name }),
    signer: 'passkey',
    credential_id: credentialId,
  });
  const bytes = encodeKeyLogRecord(record);
  const assertion = await input.authenticator.assert({
    challenge: sha256(bytes),
    rpId: RP_ID,
    origin: ORIGIN,
    counter: input.counter,
  });
  const req = new Request('http://localhost/api/auth/keylog?hub=sync', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `tmex_s_self=${b.sid}` },
    body: JSON.stringify({
      bytes: encodeBase64url(bytes),
      sig: encodeBase64url(encodePasskeyAssertionSig(assertion)),
    }),
  });
  const res = await b.runtime.handleRequest(req, { upgrade: () => true });
  if (!(res instanceof Response)) throw new Error('unhandled keylog request');
  return res;
}

describe('hub=sync 下 passkey 记录的计数器', () => {
  test('计数器自增的认证器：预演不写计数器，落账后只推进一次', async () => {
    const b = await boot();
    try {
      const { authenticator, credentialId } = await addPasskey(b);
      expect(storedCounter(b, credentialId)).toBe(START_COUNTER);

      const headBefore = b.keyLogService.currentState(b.user.userId).head.seq;
      const res = await postPasskeyRecord(b, { authenticator, counter: START_COUNTER + 1 }, '书房');
      expect(res.status).toBe(200);
      expect(storedCounter(b, credentialId)).toBe(START_COUNTER + 1);
      // 记录确实落库了（不是「预演过了但落账失败」）。
      expect(b.keyLogService.currentState(b.user.userId).head.seq).toBe(headBefore + 1n);
      expect(b.userStore.getNode(b.identity.nodeIdHex)?.name).toBe('书房');

      // 同一把 passkey 还能接着签下一条：计数器没有被多推进过。
      const again = await postPasskeyRecord(
        b,
        { authenticator, counter: START_COUNTER + 2 },
        '客厅'
      );
      expect(again.status).toBe(200);
      expect(storedCounter(b, credentialId)).toBe(START_COUNTER + 2);
    } finally {
      b.close();
    }
  });

  test('计数器倒退的断言被拒，且不写库', async () => {
    const b = await boot();
    try {
      const { authenticator, credentialId } = await addPasskey(b);
      const headBefore = b.keyLogService.currentState(b.user.userId).head.seq;
      const res = await postPasskeyRecord(b, { authenticator, counter: START_COUNTER }, '书房');
      expect(res.status).toBe(400);
      expect(storedCounter(b, credentialId)).toBe(START_COUNTER);
      expect(b.keyLogService.currentState(b.user.userId).head.seq).toBe(headBefore);
    } finally {
      b.close();
    }
  });
});
