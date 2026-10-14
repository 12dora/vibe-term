// `vibeterm token`：机器访问令牌（无人值守的 agent / CI 用，不必登录）。

import { SELF_NODE_ID, isValidNodeId } from '@vibeterm/api-client/node-url';
import {
  ACCESS_TOKEN_EXPIRES_DAYS_MAX,
  ACCESS_TOKEN_NAME_MAX,
  ACCESS_TOKEN_SCOPES,
  type AccessTokenDto,
  type AccessTokenListResponse,
  type AccessTokenScope,
  type CreateAccessTokenRequest,
  type CreateAccessTokenResponse,
  isAccessTokenScope,
} from '@vibeterm/shared';
import { type FlagValues, flagBool, flagString } from '../core/args';
import { type SubHandler, emit, rejectExtra, requireArg, runSubs } from '../core/cmd';
import type { CliContext } from '../core/context';
import { AuthError, PermissionError, UsageError } from '../core/errors';
import { NODE_TOKEN_COOKIE_PREFIX, TOKEN_SCOPE_CODE } from '../core/http';
import { readAllStdin } from '../core/prompt';
import { type StoredToken, isLiveToken, isValidTokenSecret } from '../core/token-store';
import type { Command } from './types';

const FLAGS = {
  name: 'string',
  scope: 'string',
  expires: 'string',
  print: 'boolean',
  'no-save': 'boolean',
  local: 'boolean',
  id: 'string',
} as const;

const DEFAULT_SCOPE: AccessTokenScope = 'exec';
const DEFAULT_EXPIRES = '90d';
const DAYS_PER_YEAR = 365;

const USAGE = [
  '用法：vibeterm token <子命令>',
  '',
  '机器访问令牌：给 agent / CI 这类无人值守的调用方，免登录执行 exec / rsh / 文件 / 端口转发。',
  '令牌按 scope 授权，只对创建它的节点有效；创建、查看、吊销必须用真实登录会话。',
  '',
  '子命令：',
  '  create [<node>] --name <名称> [--scope exec,files,forward] [--expires 30d|90d|1y|never|<N>d]',
  '         [--print | --no-save]',
  '                               创建令牌并保存到本机（默认 scope=exec，有效期 90d）',
  '                               --print    保存后把 secret 也打印到 stdout（其余提示走 stderr）',
  '                               --no-save  不保存，只把 secret 打印到 stdout（交给别的机器）',
  '  ls [<node>]                  列出令牌：ID NAME SCOPES CREATED LAST USED EXPIRES SAVED',
  '  rm [<node>] <id|名称>        吊销令牌，并清掉本机保存的副本',
  '  rm --local [<node>]          只清掉本机保存的该节点令牌，不联系服务端（add 导入的令牌用这个清）',
  '  add [<node>] <secret|-> [--id <32位节点id>]',
  '                               保存一个已有的 secret（如网页端创建的）；先验证再落盘，- 表示读 stdin',
  '                               没有登录会话时无法按名字解析节点：直接给节点 id，或用 --id 并把名字当别名',
  '',
  'scope：exec = 远程命令（exec / rsh）；files = 文件读写与传输；forward = 端口转发。',
  '本机保存位置：<配置目录>/tokens.json（0600），可用 VIBETERM_TOKENS_FILE 改路径。',
  '同一节点有登录会话时优先用会话，令牌只在没有会话时生效；vibeterm nodes ls 的 LOGIN 列显示 session / token。',
  '保存令牌时会记下节点名，之后没有会话也能用该名字寻址这台节点（名册要登录才能读）。',
  'add 导入的令牌拿不到服务端 id：ls 的 SAVED 显示 no；在有会话的机器上 rm 吊销后，用 rm --local 清本机副本。',
  '',
  '示例：',
  '  # agent：登录一次、创建令牌，之后 exec / rsh 不再需要登录',
  '  vibeterm login && vibeterm token create office --name agent --scope exec,files',
  '  vibeterm exec office -- uptime',
  '  # CI：在已登录的机器上生成但不保存，secret 经安全渠道交给 CI 机器',
  '  vibeterm token create office --name ci --no-save --expires 30d   # 输出 secret',
  '  # 在 CI 机器上保存（无登录会话：节点用 32 位 id；--id 同时把 office 记作别名）',
  '  echo "$SECRET" | vibeterm token add --id <32位节点id> office -',
  '',
  '--json 形状：',
  '  create  { token: AccessTokenDto, saved: boolean, secret?: string }  （--print / --no-save 才含 secret）',
  '  ls      { tokens: (AccessTokenDto & { saved: boolean })[] }',
  '  rm      { ok, id }',
  '  add     { ok, node }',
].join('\n');

