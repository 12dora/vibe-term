// enrollment / admit / revoke：pending 落 sessionStorage、证书匹配、admit-node 记录能过
// `@tmex/shared/auth` 的验签与 reducer、非匹配证书忽略、过期 pending 拒绝、revoke 记录形状。

import { beforeEach, describe, expect, test } from 'bun:test';
import {
  SIGNER_REUSE_WINDOW_MS,
  forgetSigner,
  rememberSigner,
  takeRememberedSigner,
} from '@/auth/credential-prompt';
import { buildAddPasskeyRecord } from '@/auth/key-log-actions';
import type { AuthenticationResponseJSON } from '@tmex/api-client/auth/index';
import type { VerifyPasskeyAssertion } from '@tmex/shared/auth';
import {
  applyKeyLogRecord,
  computeRecordHash,
  concatBytes,
  createEnrollment,
  createNodeCertificate,
  decodeAdmitNodePayload,
  decodeAuthorization,
  decodeBase64url,
  decodeJoinToken,
  decodeKeyLogRecord,
  decodePasskeyAssertion,
  decodeRevokeNodePayload,
  emptyUserKeyState,
  encodeBase64url,
  encodeJoinToken,
  generateEd25519KeyPair,
  generateKdfParams,
  genesisHead,
  randomBytes,
  rootKeyFromSeed,
  sha256,
  signEd25519,
  verifyEd25519,
  verifyKeyLogRecord,
} from '@tmex/shared/auth';
import type { PendingStorage } from './enrollment';
import {
  PENDING_STORAGE_KEY,
  type PendingEnrollment,
  addPendingEnrollment,
  admitDisposition,
  admitPlan,
  buildAdmitNodeRecord,
  buildRevokeNodeRecord,
  classifyKeyLogFailure,
  clearPendingEnrollments,
  clearUnconfirmedRecords,
  createEnrollmentOnHub,
  encodeJoinTokenZeroing,
  findPendingForCertificate,
  forgetUnconfirmedRecord,
  isTrustedHubUrl,
  joinCommand,
  listPendingEnrollments,
  listUnconfirmedRecordIds,
  matchPendingCertificate,
  nextPendingExpiry,
  prunePendingEnrollments,
  removePendingEnrollment,
  requireRootPublicKey,
  setPendingStorage,
  submitAdmitRecord,
  subscribeUnconfirmedRecords,
  unconfirmedRecord,
} from './enrollment';
import { offerCertificate } from './enrollment-watch';
import type { HubApi } from './hub-api';

function memoryStorage(): PendingStorage & { dump(): Record<string, string> } {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
    dump: () => Object.fromEntries(values),
  };
}

const UID = 'user-1';
const ROOT_EPOCH = 3;
const NOW = 1_700_000_000_000;

const rootKey = rootKeyFromSeed(new Uint8Array(32).fill(0x42));

// ---------------------------------------------------------------------------
// 假 passkey：真实认证器签的是 `authenticator_data ‖ sha256(client_data_json)`，
// challenge 写在 client_data 里。这里用 Ed25519 顶替 ES256，验签器与它对拍。
// ---------------------------------------------------------------------------

const CREDENTIAL_ID = 'cred-1';
const passkeyPair = generateEd25519KeyPair();
const AUTHENTICATOR_DATA = new Uint8Array(37).fill(0x11);

function fakeAssert(challenge: Uint8Array, credentialId: string): AuthenticationResponseJSON {
  const clientDataJSON = new TextEncoder().encode(
    JSON.stringify({
      type: 'webauthn.get',
      challenge: encodeBase64url(challenge),
      origin: 'https://hub.example',
    })
  );
  const signature = signEd25519(
    passkeyPair.secretKey,
    concatBytes(AUTHENTICATOR_DATA, sha256(clientDataJSON))
  );
  return {
    id: credentialId,
    rawId: credentialId,
    type: 'public-key',
    clientExtensionResults: {},
    response: {
      clientDataJSON: encodeBase64url(clientDataJSON),
      authenticatorData: encodeBase64url(AUTHENTICATOR_DATA),
      signature: encodeBase64url(signature),
    },
  };
}

const passkeySigner = {
  kind: 'passkey',
  credentialId: CREDENTIAL_ID,
  assert: (challenge: Uint8Array, credentialId: string) =>
    Promise.resolve(fakeAssert(challenge, credentialId)),
} as const;

/** 共享验签器的 `verifyPasskeyAssertion` 钩子：解 Borsh 断言、核 challenge、验 Ed25519。 */
const verifyPasskeyAssertion: VerifyPasskeyAssertion = ({
  sig,
  credentialId,
  publicKey,
  challenge,
}) => {
  const assertion = decodePasskeyAssertion(sig);
  if (assertion.credential_id !== credentialId) return false;
  const clientData = JSON.parse(new TextDecoder().decode(assertion.client_data_json)) as {
    type: string;
    challenge: string;
  };
  if (clientData.type !== 'webauthn.get') return false;
  if (clientData.challenge !== encodeBase64url(challenge)) return false;
  return verifyEd25519(
    assertion.signature,
    concatBytes(assertion.authenticator_data, sha256(assertion.client_data_json)),
    publicKey
  );
};

