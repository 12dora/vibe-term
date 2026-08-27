// redeem 证书的两条到达路径：`GET /n/<hub>/api/hub/enrollments/:id` 轮询，
// 与 `/mesh/ws` 的 `ENROLL_REDEEMED` 推送。两者都汇进 `offerCertificate()`。

import { describe, expect, test } from 'bun:test';
import {
  createEnrollment,
  createNodeCertificate,
  encodeBase64url,
  generateEd25519KeyPair,
  rootKeyFromSeed,
} from '@tmex/shared/auth';
import type { PendingEnrollment } from './enrollment';
import {
  collectRedeemedCertificates,
  offerCertificate,
  outcomesForCandidates,
} from './enrollment-watch';
import type { HubApi, HubEnrollmentStatus } from './hub-api';
import { decodeMeshFrame } from './mesh-events';

const UID = 'user-1';
const NOW = 1_700_000_000_000;
const rootKey = rootKeyFromSeed(new Uint8Array(32).fill(0x42));

async function fixture() {
  const enrollment = await createEnrollment(rootKey, { uid: UID, rootEpoch: 1, now: NOW });
  const pending: PendingEnrollment = {
    hubEnrollmentId: 'e-1',
    enrollPk: encodeBase64url(enrollment.enrollPk),
    authorizationBytes: encodeBase64url(enrollment.authorizationBytes),
    authorizationSig: encodeBase64url(enrollment.authorizationSig),
    exp: NOW + 600_000,
    name: null,
    createdAt: NOW,
  };
  const ed = generateEd25519KeyPair();
  const x = generateEd25519KeyPair();
  const cert = createNodeCertificate(enrollment.enrollSk, {
    uid: UID,
    edPk: ed.publicKey,
    x25519Pk: x.publicKey,
    enrollPk: enrollment.enrollPk,
    now: NOW,
  });
  return { pending, cert };
}

function hubApiReturning(byId: Record<string, HubEnrollmentStatus | Error>): HubApi {
  return {
    getEnrollment: (id: string) => {
      const row = byId[id];
      if (!row) return Promise.reject(new Error('not found'));
      if (row instanceof Error) return Promise.reject(row);
      return Promise.resolve(row);
    },
  } as unknown as HubApi;
}

describe('collectRedeemedCertificates', () => {
  test('按 enrollment id 查到 redeemed 证书后交给 offerCertificate 判定为 admit', async () => {
    const { pending, cert } = await fixture();
    const hubApi = hubApiReturning({
      'e-1': {
        status: 'redeemed',
        enroll_pk: pending.enrollPk,
        certificate: encodeBase64url(cert.certificateBytes),
        cert_sig: encodeBase64url(cert.certSig),
        node_id: 'a'.repeat(32),
      },
    });
    const candidates = await collectRedeemedCertificates(hubApi, [pending]);
    expect(candidates).toHaveLength(1);
    const outcome = offerCertificate([pending], candidates[0], NOW);
    expect(outcome.kind).toBe('admit');
  });

  test('还没 redeem 的 enrollment 不产生候选', async () => {
    const { pending } = await fixture();
    const hubApi = hubApiReturning({
      'e-1': { status: 'pending', enroll_pk: pending.enrollPk },
    });
    expect(await collectRedeemedCertificates(hubApi, [pending])).toEqual([]);
  });

  test('hub 查询失败只是没有候选，不抛（轮询要能继续）', async () => {
    const { pending } = await fixture();
    const hubApi = hubApiReturning({ 'e-1': new Error('hub down') });
    expect(await collectRedeemedCertificates(hubApi, [pending])).toEqual([]);
  });
});

describe('ENROLL_REDEEMED 推送 → offerCertificate', () => {
  test('推送来的证书与轮询走同一条判定路径', async () => {
    const { pending, cert } = await fixture();
    // 推送帧解码后就是 base64url 的 {certificate, certSig}
    const frame = {
      certificate: encodeBase64url(cert.certificateBytes),
      certSig: encodeBase64url(cert.certSig),
    };
    expect(offerCertificate([pending], frame, NOW).kind).toBe('admit');
    // 过期的 pending 一律拒绝
    expect(offerCertificate([pending], frame, pending.exp + 1)).toMatchObject({
      kind: 'invalid',
      reason: 'expired',
    });
  });

  test('不属于任何 pending 的推送证书报 unknown（告警信号）', async () => {
    const { pending } = await fixture();
    const other = await createEnrollment(rootKey, { uid: UID, rootEpoch: 1, now: NOW });
    const ed = generateEd25519KeyPair();
    const x = generateEd25519KeyPair();
    const cert = createNodeCertificate(other.enrollSk, {
      uid: UID,
      edPk: ed.publicKey,
      x25519Pk: x.publicKey,
      enrollPk: other.enrollPk,
      now: NOW,
    });
    expect(
      offerCertificate(
        [pending],
        {
          certificate: encodeBase64url(cert.certificateBytes),
          certSig: encodeBase64url(cert.certSig),
        },
        NOW
      )
    ).toEqual({ kind: 'unknown' });
  });

  test('decodeMeshFrame 是推送侧的唯一入口（非法帧不会变成候选）', () => {
    expect(decodeMeshFrame(new Uint8Array([0, 1, 2]))).toBeNull();
  });
});

describe('轮询路径的 outcome 上报', () => {
  test('对不上任何 pending 的证书也要上报 unknown（与推送路径一致）', async () => {
    const { pending } = await fixture();
    const other = await createEnrollment(rootKey, { uid: UID, rootEpoch: 1, now: NOW });
    const ed = generateEd25519KeyPair();
    const x = generateEd25519KeyPair();
    const stranger = createNodeCertificate(other.enrollSk, {
      uid: UID,
      edPk: ed.publicKey,
      x25519Pk: x.publicKey,
      enrollPk: other.enrollPk,
      now: NOW,
    });

    const outcomes = outcomesForCandidates(
      [pending],
      [
        {
          certificate: encodeBase64url(stranger.certificateBytes),
          certSig: encodeBase64url(stranger.certSig),
        },
      ],
      NOW
    );

    // 之前这里被 `if (outcome.kind !== 'unknown')` 吃掉了，UI 收不到告警
    expect(outcomes).toEqual([{ kind: 'unknown' }]);
  });

  test('多份候选逐一上报，顺序不变', async () => {
    const { pending, cert } = await fixture();
    const outcomes = outcomesForCandidates(
      [pending],
      [
        { certificate: 'not-base64url!!', certSig: 'x' },
        {
          certificate: encodeBase64url(cert.certificateBytes),
          certSig: encodeBase64url(cert.certSig),
        },
      ],
      NOW
    );
    expect(outcomes.map((row) => row.kind)).toEqual(['unknown', 'admit']);
  });
});
