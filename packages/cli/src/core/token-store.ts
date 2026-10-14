// 令牌文件：`<config dir>/tokens.json`（目录 0700，文件 0600）。
//
// 存的是机器访问令牌的明文 secret（只在创建时返回一次），本身就是完整凭据：
// 权限与符号链接检查与会话文件一致，过期令牌一律当作不存在。

import { type ConfigEnv, tokensFilePath } from './config';
import type { UsageError } from './errors';
import {
  type SecureFileKind,
  loadSecureJson,
  saveSecureJson,
  securePrivacyError,
} from './secure-json-file';

export const TOKENS_FILE_VERSION = 1;

/** 与 apps/gateway/src/auth/access-tokens.ts 的 `SECRET_PATTERN` 一致：`vtk_` + base64url(32 字节)。 */
export const ACCESS_TOKEN_SECRET_PATTERN = /^vtk_[A-Za-z0-9_-]{43}$/;

export function isValidTokenSecret(secret: string): boolean {
  return ACCESS_TOKEN_SECRET_PATTERN.test(secret);
}

export interface StoredToken {
  /** 服务端令牌 id；`token add` 导入的令牌拿不到，为空串（只能用 `token rm --local` 清）。 */
  tokenId: string;
  /** 该节点真实的 mesh id（入口自己那台也是），不知道时为空串；用来把 `self` 与它的 mesh id 归为一台。 */
  nodeId: string;
  /** 保存时用户用来称呼该节点的名字；没有名册会话时靠它把名字解析回节点。 */
  nodeName: string;
  secret: string;
  name: string;
  scopes: string[];
  /** epoch 毫秒；null = 永不过期。 */
  expiresAt: number | null;
  createdAt: number;
}

export interface TokenEntry {
  /** 键为 CLI 寻址该节点的方式：`self` 或 32 位十六进制 mesh id。 */
  nodes: Record<string, StoredToken>;
}

export interface TokenFile {
  version: number;
  entries: Record<string, TokenEntry>;
}

/** HttpClient 只依赖这个窄接口取「某节点现在可用的令牌」。 */
export interface TokenSource {
  get(nodeId: string): { secret: string } | null;
  /** 节点名 → 寻址键（`self` 或 mesh id）；名册不可用（未登录）时 resolver 的兜底。 */
  nodeByName?(name: string): { id: string; name: string } | null;
}

export function isLiveToken(token: StoredToken | null | undefined, now = Date.now()): boolean {
  if (!token || !isValidTokenSecret(token.secret)) return false;
  return token.expiresAt === null || token.expiresAt > now;
}

function emptyFile(): TokenFile {
  return { version: TOKENS_FILE_VERSION, entries: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseToken(value: unknown): StoredToken | null {
  if (!isRecord(value)) return null;
  const { tokenId, nodeId, nodeName, secret, name, scopes, expiresAt, createdAt } = value;
  if (typeof secret !== 'string' || !isValidTokenSecret(secret)) return null;
  return {
    tokenId: typeof tokenId === 'string' ? tokenId : '',
    nodeId: typeof nodeId === 'string' ? nodeId : '',
    nodeName: typeof nodeName === 'string' ? nodeName : '',
    secret,
    name: typeof name === 'string' ? name : '',
    scopes: Array.isArray(scopes)
      ? scopes.filter((item): item is string => typeof item === 'string')
      : [],
    expiresAt: typeof expiresAt === 'number' ? expiresAt : null,
    createdAt: typeof createdAt === 'number' ? createdAt : 0,
  };
}

/** 只认得懂的字段，其余丢弃：手工改坏的文件不该让 CLI 整个起不来。 */
export function parseTokenFile(text: string): TokenFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return emptyFile();
  }
  const file = emptyFile();
  if (!isRecord(raw) || !isRecord(raw.entries)) return file;
  for (const [entryUrl, entry] of Object.entries(raw.entries)) {
    if (!isRecord(entry) || !isRecord(entry.nodes)) continue;
    const nodes: Record<string, StoredToken> = {};
    for (const [nodeKey, value] of Object.entries(entry.nodes)) {
      const token = parseToken(value);
      if (token) nodes[nodeKey] = token;
    }
    file.entries[entryUrl] = { nodes };
  }
  return file;
}