/** 一条由根钥签的 `add-passkey`：让状态机认识上面那把假 passkey。 */
async function applyAddPasskey(state: ReturnType<typeof emptyUserKeyState>) {
  const record = await buildAddPasskeyRecord({
    head: state.head,
    rootEpoch: ROOT_EPOCH,
    uid: UID,
    payload: {
      credential_id: CREDENTIAL_ID,
      public_key: passkeyPair.publicKey,
      rp_id: 'hub.example',
      origin: 'https://hub.example',
      counter: 0,
      transports: ['internal'],
      backup_eligible: false,
      backup_state: false,
      device_type: 'singleDevice',
      name: 'laptop',
    },
    signer: { kind: 'root', rootKey },
  });
  const applied = await applyKeyLogRecord(
    state,
    decodeKeyLogRecord(record.bytes),
    computeRecordHash(record.bytes, record.sig)
  );
  if (!applied.ok) throw new Error(`add-passkey rejected: ${applied.error}`);
  return applied.state;
}

async function makeEnrollment(now = NOW) {
  const enrollment = await createEnrollment(rootKey, {
    uid: UID,
    rootEpoch: ROOT_EPOCH,
    now,
  });
  const pending: PendingEnrollment = {
    hubEnrollmentId: 'enroll-1',
    enrollPk: encodeBase64url(enrollment.enrollPk),
    authorizationBytes: encodeBase64url(enrollment.authorizationBytes),
    authorizationSig: encodeBase64url(enrollment.authorizationSig),
    exp: now + 10 * 60 * 1000,
    name: 'studio',
    createdAt: now,
  };
  return { enrollment, pending };
}

function makeCertificate(enrollSk: Uint8Array, enrollPk: Uint8Array, now = NOW) {
  const ed = generateEd25519KeyPair();
  const x = generateEd25519KeyPair();
  return createNodeCertificate(enrollSk, {
    uid: UID,
    edPk: ed.publicKey,
    x25519Pk: x.publicKey,
    enrollPk,
    now,
  });
}

let storage: ReturnType<typeof memoryStorage>;

beforeEach(() => {
  storage = memoryStorage();
  setPendingStorage(storage);
  clearPendingEnrollments();
});

describe('pending 存储', () => {
  test('写入后落到 sessionStorage 且可重新读出（模拟页面刷新）', async () => {
    const { pending } = await makeEnrollment();
    addPendingEnrollment(pending);

    const raw = storage.dump()[PENDING_STORAGE_KEY];
    expect(raw).toBeString();
    expect(JSON.parse(raw)).toEqual([pending]);

    // 重新装一次 storage = 刷新页面后从 sessionStorage 恢复
    setPendingStorage(storage);
    expect(listPendingEnrollments()).toEqual([pending]);
  });

  test('落盘内容里绝不出现 enroll_sk 或 join 串', async () => {
    const { enrollment, pending } = await makeEnrollment();
    addPendingEnrollment(pending);
    const raw = storage.dump()[PENDING_STORAGE_KEY];
    expect(raw).not.toContain(encodeBase64url(enrollment.enrollSk));
    const parsed = JSON.parse(raw) as Record<string, unknown>[];
    expect(Object.keys(parsed[0]).sort()).toEqual([
      'authorizationBytes',
      'authorizationSig',
      'createdAt',
      'enrollPk',
      'exp',
      'hubEnrollmentId',
      'name',
    ]);
  });

  test('旧格式（含 enrollSk / joinToken）读回时整条丢弃，不再写回', async () => {
    storage.setItem(
      PENDING_STORAGE_KEY,
      JSON.stringify([
        {
          hubEnrollmentId: 'legacy',
          enrollPk: 'pk',
          enrollSk: 'SECRET',
          authorizationBytes: 'a',
          authorizationSig: 's',
          exp: NOW + 1000,
          joinToken: 'x'.repeat(128),
        },
      ])
    );
    setPendingStorage(storage);
    expect(listPendingEnrollments()).toEqual([]);
  });

  test('读到旧格式时**立刻把存储里的秘密删掉**，不是只从内存结果里过滤', () => {
    storage.setItem(
      PENDING_STORAGE_KEY,
      JSON.stringify([
        {
          hubEnrollmentId: 'legacy',
          enrollPk: 'pk',
          enrollSk: 'SECRET-ENROLL-SK',
          authorizationBytes: 'a',
          authorizationSig: 's',
          exp: NOW + 1000,
          joinToken: 'x'.repeat(128),
        },
      ])
    );
    setPendingStorage(storage);

    listPendingEnrollments();

    // 同源脚本再也读不到那把私钥
    expect(storage.dump()[PENDING_STORAGE_KEY]).toBeUndefined();
    expect(JSON.stringify(storage.dump())).not.toContain('SECRET-ENROLL-SK');
  });

  test('带秘密味道字段的整条丢弃，其余只以公开投影重写回去', () => {
    const base = {
      hubEnrollmentId: 'ok',
      enrollPk: 'pk',
      authorizationBytes: 'a',
      authorizationSig: 's',
      exp: NOW + 1000,
      name: null,
      createdAt: NOW,
    };
    storage.setItem(
      PENDING_STORAGE_KEY,
      JSON.stringify([
        { ...base, hubEnrollmentId: 'legacy', joinToken: 'T' },
        // 将来某个分支塞进来的秘密：名字带 secret/sk/token 一律整条不要
        { ...base, hubEnrollmentId: 'leaky', sessionSecret: 'LEAK' },
        // 无害的多余字段：记录留下，但字段不写回去
        { ...base, note: 'STRIPPED' },
      ])
    );
    setPendingStorage(storage);

    const rows = listPendingEnrollments();
    expect(rows.map((row) => row.hubEnrollmentId)).toEqual(['ok']);

    const raw = storage.dump()[PENDING_STORAGE_KEY];
    expect(raw).not.toContain('LEAK');
    expect(raw).not.toContain('STRIPPED');
    expect(raw).not.toContain('joinToken');
    expect(Object.keys(JSON.parse(raw)[0]).sort()).toEqual([
      'authorizationBytes',
      'authorizationSig',
      'createdAt',
      'enrollPk',
      'exp',
      'hubEnrollmentId',
      'name',
    ]);
  });

  test('本来就干净的存储不做无谓重写', async () => {
    const { pending } = await makeEnrollment();
    addPendingEnrollment(pending);
    const before = storage.dump()[PENDING_STORAGE_KEY];
    setPendingStorage(storage);
    expect(listPendingEnrollments()).toEqual([pending]);
    expect(storage.dump()[PENDING_STORAGE_KEY]).toBe(before);
  });

  test('同 id 覆盖而不是重复追加，删除后为空', async () => {
    const { pending } = await makeEnrollment();
    addPendingEnrollment(pending);
    addPendingEnrollment({ ...pending, name: 'renamed' });
    expect(listPendingEnrollments()).toHaveLength(1);
    expect(listPendingEnrollments()[0].name).toBe('renamed');
    removePendingEnrollment(pending.hubEnrollmentId);
    expect(listPendingEnrollments()).toEqual([]);
  });

  test('过期 pending 被 prune 掉，并返回被丢弃的那些', async () => {
    const { pending } = await makeEnrollment();
    addPendingEnrollment(pending);
    expect(prunePendingEnrollments(pending.exp - 1)).toHaveLength(0);
    expect(listPendingEnrollments()).toHaveLength(1);
    expect(prunePendingEnrollments(pending.exp + 1)).toEqual([pending]);
    expect(listPendingEnrollments()).toEqual([]);
  });

  test('nextPendingExpiry 取最早的过期时刻', async () => {
    const { pending } = await makeEnrollment();
    expect(nextPendingExpiry([])).toBeNull();
    expect(
      nextPendingExpiry([pending, { ...pending, hubEnrollmentId: 'b', exp: pending.exp - 5 }])
    ).toBe(pending.exp - 5);
  });
});

