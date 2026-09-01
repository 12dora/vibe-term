// 会话钥的 IndexedDB 持久化 + 「新 document 里恢复」的时序。
//
// bun test 没有 IndexedDB，这里用一个最小的内存假实现（只做 open / upgradeneeded / 单表
// get-put-delete，值走真正的 `structuredClone`，所以不可导出 CryptoKey 的往返是真的）。

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ApiClient } from '@tmex/api-client';
import { AuthApi, type MeshNode } from '@tmex/api-client/auth/index';
import {
  createDelegation,
  decodeBase64url,
  decodeDelegation,
  decodeLogin,
  encodeBase64url,
  generateEd25519KeyPair,
  generateWebCryptoEd25519KeyPair,
  rootKeyFromSeed,
  verifyLogin,
} from '@tmex/shared/auth';
import {
  PERSISTED_SESSION_VERSION,
  type PersistedSession,
  clearPersistedSession,
  isSessionPersistenceAvailable,
  loadPersistedSession,
  savePersistedSession,
} from './session-key-persistence';
import {
  adoptSessionSecrets,
  clearSessionKey,
  ensureNodeLogin,
  getSessionKey,
  resetNodeLoginsForTest,
  resetSessionMemoryForTest,
  restoreSessionKey,
} from './session-key-store';
import { establishSessionFromSeed, loginToNode } from './session-login';

// ---------------------------------------------------------------------------
// 最小 IndexedDB 假实现
// ---------------------------------------------------------------------------

interface FakeRequest {
  result: unknown;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
  onupgradeneeded?: (() => void) | null;
  onblocked?: (() => void) | null;
}

class FakeIndexedDb {
  readonly tables = new Map<string, Map<string, unknown>>();
  /** 隐私模式：连库都开不出来。 */
  failOpen = false;
  /** 配额用尽：事务写不进去。 */
  failWrite = false;
  /** 规范允许的时序：请求 `success` 已经发过，事务随后才 abort，改动整体回滚。 */
  abortAfterSuccess = false;

  open(_name: string, _version: number): FakeRequest {
    const request: FakeRequest = {
      result: null,
      onsuccess: null,
      onerror: null,
      onupgradeneeded: null,
      onblocked: null,
    };
    queueMicrotask(() => {
      if (this.failOpen) {
        request.onerror?.();
        return;
      }
      const fresh = this.tables.size === 0;
      request.result = new FakeDb(this);
      if (fresh) request.onupgradeneeded?.();
      request.onsuccess?.();
    });
    return request;
  }
}

interface FakeTransaction {
  onabort: (() => void) | null;
  onerror: (() => void) | null;
  oncomplete: (() => void) | null;
  objectStore: (name: string) => FakeStore;
}

class FakeDb {
  constructor(private readonly idb: FakeIndexedDb) {}

  get objectStoreNames(): { contains: (name: string) => boolean } {
    return { contains: (name: string) => this.idb.tables.has(name) };
  }

  createObjectStore(name: string): void {
    this.idb.tables.set(name, new Map());
  }

  transaction(name: string, _mode: string): FakeTransaction {
    const table = this.idb.tables.get(name);
    if (!table) throw new Error(`NotFoundError: ${name}`);
    const tx: FakeTransaction = {
      onabort: null,
      onerror: null,
      oncomplete: null,
      objectStore: (_store: string) => new FakeStore(table, tx, this.idb),
    };
    return tx;
  }

  close(): void {
    // 假实现没有连接可关。
  }
}

class FakeStore {
  constructor(
    private readonly table: Map<string, unknown>,
    private readonly tx: Pick<FakeTransaction, 'onabort' | 'oncomplete'>,
    private readonly idb: FakeIndexedDb
  ) {}

  private settle(run: () => unknown, write: boolean): FakeRequest {
    const request: FakeRequest = { result: undefined, onsuccess: null, onerror: null };
    queueMicrotask(() => {
      if (write && this.idb.failWrite) {
        request.onerror?.();
        this.tx.onabort?.();
        return;
      }
      const before = write ? new Map(this.table) : null;
      try {
        request.result = run();
      } catch {
        request.onerror?.();
        if (write) this.tx.onabort?.();
        return;
      }
      request.onsuccess?.();
      if (!write) return;
      // 写事务额外走一次提交/回滚：请求 success 之后才 abort 是规范允许的时序。
      if (this.idb.abortAfterSuccess) {
        this.table.clear();
        for (const [key, value] of before ?? []) this.table.set(key, value);
        this.tx.onabort?.();
        return;
      }
      this.tx.oncomplete?.();
    });
    return request;
  }

