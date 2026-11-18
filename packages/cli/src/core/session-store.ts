// 会话文件：`<config dir>/session.json`（目录 0700，文件 0600）。
//
// v2 在每个 `nodes[nodeId]` 上保存登录时的 `{ sessSk, sessPk }`（base64url），与该 node
// 的 sid 成对。早期 v2 把密钥写在 entry 上：读入时复制到当时每一个 node 记录。v1 没有密钥，
// 读入后请求不带 PoP。密码与根种子仍然绝不落盘。

import { rmSync } from 'node:fs';
import { SELF_NODE_ID } from '@vibeterm/api-client/node-url';
import { type ConfigEnv, sessionFilePath } from './config';
import type { UsageError } from './errors';
import {
  type SecureFileKind,
  loadSecureJson,
  saveSecureJson,
  securePrivacyError,
} from './secure-json-file';
import { type PopKeyPair, copyPopKey, encodePopKey, parsePopKey } from './session-pop';

export const SESSION_FILE_VERSION = 2;

export interface NodeSession {
  nodeId: string;
  /** `vibeterm_s_<nodeId>` 的值。 */
  sid: string;
  /** epoch 毫秒；0 表示服务端没给到期时刻。 */
  expiresAt: number;
  /** Ed25519 会话私钥（base64url）；v1 与未登录 PoP 的条目没有。 */
  sessSk?: string;
  /** Ed25519 会话公钥（base64url）；v1 与未登录 PoP 的条目没有。 */
  sessPk?: string;
}

/** jar / session.json 里有非空 sid，且未过期（`expiresAt === 0` 视为服务端没给到期）。 */
export function isLiveNodeSession(
  session: NodeSession | null | undefined,
  now = Date.now()
): boolean {
  if (!session?.sid) return false;
  if (!session.expiresAt) return true;
  return session.expiresAt > now;
}

export interface EntrySession {
  entry: string;
  uid: string | null;
  username: string | null;
  updatedAt: number;
  nodes: Record<string, NodeSession>;
}

export interface SessionFile {
  version: number;
  lastEntry: string | null;
  entries: Record<string, EntrySession>;
}

export interface CookieJar {
  get(nodeId: string): NodeSession | null;
  set(nodeId: string, sid: string, expiresAt: number): void;
  clear(nodeId: string): void;
  list(): NodeSession[];
  popKey(nodeId: string): PopKeyPair | null;
  setPopKey(nodeId: string, key: PopKeyPair | null): void;
}

interface EncodedPopKey {
  sessSk: string;
  sessPk: string;
}