describe('createEnrollmentOnHub', () => {
  const headHash = new Uint8Array(32).fill(7);

  function fakeHub(created: Record<string, string>[], extras?: { ca_fingerprint?: string }) {
    return {
      createEnrollment: (body: Record<string, string>) => {
        created.push(body);
        return Promise.resolve({
          ok: true,
          id: 'e-1',
          expires_at: NOW + 60_000,
          public_url: 'https://hub.example',
          ca_fingerprint: extras?.ca_fingerprint,
        });
      },
    } as unknown as HubApi;
  }

  test('join 串只在返回值里，pending 不含私钥，且 enroll_sk 用后即清零', async () => {
    const created: Record<string, string>[] = [];
    const hubApi = fakeHub(created);

    const outcome = await createEnrollmentOnHub({
      hubApi,
      uid: UID,
      rootEpoch: ROOT_EPOCH,
      signer: { kind: 'root', rootKey },
      rootPublicKey: rootKey.publicKey,
      keyLogHeadHash: headHash,
      name: 'studio',
      now: NOW,
    });

    expect(outcome.joinToken).toHaveLength(128);
    expect(outcome.hubPublicUrl).toBe('https://hub.example');
    expect(outcome.pending.hubEnrollmentId).toBe('e-1');
    expect(Object.keys(outcome.pending)).not.toContain('enrollSk');
    expect(JSON.stringify(outcome.pending)).not.toContain(outcome.joinToken);

    // join 串里前 32 字节就是 enroll_sk；此刻内存里的那份必须已经清零。
    const token = decodeJoinToken(outcome.joinToken);
    expect(token.enrollSk.some((byte) => byte !== 0)).toBe(true);
    expect(encodeBase64url(token.rootPublicKey)).toBe(encodeBase64url(rootKey.publicKey));
    expect(encodeBase64url(token.keyLogHeadHash)).toBe(encodeBase64url(headHash));
    expect(created).toHaveLength(1);
    expect(listPendingEnrollments()).toEqual([outcome.pending]);

    // 根钥路径的授权签名仍是裸 64 字节 Ed25519。
    const authorization = decodeAuthorization(decodeBase64url(outcome.pending.authorizationBytes));
    expect(authorization.signer).toBe('root');
    expect(authorization.credential_id).toBeNull();
    expect(decodeBase64url(outcome.pending.authorizationSig)).toHaveLength(64);
  });

  test('hub 返回 ca_fingerprint 时 join 串带 v2 段', async () => {
    const fingerprint = 'cd'.repeat(32);
    const outcome = await createEnrollmentOnHub({
      hubApi: fakeHub([], { ca_fingerprint: fingerprint }),
      uid: UID,
      rootEpoch: ROOT_EPOCH,
      signer: { kind: 'root', rootKey },
      rootPublicKey: rootKey.publicKey,
      keyLogHeadHash: headHash,
      now: NOW,
    });
    expect(decodeJoinToken(outcome.joinToken).caFingerprint).toBe(fingerprint);
    expect(outcome.joinToken.endsWith(`.${fingerprint}`)).toBe(true);
  });

  test('passkey 签授权：signer=passkey、credential_id 落在授权里，sig 是 Borsh 断言', async () => {
    const created: Record<string, string>[] = [];
    const outcome = await createEnrollmentOnHub({
      hubApi: fakeHub(created),
      uid: UID,
      rootEpoch: ROOT_EPOCH,
      signer: passkeySigner,
      rootPublicKey: rootKey.publicKey,
      keyLogHeadHash: headHash,
      name: 'studio',
      now: NOW,
    });

    const authorizationBytes = decodeBase64url(outcome.pending.authorizationBytes);
    const authorization = decodeAuthorization(authorizationBytes);
    expect(authorization.signer).toBe('passkey');
    expect(authorization.credential_id).toBe(CREDENTIAL_ID);
    expect(authorization.uid).toBe(UID);
    expect(authorization.root_epoch).toBe(ROOT_EPOCH);

    // 断言字节不是 64 字节裸签名，而是 Borsh PasskeyAssertion，challenge = sha256(授权字节)。
    const sig = decodeBase64url(outcome.pending.authorizationSig);
    expect(sig.length).not.toBe(64);
    expect(decodePasskeyAssertion(sig).credential_id).toBe(CREDENTIAL_ID);
    expect(
      verifyPasskeyAssertion({
        recordBytes: authorizationBytes,
        sig,
        credentialId: CREDENTIAL_ID,
        publicKey: passkeyPair.publicKey,
        challenge: sha256(authorizationBytes),
      })
    ).toBe(true);

    // 手上没有根钥也照样能拼 join 串：第二段来自 /api/auth/mode 的 rootPublicKey。
    const token = decodeJoinToken(outcome.joinToken);
    expect(encodeBase64url(token.rootPublicKey)).toBe(encodeBase64url(rootKey.publicKey));
    expect(encodeBase64url(token.keyLogHeadHash)).toBe(encodeBase64url(headHash));
    expect(created[0].authorization_sig).toBe(outcome.pending.authorizationSig);
  });

  test('断言返回的 credential 与请求的不一致时直接拒绝', async () => {
    await expect(
      createEnrollmentOnHub({
        hubApi: fakeHub([]),
        uid: UID,
        rootEpoch: ROOT_EPOCH,
        signer: {
          kind: 'passkey',
          credentialId: CREDENTIAL_ID,
          assert: (challenge) => Promise.resolve(fakeAssert(challenge, 'other-cred')),
        },
        rootPublicKey: rootKey.publicKey,
        keyLogHeadHash: headHash,
        now: NOW,
      })
    ).rejects.toThrow('credential mismatch');
  });

  test('根公钥长度不对时不生成任何东西', async () => {
    await expect(
      createEnrollmentOnHub({
        hubApi: fakeHub([]),
        uid: UID,
        rootEpoch: ROOT_EPOCH,
        signer: { kind: 'root', rootKey },
        rootPublicKey: new Uint8Array(16),
        keyLogHeadHash: headHash,
        now: NOW,
      })
    ).rejects.toThrow('32 bytes');
    expect(listPendingEnrollments()).toEqual([]);
  });
});