  get(key: string): FakeRequest {
    return this.settle(() => {
      const value = this.table.get(key);
      return value === undefined ? undefined : structuredClone(value);
    }, false);
  }

  put(value: unknown, key: string): FakeRequest {
    return this.settle(() => {
      this.table.set(key, structuredClone(value));
      return key;
    }, true);
  }

  delete(key: string): FakeRequest {
    return this.settle(() => {
      this.table.delete(key);
      return undefined;
    }, true);
  }
}

let idb: FakeIndexedDb;

function installFakeIndexedDb(): FakeIndexedDb {
  idb = new FakeIndexedDb();
  (globalThis as { indexedDB?: unknown }).indexedDB = idb;
  return idb;
}

function uninstallIndexedDb(): void {
  (globalThis as { indexedDB?: unknown }).indexedDB = undefined;
}

/** 盘上到底存了什么（绕过模块自己的校验，用来断言「什么都没写」）。 */
function rawRecord(): unknown {
  return idb.tables.get('session')?.get('current');
}

// ---------------------------------------------------------------------------
// 固定素材
// ---------------------------------------------------------------------------

const UID = 'alice';
const ENTRY = '0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e';
const NODE_A = '0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a';

function fill(length: number, value: number): Uint8Array {
  const out = new Uint8Array(length);
  out.fill(value);
  return out;
}

const ROOT_SEED = fill(32, 0x11);
const NODE_A_PK = fill(32, 0x22);
const NONCE = fill(32, 0x44);

function meshRow(id: string, publicKey: Uint8Array): MeshNode {
  return {
    id,
    name: id,
    publicKey: encodeBase64url(publicKey),
    online: true,
    reach: 'lan',
    version: null,
    direct_capable: false,
    inventory: null,
    loggedIn: false,
  };
}

interface Captured {
  login?: Record<string, string>;
}

function mockApi(): { api: AuthApi; captured: Captured } {
  const captured: Captured = {};
  const client = new ApiClient('', (url, init) => {
    const match = /^\/n\/([^/]+)\/api\/auth\/(challenge|login)$/.exec(url);
    if (!match) return Promise.resolve(new Response('not found', { status: 404 }));
    if (match[2] === 'challenge') {
      return Promise.resolve(
        Response.json({
          challenge_id: `c-${match[1]}`,
          nonce: encodeBase64url(NONCE),
          nodePk: encodeBase64url(NODE_A_PK),
        })
      );
    }
    captured.login = JSON.parse(String(init?.body)) as Record<string, string>;
    return Promise.resolve(Response.json({ expires_at: 1 }));
  });
  return { api: new AuthApi(client), captured };
}

async function persistedFixture(overrides: Partial<PersistedSession> = {}) {
  const pair = await generateWebCryptoEd25519KeyPair();
  const signed = createDelegation(rootKeyFromSeed(new Uint8Array(ROOT_SEED)), {
    uid: UID,
    sessPk: pair.publicKey,
    now: Date.now(),
  });
  return {
    version: PERSISTED_SESSION_VERSION,
    info: {
      uid: UID,
      entryNodeId: ENTRY,
      method: 'root' as const,
      issuedAt: Number(signed.delegation.issued_at),
      expiresAt: Number(signed.delegation.exp),
      hasTotp: false,
      credentialId: null,
    },
    privateKey: pair.privateKey,
    sessPk: pair.publicKey,
    delegation: signed.delegation,
    delegationBytes: signed.bytes,
    delegationSig: signed.sig,
    ...overrides,
  } satisfies PersistedSession;
}

beforeEach(() => {
  installFakeIndexedDb();
});

afterEach(async () => {
  clearSessionKey();
  resetNodeLoginsForTest();
  await clearPersistedSession();
});

afterAll(() => {
  // 别把 indexedDB 漏给同进程里的其它测试文件。
  uninstallIndexedDb();
});

