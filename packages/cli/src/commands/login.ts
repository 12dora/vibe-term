// `vibeterm login`：与浏览器同一套登录流程，默认把 mesh 里的每个 node 都登一遍。

import type { MeshNode } from '@vibeterm/api-client/auth/types';
import { SELF_NODE_ID } from '@vibeterm/api-client/node-url';
import { bytesEqual, decodeBase64url } from '@vibeterm/shared/auth';
import { flagBool, flagNumber, flagString, parseArgv } from '../core/args';
import {
  type AuthMode,
  type SessionMaterial,
  TOTP_KEY_UNAVAILABLE,
  buildSessionMaterial,
  fetchAuthMode,
  loginFailure,
  loginToNode,
  needsTotp,
  requiresLogin,
} from '../core/auth';
import type { CliContext } from '../core/context';
import { AuthError, UsageError } from '../core/errors';
import {
  DEFAULT_LOGIN_CONCURRENCY,
  DEFAULT_NODE_TIMEOUT_MS,
  type LoginTarget,
  type TargetOutcome,
  emitLoginDone,
  emitLoginStart,
  loginOthers,
  reportLoginFailures,
  reportLoginOutcomes,
  requirePositiveInt,
  throwIfSelfFailed,
} from '../core/login-fanout';
import { isInteractive, promptHidden, promptLine, readAllStdin } from '../core/prompt';
import type { Command } from './types';

const FLAGS = {
  user: 'string',
  totp: 'string',
  'password-stdin': 'boolean',
  'all-nodes': 'boolean',
  'node-timeout': 'number',
  concurrency: 'number',
} as const;

interface LoginAttemptOpts {
  treatUnreachableAsOutcome?: boolean;
  allowPrompt?: boolean;
  timeoutMs: number;
}

async function readPassword(ctx: CliContext, fromStdin: boolean): Promise<string> {
  if (fromStdin) {
    const value = await readAllStdin();
    if (!value) throw new UsageError('--password-stdin got an empty password');
    return value;
  }
  const fromEnv = process.env.VIBETERM_PASSWORD;
  if (fromEnv) return fromEnv;
  if (!isInteractive()) {
    throw new AuthError(
      'a password is required and stdin is not a terminal',
      'pass --password-stdin or set VIBETERM_PASSWORD'
    );
  }
  const value = await promptHidden(`Password for ${ctx.globals.entry}: `);
  if (!value) throw new UsageError('password is empty');
  return value;
}

/** 已知开了两步验证时先把码要到手：省得每个 node 各撞一次 TOTP_REQUIRED。 */
async function readTotp(mode: AuthMode, flag: string | undefined): Promise<string | null> {
  const provided = flag ?? process.env.VIBETERM_TOTP;
  if (provided) return provided.trim();
  if (!needsTotp(mode)) return null;
  if (!isInteractive()) {
    throw new AuthError(
      'two-step verification is enabled for this account',
      'pass --totp <code> or set VIBETERM_TOTP'
    );
  }
  const value = (await promptLine('Two-step verification code: ')).trim();
  if (!value) throw new UsageError('TOTP code is empty');
  return value;
}

function assertUserMatches(mode: AuthMode, user: string | undefined): void {
  if (!user) return;
  if (user === mode.username || user === mode.uid) return;
  throw new UsageError(
    `entry ${mode.nodeId} serves user "${mode.username ?? mode.uid}", not "${user}"`,
    'omit --user, or point --entry at the entry that hosts that account'
  );
}

function pkOf(row: MeshNode | null): string | null {
  return row?.publicKey ?? null;
}

/** entry 之外要登的 node：`--node` 指名一台，否则整张 mesh 名单（去掉 entry 自己那行）。 */
async function otherTargets(
  ctx: CliContext,
  mode: AuthMode,
  nodeRef: string | null,
  roster: readonly MeshNode[]
): Promise<LoginTarget[]> {
  if (nodeRef) {
    const resolved = await ctx.resolver.resolveNode(nodeRef);
    if (resolved.isSelf || resolved.id === mode.nodeId) return [];
    return [{ nodeId: resolved.id, name: resolved.name, publicKey: pkOf(resolved.row) }];
  }
  return roster
    .filter((node) => node.id !== mode.nodeId)
    .map((node) => ({ nodeId: node.id, name: node.name, publicKey: node.publicKey }));
}