describe('requireRootPublicKey', () => {
  test('base64url 的 32 字节根公钥原样解出', () => {
    expect(
      encodeBase64url(requireRootPublicKey({ rootPublicKey: encodeBase64url(rootKey.publicKey) }))
    ).toBe(encodeBase64url(rootKey.publicKey));
  });

  test('缺失 / 长度不对 / 畸形一律按协议不兼容中止，绝不猜', () => {
    expect(() => requireRootPublicKey({})).toThrow('rootPublicKey');
    expect(() => requireRootPublicKey({ rootPublicKey: null })).toThrow('rootPublicKey');
    expect(() =>
      requireRootPublicKey({ rootPublicKey: encodeBase64url(new Uint8Array(16)) })
    ).toThrow('rootPublicKey');
    expect(() => requireRootPublicKey({ rootPublicKey: '@@@' })).toThrow('rootPublicKey');
  });
});

describe('证书匹配', () => {
  test('enroll_pk 命中且 cert_sig 有效 → ok，并给出 node id hex', async () => {
    const { enrollment, pending } = await makeEnrollment();
    const cert = makeCertificate(enrollment.enrollSk, enrollment.enrollPk);
    const match = matchPendingCertificate(
      pending,
      {
        certificate: encodeBase64url(cert.certificateBytes),
        certSig: encodeBase64url(cert.certSig),
      },
      NOW
    );
    expect(match.ok).toBe(true);
    if (!match.ok) return;
    expect(match.nodeIdHex).toHaveLength(32);
  });

  test('别人的 enroll key 签出来的证书 → enroll_pk_mismatch，且 offerCertificate 报 unknown', async () => {
    const { pending } = await makeEnrollment();
    const other = await createEnrollment(rootKey, { uid: UID, rootEpoch: ROOT_EPOCH, now: NOW });
    const cert = makeCertificate(other.enrollSk, other.enrollPk);
    const candidate = {
      certificate: encodeBase64url(cert.certificateBytes),
      certSig: encodeBase64url(cert.certSig),
    };
    const match = matchPendingCertificate(pending, candidate, NOW);
    expect(match).toEqual({ ok: false, reason: 'enroll_pk_mismatch' });
    expect(findPendingForCertificate([pending], candidate, NOW)).toBeNull();
    expect(offerCertificate([pending], candidate, NOW)).toEqual({ kind: 'unknown' });
  });

  test('cert_sig 被篡改 → bad_cert_sig', async () => {
    const { enrollment, pending } = await makeEnrollment();
    const cert = makeCertificate(enrollment.enrollSk, enrollment.enrollPk);
    const tampered = new Uint8Array(cert.certSig);
    tampered[0] ^= 0xff;
    const outcome = offerCertificate(
      [pending],
      {
        certificate: encodeBase64url(cert.certificateBytes),
        certSig: encodeBase64url(tampered),
      },
      NOW
    );
    expect(outcome).toEqual({ kind: 'invalid', pending, reason: 'bad_cert_sig' });
  });

  test('pending 已过期 → 拒绝 admit', async () => {
    const { enrollment, pending } = await makeEnrollment();
    const cert = makeCertificate(enrollment.enrollSk, enrollment.enrollPk);
    const outcome = offerCertificate(
      [pending],
      {
        certificate: encodeBase64url(cert.certificateBytes),
        certSig: encodeBase64url(cert.certSig),
      },
      pending.exp + 1
    );
    expect(outcome).toEqual({ kind: 'invalid', pending, reason: 'expired' });
  });

  test('畸形证书串直接判 unknown，不抛异常', async () => {
    const { pending } = await makeEnrollment();
    expect(offerCertificate([pending], { certificate: '@@@', certSig: '@@@' }, NOW)).toEqual({
      kind: 'unknown',
    });
  });
});