describe('session-key-persistence', () => {
  test('存进去再读出来：CryptoKey 仍不可导出，字节原样往返', async () => {
    const record = await persistedFixture();
    await savePersistedSession(record);

    const loaded = await loadPersistedSession();
    expect(loaded).not.toBeNull();
    expect(loaded?.privateKey.extractable).toBe(false);
    expect(loaded?.privateKey.type).toBe('private');
    expect(loaded?.sessPk).toEqual(record.sessPk);
    expect(loaded?.delegationBytes).toEqual(record.delegationBytes);
    expect(loaded?.info.uid).toBe(UID);
  });

  test('没有记录 / 删掉之后都读到 null', async () => {
    expect(await loadPersistedSession()).toBeNull();
    await savePersistedSession(await persistedFixture());
    expect(await loadPersistedSession()).not.toBeNull();
    await clearPersistedSession();
    expect(await loadPersistedSession()).toBeNull();
  });

  test('版本对不上或私钥可导出的记录一律当成没有', async () => {
    await savePersistedSession(await persistedFixture({ version: 99 }));
    expect(await loadPersistedSession()).toBeNull();

    const extractable = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
      'sign',
      'verify',
    ]);
    await savePersistedSession(
      await persistedFixture({ privateKey: (extractable as CryptoKeyPair).privateKey })
    );
    expect(await loadPersistedSession()).toBeNull();
  });

  test('环境没有 IndexedDB：三个操作都不抛，读到 null', async () => {
    uninstallIndexedDb();
    expect(isSessionPersistenceAvailable()).toBe(false);
    await savePersistedSession(await persistedFixture());
    expect(await loadPersistedSession()).toBeNull();
    await clearPersistedSession();
    installFakeIndexedDb();
  });

  test('开库失败（隐私模式）与写事务失败（配额）都退化成纯内存，不抛异常', async () => {
    idb.failOpen = true;
    await savePersistedSession(await persistedFixture());
    expect(await loadPersistedSession()).toBeNull();

    idb.failOpen = false;
    idb.failWrite = true;
    expect(await savePersistedSession(await persistedFixture())).toBe(false);
    idb.failWrite = false;
    expect(await loadPersistedSession()).toBeNull();
  });

  test('请求 success 之后事务才 abort：写与删都按失败上报，改动整体回滚', async () => {
    const record = await persistedFixture();
    expect(await savePersistedSession(record)).toBe(true);
    expect(rawRecord()).toBeDefined();

    idb.abortAfterSuccess = true;
    // 删：request.success 已经发过，但事务没提交——不能当成删掉了。
    expect(await clearPersistedSession()).toBe(false);
    expect(rawRecord()).toBeDefined();

    // 写：同理，回滚后盘上还是原来那条。
    const replacement = await persistedFixture({ info: { ...record.info, uid: 'mallory' } });
    expect(await savePersistedSession(replacement)).toBe(false);
    idb.abortAfterSuccess = false;
    expect((await loadPersistedSession())?.info.uid).toBe(UID);
  });
});