const TOKEN_FILE_KIND: SecureFileKind = {
  noun: 'token',
  sensitivity: 'this file holds usable access tokens, protect it',
};

/** 符号链接一律拒绝；win32 的 mode 恒为 0666/0444，跳过权限位。 */
export function tokenFilePrivacyError(
  path: string,
  info: { isSymbolicLink(): boolean; mode: number },
  platform: NodeJS.Platform = process.platform
): UsageError | null {
  return securePrivacyError(TOKEN_FILE_KIND, path, info, platform);
}

export class TokenStore {
  private data: TokenFile | null = null;

  constructor(
    readonly path: string,
    /** CLI 自有 config dir；覆盖路径的父目录不等于它时，已存在则不 chmod。 */
    private readonly ownDir: string | null = null
  ) {}

  static open(dir: string, env: ConfigEnv = process.env): TokenStore {
    return new TokenStore(tokensFilePath(dir, env), dir);
  }

  private load(): TokenFile {
    this.data ??= loadSecureJson(TOKEN_FILE_KIND, this.path, parseTokenFile, emptyFile);
    return this.data;
  }

  /** 该 entry 下某节点的有效令牌；过期或缺失为 null。 */
  get(entry: string, nodeKey: string, now = Date.now()): StoredToken | null {
    const token = this.load().entries[entry]?.nodes[nodeKey];
    return isLiveToken(token, now) ? token : null;
  }

  /** 该 entry 下所有已存令牌（含过期，供 `ls` 对账）。 */
  nodes(entry: string): Readonly<Record<string, StoredToken>> {
    return this.load().entries[entry]?.nodes ?? {};
  }

  source(entry: string): TokenSource {
    return {
      get: (nodeId) => this.get(entry, nodeId),
      nodeByName: (name) => this.nodeByName(entry, name),
    };
  }

  /**
   * 按保存时记下的节点名（忽略大小写）找节点；同名指向不同节点时视为歧义返回 null。
   * 返回寻址键：入口自己那台优先给 `self`。
   */
  nodeByName(entry: string, name: string, now = Date.now()): { id: string; name: string } | null {
    const wanted = name.trim().toLowerCase();
    if (!wanted) return null;
    const hits = Object.entries(this.nodes(entry)).filter(
      ([, token]) => token.nodeName.toLowerCase() === wanted && isLiveToken(token, now)
    );
    if (hits.length === 0) return null;
    const nodes = new Set(hits.map(([key, token]) => token.nodeId || key));
    if (nodes.size !== 1) return null;
    const key = hits.some(([hit]) => hit === 'self') ? 'self' : hits[0][0];
    return { id: key, name: hits[0][1].nodeName };
  }

  /** 同一把令牌可以挂在多个寻址键下（`self` 与入口自己的 mesh id）。 */
  put(entry: string, nodeKeys: readonly string[], token: StoredToken): void {
    const file = this.load();
    const record = file.entries[entry] ?? { nodes: {} };
    file.entries[entry] = record;
    for (const key of nodeKeys) record.nodes[key] = token;
  }

  /** 按服务端令牌 id 清掉所有寻址键；返回清掉的条数。 */
  removeById(entry: string, tokenId: string): number {
    if (!tokenId) return 0;
    const record = this.load().entries[entry];
    if (!record) return 0;
    let removed = 0;
    for (const [key, token] of Object.entries(record.nodes)) {
      if (token.tokenId !== tokenId) continue;
      delete record.nodes[key];
      removed += 1;
    }
    return removed;
  }

  /** 清掉这些寻址键下的所有令牌（不管服务端 id）；返回清掉的条数。 */
  removeKeys(entry: string, nodeKeys: readonly string[]): number {
    const record = this.load().entries[entry];
    if (!record) return 0;
    let removed = 0;
    for (const key of nodeKeys) {
      if (!(key in record.nodes)) continue;
      delete record.nodes[key];
      removed += 1;
    }
    return removed;
  }

  save(): void {
    saveSecureJson(this.path, this.ownDir, this.load());
  }
}