describe('admit-node 记录', () => {
  test('构造出的记录能过共享验签器与 reducer，内嵌证书链完整', async () => {
    const { enrollment, pending } = await makeEnrollment();
    const cert = makeCertificate(enrollment.enrollSk, enrollment.enrollPk);
    const record = await buildAdmitNodeRecord({
      head: genesisHead(),
      rootEpoch: ROOT_EPOCH,
      uid: UID,
      pending,
      certificateBytes: cert.certificateBytes,
      certSig: cert.certSig,
      signer: { kind: 'root', rootKey },
    });

    const verified = await verifyKeyLogRecord(record.bytes, record.sig, {
      head: genesisHead(),
      rootEpoch: ROOT_EPOCH,
      rootPublicKey: rootKey.publicKey,
      resolvePasskey: () => null,
    });
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.record.type).toBe('admit-node');

    const payload = decodeAdmitNodePayload(verified.record.payload);
    expect(encodeBase64url(payload.authorization_bytes)).toBe(pending.authorizationBytes);
    expect(encodeBase64url(payload.authorization_sig)).toBe(pending.authorizationSig);
    expect(encodeBase64url(payload.certificate_bytes)).toBe(encodeBase64url(cert.certificateBytes));

    const state = emptyUserKeyState(rootKey.publicKey, generateKdfParams(), ROOT_EPOCH);
    const applied = await applyKeyLogRecord(
      state,
      verified.record,
      computeRecordHash(record.bytes, record.sig)
    );
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.state.nodeCerts.size).toBe(1);
  });

  test('passkey 签的 admit-node：记录与内嵌授权都由断言验证，reducer 认下证书', async () => {
    // 授权与记录都用同一把 passkey 签（enroll 与 admit 都不需要根钥在手）。
    const created: Record<string, string>[] = [];
    const outcome = await createEnrollmentOnHub({
      hubApi: {
        createEnrollment: (body: Record<string, string>) => {
          created.push(body);
          return Promise.resolve({ ok: true, id: 'e-pk', expires_at: NOW + 60_000 });
        },
      } as unknown as HubApi,
      uid: UID,
      rootEpoch: ROOT_EPOCH,
      signer: passkeySigner,
      rootPublicKey: rootKey.publicKey,
      keyLogHeadHash: new Uint8Array(32).fill(7),
      now: NOW,
    });
    const enrollSk = decodeJoinToken(outcome.joinToken).enrollSk;
    const cert = makeCertificate(enrollSk, decodeBase64url(outcome.pending.enrollPk));

    // 状态机先认下这把 passkey（一条根钥签的 add-passkey）。
    let state = emptyUserKeyState(rootKey.publicKey, generateKdfParams(), ROOT_EPOCH);
    state = await applyAddPasskey(state);
    expect(state.passkeys.get(CREDENTIAL_ID)?.public_key).toEqual(passkeyPair.publicKey);

    const record = await buildAdmitNodeRecord({
      head: state.head,
      rootEpoch: ROOT_EPOCH,
      uid: UID,
      pending: outcome.pending,
      certificateBytes: cert.certificateBytes,
      certSig: cert.certSig,
      signer: passkeySigner,
    });

    const decoded = decodeKeyLogRecord(record.bytes);
    expect(decoded.signer).toBe('passkey');
    expect(decoded.credential_id).toBe(CREDENTIAL_ID);

    const verified = await verifyKeyLogRecord(record.bytes, record.sig, {
      head: state.head,
      rootEpoch: ROOT_EPOCH,
      rootPublicKey: rootKey.publicKey,
      resolvePasskey: (id) => (id === CREDENTIAL_ID ? passkeyPair.publicKey : null),
      verifyPasskeyAssertion,
    });
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;

    const applied = await applyKeyLogRecord(
      state,
      verified.record,
      computeRecordHash(record.bytes, record.sig),
      { verifyPasskeyAssertion }
    );
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.state.nodeCerts.size).toBe(1);
  });

  test('没有 verifyPasskeyAssertion 钩子时，passkey 记录一律 unknown_signer', async () => {
    const { enrollment, pending } = await makeEnrollment();
    const cert = makeCertificate(enrollment.enrollSk, enrollment.enrollPk);
    const record = await buildAdmitNodeRecord({
      head: genesisHead(),
      rootEpoch: ROOT_EPOCH,
      uid: UID,
      pending,
      certificateBytes: cert.certificateBytes,
      certSig: cert.certSig,
      signer: passkeySigner,
    });
    const verified = await verifyKeyLogRecord(record.bytes, record.sig, {
      head: genesisHead(),
      rootEpoch: ROOT_EPOCH,
      rootPublicKey: rootKey.publicKey,
      resolvePasskey: (id) => (id === CREDENTIAL_ID ? passkeyPair.publicKey : null),
    });
    expect(verified).toEqual({ ok: false, error: 'unknown_signer' });
  });

  test('用错的根钥验签必然失败', async () => {
    const { enrollment, pending } = await makeEnrollment();
    const cert = makeCertificate(enrollment.enrollSk, enrollment.enrollPk);
    const record = await buildAdmitNodeRecord({
      head: genesisHead(),
      rootEpoch: ROOT_EPOCH,
      uid: UID,
      pending,
      certificateBytes: cert.certificateBytes,
      certSig: cert.certSig,
      signer: { kind: 'root', rootKey },
    });
    const wrong = rootKeyFromSeed(randomBytes(32));
    const verified = await verifyKeyLogRecord(record.bytes, record.sig, {
      head: genesisHead(),
      rootEpoch: ROOT_EPOCH,
      rootPublicKey: wrong.publicKey,
      resolvePasskey: () => null,
    });
    expect(verified).toEqual({ ok: false, error: 'bad_signature' });
  });
});

