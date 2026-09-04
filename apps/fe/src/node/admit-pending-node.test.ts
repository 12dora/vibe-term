// 「批准加入」：材料齐全时签一条 `admit-node` 并 `hub=sync` 提交；未确认时只重发那份字节。

import { beforeEach, describe, expect, test } from 'bun:test';
import type { CredentialPromptHandle } from '@/auth/credential-prompt';
import type { AuthApi } from '@tmex/api-client/auth/index';
import {
  decodeAdmitNodePayload,
  decodeKeyLogRecord,
  encodeBase64url,
  rootKeyFromSeed,
} from '@tmex/shared/auth';
import { admitPendingNode } from './admit-pending-node';
import { clearUnconfirmedRecords, listUnconfirmedRecordIds } from './enrollment';
import type { PendingAdmitMaterial } from './merge-nodes';

const rootKey = rootKeyFromSeed(new Uint8Array(32).fill(7));

const MATERIAL: PendingAdmitMaterial = {
  enrollmentId: 'enr-1',
  authorization: encodeBase64url(new Uint8Array(24).fill(1)),
  authorizationSig: encodeBase64url(new Uint8Array(64).fill(2)),
  certificate: encodeBase64url(new Uint8Array(40).fill(3)),
  certSig: encodeBase64url(new Uint8Array(64).fill(4)),
};

const MODE = { uid: 'u1', rootEpoch: 3 };

function fakeApi(results: ({ ok: true; hubAck?: boolean } | { ok: false; code: string })[]): {
  api: AuthApi;
  sent: { bytes: string; sig: string }[];
} {
  const sent: { bytes: string; sig: string }[] = [];
  const api = {
    keyLogHead: () =>
      Promise.resolve({ seq: '5', hash: encodeBase64url(new Uint8Array(32).fill(9)) }),
    appendKeyLog(body: { bytes: string; sig: string }, opts?: { hubSync?: boolean }) {
      expect(opts?.hubSync).toBe(true);
      sent.push({ ...body });
      return Promise.resolve(results[sent.length - 1] ?? { ok: true as const, hubAck: true });
    },
  } as unknown as AuthApi;
  return { api, sent };
}

function fakePrompt(behaviour: 'root' | 'cancel' | 'throw'): {
  prompt: CredentialPromptHandle;
  calls: Array<{ purpose?: string; reuse?: boolean }>;
} {
  const calls: Array<{ purpose?: string; reuse?: boolean }> = [];
  const prompt = {
    request(options?: { purpose?: string; reuse?: boolean }) {
      calls.push(options ?? {});
      if (behaviour === 'cancel') return Promise.resolve(null);
      if (behaviour === 'throw') return Promise.reject(new Error('passkey aborted'));
      return Promise.resolve({ kind: 'root', rootKey });
    },
  } as unknown as CredentialPromptHandle;
  return { prompt, calls };
}

