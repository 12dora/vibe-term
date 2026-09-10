// 命令上下文：命令组只依赖这一个对象，不自己拼 URL、不自己碰会话文件。

import { SELF_NODE_ID } from '@vibeterm/api-client/node-url';
import {
  configDir as defaultConfigDir,
  entryOrigin,
  installBaseUrl,
  normalizeEntry,
  pickEntry,
} from './config';
import { type FetchLike, HttpClient, createSessionCookieJar } from './http';
import { Output, shouldUseColor } from './output';
import { Resolver } from './resolve';
import { SessionStore } from './session-store';
import { type GatewaySocket, type OpenGatewaySocketOptions, openGatewaySocket } from './ws';

export const DEFAULT_TIMEOUT_MS = 30_000;

export interface CliGlobals {
  entry: string;
  /** `--node` 原文（id 或名字）；未给为 null。 */
  node: string | null;
  json: boolean;
  quiet: boolean;
  color: boolean;
  timeoutMs: number;
}

export interface CliContext {
  readonly globals: CliGlobals;
  readonly out: Output;
  readonly http: HttpClient;
  readonly sessions: SessionStore;
  readonly resolver: Resolver;
  readonly configDir: string;
  /** `--node` 解析成 node id；未给即 `self`。 */
  targetNodeId(): Promise<string>;
  openSocket(nodeId: string, options?: OpenGatewaySocketOptions): Promise<GatewaySocket>;
}

export interface BuildContextOptions {
  entryFlag?: string;
  node?: string | null;
  json: boolean;
  quiet: boolean;
  noColor: boolean;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** 测试注入：跳过真实的 `~/.config` 与安装目录探测。 */
  configDir?: string;
  installEntry?: string | null;
  /** 测试注入：替换 `fetch` 与输出流。 */
  fetchImpl?: FetchLike;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

export function buildContext(options: BuildContextOptions): CliContext {
  const env = options.env ?? process.env;
  const dir = options.configDir ?? defaultConfigDir(env);
  const sessions = SessionStore.open(dir);
  const entry = pickEntry({
    flag: options.entryFlag,
    env: env.VIBETERM_ENTRY?.trim() || undefined,
    session: sessions.lastEntry() ?? undefined,
    install:
      (options.installEntry === undefined ? installBaseUrl() : options.installEntry) ?? undefined,
  });
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const globals: CliGlobals = {
    entry,
    node: options.node ?? null,
    json: options.json,
    quiet: options.quiet,
    color: shouldUseColor(options.noColor, env),
    timeoutMs,
  };
  const http = new HttpClient({
    entry,
    timeoutMs,
    jar: createSessionCookieJar(sessions, entry),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  const out = new Output({
    json: globals.json,
    quiet: globals.quiet,
    color: globals.color,
    ...(options.stdout ? { stdout: options.stdout } : {}),
    ...(options.stderr ? { stderr: options.stderr } : {}),
  });
  const resolver = new Resolver(http);

  let cachedNodeId: string | null = null;
  return {
    globals,
    out,
    http,
    sessions,
    resolver,
    configDir: dir,
    async targetNodeId() {
      if (cachedNodeId) return cachedNodeId;
      if (!globals.node) {
        cachedNodeId = SELF_NODE_ID;
        return cachedNodeId;
      }
      cachedNodeId = (await resolver.resolveNode(globals.node)).id;
      return cachedNodeId;
    },
    openSocket(nodeId, socketOptions) {
      return openGatewaySocket(http, nodeId, { timeoutMs, ...socketOptions });
    },
  };
}

export { entryOrigin, normalizeEntry };