describe('revoke-node 记录', () => {
  const nodeIdHex = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

  test('payload 里是 16 字节 node_id 与原因，签名能验', async () => {
    const record = await buildRevokeNodeRecord({
      head: genesisHead(),
      rootEpoch: ROOT_EPOCH,
      uid: UID,
      nodeIdHex,
      reason: '设备遗失',
      signer: { kind: 'root', rootKey },
    });
    const decoded = decodeKeyLogRecord(record.bytes);
    expect(decoded.type).toBe('revoke-node');
    expect(decoded.uid).toBe(UID);
    expect(decoded.root_epoch).toBe(ROOT_EPOCH);
    expect(decoded.seq).toBe(1n);

    const payload = decodeRevokeNodePayload(decoded.payload);
    expect(payload.node_id).toHaveLength(16);
    expect(payload.reason).toBe('设备遗失');

    const verified = await verifyKeyLogRecord(record.bytes, record.sig, {
      head: genesisHead(),
      rootEpoch: ROOT_EPOCH,
      rootPublicKey: rootKey.publicKey,
      resolvePasskey: () => null,
    });
    expect(verified.ok).toBe(true);
  });

  test('passkey 也能签 revoke-node：signer/credential_id 落在记录里且验签通过', async () => {
    const record = await buildRevokeNodeRecord({
      head: genesisHead(),
      rootEpoch: ROOT_EPOCH,
      uid: UID,
      nodeIdHex,
      reason: '设备遗失',
      signer: passkeySigner,
    });
    const decoded = decodeKeyLogRecord(record.bytes);
    expect(decoded.signer).toBe('passkey');
    expect(decoded.credential_id).toBe(CREDENTIAL_ID);
    expect(decodePasskeyAssertion(record.sig).credential_id).toBe(CREDENTIAL_ID);

    const verified = await verifyKeyLogRecord(record.bytes, record.sig, {
      head: genesisHead(),
      rootEpoch: ROOT_EPOCH,
      rootPublicKey: rootKey.publicKey,
      resolvePasskey: (id) => (id === CREDENTIAL_ID ? passkeyPair.publicKey : null),
      verifyPasskeyAssertion,
    });
    expect(verified.ok).toBe(true);

    // 断言被篡改就必须挂：challenge 绑的是记录字节本身。
    const tampered = await buildRevokeNodeRecord({
      head: genesisHead(),
      rootEpoch: ROOT_EPOCH,
      uid: UID,
      nodeIdHex,
      reason: '换了个理由',
      signer: passkeySigner,
    });
    const crossed = await verifyKeyLogRecord(tampered.bytes, record.sig, {
      head: genesisHead(),
      rootEpoch: ROOT_EPOCH,
      rootPublicKey: rootKey.publicKey,
      resolvePasskey: (id) => (id === CREDENTIAL_ID ? passkeyPair.publicKey : null),
      verifyPasskeyAssertion,
    });
    expect(crossed).toEqual({ ok: false, error: 'bad_signature' });
  });

  test('node id 长度不对直接拒绝', async () => {
    await expect(
      buildRevokeNodeRecord({
        head: genesisHead(),
        rootEpoch: ROOT_EPOCH,
        uid: UID,
        nodeIdHex: 'abcd',
        reason: '',
        signer: { kind: 'root', rootKey },
      })
    ).rejects.toThrow();
  });
});