describe('admitPendingNode', () => {
  beforeEach(() => clearUnconfirmedRecords());

  test('材料齐全：走 admit 复用窗口，签出的记录内嵌授权与证书', async () => {
    const { api, sent } = fakeApi([{ ok: true, hubAck: true }]);
    const { prompt, calls } = fakePrompt('root');

    const result = await admitPendingNode({ admitMaterial: MATERIAL }, { api, mode: MODE, prompt });

    expect(result).toEqual({ kind: 'admitted' });
    expect(calls).toEqual([{ purpose: 'admit', reuse: true }]);
    expect(sent).toHaveLength(1);
    const record = decodeKeyLogRecord(Buffer.from(sent[0].bytes, 'base64url'));
    expect(record.type).toBe('admit-node');
    const payload = decodeAdmitNodePayload(record.payload);
    expect(encodeBase64url(payload.authorization_bytes)).toBe(MATERIAL.authorization);
    expect(encodeBase64url(payload.certificate_bytes)).toBe(MATERIAL.certificate);
  });

  test('Hub 未确认：留住字节，第二次只重发同一份，不再要凭据', async () => {
    const { api, sent } = fakeApi([
      { ok: false, code: 'HUB_TIMEOUT' },
      { ok: true, hubAck: true },
    ]);
    const { prompt, calls } = fakePrompt('root');
    const row = { admitMaterial: MATERIAL };

    expect(await admitPendingNode(row, { api, mode: MODE, prompt })).toEqual({
      kind: 'unconfirmed',
    });
    expect(listUnconfirmedRecordIds()).toEqual(['enr-1']);

    expect(await admitPendingNode(row, { api, mode: MODE, prompt })).toEqual({ kind: 'admitted' });
    expect(calls).toHaveLength(1);
    expect(sent[0]).toEqual(sent[1]);
    expect(listUnconfirmedRecordIds()).toEqual([]);
  });

  test('Hub 终态拒绝：原样带出错误码', async () => {
    const { api } = fakeApi([{ ok: false, code: 'BAD_SIGNATURE' }]);
    const { prompt } = fakePrompt('root');
    expect(
      await admitPendingNode({ admitMaterial: MATERIAL }, { api, mode: MODE, prompt })
    ).toEqual({ kind: 'error', code: 'BAD_SIGNATURE' });
  });

  test('材料不全：不取凭据、不发任何请求', async () => {
    const { api, sent } = fakeApi([]);
    const { prompt, calls } = fakePrompt('root');
    expect(await admitPendingNode({ admitMaterial: null }, { api, mode: MODE, prompt })).toEqual({
      kind: 'no-material',
    });
    expect(calls).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  test('用户取消凭据：什么都不写', async () => {
    const { api, sent } = fakeApi([]);
    const { prompt } = fakePrompt('cancel');
    expect(
      await admitPendingNode({ admitMaterial: MATERIAL }, { api, mode: MODE, prompt })
    ).toEqual({ kind: 'cancelled' });
    expect(sent).toHaveLength(0);
  });

  test('凭据对话框抛错：折成 failed，不炸到调用方', async () => {
    const { api } = fakeApi([]);
    const { prompt } = fakePrompt('throw');
    expect(
      await admitPendingNode({ admitMaterial: MATERIAL }, { api, mode: MODE, prompt })
    ).toEqual({ kind: 'failed', message: 'passkey aborted' });
  });

  test('请求抛异常：折成 failed', async () => {
    const { prompt } = fakePrompt('root');
    const api = {
      keyLogHead: () => Promise.reject(new Error('connection reset')),
    } as unknown as AuthApi;
    expect(
      await admitPendingNode({ admitMaterial: MATERIAL }, { api, mode: MODE, prompt })
    ).toEqual({ kind: 'failed', message: 'connection reset' });
  });

  test('提交阶段断网：字节已暂存，按 Hub 未确认处理而不是失败', async () => {
    const { prompt } = fakePrompt('root');
    const api = {
      keyLogHead: () =>
        Promise.resolve({ seq: '5', hash: encodeBase64url(new Uint8Array(32).fill(9)) }),
      appendKeyLog: () => Promise.reject(new Error('network timeout')),
    } as unknown as AuthApi;

    expect(
      await admitPendingNode({ admitMaterial: MATERIAL }, { api, mode: MODE, prompt })
    ).toEqual({ kind: 'unconfirmed' });
    // 那份字节留着，下一次原样重发。
    expect(listUnconfirmedRecordIds()).toEqual(['enr-1']);
  });

  test('重发路径断网：同样是未确认，绝不重签', async () => {
    const { prompt, calls } = fakePrompt('root');
    let fail = false;
    const api = {
      keyLogHead: () =>
        Promise.resolve({ seq: '5', hash: encodeBase64url(new Uint8Array(32).fill(9)) }),
      appendKeyLog: () =>
        fail
          ? Promise.reject(new Error('network timeout'))
          : Promise.resolve({ ok: false as const, code: 'HUB_TIMEOUT' }),
    } as unknown as AuthApi;
    const row = { admitMaterial: MATERIAL };

    expect(await admitPendingNode(row, { api, mode: MODE, prompt })).toEqual({
      kind: 'unconfirmed',
    });
    fail = true;
    expect(await admitPendingNode(row, { api, mode: MODE, prompt })).toEqual({
      kind: 'unconfirmed',
    });
    expect(calls).toHaveLength(1);
  });
});

describe('admitPendingNode 的行复核', () => {
  beforeEach(() => clearUnconfirmedRecords());

  test('凭据对话框期间这一行被 Hub 轮询改掉：静默取消，什么都不写', async () => {
    const { api, sent } = fakeApi([]);
    const { prompt } = fakePrompt('root');

    const result = await admitPendingNode(
      { admitMaterial: MATERIAL },
      { api, mode: MODE, prompt, stillValid: () => false }
    );

    expect(result).toEqual({ kind: 'cancelled' });
    expect(sent).toHaveLength(0);
  });

  test('凭据回来时还在，进写锁后才失效：同样静默取消', async () => {
    const { api, sent } = fakeApi([]);
    const { prompt } = fakePrompt('root');
    let checks = 0;

    const result = await admitPendingNode(
      { admitMaterial: MATERIAL },
      {
        api,
        mode: MODE,
        prompt,
        stillValid: () => {
          checks += 1;
          return checks === 1;
        },
      }
    );

    expect(result).toEqual({ kind: 'cancelled' });
    expect(checks).toBe(2);
    expect(sent).toHaveLength(0);
  });

  test('重发路径同样复核：行没了就不再提交那份字节', async () => {
    const { api, sent } = fakeApi([{ ok: false, code: 'HUB_TIMEOUT' }]);
    const { prompt } = fakePrompt('root');
    const row = { admitMaterial: MATERIAL };

    expect(await admitPendingNode(row, { api, mode: MODE, prompt })).toEqual({
      kind: 'unconfirmed',
    });
    expect(
      await admitPendingNode(row, { api, mode: MODE, prompt, stillValid: () => false })
    ).toEqual({ kind: 'cancelled' });
    expect(sent).toHaveLength(1);
  });

  test('复核通过时照常批准', async () => {
    const { api, sent } = fakeApi([{ ok: true, hubAck: true }]);
    const { prompt } = fakePrompt('root');

    const result = await admitPendingNode(
      { admitMaterial: MATERIAL },
      { api, mode: MODE, prompt, stillValid: (id) => id === 'enr-1' }
    );

    expect(result).toEqual({ kind: 'admitted' });
    expect(sent).toHaveLength(1);
  });
});