/**
 * 与浏览器的 `loginSelf` / `verifySelfPublicKey` 同一道检查：challenge 里 entry 当场出示的
 * 公钥，必须与账户根钥签发、记在 `/api/mesh/nodes` 里的那把逐字节一致。对不上说明入口被掉包或
 * 配置错乱——立刻丢掉刚拿到的会话，不让用户带着一个不可信的会话继续。
 */
function verifySelfPublicKey(
  ctx: CliContext,
  mode: AuthMode,
  roster: readonly MeshNode[],
  presented: string | undefined
): void {
  const row = roster.find((node) => node.id === mode.nodeId);
  // 名册里没有自己那行（standalone / 旧网关 / 成员表还没同步）时无从比对，跳过。
  if (!row || !presented) return;
  if (bytesEqual(decodeBase64url(presented), decodeBase64url(row.publicKey))) return;
  ctx.sessions.clearEntry(ctx.globals.entry);
  ctx.sessions.save();
  throw loginFailure(mode.nodeId, 'NODE_PK_MISMATCH', mode.secondFactorPolicy);
}

async function loginOne(
  ctx: CliContext,
  target: LoginTarget,
  material: SessionMaterial,
  totp: { code: string | null },
  opts: LoginAttemptOpts
): Promise<TargetOutcome> {
  const attempt = () => {
    const signal = AbortSignal.timeout(opts.timeoutMs);
    return loginToNode({
      http: ctx.http,
      nodeId: target.nodeId,
      material,
      pinnedPublicKey: target.publicKey,
      totpCode: totp.code,
      treatUnreachableAsOutcome: opts.treatUnreachableAsOutcome,
      signal,
      timeoutMs: opts.timeoutMs,
    });
  };
  let result = await attempt();
  // mode 快照说没开两步验证，服务端却要码：TTY 下当场补一次，非 TTY 交回调用方。
  // 只有 TOTP_REQUIRED 会重来一次——PASSKEY_REQUIRED 重发只会再被拒一次并多记一次失败。
  const promptTotp =
    !result.ok &&
    result.code === 'TOTP_REQUIRED' &&
    !totp.code &&
    opts.allowPrompt &&
    isInteractive();
  if (promptTotp) {
    if (!material.kTotp) {
      return { node: target.nodeId, name: target.name, ok: false, code: TOTP_KEY_UNAVAILABLE };
    }
    const code = (await promptLine('Two-step verification code: ')).trim();
    if (code) {
      totp.code = code;
      result = await attempt();
    }
  }
  return {
    node: target.nodeId,
    name: target.name,
    ok: result.ok,
    code: result.code,
    nodePk: result.nodePk,
  };
}

function emitOpenStandalone(ctx: CliContext): void {
  ctx.out.info(`${ctx.globals.entry} does not require a login (open standalone instance)`);
  if (ctx.globals.json) ctx.out.data({ entry: ctx.globals.entry, login: 'not-required' });
}

async function loginEntry(
  ctx: CliContext,
  mode: AuthMode,
  material: SessionMaterial,
  totp: { code: string | null },
  timeoutMs: number
): Promise<TargetOutcome> {
  const self: LoginTarget = { nodeId: SELF_NODE_ID, name: 'self (entry)', publicKey: null };
  emitLoginStart(ctx.out, self.name);
  const selfOutcome = await loginOne(ctx, self, material, totp, { timeoutMs, allowPrompt: true });
  emitLoginDone(ctx.out, self.name, selfOutcome);
  throwIfSelfFailed(selfOutcome, mode.secondFactorPolicy);
  ctx.sessions.setIdentity(ctx.globals.entry, { uid: mode.uid, username: mode.username });
  ctx.sessions.save();
  return selfOutcome;
}

