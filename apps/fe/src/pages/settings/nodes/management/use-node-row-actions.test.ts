// 吊销之后那条 `meta-key` 换代：模式判定的权威来源、失败时的欠账与结论。

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { CredentialPromptHandle } from '@/auth/credential-prompt';
import type { RecordSigner } from '@/auth/key-log-actions';
import type { NodeRow } from '@/node/mesh-nodes';
import { resetMeshRelayStateForTest, setMeshRelayStateForTest } from '@/node/mesh-relay';
import { clearPendingMetaKeysForTest, listPendingMetaKeys } from '@/node/relay-meta-key-pending';
import { ApiClient } from '@vibeterm/api-client';
import type { AuthApi } from '@vibeterm/api-client/auth/index';
import { RelayTenantApi } from '@vibeterm/api-client/relay/tenant-api';
import {
  decodeBase64url,
  decodeKeyLogRecord,
  decodeRevokeNodePayload,
  deriveSeed,
  encodeBase64url,
  rootKeyFromSeed,
} from '@vibeterm/shared/auth';
import type { ResolvedMode } from './types';
import type { NodeActionDeps } from './types';
import { revokeNodeRecord, useBulkRevoke, useNodeRowActions } from './use-node-row-actions';

const KDF_JSON = {
  salt: encodeBase64url(new Uint8Array(16).fill(0x05)),
  memory_kib: 64,
  iterations: 1,
  parallelism: 1,
};
const NODE_ID = 'ab'.repeat(16);
const t = (key: string) => key;

async function rootSigner(): Promise<RecordSigner> {
  const seed = await deriveSeed('pw', {
    salt: decodeBase64url(KDF_JSON.salt),
    memory_kib: KDF_JSON.memory_kib,
    iterations: KDF_JSON.iterations,
    parallelism: KDF_JSON.parallelism,
  });
  return { kind: 'root', rootKey: rootKeyFromSeed(seed) };
}

type Appended = { bytes: string; sig: string };

function authApi(appended: Appended[], results: unknown[] = []): AuthApi {
  return {
    keyLogHead: () =>
      Promise.resolve({ seq: 4, hash: encodeBase64url(new Uint8Array(32).fill(7)) }),
    appendKeyLog: (body: Appended) => {
      appended.push(body);
      return Promise.resolve(results[appended.length - 1] ?? { ok: true, hubAck: true });
    },
  } as unknown as AuthApi;
}

function relayApiOf(mode: 'relay' | 'hub'): { relayApi: RelayTenantApi; prepared: () => number } {
  let prepared = 0;
  const client = new ApiClient('', (url) => {
    if (url === '/api/mesh/relay/status') {
      return Promise.resolve(Response.json({ mode, relays: [] }));
    }
    if (url === '/api/mesh/relay/meta-key/prepare') {
      prepared += 1;
      return Promise.resolve(
        Response.json({
          epoch: 2,
          payload: encodeBase64url(new Uint8Array([4, 5])),
          payloadHash: 'z',
        })
      );
    }
    return Promise.resolve(new Response('not found', { status: 404 }));
  });
  return { relayApi: new RelayTenantApi(client), prepared: () => prepared };
}

const MODE = { uid: 'u1', rootEpoch: 3, kdfParams: KDF_JSON } as unknown as ResolvedMode;

function ctxOf(api: AuthApi, relayApi: RelayTenantApi) {
  return { api, mode: MODE, writerPublicUrl: null, t, relayApi };
}

afterEach(() => {
  resetMeshRelayStateForTest();
});

