// `vibeterm login`：与浏览器同一套登录流程，默认把 mesh 里的每个 node 都登一遍。

import type { MeshNode } from '@vibeterm/api-client/auth/types';
import { SELF_NODE_ID } from '@vibeterm/api-client/node-url';
import { bytesEqual, decodeBase64url } from '@vibeterm/shared/auth';
import { flagBool, flagString, parseArgv } from '../core/args';
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
import { AuthError, EXIT_AUTH, UsageError, exitCodeOf } from '../core/errors';
import { isInteractive, promptHidden, promptLine, readAllStdin } from '../core/prompt';
import type { Command } from './types';

const FLAGS = {
  user: 'string',
  totp: 'string',
  'password-stdin': 'boolean',
  'all-nodes': 'boolean',
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
 * 公钥，必须与 hub 签发、记在 `/api/mesh/nodes` 里的那把逐字节一致。对不上说明入口被掉包或
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
  totp: { code: string | null }
): Promise<TargetOutcome> {
  const attempt = () =>
    loginToNode({
      http: ctx.http,
      nodeId: target.nodeId,
      material,
      pinnedPublicKey: target.publicKey,
      totpCode: totp.code,
    });
  let result = await attempt();
  // mode 快照说没开两步验证，服务端却要码：TTY 下当场补一次，非 TTY 交回调用方。
  // 只有 TOTP_REQUIRED 会重来一次——PASSKEY_REQUIRED 重发只会再被拒一次并多记一次失败。
  if (!result.ok && result.code === 'TOTP_REQUIRED' && !totp.code && isInteractive()) {
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

/**
 * fan-out 里失败的 node 逐条给出与 entry 同一套解释（`PASSKEY_REQUIRED` 尤其要说清怎么办）。
 * 失败全是「要登录 / 要二次验证」时按鉴权失败退出（3），混了别的原因才退 1。
 */
function reportFailures(ctx: CliContext, mode: AuthMode, outcomes: TargetOutcome[]): number {
  const failed = outcomes.filter((outcome) => !outcome.ok);
  if (failed.length === 0) return 0;
  let authOnly = true;
  for (const outcome of failed) {
    const error = loginFailure(outcome.node, outcome.code ?? 'UNKNOWN', mode.secondFactorPolicy);
    ctx.out.warn(`node ${outcome.node} (${outcome.name}): ${error.message}`);
    if (error.hint) ctx.out.warn(`  ${error.hint}`);
    if (exitCodeOf(error) !== EXIT_AUTH) authOnly = false;
  }
  return authOnly ? EXIT_AUTH : 1;
}

async function run(ctx: CliContext, argv: string[]): Promise<number | undefined> {
  const { flags } = parseArgv(argv, FLAGS);
  const nodeRef = ctx.globals.node;
  if (nodeRef && flagBool(flags, 'all-nodes')) {
    throw new UsageError('--node and --all-nodes are mutually exclusive');
  }
  const mode = await fetchAuthMode(ctx.http, SELF_NODE_ID);
  if (!mode || !requiresLogin(mode)) {
    ctx.out.info(`${ctx.globals.entry} does not require a login (open standalone instance)`);
    if (ctx.globals.json) ctx.out.data({ entry: ctx.globals.entry, login: 'not-required' });
    return;
  }
  assertUserMatches(mode, flagString(flags, 'user'));

  const password = await readPassword(ctx, flagBool(flags, 'password-stdin'));
  const totp = { code: await readTotp(mode, flagString(flags, 'totp')) };
  const material = await buildSessionMaterial({ password, mode });
  try {
    const self: LoginTarget = { nodeId: SELF_NODE_ID, name: 'self (entry)', publicKey: null };
    const selfOutcome = await loginOne(ctx, self, material, totp);
    if (!selfOutcome.ok) {
      throw loginFailure('self', selfOutcome.code ?? 'UNKNOWN', mode.secondFactorPolicy);
    }
    ctx.sessions.setIdentity(ctx.globals.entry, { uid: mode.uid, username: mode.username });
    ctx.sessions.save();

    const roster = await ctx.resolver.listNodes();
    verifySelfPublicKey(ctx, mode, roster, selfOutcome.nodePk);

    const outcomes: TargetOutcome[] = [selfOutcome];
    for (const target of await otherTargets(ctx, mode, nodeRef, roster)) {
      outcomes.push(await loginOne(ctx, target, material, totp));
    }
    report(ctx, outcomes);
    return reportFailures(ctx, mode, outcomes);
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
    'is signed; only session cookies are written to <config dir>/session.json (mode 0600).',
    '',
    'Options:',
    '  --user <name>       verify the entry serves this account before asking for a password',
    '  --totp <code>       two-step verification code (or set VIBETERM_TOTP)',
    '  --password-stdin    read the password from stdin instead of prompting',
    '  --all-nodes         log into every mesh node (default when --node is absent)',
    '  --node <id|name>    log into this node only (plus the entry itself)',
    '  --ca <pem-file>     trust this extra CA; --insecure skips verification entirely',
    '',
    'Password sources: --password-stdin > VIBETERM_PASSWORD > hidden TTY prompt.',
  ].join('\n'),
  flags: FLAGS,
  run,
};