interface NodeTarget {
  id: string;
  /** 给人看的名字：用户敲的 node 引用，缺省为 self。 */
  label: string;
  /** 保存令牌时记下的节点名；不知道为空串。 */
  name: string;
}

function knownName(resolved: { id: string; name: string }): string {
  return resolved.name === resolved.id || resolved.name === SELF_NODE_ID ? '' : resolved.name;
}

async function resolveTarget(ctx: CliContext, ref: string | undefined): Promise<NodeTarget> {
  const raw = ref ?? ctx.globals.node;
  if (!raw) return { id: SELF_NODE_ID, label: SELF_NODE_ID, name: '' };
  const resolved = await ctx.resolver.resolveNode(raw);
  return { id: resolved.id, label: raw, name: knownName(resolved) };
}

/** 令牌管理接口只认真实会话；令牌调用方被拒（TOKEN_SCOPE）时给出明确的下一步。 */
async function asSessionOnly<T>(target: NodeTarget, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof PermissionError && error.code === TOKEN_SCOPE_CODE) {
      const node = target.id === SELF_NODE_ID ? '' : ` --node ${target.label}`;
      throw new AuthError(`管理令牌需要先登录：vibeterm login${node}`);
    }
    throw error;
  }
}

function parseScopes(raw: string | undefined): AccessTokenScope[] {
  if (raw === undefined) return [DEFAULT_SCOPE];
  const scopes: AccessTokenScope[] = [];
  for (const item of raw.split(',').map((part) => part.trim())) {
    if (!isAccessTokenScope(item)) {
      throw new UsageError(
        `未知的 scope：${item || '(空)'}`,
        `可选：${ACCESS_TOKEN_SCOPES.join(', ')}`
      );
    }
    if (!scopes.includes(item)) scopes.push(item);
  }
  return scopes;
}

/** `30d` / `1y` / `never` → 天数；never 为 null。 */
export function parseExpiresDays(raw: string): number | null {
  const value = raw.trim().toLowerCase();
  if (value === 'never') return null;
  const match = /^(\d+)([dy])$/.exec(value);
  const days = match ? Number(match[1]) * (match[2] === 'y' ? DAYS_PER_YEAR : 1) : 0;
  if (!match || days < 1 || days > ACCESS_TOKEN_EXPIRES_DAYS_MAX) {
    throw new UsageError(
      `--expires 无效：${raw}`,
      `用 30d、90d、1y、<N>d（1..${ACCESS_TOKEN_EXPIRES_DAYS_MAX} 天）或 never`
    );
  }
  return days;
}

/** 保存键：CLI 寻址该节点的方式；入口自己那台同时存 `self` 与它真实的 mesh id。 */
async function storageKeys(ctx: CliContext, nodeId: string): Promise<string[]> {
  if (nodeId !== SELF_NODE_ID) return [nodeId];
  const entryNodeId = await ctx.resolver.entryNodeId();
  return entryNodeId ? [SELF_NODE_ID, entryNodeId] : [SELF_NODE_ID];
}

type SavedFields = Omit<StoredToken, 'nodeId' | 'nodeName'>;

async function saveToken(ctx: CliContext, target: NodeTarget, fields: SavedFields): Promise<void> {
  const keys = await storageKeys(ctx, target.id);
  ctx.tokens.put(ctx.globals.entry, keys, {
    ...fields,
    nodeId: keys[keys.length - 1],
    nodeName: target.name,
  });
  ctx.tokens.save();
}

function formatTime(at: number | null | undefined, empty = '-'): string {
  if (at === null || at === undefined || !Number.isFinite(at)) return empty;
  return new Date(at).toISOString().slice(0, 16).replace('T', ' ');
}

type CreateOptions = {
  name: string;
  scopes: AccessTokenScope[];
  expiresInDays: number | null;
  noSave: boolean;
  print: boolean;
};