describe('revokeNodeRecord 之后的 meta-key 换代', () => {
  beforeEach(() => clearPendingMetaKeysForTest());

  test('模式以网关为准：页面 store 说 hub，网关说 relay，照样补一条 meta-key', async () => {
    // 轮询快照最长陈旧 30 秒；刚接入中继就吊销一台时，读快照会整条跳过换代。
    setMeshRelayStateForTest({ mode: 'hub' });
    const appended: Appended[] = [];
    const relay = relayApiOf('relay');
    const attempt = await revokeNodeRecord(
      await rootSigner(),
      { id: NODE_ID, name: 'n1' },
      '',
      ctxOf(authApi(appended), relay.relayApi)
    );
    expect(attempt).toEqual({ kind: 'done' });
    expect(relay.prepared()).toBe(1);
    expect(appended).toHaveLength(2);
    expect(decodeKeyLogRecord(decodeBase64url(appended[0].bytes)).type).toBe('revoke-node');
    expect(decodeKeyLogRecord(decodeBase64url(appended[1].bytes)).type).toBe('meta-key');
    expect(listPendingMetaKeys()).toHaveLength(0);
  }, 20000);

  test('网关说 hub 时一条 meta-key 都不发', async () => {
    setMeshRelayStateForTest({ mode: 'relay' });
    const appended: Appended[] = [];
    const relay = relayApiOf('hub');
    const attempt = await revokeNodeRecord(
      await rootSigner(),
      { id: NODE_ID, name: 'n1' },
      '',
      ctxOf(authApi(appended), relay.relayApi)
    );
    expect(attempt).toEqual({ kind: 'done' });
    expect(relay.prepared()).toBe(0);
    expect(appended).toHaveLength(1);
  }, 20000);

  test('换代没落账时不报「已移除」，欠账留着重试', async () => {
    setMeshRelayStateForTest({ mode: 'relay' });
    const appended: Appended[] = [];
    const relay = relayApiOf('relay');
    const attempt = await revokeNodeRecord(
      await rootSigner(),
      { id: NODE_ID, name: 'n1' },
      '',
      ctxOf(
        authApi(appended, [
          { ok: true, hubAck: true },
          { ok: true, hubAck: false, hubError: 'RELAY_OFFLINE' },
        ]),
        relay.relayApi
      )
    );
    expect(attempt).toEqual({ kind: 'meta-pending', code: 'RELAY_OFFLINE' });
    const pending = listPendingMetaKeys();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.id).toBe(`revoke:${NODE_ID}`);
    expect(pending[0]?.op).toEqual({ op: 'rotate', exclude: [NODE_ID] });
    // 本地 head 没动：签好的字节留着，重发即可落账。
    expect(pending[0]?.record?.type).toBe('meta-key');
  }, 20000);
});

// ---------------------------------------------------------------------------
// 改名：hub 模式打控制面，中继模式签 rename-node
// ---------------------------------------------------------------------------

const { renderToStaticMarkup } = await import('react-dom/server');
const { createElement } = await import('react');

const ROW = { id: NODE_ID, name: 'n1' } as NodeRow;

function promptStub(signer: RecordSigner): CredentialPromptHandle {
  return {
    request: () => Promise.resolve(signer),
    withSigner: (<T>(fn: (s: RecordSigner) => Promise<T> | T) =>
      Promise.resolve(fn(signer))) as CredentialPromptHandle['withSigner'],
    forget: () => undefined,
    dialog: null,
    passkeys: [],
  };
}

