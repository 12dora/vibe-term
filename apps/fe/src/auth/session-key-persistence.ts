// 会话钥（`sk_sess` + delegation）的跨文档持久化：IndexedDB 里的单条记录。
//
// 为什么需要：iOS 的 PWA 每次冷启动都是一个新 document，纯内存的会话钥必然丢失——entry 的
// HttpOnly cookie 还在，但每台远端 node 都会退回「登录该节点」并再要一次密码。
//
// 安全前提（docs/hub/2026082700-hub-node-architecture.md §2「会话钥的跨文档持久化」）：
//   * 只在 WebCrypto 能生成**不可导出** Ed25519 私钥时才启用。存进去的是 `CryptoKey` 本身，
//     structured clone 保留 non-extractable，JS（含 XSS）永远读不到私钥字节。
//   * `k_totp` 与一次性 TOTP 码**绝不写盘**；delegation 的 18 小时 TTL 就是这份记录的上限。
//   * 任何一步失败（隐私模式、配额、被其它 tab 阻塞）都退化成纯内存，绝不把异常抛给 UI。

import type { Delegation } from '@tmex/shared/auth';
import type { SessionKeyInfo } from './session-key-store';

const DB_NAME = 'tmex-auth';
const STORE_NAME = 'session';
const RECORD_KEY = 'current';
export const PERSISTED_SESSION_VERSION = 1;

export interface PersistedSession {
  version: number;
  info: SessionKeyInfo;
  /** 不可导出的 `sk_sess`。 */
  privateKey: CryptoKey;
  sessPk: Uint8Array;
  delegation: Delegation;
  delegationBytes: Uint8Array;
  delegationSig: Uint8Array;
}

function factory(): IDBFactory | null {
  try {
    return (globalThis as { indexedDB?: IDBFactory }).indexedDB ?? null;
  } catch {
    return null;
  }
}

/** 当前环境是否有 IndexedDB（隐私模式下可能有对象但一开就报错，那由各操作各自兜住）。 */
export function isSessionPersistenceAvailable(): boolean {
  return factory() !== null;
}

function openDb(): Promise<IDBDatabase | null> {
  const idb = factory();
  if (!idb) return Promise.resolve(null);
  return new Promise((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = idb.open(DB_NAME, 1);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    // 另一个 tab 拿着旧版本的连接不放：不等，直接当成没有持久化。
    request.onblocked = () => resolve(null);
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest
): Promise<T | null> {
  const db = await openDb();
  if (!db) return null;
  try {
    return await new Promise<T | null>((resolve) => {
      let request: IDBRequest;
      try {
        const tx = db.transaction(STORE_NAME, mode);
        tx.onabort = () => resolve(null);
        request = run(tx.objectStore(STORE_NAME));
      } catch {
        resolve(null);
        return;
      }
      request.onsuccess = () => resolve(request.result as T);
      request.onerror = () => resolve(null);
    });
  } catch {
    return null;
  } finally {
    try {
      db.close();
    } catch {
      // 关不掉也无所谓，连接随文档一起释放。
    }
  }
}

// 写与删必须串行：`adoptSessionSecrets()` 先清旧会话再存新会话，两个事务并发时删有可能后落地。
let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const next = queue.then(task, task);
  queue = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

export function savePersistedSession(record: PersistedSession): Promise<void> {
  return enqueue(async () => {
    await withStore('readwrite', (store) => store.put(record, RECORD_KEY));
  });
}

export function loadPersistedSession(): Promise<PersistedSession | null> {
  return enqueue(async () => {
    const record = await withStore<PersistedSession | undefined>('readonly', (store) =>
      store.get(RECORD_KEY)
    );
    return isUsableRecord(record) ? record : null;
  });
}

export function clearPersistedSession(): Promise<void> {
  return enqueue(async () => {
    await withStore('readwrite', (store) => store.delete(RECORD_KEY));
  });
}

/** 结构不对（换过格式 / 被人塞了别的东西）一律当成没有，不去猜。 */
function isUsableRecord(record: PersistedSession | null | undefined): record is PersistedSession {
  if (!record || typeof record !== 'object') return false;
  if (record.version !== PERSISTED_SESSION_VERSION) return false;
  const key = record.privateKey as CryptoKey | undefined;
  if (!key || typeof key !== 'object' || key.extractable !== false) return false;
  return (
    record.sessPk instanceof Uint8Array &&
    record.delegationBytes instanceof Uint8Array &&
    record.delegationSig instanceof Uint8Array &&
    typeof record.info?.expiresAt === 'number'
  );
}
