// 「成员密钥未送达」告警条：有欠账才出，名单来自中继状态（服务端真相）。
// 无 DOM 测试环境，用 react-dom/server 静态渲染。

import { afterEach, describe, expect, test } from 'bun:test';
import type { CredentialPromptHandle } from '@/auth/credential-prompt';
import type { RelayFlowDeps } from '@/node/relay-enroll';
import { type AuthApi, defaultAuthApi } from '@vibeterm/api-client/auth/index';
import type {
  RelayMetaKeyLaggingNode,
  RelayTenantApi,
} from '@vibeterm/api-client/relay/tenant-api';
import { installWindowStorage } from '@vibeterm/stores/test-utils';

installWindowStorage();

const { renderToStaticMarkup } = await import('react-dom/server');
const { encodeBase64url, rootKeyFromSeed } = await import('@vibeterm/shared/auth');
const { getEnrollmentEngineState, resetEnrollmentEngineState, setEnrollmentEngineStateForTest } =
  await import('@/node/enrollment-engine-state');
const { resetMeshRelayStateForTest } = await import('@/node/mesh-relay');
const { clearPendingMetaKeysForTest } = await import('@/node/relay-meta-key-pending');
const { RelayMetaLagNotice, laggingNames, resendLaggingMemberKeys } = await import(
  './relay-meta-lag-notice'
);

const NODE_A = 'aa'.repeat(16);
const NODE_B = 'bb'.repeat(16);

const prompt = {
  withSigner: () => Promise.resolve(null),
  request: () => Promise.resolve(null),
  dialog: null,
} as unknown as CredentialPromptHandle;

const MODE = {
  uid: 'u1',
  rootEpoch: 2,
  kdfParams: { salt: 'x', memory_kib: 64, iterations: 1, parallelism: 1 },
};

function render(lagging: RelayMetaKeyLaggingNode[]): string {
  return renderToStaticMarkup(
    <RelayMetaLagNotice
      lagging={lagging}
      mode={MODE}
      api={defaultAuthApi}
      prompt={prompt}
      onChanged={() => undefined}
    />
  );
}

function row(nodeId: string, name: string | null): RelayMetaKeyLaggingNode {
  return { nodeId, name, since: null, admitSeq: 1 };
}

describe('RelayMetaLagNotice', () => {
  test('没有欠账时什么都不渲染', () => {
    expect(render([])).toBe('');
  });

  test('有欠账时出告警条与补发按钮', () => {
    const html = render([row(NODE_A, 'oracle-jp')]);
    expect(html).toContain('nodes-relay-meta-lagging');
    expect(html).toContain('nodes-relay-meta-lagging-action');
    expect(html).toContain('relay.tenant.metaKey.lagging.action');
  });

  test('缺 uid / kdf 参数时按钮禁用（签不出记录）', () => {
    const html = renderToStaticMarkup(
      <RelayMetaLagNotice
        lagging={[row(NODE_A, null)]}
        mode={null}
        api={defaultAuthApi}
        prompt={prompt}
        onChanged={() => undefined}
      />
    );
    expect(html).toContain('disabled');
  });

  test('没有名字的成员只显示 node id 前 8 位——整串 hex 没人读得下去', () => {
    expect(laggingNames([row(NODE_A, null), row(NODE_B, 'tokyo')])).toBe(
      `${NODE_A.slice(0, 8)}、tokyo`
    );
  });

  test('名单过长只列前三台', () => {
    const rows = [row(NODE_A, 'a'), row(NODE_B, 'b'), row(NODE_A, 'c'), row(NODE_B, 'd')];
    expect(laggingNames(rows)).toBe('a、b、c');
  });
});

describe('resendLaggingMemberKeys：补发结果收进加入结果行', () => {
  afterEach(() => {
    resetEnrollmentEngineState();
    resetMeshRelayStateForTest();
    clearPendingMetaKeysForTest();
  });

  const ACCEPTED = { ok: true, hubAck: true, relayAck: true };
  const REJECTED = { ok: false, code: 'RELAY_OFFLINE' };
  const ROOT_SIGNER = { kind: 'root', rootKey: rootKeyFromSeed(new Uint8Array(32).fill(3)) };

  /** `status` 给出欠账名单；`failing` 里的节点 append 会被拒。 */
  function depsOf(status: () => Promise<unknown>, failing: string[] = []): RelayFlowDeps {
    let preparing = '';
    return {
      api: {
        keyLogHead: () =>
          Promise.resolve({ seq: 4, hash: encodeBase64url(new Uint8Array(32).fill(7)) }),
        appendKeyLog: () => Promise.resolve(failing.includes(preparing) ? REJECTED : ACCEPTED),
      } as unknown as AuthApi,
      relayApi: {
        metaKeyPrepare: (op: { node_id: string }) => {
          preparing = op.node_id;
          return Promise.resolve({ payload: 'AQID', payloadHash: 'h' });
        },
        status,
      } as unknown as RelayTenantApi,
      mode: MODE,
      lock: (run) => run(),
    };
  }

  const signing = {
    withSigner: (fn: (signer: unknown) => unknown) => Promise.resolve(fn(ROOT_SIGNER)),
  } as unknown as CredentialPromptHandle;

  const t = (key: string) => key;

  function seedKeyPending(rows: Record<string, string | null>): void {
    setEnrollmentEngineStateForTest({
      progressById: Object.fromEntries(
        Object.entries(rows).map(([id, nodeId]) => [
          id,
          { phase: 'keyPending' as const, steps: 2 as const, name: null, nodeId },
        ])
      ),
    });
  }

  function phases(): Record<string, string> {
    return Object.fromEntries(
      Object.entries(getEnrollmentEngineState().progressById).map(([id, row]) => [id, row.phase])
    );
  }

  function statusOf(...nodeIds: string[]) {
    const metaKeyLagging = nodeIds.map((nodeId) => ({ nodeId }));
    return () => Promise.resolve({ mode: 'relay', relays: [], metaKeyLagging });
  }

  test('全部补成：对应的待补发行（含解不出 node id 的）都收成已加入', async () => {
    seedKeyPending({ a: NODE_A, unknown: null });
    const ran = await resendLaggingMemberKeys({
      deps: depsOf(statusOf(NODE_A, NODE_B)),
      prompt: signing,
      t,
    });
    expect(ran).toBe(true);
    expect(phases()).toEqual({ a: 'done', unknown: 'done' });
  });

  test('只补成一部分：只收补成的那几台，解不出 node id 的留着', async () => {
    seedKeyPending({ a: NODE_A, b: NODE_B, unknown: null });
    await resendLaggingMemberKeys({
      deps: depsOf(statusOf(NODE_A, NODE_B), [NODE_B]),
      prompt: signing,
      t,
    });
    expect(phases()).toEqual({ a: 'done', b: 'keyPending', unknown: 'keyPending' });
  });

  test('欠账名单拉不到：不把任何一行当成已补齐', async () => {
    seedKeyPending({ a: NODE_A, unknown: null });
    const ran = await resendLaggingMemberKeys({
      deps: depsOf(() => Promise.reject(new Error('offline'))),
      prompt: signing,
      t,
    });
    expect(ran).toBe(true);
    expect(phases()).toEqual({ a: 'keyPending', unknown: 'keyPending' });
  });

  test('用户取消凭据框：什么都不动', async () => {
    seedKeyPending({ a: NODE_A });
    const ran = await resendLaggingMemberKeys({ deps: depsOf(statusOf(NODE_A)), prompt, t });
    expect(ran).toBe(false);
    expect(phases()).toEqual({ a: 'keyPending' });
  });
});
