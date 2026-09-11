// 会话文件：`<config dir>/session.json`（目录 0700，文件 0600）。
//
// 只存会话 cookie（sid）与它的到期时刻，**绝不落盘密码、根种子或会话私钥**：
// 会话过期后重新 `vibeterm login` 即可，落盘私钥换来的只是一点便利和一个长期把柄。

import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { sessionFilePath } from './config';

export const SESSION_FILE_VERSION = 1;

export interface NodeSession {
  nodeId: string;
  /** `vibeterm_s_<nodeId>` 的值。 */
  sid: string;
  /** epoch 毫秒；0 表示服务端没给到期时刻。 */
  expiresAt: number;
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

function emptyFile(): SessionFile {
  return { version: SESSION_FILE_VERSION, lastEntry: null, entries: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseNode(value: unknown): NodeSession | null {
  if (!isRecord(value)) return null;
  const { nodeId, sid, expiresAt } = value;
  if (typeof nodeId !== 'string' || typeof sid !== 'string' || !nodeId || !sid) return null;
  return { nodeId, sid, expiresAt: typeof expiresAt === 'number' ? expiresAt : 0 };
}

function parseEntry(key: string, value: unknown): EntrySession | null {
  if (!isRecord(value)) return null;
  const nodes: Record<string, NodeSession> = {};
  if (isRecord(value.nodes)) {
    for (const [nodeId, raw] of Object.entries(value.nodes)) {
      const node = parseNode(raw);
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

export class SessionStore {
  private data: SessionFile | null = null;

  constructor(readonly path: string) {}

  static open(dir: string): SessionStore {
    return new SessionStore(sessionFilePath(dir));
  }

  private load(): SessionFile {
    if (this.data) return this.data;
    try {
      this.data = parseSessionFile(readFileSync(this.path, 'utf8'));
    } catch {
      this.data = emptyFile();
    }
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
    record.nodes[session.nodeId] = session;
    record.updatedAt = Date.now();
    this.load().lastEntry = entry;
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

  /** 原子写：先写同目录临时文件（0600）再 rename，避免半截文件被下次读到。 */
  save(): void {
    const file = this.load();
    const dir = dirname(this.path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const tmp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    try {
      writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, this.path);
    } catch (error) {
      rmSync(tmp, { force: true });
      throw error;
    }
  }

  remove(): void {
    rmSync(this.path, { force: true });
    this.data = emptyFile();
  }
}