function parseCreateOptions(flags: FlagValues): CreateOptions {
  const name = flagString(flags, 'name')?.trim();
  if (!name) throw new UsageError('缺少 --name', '例：vibeterm token create --name ci');
  if (name.length > ACCESS_TOKEN_NAME_MAX) {
    throw new UsageError(`--name 最长 ${ACCESS_TOKEN_NAME_MAX} 个字符`);
  }
  const scopes = parseScopes(flagString(flags, 'scope'));
  const expiresInDays = parseExpiresDays(flagString(flags, 'expires') ?? DEFAULT_EXPIRES);
  const noSave = flagBool(flags, 'no-save');
  const print = flagBool(flags, 'print');
  if (noSave && print) throw new UsageError('--print 与 --no-save 不能同时使用');
  return { name, scopes, expiresInDays, noSave, print };
}

async function saveCreatedToken(
  ctx: CliContext,
  target: NodeTarget,
  created: CreateAccessTokenResponse
): Promise<void> {
  await saveToken(ctx, target, {
    tokenId: created.token.id,
    secret: created.secret,
    name: created.token.name,
    scopes: created.token.scopes,
    expiresAt: created.token.expiresAt,
    createdAt: created.token.createdAt,
  });
}

function reportCreatedToken(
  ctx: CliContext,
  label: string,
  opts: CreateOptions,
  created: CreateAccessTokenResponse
): void {
  const { name, scopes, expiresInDays, noSave, print } = opts;
  const showSecret = print || noSave;
  const expiry = expiresInDays === null ? '永不过期' : `有效期 ${expiresInDays} 天`;
  const summary = `已为 ${label} 创建令牌 ${name}（${scopes.join(',')}，${expiry}）${noSave ? '，未保存' : '并保存'}`;
  if (ctx.globals.json) {
    ctx.out.data({
      token: created.token,
      saved: !noSave,
      ...(showSecret ? { secret: created.secret } : {}),
    });
  } else if (showSecret) {
    ctx.out.line(created.secret);
    ctx.out.info(summary);
  } else {
    ctx.out.line(summary);
  }
}

const create: SubHandler = async (ctx, flags, positionals) => {
  rejectExtra(positionals, 1);
  const opts = parseCreateOptions(flags);
  const target = await resolveTarget(ctx, positionals[0]);
  const body: CreateAccessTokenRequest = {
    name: opts.name,
    scopes: opts.scopes,
    expiresInDays: opts.expiresInDays,
  };
  const created = await asSessionOnly(target, () =>
    ctx.http.json<CreateAccessTokenResponse>(target.id, 'POST', '/api/auth/tokens', body)
  );
  if (!opts.noSave) await saveCreatedToken(ctx, target, created);
  reportCreatedToken(ctx, target.label, opts, created);
};

const ls: SubHandler = async (ctx, _flags, positionals) => {
  rejectExtra(positionals, 1);
  const target = await resolveTarget(ctx, positionals[0]);
  const { tokens } = await asSessionOnly(target, () =>
    ctx.http.json<AccessTokenListResponse>(target.id, 'GET', '/api/auth/tokens')
  );
  const saved = ctx.tokens.nodes(ctx.globals.entry)[target.id];
  const rows = tokens.map((token) => ({
    ...token,
    saved: Boolean(saved?.tokenId) && saved?.tokenId === token.id && isLiveToken(saved),
  }));
  emit(ctx, { tokens: rows }, () => {
    ctx.out.table(rows, [
      { header: 'ID', value: (row) => row.id },
      { header: 'NAME', value: (row) => row.name },
      { header: 'SCOPES', value: (row) => row.scopes.join(',') },
      { header: 'CREATED', value: (row) => formatTime(row.createdAt) },
      { header: 'LAST USED', value: (row) => formatTime(row.lastUsedAt) },
      { header: 'EXPIRES', value: (row) => formatTime(row.expiresAt, 'never') },
      { header: 'SAVED', value: (row) => (row.saved ? 'yes' : 'no') },
    ]);
  });
};

function pickToken(tokens: readonly AccessTokenDto[], ref: string): AccessTokenDto {
  const byId = tokens.find((token) => token.id === ref);
  if (byId) return byId;
  const byName = tokens.filter((token) => token.name === ref);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) {
    throw new UsageError(`有 ${byName.length} 个令牌叫 ${ref}`, '改用 ID：vibeterm token ls');
  }
  throw new UsageError(`找不到令牌：${ref}`, '先看列表：vibeterm token ls');
}

