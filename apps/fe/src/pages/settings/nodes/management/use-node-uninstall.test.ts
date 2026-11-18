// 卸载确认：先收确认框再取凭据；已加入中继时凭据框只收账户密码。

import { afterEach, describe, expect, test } from 'bun:test';
import type { CredentialPromptHandle } from '@/auth/credential-prompt';
import type { NodeRow } from '@/node/mesh-nodes';
import { resetMeshRelayStateForTest, setMeshRelayStateForTest } from '@/node/mesh-relay';
import type { AuthApi } from '@vibeterm/api-client/auth/index';
import type { ResolvedMode } from './types';
import { type UninstallConfirmRun, runUninstallConfirm } from './use-node-uninstall';

const ROW = { id: 'ab'.repeat(16), name: 'n1' } as NodeRow;

afterEach(() => {
  resetMeshRelayStateForTest();
});

type SignerOptions = { purpose?: string; passwordOnly?: boolean } | undefined;

function harness(): { log: string[]; seen: SignerOptions[]; run: UninstallConfirmRun } {
  const log: string[] = [];
  const seen: SignerOptions[] = [];
  // 用户在凭据框里取消：`withSigner` 返回 null，批次不会跑。
  const prompt = {
    withSigner: (async (_fn: unknown, options?: SignerOptions) => {
      log.push('withSigner');
      seen.push(options);
      return null;
    }) as CredentialPromptHandle['withSigner'],
  } as CredentialPromptHandle;
  const run: UninstallConfirmRun = {
    rekeyDeps: {
      api: {} as AuthApi,
      mode: { uid: 'u1', rootEpoch: 3 } as unknown as ResolvedMode,
      t: (key) => key,
      prompt,
    },
    batch: {
      targets: [ROW],
      io: {
        start: () => Promise.resolve({ kind: 'scheduled' }),
        clearOperation: () => Promise.resolve(true),
      },
      t: (key) => key,
      onScheduled: () => undefined,
      canWrite: () => true,
    },
    setPlan: (plan) => log.push(plan === null ? 'plan:null' : 'plan:set'),
    setRunning: (running) => log.push(running ? 'running' : 'idle'),
    onChanged: () => log.push('changed'),
  };
  return { log, seen, run };
}

describe('runUninstallConfirm', () => {
  test('取凭据之前先收起确认框，凭据框不再叠在它上面', async () => {
    const { log, run } = harness();
    await runUninstallConfirm(run);
    expect(log).toEqual(['plan:null', 'running', 'withSigner', 'idle', 'changed']);
    expect(log.indexOf('plan:null')).toBeLessThan(log.indexOf('withSigner'));
  });

  test('已加入中继：凭据框只收账户密码', async () => {
    setMeshRelayStateForTest({
      mode: 'relay',
      relays: [{ url: 'https://relay.example.com', priority: 0 }] as never,
    });
    const { seen, run } = harness();
    await runUninstallConfirm(run);
    expect(seen).toEqual([{ purpose: 'revoke', passwordOnly: true }]);
  });

  test('未加入中继：照旧，可用通行密钥', async () => {
    const { seen, run } = harness();
    await runUninstallConfirm(run);
    expect(seen).toEqual([{ purpose: 'revoke' }]);
  });
});
