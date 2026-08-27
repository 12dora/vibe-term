// enrollment / admit / revoke：pending 落 sessionStorage、证书匹配、admit-node 记录能过
// `@tmex/shared/auth` 的验签与 reducer、非匹配证书忽略、过期 pending 拒绝、revoke 记录形状。

import { beforeEach, describe, expect, test } from 'bun:test';
import {
  applyKeyLogRecord,
  computeRecordHash,
  createEnrollment,
  createNodeCertificate,
  decodeAdmitNodePayload,
  decodeKeyLogRecord,
  decodeRevokeNodePayload,
  emptyUserKeyState,
  encodeBase64url,
  generateEd25519KeyPair,
  generateKdfParams,
  genesisHead,
  randomBytes,
  rootKeyFromSeed,
  verifyKeyLogRecord,
} from '@tmex/shared/auth';
import type { PendingStorage } from './enrollment';
import {
  PENDING_STORAGE_KEY,
  type PendingEnrollment,
  SIGNER_REUSE_WINDOW_MS,
  addPendingEnrollment,
  buildAdmitNodeRecord,
  buildRevokeNodeRecord,
  clearPendingEnrollments,
  findPendingForCertificate,
  joinCommand,
  listPendingEnrollments,
  matchPendingCertificate,
  prunePendingEnrollments,
  rememberSigner,
  removePendingEnrollment,
  setPendingStorage,
  takeRememberedSigner,
} from './enrollment';
import { offerCertificate } from './enrollment-watch';

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

async function makeEnrollment(now = NOW) {
  const enrollment = await createEnrollment(rootKey, {
    uid: UID,
    rootEpoch: ROOT_EPOCH,
    now,
  });
  const pending: PendingEnrollment = {
    id: 'enroll-1',
    uid: UID,
    rootEpoch: ROOT_EPOCH,
    enrollPk: encodeBase64url(enrollment.enrollPk),
    enrollSk: encodeBase64url(enrollment.enrollSk),
    authorization: encodeBase64url(enrollment.authorizationBytes),
    authorizationSig: encodeBase64url(enrollment.authorizationSig),
    exp: now + 10 * 60 * 1000,
    joinToken: 'x'.repeat(128),
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

  test('同 id 覆盖而不是重复追加，删除后为空', async () => {
    const { pending } = await makeEnrollment();
    addPendingEnrollment(pending);
    addPendingEnrollment({ ...pending, name: 'renamed' });
    expect(listPendingEnrollments()).toHaveLength(1);
    expect(listPendingEnrollments()[0].name).toBe('renamed');
    removePendingEnrollment(pending.id);
    expect(listPendingEnrollments()).toEqual([]);
  });

  test('过期 pending 被 prune 掉', async () => {
    const { pending } = await makeEnrollment();
    addPendingEnrollment(pending);
    expect(prunePendingEnrollments(pending.exp - 1)).toHaveLength(1);
    expect(prunePendingEnrollments(pending.exp + 1)).toHaveLength(0);
    expect(listPendingEnrollments()).toEqual([]);
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
    expect(encodeBase64url(payload.authorization_bytes)).toBe(pending.authorization);
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
    const signer = { kind: 'root', rootKey } as const;
    rememberSigner(signer, NOW);
    expect(takeRememberedSigner(NOW + SIGNER_REUSE_WINDOW_MS - 1)).toBe(signer);
    expect(takeRememberedSigner(NOW + SIGNER_REUSE_WINDOW_MS)).toBeNull();
    expect(takeRememberedSigner(NOW)).toBeNull();
  });
});

describe('joinCommand', () => {
  test('带名称时加 --name，特殊字符加引号', () => {
    expect(joinCommand('https://hub.example', 'TOKEN', 'studio')).toBe(
      'npx tmex-cli hub join https://hub.example --token TOKEN --name studio'
    );
    expect(joinCommand('https://hub.example', 'TOKEN', 'my node')).toContain("--name 'my node'");
    expect(joinCommand('https://hub.example', 'TOKEN', null)).toBe(
      'npx tmex-cli hub join https://hub.example --token TOKEN'
    );
  });
});