function emptyFile(): SessionFile {
  return { version: SESSION_FILE_VERSION, lastEntry: null, entries: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalB64(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function encodedPopKey(sessSk: unknown, sessPk: unknown): EncodedPopKey | undefined {
  const sk = optionalB64(sessSk);
  const pk = optionalB64(sessPk);
  if (!sk || !pk || !parsePopKey(sk, pk)) return undefined;
  return { sessSk: sk, sessPk: pk };
}

function withPopKey(session: NodeSession, key: EncodedPopKey | undefined): NodeSession {
  const base: NodeSession = {
    nodeId: session.nodeId,
    sid: session.sid,
    expiresAt: session.expiresAt,
  };
  return key ? { ...base, ...key } : base;
}

function parseNode(value: unknown, inherited?: EncodedPopKey): NodeSession | null {
  if (!isRecord(value)) return null;
  const { nodeId, sid, expiresAt } = value;
  if (typeof nodeId !== 'string' || typeof sid !== 'string' || !nodeId || !sid) return null;
  return withPopKey(
    {
      nodeId,
      sid,
      expiresAt: typeof expiresAt === 'number' ? expiresAt : 0,
    },
    encodedPopKey(value.sessSk, value.sessPk) ?? inherited
  );
}

function parseEntry(key: string, value: unknown): EntrySession | null {
  if (!isRecord(value)) return null;
  const inherited = encodedPopKey(value.sessSk, value.sessPk);
  const nodes: Record<string, NodeSession> = {};
  if (isRecord(value.nodes)) {
    for (const [nodeId, raw] of Object.entries(value.nodes)) {
      const node = parseNode(raw, inherited);
      if (node) nodes[nodeId] = node;
    }
  }
  return {
    entry: typeof value.entry === 'string' ? value.entry : key,
    uid: typeof value.uid === 'string' ? value.uid : null,
    username: typeof value.username === 'string' ? value.username : null,
    updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : 0,
    nodes,
  };
}

/** 只认得懂的字段，其余一律丢弃：手工改坏的文件不该让 CLI 整个起不来。 */
export function parseSessionFile(text: string): SessionFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return emptyFile();
  }
  if (!isRecord(raw)) return emptyFile();
  const file = emptyFile();
  if (typeof raw.lastEntry === 'string') file.lastEntry = raw.lastEntry;
  if (isRecord(raw.entries)) {
    for (const [key, value] of Object.entries(raw.entries)) {
      const entry = parseEntry(key, value);
      if (entry) file.entries[key] = entry;
    }
  }
  return file;
}

const SESSION_FILE_KIND: SecureFileKind = {
  noun: 'session',
  sensitivity: 'this file holds the session private key, protect it',
};

/** 符号链接一律拒绝；win32 的 mode 恒为 0666/0444，跳过权限位。 */
export function sessionFilePrivacyError(
  path: string,
  info: { isSymbolicLink(): boolean; mode: number },
  platform: NodeJS.Platform = process.platform
): UsageError | null {
  return securePrivacyError(SESSION_FILE_KIND, path, info, platform);
}

export class SessionStore {
  private data: SessionFile | null = null;

  constructor(
    readonly path: string,
    /** CLI 自有 config dir；覆盖路径的父目录不等于它时，已存在则不 chmod。 */
    private readonly ownDir: string | null = null
  ) {}

  static open(dir: string, env: ConfigEnv = process.env): SessionStore {
    return new SessionStore(sessionFilePath(dir, env), dir);
  }

  /** 已有文件必须是 0600：group/world 可读就是把完整会话能力泄露出去。 */
  private load(): SessionFile {
    this.data ??= loadSecureJson(SESSION_FILE_KIND, this.path, parseSessionFile, emptyFile);
    this.data.version = SESSION_FILE_VERSION;
    return this.data;
  }

  snapshot(): SessionFile {
    return this.load();
  }

  lastEntry(): string | null {
    return this.load().lastEntry;
  }

  entry(entry: string): EntrySession | null {
    return this.load().entries[entry] ?? null;
  }

  private ensureEntry(entry: string): EntrySession {
    const file = this.load();
    const existing = file.entries[entry];
    if (existing) return existing;
    const created: EntrySession = {
      entry,
      uid: null,
      username: null,
      updatedAt: Date.now(),
      nodes: {},
    };
    file.entries[entry] = created;
    return created;
  }

  setIdentity(entry: string, identity: { uid: string | null; username: string | null }): void {
    const record = this.ensureEntry(entry);
    record.uid = identity.uid;
    record.username = identity.username;
    record.updatedAt = Date.now();
    this.load().lastEntry = entry;
  }

  setNodeSession(entry: string, session: NodeSession): void {
    const record = this.ensureEntry(entry);
    const prev = record.nodes[session.nodeId];
    record.nodes[session.nodeId] = withPopKey(
      { nodeId: session.nodeId, sid: session.sid, expiresAt: session.expiresAt },
      encodedPopKey(session.sessSk, session.sessPk) ?? encodedPopKey(prev?.sessSk, prev?.sessPk)
    );
    record.updatedAt = Date.now();
    this.load().lastEntry = entry;
  }

  setPopKey(entry: string, nodeId: string, key: PopKeyPair | null): void {
    const record = this.ensureEntry(entry);
    const node = record.nodes[nodeId];
    if (!node) return;
    record.nodes[nodeId] = withPopKey(node, key ? encodePopKey(copyPopKey(key)) : undefined);
    record.updatedAt = Date.now();
    this.load().lastEntry = entry;
  }

  popKey(entry: string, nodeId: string): PopKeyPair | null {
    const node = this.load().entries[entry]?.nodes[nodeId];
    return parsePopKey(node?.sessSk, node?.sessPk);
  }

  clearNodeSession(entry: string, nodeId: string): void {
    const record = this.load().entries[entry];
    if (!record) return;
    delete record.nodes[nodeId];
    record.updatedAt = Date.now();
  }

  clearEntry(entry: string): void {
    const file = this.load();
    delete file.entries[entry];
    if (file.lastEntry === entry) file.lastEntry = null;
  }

  save(): void {
    saveSecureJson(this.path, this.ownDir, this.load());
  }

  remove(): void {
    rmSync(this.path, { force: true });
    this.data = emptyFile();
  }
}

/**
 * 部分登录才复用 stored self 密钥：self 会话必须仍有效，且 entry 上记下的 uid
 * 与正在登录的账户一致。过期、缺失或换账户则返回 null，调用方应生成新对。
 */
export function reusableSelfPopKey(
  store: SessionStore,
  entry: string,
  uid: string | null | undefined
): PopKeyPair | null {
  if (!uid) return null;
  const record = store.entry(entry);
  if (!record || record.uid !== uid) return null;
  const self = record.nodes[SELF_NODE_ID];
  if (!isLiveNodeSession(self)) return null;
  return parsePopKey(self.sessSk, self.sessPk);
}

/** 落盘的 cookie 罐：每次写入立即持久化，命令中途被打断也不会丢掉刚拿到的会话。 */
export function createSessionCookieJar(store: SessionStore, entry: string): CookieJar {
  return {
    get(nodeId) {
      return store.entry(entry)?.nodes[nodeId] ?? null;
    },
    set(nodeId, sid, expiresAt) {
      store.setNodeSession(entry, { nodeId, sid, expiresAt });
      store.save();
    },
    clear(nodeId) {
      store.clearNodeSession(entry, nodeId);
      store.save();
    },
    list() {
      return Object.values(store.entry(entry)?.nodes ?? {});
    },
    popKey(nodeId) {
      return store.popKey(entry, nodeId);
    },
    setPopKey(nodeId, key) {
      store.setPopKey(entry, nodeId, key);
      store.save();
    },
  };
}

export function createMemoryCookieJar(): CookieJar {
  const nodes = new Map<string, NodeSession>();
  return {
    get: (nodeId) => nodes.get(nodeId) ?? null,
    set: (nodeId, sid, expiresAt) => {
      const prev = nodes.get(nodeId);
      nodes.set(
        nodeId,
        withPopKey({ nodeId, sid, expiresAt }, encodedPopKey(prev?.sessSk, prev?.sessPk))
      );
    },
    clear: (nodeId) => {
      nodes.delete(nodeId);
    },
    list: () => [...nodes.values()],
    popKey: (nodeId) => {
      const node = nodes.get(nodeId);
      return parsePopKey(node?.sessSk, node?.sessPk);
    },
    setPopKey: (nodeId, key) => {
      const node = nodes.get(nodeId);
      if (!node) return;
      nodes.set(nodeId, withPopKey(node, key ? encodePopKey(copyPopKey(key)) : undefined));
    },
  };
}