async function run(ctx: CliContext, argv: string[]): Promise<number | undefined> {
  const { flags } = parseArgv(argv, FLAGS);
  const nodeRef = ctx.globals.node;
  if (nodeRef && flagBool(flags, 'all-nodes')) {
    throw new UsageError('--node and --all-nodes are mutually exclusive');
  }
  const timeoutMs = requirePositiveInt(
    'node-timeout',
    flagNumber(flags, 'node-timeout'),
    DEFAULT_NODE_TIMEOUT_MS
  );
  const concurrency = requirePositiveInt(
    'concurrency',
    flagNumber(flags, 'concurrency'),
    DEFAULT_LOGIN_CONCURRENCY
  );
  const mode = await fetchAuthMode(ctx.http, SELF_NODE_ID);
  if (!mode || !requiresLogin(mode)) {
    emitOpenStandalone(ctx);
    return;
  }
  assertUserMatches(mode, flagString(flags, 'user'));

  const password = await readPassword(ctx, flagBool(flags, 'password-stdin'));
  const totp = { code: await readTotp(mode, flagString(flags, 'totp')) };
  const material = await buildSessionMaterial({ password, mode });
  try {
    const selfOutcome = await loginEntry(ctx, mode, material, totp, timeoutMs);
    const roster = await ctx.resolver.listNodes();
    verifySelfPublicKey(ctx, mode, roster, selfOutcome.nodePk);
    const rest = await loginOthers({
      ctx,
      targets: await otherTargets(ctx, mode, nodeRef, roster),
      totp,
      hasTotpKey: Boolean(material.kTotp),
      interactive: isInteractive(),
      promptTotp: () => promptLine('Two-step verification code: '),
      concurrency,
      attempt: (target) =>
        loginOne(ctx, target, material, totp, {
          timeoutMs,
          allowPrompt: false,
          treatUnreachableAsOutcome: true,
        }),
    });
    const outcomes = [selfOutcome, ...rest];
    reportLoginOutcomes(ctx, outcomes);
    return reportLoginFailures(ctx, mode, outcomes, Boolean(nodeRef));
  } finally {
    material.destroy();
  }
}

export const command: Command = {
  name: 'login',
  summary: 'authenticate against an entry and every mesh node behind it',
  usage: [
    'Usage: vibeterm login [options]',
    '',
    'Logs into the entry (self) and, by default, into every node from /api/mesh/nodes',
    'using the same in-memory root seed. The seed is zeroized as soon as the delegation',
    'is signed; only session cookies are written to <config dir>/session.json (mode 0600),',
    'or to $VIBETERM_SESSION_FILE when set (the file is a full session capability, protect it).',
    '',
    'The entry is logged in first (other nodes need that session). Remaining nodes run with',
    'bounded concurrency (default 4). Each node has a wall-clock deadline (default 25000 ms);',
    'when it fires the in-flight request is aborted and the row is TIMEOUT, counted as a',
    'network skip like NODE_UNREACHABLE — not an auth rejection. Progress lines go to stderr',
    'so `--json` stdout stays a single object.',
    '',
    'Login challenge/login requests ignore the global `--timeout` flag. Their deadline is',
    '`--node-timeout` (default 25000 ms) only; `--timeout 50 --node-timeout 500` still waits',
    'up to 500 ms per node. A 5xx/404/non-session 403 on one node is a failed row (code',
    'HTTP_5xx), not a command abort: the rest continue and the result table is always printed.',
    '',
    'An offline node (HTTP 503 NODE_UNREACHABLE, a network error, or TIMEOUT) is skipped with',
    '`skipped <node>: unreachable|timeout` when `--node` is absent; login still exits 0 if the',
    'entry succeeded and every other failure is unreachable or timeout. `--node` naming a single',
    'unreachable or timed-out target exits 5. Auth rejections exit 3; a non-auth HTTP error',
    '(5xx/404) exits 1, including when mixed with auth rejections.',
    '',
    'Options:',
    '  --user <name>         verify the entry serves this account before asking for a password',
    '  --totp <code>         two-step verification code (or set VIBETERM_TOTP)',
    '  --password-stdin      read the password from stdin instead of prompting',
    '  --all-nodes           log into every mesh node (default when --node is absent)',
    '  --node <id|name>      log into this node only (plus the entry itself)',
    '  --node-timeout <ms>   per-node login deadline (default 25000); aborts the in-flight fetch.',
    '                        Challenge/login ignore global --timeout; only this flag applies',
    '  --concurrency <n>     max parallel logins after the entry (default 4)',
    '  --ca <pem-file>       trust this extra CA; --insecure skips verification entirely',
    '',
    'Password sources: --password-stdin > VIBETERM_PASSWORD > hidden TTY prompt.',
    'Session file: $VIBETERM_SESSION_FILE overrides <config dir>/session.json (0600).',
  ].join('\n'),
  flags: FLAGS,
  run,
};