describe('凭据复用窗口', () => {
  test('5 分钟内可复用，超时即失效', () => {
    const throwaway = rootKeyFromSeed(new Uint8Array(32).fill(0x77));
    const signer = { kind: 'root', rootKey: throwaway } as const;
    rememberSigner(signer, NOW);
    expect(takeRememberedSigner(NOW + SIGNER_REUSE_WINDOW_MS - 1)).toBe(signer);
    expect(takeRememberedSigner(NOW + SIGNER_REUSE_WINDOW_MS)).toBeNull();
    expect(takeRememberedSigner(NOW)).toBeNull();
  });

  test('窗口结束 / 换 signer 时根钥 seed 被清零，而不是只丢引用', () => {
    const first = rootKeyFromSeed(new Uint8Array(32).fill(0x21));
    rememberSigner({ kind: 'root', rootKey: first }, NOW);
    // 超时读一次即触发清理
    expect(takeRememberedSigner(NOW + SIGNER_REUSE_WINDOW_MS)).toBeNull();
    expect(first.seed.every((byte) => byte === 0)).toBe(true);

    const second = rootKeyFromSeed(new Uint8Array(32).fill(0x22));
    rememberSigner({ kind: 'root', rootKey: second }, NOW);
    const third = rootKeyFromSeed(new Uint8Array(32).fill(0x23));
    rememberSigner({ kind: 'root', rootKey: third }, NOW);
    expect(second.seed.every((byte) => byte === 0)).toBe(true);
    forgetSigner();
    expect(third.seed.every((byte) => byte === 0)).toBe(true);
  });
});

describe('joinCommand', () => {
  test('带名称时加 --name，特殊字符加引号', () => {
    expect(joinCommand('https://hub.example', 'TOKEN', 'studio')).toBe(
      "tmex hub join 'https://hub.example' --token TOKEN --name studio"
    );
    expect(joinCommand('https://hub.example', 'TOKEN', 'my node')).toContain("--name 'my node'");
    expect(joinCommand('https://hub.example', 'TOKEN', null)).toBe(
      "tmex hub join 'https://hub.example' --token TOKEN"
    );
  });

  test('URL 一律 shell 转义：合法 URL 里的 & 不会截断命令', () => {
    const command = joinCommand('https://hub.example/x?a=1&b=2', 'TOKEN');
    expect(command).toContain("'https://hub.example/x?a=1&b=2'");
    expect(command).not.toContain('& b');
    // 引号之外不应再出现裸的 shell 元字符
    expect(command.split("'")[0]).toBe('tmex hub join ');
  });

  test('注入型 URL 直接拒绝，不是「引起来就算了」', () => {
    expect(() => joinCommand('https://hub.example; touch /tmp/pwn', 'TOKEN')).toThrow();
    expect(() => joinCommand('$(curl evil.example)', 'TOKEN')).toThrow();
    expect(() => joinCommand('http://hub.example', 'TOKEN')).toThrow();
    expect(() => joinCommand('javascript:alert(1)', 'TOKEN')).toThrow();
  });

  test('isTrustedHubUrl：只认 https（回环 http 例外），拒绝带凭据的 URL', () => {
    expect(isTrustedHubUrl('https://hub.example:8443/base')).toBe(true);
    expect(isTrustedHubUrl('http://localhost:19663')).toBe(true);
    expect(isTrustedHubUrl('http://127.0.0.1:9663')).toBe(true);
    expect(isTrustedHubUrl('http://hub.example')).toBe(false);
    expect(isTrustedHubUrl('https://user:pw@hub.example')).toBe(false);
    expect(isTrustedHubUrl('ftp://hub.example')).toBe(false);
    expect(isTrustedHubUrl('')).toBe(false);
    expect(isTrustedHubUrl(null)).toBe(false);
  });
});

