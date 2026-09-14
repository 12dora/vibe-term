// 节点行动作：重命名走 key-log，吊销走确认框而不是浏览器 confirm。

import { afterEach, describe, expect, test } from 'bun:test';
import type { CredentialPromptHandle } from '@/auth/credential-prompt';
import type { RecordSigner } from '@/auth/key-log-actions';
import type { NodeRow } from '@/node/mesh-nodes';
import { resetMeshRelayStateForTest } from '@/node/mesh-relay';
import type { AuthApi } from '@vibeterm/api-client/auth/index';
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
import { useBulkRevoke, useNodeRowActions } from './use-node-row-actions';

const KDF_JSON = {
  salt: encodeBase64url(new Uint8Array(16).fill(0x05)),
  memory_kib: 64,
  iterations: 1,
  parallelism: 1,
};
const NODE_ID = 'ab'.repeat(16);

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

const MODE = { uid: 'u1', rootEpoch: 3, kdfParams: KDF_JSON } as unknown as ResolvedMode;

afterEach(() => {
  resetMeshRelayStateForTest();
});

// ---------------------------------------------------------------------------
// 改名：签 rename-node
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

function renameDeps(appended: Appended[], signer: RecordSigner): NodeActionDeps {
  return {
    uplinkWritable: true,
    mode: { uid: 'user-1', rootEpoch: 0, kdfParams: KDF_JSON } as unknown as ResolvedMode,
    api: authApi(appended),
    prompt: promptStub(signer),
    onChanged: () => undefined,
  } as unknown as NodeActionDeps;
}

describe('useNodeRowActions 的改名', () => {
  test('签 rename-node 记录', async () => {
    const appended: Appended[] = [];
    await renameOf(renameDeps(appended, await rootSigner()))('studio');
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
    uplinkWritable: true,
    mode: MODE,
    api: authApi(appended),
    prompt: promptStub(signer),
    onChanged: () => changed.push('changed'),
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

  function stubNoRelay(): void {
    globalThis.fetch = ((input: string) =>
      String(input).includes('/api/mesh/relay/status')
        ? Promise.resolve(Response.json({ mode: 'none', relays: [] }))
        : Promise.resolve(new Response('{}', { status: 404 }))) as typeof fetch;
  }

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test('确认：原因原样签进 revoke-node 记录，随后刷新列表', async () => {
    stubNoRelay();
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
    stubNoRelay();
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
    stubNoRelay();
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