async function revokeRemote(ctx: CliContext, target: NodeTarget, ref: string) {
  return await asSessionOnly(target, async () => {
    const { tokens } = await ctx.http.json<AccessTokenListResponse>(
      target.id,
      'GET',
      '/api/auth/tokens'
    );
    const picked = pickToken(tokens, ref);
    await ctx.http.json(target.id, 'DELETE', `/api/auth/tokens/${encodeURIComponent(picked.id)}`);
    return picked;
  });
}

async function rmLocal(ctx: CliContext, positionals: string[]): Promise<void> {
  rejectExtra(positionals, 1);
  const target = await resolveTarget(ctx, positionals[0]);
  const removed = ctx.tokens.removeKeys(ctx.globals.entry, await storageKeys(ctx, target.id));
  if (removed > 0) ctx.tokens.save();
  emit(ctx, { ok: true, node: target.id, removed }, () =>
    ctx.out.line(
      removed > 0 ? `已清除本机保存的 ${target.label} 令牌` : `本机没有保存 ${target.label} 的令牌`
    )
  );
}

const rm: SubHandler = async (ctx, flags, positionals) => {
  if (flagBool(flags, 'local')) return await rmLocal(ctx, positionals);
  const ref = requireArg(positionals, positionals.length - 1, '令牌 id 或名称');
  rejectExtra(positionals, 2);
  const target = await resolveTarget(ctx, positionals.length === 2 ? positionals[0] : undefined);
  const token = await revokeRemote(ctx, target, ref);
  if (ctx.tokens.removeById(ctx.globals.entry, token.id) > 0) ctx.tokens.save();
  emit(ctx, { ok: true, id: token.id }, () =>
    ctx.out.line(`已吊销 ${target.label} 上的令牌 ${token.name}`)
  );
};

/** `--id` 直接给节点 id（无登录会话时的唯一可靠寻址）；位置参数此时只是别名。 */
async function resolveAddTarget(
  ctx: CliContext,
  flags: FlagValues,
  ref: string | undefined
): Promise<NodeTarget> {
  const idFlag = flagString(flags, 'id');
  if (idFlag !== undefined) {
    if (!isValidNodeId(idFlag)) throw new UsageError('--id 需要 32 位十六进制节点 id');
    const target = await resolveTarget(ctx, idFlag);
    const alias = ref && !isValidNodeId(ref) && ref !== SELF_NODE_ID ? ref : '';
    return { ...target, label: ref ?? target.label, name: alias || target.name };
  }
  try {
    return await resolveTarget(ctx, ref);
  } catch (error) {
    if (!(error instanceof AuthError) || !ref) throw error;
    throw new AuthError(`无法解析节点名 ${ref}：需要先登录；或直接给 32 位节点 id / 用 --id 指定`);
  }
}

const add: SubHandler = async (ctx, flags, positionals) => {
  const last = requireArg(positionals, positionals.length - 1, 'secret（或 - 读 stdin）');
  rejectExtra(positionals, 2);
  const secret = (last === '-' ? await readAllStdin() : last).trim();
  if (!isValidTokenSecret(secret)) {
    throw new UsageError('secret 格式无效', '应为 vtk_ 加 43 位 base64url 字符');
  }
  const nodeRef = positionals.length === 2 ? positionals[0] : undefined;
  const target = await resolveAddTarget(ctx, flags, nodeRef);

  const response = await ctx.http.fetch(target.id, '/api/devices', {
    cookieOverride: `${NODE_TOKEN_COOKIE_PREFIX}${target.id}=${secret}`,
  });
  if (response.status === 401 || response.status === 403) {
    throw new AuthError(`令牌无效、已过期或已被吊销（${target.label}）`);
  }
  await ctx.http.assertOk(target.id, response, '/api/devices');

  await saveToken(ctx, target, {
    tokenId: '',
    secret,
    name: 'imported',
    scopes: [],
    expiresAt: null,
    createdAt: Date.now(),
  });
  emit(ctx, { ok: true, node: target.id }, () => ctx.out.line(`已保存 ${target.label} 的令牌`));
};

const HANDLERS: Record<string, SubHandler> = { create, ls, rm, add };

export const command: Command = {
  name: 'token',
  summary: '机器访问令牌：为 agent / CI 创建、查看、吊销免登录凭据',
  usage: USAGE,
  flags: FLAGS,
  run: (ctx, argv) => runSubs(ctx, argv, FLAGS, HANDLERS, 'run: vibeterm token --help'),
};
