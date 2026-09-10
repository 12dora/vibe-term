// `vibeterm login`：与浏览器同一套登录流程，默认把 mesh 里的每个 node 都登一遍。

import type { MeshNode } from '@vibeterm/api-client/auth/types';
import { SELF_NODE_ID } from '@vibeterm/api-client/node-url';
import { flagBool, flagString, parseArgv } from '../core/args';
import {
  type AuthMode,
  type SessionMaterial,
  buildSessionMaterial,
  fetchAuthMode,
  listMeshNodes,
  loginFailure,
  loginToNode,
  needsTotp,
  requiresLogin,
} from '../core/auth';
import type { CliContext } from '../core/context';
import { AuthError, UsageError } from '../core/errors';
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
  nodeRef: string | null
): Promise<LoginTarget[]> {
  if (nodeRef) {
    const resolved = await ctx.resolver.resolveNode(nodeRef);
    if (resolved.isSelf || resolved.id === mode.nodeId) return [];
    return [{ nodeId: resolved.id, name: resolved.name, publicKey: pkOf(resolved.row) }];
  }
  const nodes = await listMeshNodes(ctx.http);
  return nodes
    .filter((node) => node.id !== mode.nodeId)
    .map((node) => ({ nodeId: node.id, name: node.name, publicKey: node.publicKey }));
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
  if (!result.ok && result.code === 'TOTP_REQUIRED' && !totp.code && isInteractive()) {
    const code = (await promptLine('Two-step verification code: ')).trim();
    if (code) {
      totp.code = code;
      result = await attempt();
    }
  }
  return { node: target.nodeId, name: target.name, ok: result.ok, code: result.code };
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

    const outcomes: TargetOutcome[] = [selfOutcome];
    for (const target of await otherTargets(ctx, mode, nodeRef)) {
      outcomes.push(await loginOne(ctx, target, material, totp));
    }
    report(ctx, outcomes);
    const failed = outcomes.filter((outcome) => !outcome.ok);
    for (const outcome of failed) {
      ctx.out.warn(`node ${outcome.node} (${outcome.name}): ${outcome.code ?? 'failed'}`);
    }
    return failed.length === 0 ? 0 : 1;
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
    '',
    'Password sources: --password-stdin > VIBETERM_PASSWORD > hidden TTY prompt.',
  ].join('\n'),
  flags: FLAGS,
  run,
};