describe('encodeJoinTokenZeroing', () => {
  test('拼出的 96 字节缓冲用完即清零（串本身与共享编码器逐字一致）', () => {
    const enrollSk = new Uint8Array(32).fill(7);
    const rootPk = new Uint8Array(32).fill(8);
    const head = new Uint8Array(32).fill(9);
    const scratch = new Uint8Array(96).fill(1);
    const token = encodeJoinTokenZeroing(enrollSk, rootPk, head, undefined, scratch);

    expect(token).toBe(encodeJoinToken(enrollSk, rootPk, head));
    expect(decodeJoinToken(token).enrollSk).toEqual(enrollSk);
    // 私钥的字节副本不能留在堆里
    expect(scratch.every((byte) => byte === 0)).toBe(true);
  });

  test('可选 CA fingerprint 段与共享编码器一致，缓冲仍清零', () => {
    const enrollSk = new Uint8Array(32).fill(7);
    const rootPk = new Uint8Array(32).fill(8);
    const head = new Uint8Array(32).fill(9);
    const fingerprint = 'ab'.repeat(32);
    const scratch = new Uint8Array(96).fill(1);
    const token = encodeJoinTokenZeroing(enrollSk, rootPk, head, fingerprint, scratch);
    expect(token).toBe(encodeJoinToken(enrollSk, rootPk, head, fingerprint));
    expect(decodeJoinToken(token).caFingerprint).toBe(fingerprint);
    expect(scratch.every((byte) => byte === 0)).toBe(true);
  });

  test('长度不对直接抛，不产出半截串', () => {
    expect(() =>
      encodeJoinTokenZeroing(new Uint8Array(31), new Uint8Array(32), new Uint8Array(32))
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// hub=sync 的失败处理（B2-6）：未确认 = 本地什么都没写，重试必须原样重发同一份字节
// ---------------------------------------------------------------------------

describe('hub=sync 失败分类', () => {
  test('超时 / hub 不可达 = 未确认（本地未落库，可原样重试）', () => {
    expect(classifyKeyLogFailure('HUB_TIMEOUT')).toBe('unconfirmed');
    expect(classifyKeyLogFailure('unavailable')).toBe('unconfirmed');
    expect(classifyKeyLogFailure('uplink_down')).toBe('unconfirmed');
  });

  test('fork / seq_gap = 记录作废（重发同一份永远不会被接受）', () => {
    expect(classifyKeyLogFailure('KEY_LOG_FORK')).toBe('stale');
    expect(classifyKeyLogFailure('seq_gap')).toBe('stale');
  });

  test('其余一律当成记录本身被拒', () => {
    expect(classifyKeyLogFailure('BAD_SIGNATURE')).toBe('rejected');
    expect(classifyKeyLogFailure('KEY_LOG_REJECTED')).toBe('rejected');
  });

  test('只有 hubAck === true 才算确认', () => {
    expect(admitDisposition({ ok: true, hubAck: true })).toEqual({ kind: 'admitted' });
    // 旧版 entry 可能仍返回 200 + hubAck:false / 不带该字段
    expect(admitDisposition({ ok: true, hubAck: false })).toEqual({ kind: 'unconfirmed' });
    expect(admitDisposition({ ok: true })).toEqual({ kind: 'unconfirmed' });
    expect(admitDisposition({ ok: false, code: 'HUB_TIMEOUT' })).toEqual({ kind: 'unconfirmed' });
    expect(admitDisposition({ ok: false, code: 'seq_gap' })).toEqual({ kind: 'stale' });
    expect(admitDisposition({ ok: false, code: 'BAD_SIGNATURE' })).toEqual({
      kind: 'error',
      code: 'BAD_SIGNATURE',
    });
  });
});

describe('submitAdmitRecord', () => {
  const RECORD = { bytes: 'BYTES-SEQ-6', sig: 'SIG-SEQ-6' };

  function fakeApi(results: ({ ok: true; hubAck?: boolean } | { ok: false; code: string })[]) {
    const sent: { bytes: string; sig: string }[] = [];
    return {
      sent,
      appendKeyLog(body: { bytes: string; sig: string }, opts?: { hubSync?: boolean }) {
        expect(opts?.hubSync).toBe(true);
        sent.push({ ...body });
        return Promise.resolve(results[sent.length - 1] ?? { ok: true as const, hubAck: true });
      },
    };
  }

  beforeEach(() => clearUnconfirmedRecords());

  test('504 HUB_TIMEOUT：留住记录，重试重发的是**同一份字节**（不重签新 seq）', async () => {
    const api = fakeApi([
      { ok: false, code: 'HUB_TIMEOUT' },
      { ok: true, hubAck: true },
    ]);

    expect(await submitAdmitRecord(api, 'e-1', RECORD)).toEqual({ kind: 'unconfirmed' });
    expect(listUnconfirmedRecordIds()).toEqual(['e-1']);

    // 「重试」按钮走的正是这条路径：取暂存记录再发一次
    const stored = unconfirmedRecord('e-1');
    expect(stored).toEqual(RECORD);
    expect(await submitAdmitRecord(api, 'e-1', stored as typeof RECORD)).toEqual({
      kind: 'admitted',
    });

    expect(api.sent).toEqual([RECORD, RECORD]);
    expect(listUnconfirmedRecordIds()).toEqual([]);
  });

  test('409 hub 拒绝（unavailable）同样保留记录', async () => {
    const api = fakeApi([{ ok: false, code: 'unavailable' }]);
    expect(await submitAdmitRecord(api, 'e-2', RECORD)).toEqual({ kind: 'unconfirmed' });
    expect(unconfirmedRecord('e-2')).toEqual(RECORD);
  });

  test('fork / seq_gap：暂存记录必须丢掉，否则重试会一直撞同一堵墙', async () => {
    const api = fakeApi([
      { ok: false, code: 'HUB_TIMEOUT' },
      { ok: false, code: 'seq_gap' },
    ]);
    await submitAdmitRecord(api, 'e-3', RECORD);
    expect(unconfirmedRecord('e-3')).toEqual(RECORD);

    expect(await submitAdmitRecord(api, 'e-3', RECORD)).toEqual({ kind: 'stale' });
    expect(unconfirmedRecord('e-3')).toBeNull();
    expect(listUnconfirmedRecordIds()).toEqual([]);
  });

  test('自动路径：手上有未确认记录时一律重发，不再现签（轮询每 5 s 会重来一次）', async () => {
    const api = fakeApi([{ ok: false, code: 'HUB_TIMEOUT' }]);
    expect(admitPlan('e-plan', true)).toBe('sign');
    expect(admitPlan('e-plan', false)).toBe('wait');

    await submitAdmitRecord(api, 'e-plan', RECORD);
    // 根钥签名者还在复用窗口里，但已经有未确认记录 → 只能重发
    expect(admitPlan('e-plan', true)).toBe('resend');
    expect(admitPlan('e-plan', false)).toBe('resend');
  });

  test('确认成功后不再留着可重发的记录', async () => {
    const api = fakeApi([{ ok: true, hubAck: true }]);
    expect(await submitAdmitRecord(api, 'e-4', RECORD)).toEqual({ kind: 'admitted' });
    expect(unconfirmedRecord('e-4')).toBeNull();
  });

  test('订阅者能看到未确认集合的变化（页面据此显示「重试」）', async () => {
    let ticks = 0;
    const stop = subscribeUnconfirmedRecords(() => {
      ticks += 1;
    });
    await submitAdmitRecord(fakeApi([{ ok: false, code: 'HUB_TIMEOUT' }]), 'e-5', RECORD);
    expect(ticks).toBe(1);
    expect(listUnconfirmedRecordIds()).toEqual(['e-5']);
    forgetUnconfirmedRecord('e-5');
    expect(ticks).toBe(2);
    stop();
  });
});
