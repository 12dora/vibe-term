// `vibeterm login`：与浏览器同一套登录流程，默认把 mesh 里的每个 node 都登一遍。

import type { MeshNode } from '@vibeterm/api-client/auth/types';
import { SELF_NODE_ID } from '@vibeterm/api-client/node-url';
import { bytesEqual, decodeBase64url } from '@vibeterm/shared/auth';
import { flagBool, flagNumber, flagString, parseArgv } from '../core/args';
import {
  type AuthMode,
  LOGIN_TIMEOUT,
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
import {
  AuthError,
  EXIT_AUTH,
  EXIT_NETWORK,
  NetworkError,
  UsageError,
  exitCodeOf,
} from '../core/errors';
import {
  DEFAULT_LOGIN_CONCURRENCY,
  DEFAULT_NODE_TIMEOUT_MS,
  emitLoginDone,
  emitLoginStart,
  formatNetworkSkipSummary,
  isNetworkLoginCode,
  mapBounded,
  networkSkipLabel,
  requirePositiveInt,
  takeTotpForRetry,
  totpRetryIndices,
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

interface LoginTarget {
  nodeId: string;
  name: string;
  publicKey: string | null;
}

interface TargetOutcome {
  node: string;
  name: string;
  ok: boolean;
  code?: string;
  nodePk?: string;
}

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

async function loginFanoutOne(
  ctx: CliContext,
  target: LoginTarget,
  material: SessionMaterial,
  totp: { code: string | null },
  timeoutMs: number
): Promise<TargetOutcome> {
  emitLoginStart(ctx.out, target.name);
  const outcome = await loginOne(ctx, target, material, totp, {
    timeoutMs,
    allowPrompt: false,
    treatUnreachableAsOutcome: true,
  });
  if (outcome.ok || outcome.code !== 'TOTP_REQUIRED') emitLoginDone(ctx.out, target.name, outcome);
  return outcome;
}

function applyTotpUnavailable(
  outcomes: TargetOutcome[],
  retryAt: readonly number[]
): TargetOutcome[] {
  const next = outcomes.slice();
  for (const index of retryAt) {
    next[index] = { ...next[index], code: TOTP_KEY_UNAVAILABLE };
  }
  return next;
}

function emitTotpPendingDone(
  ctx: CliContext,
  targets: readonly LoginTarget[],
  outcomes: readonly TargetOutcome[],
  retryAt: readonly number[]
): void {
  for (const index of retryAt) emitLoginDone(ctx.out, targets[index].name, outcomes[index]);
}

async function retryTotpTargets(args: {
  ctx: CliContext;
  targets: readonly LoginTarget[];
  first: TargetOutcome[];
  material: SessionMaterial;
  totp: { code: string | null };
  timeoutMs: number;
  concurrency: number;
  retryAt: readonly number[];
}): Promise<TargetOutcome[]> {
  const retried = await mapBounded(args.retryAt, args.concurrency, async (index) => {
    const target = args.targets[index];
    emitLoginStart(args.ctx.out, target.name);
    const outcome = await loginOne(args.ctx, target, args.material, args.totp, {
      timeoutMs: args.timeoutMs,
      allowPrompt: false,
      treatUnreachableAsOutcome: true,
    });
    emitLoginDone(args.ctx.out, target.name, outcome);
    return outcome;
  });
  const next = args.first.slice();
  args.retryAt.forEach((index, i) => {
    next[index] = retried[i];
  });
  return next;
}

async function finishFanout(args: {
  ctx: CliContext;
  targets: readonly LoginTarget[];
  first: TargetOutcome[];
  material: SessionMaterial;
  totp: { code: string | null };
  timeoutMs: number;
  concurrency: number;
}): Promise<TargetOutcome[]> {
  const retryAt = totpRetryIndices(args.first);
  if (retryAt.length === 0) return args.first;
  if (args.totp.code) {
    emitTotpPendingDone(args.ctx, args.targets, args.first, retryAt);
    return args.first;
  }
  const status = await takeTotpForRetry({
    totp: args.totp,
    hasTotpKey: Boolean(args.material.kTotp),
    interactive: isInteractive(),
    prompt: () => promptLine('Two-step verification code: '),
  });
  if (status === 'ready') return retryTotpTargets({ ...args, retryAt });
  const finalized =
    status === 'unavailable' ? applyTotpUnavailable(args.first, retryAt) : args.first;
  emitTotpPendingDone(args.ctx, args.targets, finalized, retryAt);
  return finalized;
}

async function loginOthers(args: {
  ctx: CliContext;
  targets: readonly LoginTarget[];
  material: SessionMaterial;
  totp: { code: string | null };
  timeoutMs: number;
  concurrency: number;
}): Promise<TargetOutcome[]> {
  const { ctx, targets, material, totp, timeoutMs, concurrency } = args;
  if (targets.length === 0) return [];
  const first = await mapBounded(targets, concurrency, (target) =>
    loginFanoutOne(ctx, target, material, totp, timeoutMs)
  );
  return finishFanout({ ctx, targets, first, material, totp, timeoutMs, concurrency });
}

function report(ctx: CliContext, outcomes: TargetOutcome[]): void {
  if (ctx.globals.json) {
    ctx.out.data({ entry: ctx.globals.entry, nodes: outcomes });
    return;
  }
  ctx.out.table(outcomes, [
    { header: 'NODE', value: (row) => row.node },
    { header: 'NAME', value: (row) => row.name },
    { header: 'STATUS', value: (row) => (row.ok ? 'ok' : (row.code ?? 'failed')) },
  ]);
}

function emitOpenStandalone(ctx: CliContext): void {
  ctx.out.info(`${ctx.globals.entry} does not require a login (open standalone instance)`);
  if (ctx.globals.json) ctx.out.data({ entry: ctx.globals.entry, login: 'not-required' });
}

function throwIfSelfFailed(outcome: TargetOutcome, policy: AuthMode['secondFactorPolicy']): void {
  if (outcome.ok) return;
  if (outcome.code === 'NODE_UNREACHABLE' || outcome.code === LOGIN_TIMEOUT) {
    throw new NetworkError(`login to node self failed: ${outcome.code}`);
  }
  throw loginFailure('self', outcome.code ?? 'UNKNOWN', policy);
}

function emitNetworkSkipSummary(ctx: CliContext, outcomes: TargetOutcome[]): void {
  const network = outcomes.filter((row) => !row.ok && isNetworkLoginCode(row.code));
  if (network.length === 0) return;
  const okCount = outcomes.filter((row) => row.ok).length;
  const unreachable = network.filter((row) => row.code === 'NODE_UNREACHABLE').length;
  const timedOut = network.filter((row) => row.code === LOGIN_TIMEOUT).length;
  ctx.out.info(formatNetworkSkipSummary(okCount, unreachable, timedOut));
}

function reportRejected(ctx: CliContext, mode: AuthMode, rejected: TargetOutcome[]): number {
  let authOnly = true;
  for (const outcome of rejected) {
    const error = loginFailure(outcome.node, outcome.code ?? 'UNKNOWN', mode.secondFactorPolicy);
    ctx.out.warn(`node ${outcome.node} (${outcome.name}): ${error.message}`);
    if (error.hint) ctx.out.warn(`  ${error.hint}`);
    if (exitCodeOf(error) !== EXIT_AUTH) authOnly = false;
  }
  return authOnly ? EXIT_AUTH : 1;
}

function reportFailures(
  ctx: CliContext,
  mode: AuthMode,
  outcomes: TargetOutcome[],
  explicitTarget: boolean
): number {
  const failed = outcomes.filter((outcome) => !outcome.ok);
  const network = failed.filter((outcome) => isNetworkLoginCode(outcome.code));
  const rejected = failed.filter((outcome) => !isNetworkLoginCode(outcome.code));
  if (explicitTarget && network.length > 0) {
    for (const outcome of network) {
      ctx.out.warn(`node ${outcome.node} (${outcome.name}): ${networkSkipLabel(outcome.code)}`);
    }
    return EXIT_NETWORK;
  }
  if (rejected.length === 0) {
    emitNetworkSkipSummary(ctx, outcomes);
    return 0;
  }
  return reportRejected(ctx, mode, rejected);
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
      material,
      totp,
      timeoutMs,
      concurrency,
    });
    const outcomes = [selfOutcome, ...rest];
    report(ctx, outcomes);
    return reportFailures(ctx, mode, outcomes, Boolean(nodeRef));
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
    'An offline node (HTTP 503 NODE_UNREACHABLE, a network error, or TIMEOUT) is skipped with',
    '`skipped <node>: unreachable|timeout` when `--node` is absent; login still exits 0 if the',
    'entry succeeded and every other failure is unreachable or timeout. `--node` naming a single',
    'unreachable or timed-out target exits 5. A reachable node that rejects the login is non-zero.',
    '',
    'Options:',
    '  --user <name>         verify the entry serves this account before asking for a password',
    '  --totp <code>         two-step verification code (or set VIBETERM_TOTP)',
    '  --password-stdin      read the password from stdin instead of prompting',
    '  --all-nodes           log into every mesh node (default when --node is absent)',
    '  --node <id|name>      log into this node only (plus the entry itself)',
    '  --node-timeout <ms>   per-node login deadline (default 25000); aborts the in-flight fetch',
    '  --concurrency <n>     max parallel logins after the entry (default 4)',
    '  --ca <pem-file>       trust this extra CA; --insecure skips verification entirely',
    '',
    'Password sources: --password-stdin > VIBETERM_PASSWORD > hidden TTY prompt.',
    'Session file: $VIBETERM_SESSION_FILE overrides <config dir>/session.json (0600).',
  ].join('\n'),
  flags: FLAGS,
  run,
};