describe('会话钥跨 document 恢复', () => {
  test('PWA 冷启动：内存空了也能恢复出会话钥，并用 WebCrypto 私钥签出可验的 login', async () => {
    await establishSessionFromSeed(new Uint8Array(ROOT_SEED), {
      uid: UID,
      entryNodeId: ENTRY,
      rootEpoch: 0,
      hasTotp: false,
    });
    // 落盘是 fire-and-forget，等一轮队列。
    await loadPersistedSession();

    resetSessionMemoryForTest();
    expect(getSessionKey()).toBeNull();

    const restored = await restoreSessionKey();
    expect(restored?.uid).toBe(UID);
    expect(restored?.entryNodeId).toBe(ENTRY);

    const { api, captured } = mockApi();
    expect(await loginToNode(NODE_A, { api, node: meshRow(NODE_A, NODE_A_PK) })).toEqual({
      ok: true,
    });
    const body = captured.login as Record<string, string>;
    const delegation = decodeDelegation(decodeBase64url(body.delegation));
    expect(
      verifyLogin(
        decodeLogin(decodeBase64url(body.login)),
        decodeBase64url(body.sig),
        delegation.sess_pk,
        {
          challengeId: `c-${NODE_A}`,
          nonce: NONCE,
          target: NODE_A,
          targetPk: NODE_A_PK,
          uid: UID,
          entry: ENTRY,
        }
      )
    ).toEqual({ ok: true });
  });

  test('ensureNodeLogin 先等恢复再判定，不会把冷启动第一帧误判成 NO_SESSION_KEY', async () => {
    await establishSessionFromSeed(new Uint8Array(ROOT_SEED), {
      uid: UID,
      entryNodeId: ENTRY,
      rootEpoch: 0,
      hasTotp: false,
    });
    await loadPersistedSession();
    resetSessionMemoryForTest();

    const { api } = mockApi();
    expect(await ensureNodeLogin(NODE_A, { api, node: meshRow(NODE_A, NODE_A_PK) })).toEqual({
      ok: true,
    });
  });

  test('记录已过期：不恢复，并把它从盘上删掉', async () => {
    const record = await persistedFixture();
    await savePersistedSession({
      ...record,
      info: { ...record.info, expiresAt: Date.now() - 1 },
    });
    resetSessionMemoryForTest();

    expect(await restoreSessionKey()).toBeNull();
    // 不许在这里手动删：清理必须由 `readPersistedSession()` 自己做，测试只冲一遍持久化队列。
    await loadPersistedSession();
    expect(rawRecord()).toBeUndefined();
  });

  test('登出（clearSessionKey）连盘上那份一起清掉，新 document 也恢复不出来', async () => {
    await establishSessionFromSeed(new Uint8Array(ROOT_SEED), {
      uid: UID,
      entryNodeId: ENTRY,
      rootEpoch: 0,
      hasTotp: false,
    });
    await loadPersistedSession();
    expect(rawRecord()).toBeDefined();

    clearSessionKey();
    await loadPersistedSession();
    expect(rawRecord()).toBeUndefined();

    resetSessionMemoryForTest();
    expect(await restoreSessionKey()).toBeNull();
  });

  test('await clearSessionKey()：promise 落定时盘上那条一定已经没了', async () => {
    await establishSessionFromSeed(new Uint8Array(ROOT_SEED), {
      uid: UID,
      entryNodeId: ENTRY,
      rootEpoch: 0,
      hasTotp: false,
    });
    await loadPersistedSession();
    expect(rawRecord()).toBeDefined();

    const cleared = clearSessionKey();
    // 内存是同步清的，盘上那条还在飞——登出路径必须等它。
    expect(getSessionKey()).toBeNull();
    expect(await cleared).toBe(true);
    // 这里不再冲队列：await 本身就该保证删除已提交。
    expect(rawRecord()).toBeUndefined();

    resetSessionMemoryForTest();
    expect(await restoreSessionKey()).toBeNull();
  });

  test('登出时删除没提交：clearSessionKey() 如实返回 false，不谎报已登出', async () => {
    await establishSessionFromSeed(new Uint8Array(ROOT_SEED), {
      uid: UID,
      entryNodeId: ENTRY,
      rootEpoch: 0,
      hasTotp: false,
    });
    await loadPersistedSession();

    idb.abortAfterSuccess = true;
    expect(await clearSessionKey()).toBe(false);
    idb.abortAfterSuccess = false;
    expect(rawRecord()).toBeDefined();
  });

  test('开了 TOTP 的密码会话不写盘：k_totp 与一次性码都不许落地', async () => {
    await establishSessionFromSeed(new Uint8Array(ROOT_SEED), {
      uid: UID,
      entryNodeId: ENTRY,
      rootEpoch: 0,
      hasTotp: true,
      totpCode: '123456',
    });
    await loadPersistedSession();
    expect(rawRecord()).toBeUndefined();
  });

  test('WebCrypto 不可用的回退路径：原始私钥只留内存，不写盘，签名照样可验', async () => {
    const sess = generateEd25519KeyPair();
    const signed = createDelegation(rootKeyFromSeed(new Uint8Array(ROOT_SEED)), {
      uid: UID,
      sessPk: sess.publicKey,
      now: Date.now(),
    });
    adoptSessionSecrets({
      info: {
        uid: UID,
        entryNodeId: ENTRY,
        method: 'root',
        issuedAt: Number(signed.delegation.issued_at),
        expiresAt: Number(signed.delegation.exp),
        hasTotp: false,
        credentialId: null,
      },
      sessKey: null,
      sessSk: sess.secretKey,
      sessPk: sess.publicKey,
      delegation: signed.delegation,
      delegationBytes: signed.bytes,
      delegationSig: signed.sig,
      kTotp: null,
      totpCode: null,
    });
    await loadPersistedSession();
    expect(rawRecord()).toBeUndefined();

    const { api, captured } = mockApi();
    expect(await loginToNode(NODE_A, { api, node: meshRow(NODE_A, NODE_A_PK) })).toEqual({
      ok: true,
    });
    const body = captured.login as Record<string, string>;
    expect(
      verifyLogin(
        decodeLogin(decodeBase64url(body.login)),
        decodeBase64url(body.sig),
        sess.publicKey,
        {
          challengeId: `c-${NODE_A}`,
          nonce: NONCE,
          target: NODE_A,
          targetPk: NODE_A_PK,
          uid: UID,
          entry: ENTRY,
        }
      )
    ).toEqual({ ok: true });

    resetSessionMemoryForTest();
    expect(await restoreSessionKey()).toBeNull();
  });

  test('IndexedDB 不可用时一切照旧：会话建得起来，只是不跨 document', async () => {
    uninstallIndexedDb();
    try {
      const info = await establishSessionFromSeed(new Uint8Array(ROOT_SEED), {
        uid: UID,
        entryNodeId: ENTRY,
        rootEpoch: 0,
        hasTotp: false,
      });
      expect(info.uid).toBe(UID);
      expect(getSessionKey()?.uid).toBe(UID);

      resetSessionMemoryForTest();
      expect(await restoreSessionKey()).toBeNull();
    } finally {
      installFakeIndexedDb();
    }
  });
});