/** 静态渲染一次探针，取出 hook 的 rename。 */
function renameOf(deps: NodeActionDeps): (name: string) => Promise<void> {
  let captured: ((name: string) => Promise<void>) | null = null;
  function Probe() {
    captured = useNodeRowActions(ROW, deps).rename;
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  if (!captured) throw new Error('probe did not render');
  return captured;
}

function renameDeps(
  appended: Appended[],
  signer: RecordSigner,
  hubRenames: string[]
): NodeActionDeps {
  return {
    hubApi: {
      rename: (id: string, name: string) => {
        hubRenames.push(`${id}:${name}`);
        return Promise.resolve();
      },
    },
    mode: { uid: 'user-1', rootEpoch: 0, kdfParams: KDF_JSON } as unknown as ResolvedMode,
    api: authApi(appended),
    prompt: promptStub(signer),
    onChanged: () => undefined,
    writerPublicUrl: null,
  } as unknown as NodeActionDeps;
}

describe('useNodeRowActions 的改名', () => {
  const realFetch = globalThis.fetch;

  function stubRelayMode(mode: 'relay' | 'hub'): void {
    globalThis.fetch = ((input: string) =>
      String(input).includes('/api/mesh/relay/status')
        ? Promise.resolve(Response.json({ mode, relays: [] }))
        : Promise.resolve(new Response('{}', { status: 404 }))) as typeof fetch;
  }

  test('hub 模式仍打 hub 控制面，不签任何记录', async () => {
    stubRelayMode('hub');
    const appended: Appended[] = [];
    const hubRenames: string[] = [];
    await renameOf(renameDeps(appended, await rootSigner(), hubRenames))('studio');
    globalThis.fetch = realFetch;
    expect(hubRenames).toEqual([`${NODE_ID}:studio`]);
    expect(appended).toHaveLength(0);
  }, 20000);

  test('中继模式签 rename-node 记录，不碰 hub 控制面', async () => {
    stubRelayMode('relay');
    const appended: Appended[] = [];
    const hubRenames: string[] = [];
    await renameOf(renameDeps(appended, await rootSigner(), hubRenames))('studio');
    globalThis.fetch = realFetch;
    expect(hubRenames).toEqual([]);
    expect(appended).toHaveLength(1);
    expect(decodeKeyLogRecord(decodeBase64url(appended[0].bytes)).type).toBe('rename-node');
  }, 20000);
});

// ---------------------------------------------------------------------------
// 吊销：确认框而不是浏览器的 confirm / prompt
// ---------------------------------------------------------------------------

type RowActions = ReturnType<typeof useNodeRowActions>;
type BulkActions = ReturnType<typeof useBulkRevoke>;

/**
 * 静态渲染一次探针，取出开着确认框的那一帧。
 * 渲染期调 `open()` 造成一次同步重渲染（React 允许对自己 setState），
 * 这样不需要 DOM 也能拿到 `plan` 非空的控制器。
 */
function openedOf<T>(useIt: () => T, plan: (value: T) => unknown, open: (value: T) => void): T {
  let captured: T | null = null;
  function Probe() {
    const value = useIt();
    captured = value;
    if (plan(value) === null) open(value);
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  if (captured === null) throw new Error('probe did not render');
  return captured;
}

function revokeDeps(appended: Appended[], signer: RecordSigner, changed: string[]): NodeActionDeps {
  return {
    hubApi: null,
    mode: MODE,
    api: authApi(appended),
    prompt: promptStub(signer),
    onChanged: () => changed.push('changed'),
    writerPublicUrl: null,
  } as unknown as NodeActionDeps;
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition never held');
}

describe('吊销的确认框', () => {
  const realFetch = globalThis.fetch;

  function stubHubMode(): void {
    globalThis.fetch = ((input: string) =>
      String(input).includes('/api/mesh/relay/status')
        ? Promise.resolve(Response.json({ mode: 'hub', relays: [] }))
        : Promise.resolve(new Response('{}', { status: 404 }))) as typeof fetch;
  }

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test('确认：原因原样签进 revoke-node 记录，随后刷新列表', async () => {
    stubHubMode();
    const appended: Appended[] = [];
    const changed: string[] = [];
    const deps = revokeDeps(appended, await rootSigner(), changed);
    const actions = openedOf<RowActions>(
      () => useNodeRowActions(ROW, deps),
      (value) => value.revokeDialog.plan,
      (value) => value.revoke()
    );

    expect(actions.revokeDialog.plan).toEqual({ kind: 'single', targets: [ROW] });
    actions.revokeDialog.confirm('设备遗失');
    await waitFor(() => changed.length > 0);

    expect(appended).toHaveLength(1);
    const decoded = decodeKeyLogRecord(decodeBase64url(appended[0].bytes));
    expect(decoded.type).toBe('revoke-node');
    expect(decodeRevokeNodePayload(decoded.payload).reason).toBe('设备遗失');
  }, 20000);

  test('取消：一条记录都不签', async () => {
    stubHubMode();
    const appended: Appended[] = [];
    const changed: string[] = [];
    const deps = revokeDeps(appended, await rootSigner(), changed);
    const actions = openedOf<RowActions>(
      () => useNodeRowActions(ROW, deps),
      (value) => value.revokeDialog.plan,
      (value) => value.revoke()
    );

    actions.revokeDialog.dismiss();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(appended).toEqual([]);
    expect(changed).toEqual([]);
  }, 20000);

  test('批量：本机被剔除，剩下的逐台带同一个原因吊销', async () => {
    stubHubMode();
    const appended: Appended[] = [];
    const changed: string[] = [];
    const signer = await rootSigner();
    const rows = [
      { id: 'aa'.repeat(16), name: 'a' } as NodeRow,
      { id: 'bb'.repeat(16), name: 'b', isSelf: true } as NodeRow,
      { id: 'cc'.repeat(16), name: 'c' } as NodeRow,
    ];
    const bulk = openedOf<BulkActions>(
      () =>
        useBulkRevoke({
          api: authApi(appended),
          mode: MODE,
          prompt: promptStub(signer),
          writerPublicUrl: null,
          onChanged: () => changed.push('changed'),
        }),
      (value) => value.revokeDialog.plan,
      (value) => value.revokeRows(rows)
    );

    expect(bulk.revokeDialog.plan?.kind).toBe('bulk');
    expect(bulk.revokeDialog.plan?.targets.map((row) => row.name)).toEqual(['a', 'c']);

    bulk.revokeDialog.confirm('换机');
    await waitFor(() => changed.length > 0);

    expect(appended).toHaveLength(2);
    for (const item of appended) {
      const decoded = decodeKeyLogRecord(decodeBase64url(item.bytes));
      expect(decoded.type).toBe('revoke-node');
      expect(decodeRevokeNodePayload(decoded.payload).reason).toBe('换机');
    }
  }, 20000);
});
