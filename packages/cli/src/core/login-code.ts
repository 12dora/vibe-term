// `vibeterm login --code`：用一次性登录命令兑换每台节点的 PoP 会话。
// 命令码只在本机拆成 secret + nodeIds；发给节点的是该节点自己的派生码。

import type { MeshNode } from '@vibeterm/api-client/auth/types';
import { SELF_NODE_ID } from '@vibeterm/api-client/node-url';
import {
  LOGIN_CODE_REDEEM_PATH,
  type LoginCodeRedeemRequest,
  type LoginCodeRedeemResponse,
} from '@vibeterm/shared';
import {
  type Ed25519KeyPair,
  decodeLoginCode,
  deriveNodeLoginCode,
  encodeBase64url,
  generateEd25519KeyPair,
} from '@vibeterm/shared/auth';
import {
  type AuthMode,
  CLI_CLIENT_HEADERS,
  LOGIN_TIMEOUT,
  fetchAuthMode,
  isNodeUnreachableError,
  listMeshNodes,
  requiresLogin,
} from './auth';
import type { CliContext } from './context';
import { AuthError, EXIT_NETWORK, NetworkError, UsageError } from './errors';
import {
  type LoginTarget,
  type TargetOutcome,
  mapBounded,
  reportLoginFailures,
  reportLoginOutcomes,
  runFanoutTarget,
} from './login-fanout';
import { copyPopKey } from './session-pop';
import { reusableSelfPopKey } from './session-store';

export interface LoginCodeOptions {
  code: string;
  timeoutMs: number;
  concurrency: number;
}

function redeemHttpOptions(signal: AbortSignal): { signal: AbortSignal; timeoutMs: null } {
  return { signal, timeoutMs: null };
}

function isRedeemTimeoutError(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  return error instanceof NetworkError && /timed out/i.test(error.message);
}

function orderNodeIds(nodeIds: readonly string[], entryNodeId: string): string[] {
  const rest = nodeIds.filter((id) => id !== entryNodeId);
  return nodeIds.includes(entryNodeId) ? [entryNodeId, ...rest] : [...nodeIds];
}

function addressingId(nodeId: string, entryNodeId: string): string {
  return nodeId === entryNodeId ? SELF_NODE_ID : nodeId;
}

function realNodeId(addressing: string, entryNodeId: string): string {
  return addressing === SELF_NODE_ID ? entryNodeId : addressing;
}

function labelOf(nodeId: string, addressing: string, roster: readonly MeshNode[]): string {
  const row = roster.find((node) => node.id === nodeId);
  if (row?.name) return row.name;
  return addressing === SELF_NODE_ID ? 'self' : nodeId.slice(0, 8);
}

function asTargets(
  nodeIds: readonly string[],
  entryNodeId: string,
  roster: readonly MeshNode[]
): LoginTarget[] {
  return nodeIds.map((id) => {
    const node = addressingId(id, entryNodeId);
    return { nodeId: node, name: labelOf(id, node, roster), publicKey: null };
  });
}

function relabelOutcomes(
  outcomes: TargetOutcome[],
  entryNodeId: string,
  roster: readonly MeshNode[]
): TargetOutcome[] {
  return outcomes.map((row) => {
    const id = realNodeId(row.node, entryNodeId);
    return { ...row, name: labelOf(id, row.node, roster) };
  });
}

async function loadRoster(ctx: CliContext): Promise<MeshNode[]> {
  try {
    return await listMeshNodes(ctx.http);
  } catch {
    return [];
  }
}

async function readRedeemErrorCode(response: Response): Promise<string> {
  if (response.status === 404 || response.status >= 500) {
    const code = await peekErrorCode(response);
    if (code === 'NODE_UNREACHABLE') return code;
    return `HTTP_${response.status}`;
  }
  const code = await peekErrorCode(response);
  return code ?? `HTTP_${response.status}`;
}

async function peekErrorCode(response: Response): Promise<string | undefined> {
  try {
    const payload = (await response.json()) as { code?: unknown; error?: unknown };
    if (typeof payload.code === 'string') return payload.code;
    if (typeof payload.error === 'string') return payload.error;
  } catch {
    // 非 JSON 体
  }
  return undefined;
}

function persistRedeem(
  ctx: CliContext,
  addressing: string,
  pair: Ed25519KeyPair,
  payload: LoginCodeRedeemResponse,
  identitySet: { value: boolean }
): void {
  ctx.sessions.setPopKey(
    ctx.globals.entry,
    addressing,
    copyPopKey({ sessSk: pair.secretKey, sessPk: pair.publicKey })
  );
  if (!identitySet.value) {
    ctx.sessions.setIdentity(ctx.globals.entry, {
      uid: payload.uid ?? null,
      username: payload.username ?? null,
    });
    identitySet.value = true;
  }
  ctx.sessions.save();
}

async function redeemToNode(args: {
  ctx: CliContext;
  target: LoginTarget;
  entryNodeId: string;
  secret: Uint8Array;
  pair: Ed25519KeyPair;
  timeoutMs: number;
  identitySet: { value: boolean };
}): Promise<TargetOutcome> {
  const { ctx, target, entryNodeId, secret, pair, timeoutMs, identitySet } = args;
  const signal = AbortSignal.timeout(timeoutMs);
  const realId = realNodeId(target.nodeId, entryNodeId);
  const body: LoginCodeRedeemRequest = {
    code: encodeBase64url(deriveNodeLoginCode(secret, realId)),
    sess_pk: encodeBase64url(pair.publicKey),
    pop: true,
  };
  try {
    const response = await ctx.http.fetch(target.nodeId, LOGIN_CODE_REDEEM_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...CLI_CLIENT_HEADERS },
      body: JSON.stringify(body),
      ...redeemHttpOptions(signal),
    });
    if (!response.ok) {
      return {
        node: target.nodeId,
        name: target.name,
        ok: false,
        code: await readRedeemErrorCode(response),
      };
    }
    const payload = (await response.json()) as LoginCodeRedeemResponse;
    persistRedeem(ctx, target.nodeId, pair, payload, identitySet);
    return { node: target.nodeId, name: target.name, ok: true };
  } catch (error) {
    if (isRedeemTimeoutError(error, signal)) {
      return { node: target.nodeId, name: target.name, ok: false, code: LOGIN_TIMEOUT };
    }
    if (isNodeUnreachableError(error)) {
      return { node: target.nodeId, name: target.name, ok: false, code: 'NODE_UNREACHABLE' };
    }
    throw error;
  }
}

function finishLoginCode(ctx: CliContext, mode: AuthMode, outcomes: TargetOutcome[]): number {
  reportLoginOutcomes(ctx, outcomes);
  const code = reportLoginFailures(ctx, mode, outcomes, false);
  if (code !== 0) return code;
  if (outcomes.some((row) => row.ok)) return 0;
  return EXIT_NETWORK;
}

function storedSessionIds(ctx: CliContext, entryNodeId: string): string[] {
  const nodes = ctx.sessions.entry(ctx.globals.entry)?.nodes;
  if (!nodes) return [];
  return Object.keys(nodes).map((id) => (id === SELF_NODE_ID ? entryNodeId : id));
}

/** 码覆盖了本 entry 当前所有已存会话节点时视为全量，应轮换密钥。 */
function codeCoversStoredSessions(
  ctx: CliContext,
  entryNodeId: string,
  codeNodeIds: readonly string[]
): boolean {
  const stored = storedSessionIds(ctx, entryNodeId);
  if (stored.length === 0) return true;
  const covered = new Set(codeNodeIds);
  return stored.every((id) => covered.has(id));
}

function resolveRedeemKeyPair(
  ctx: CliContext,
  entryNodeId: string,
  codeNodeIds: readonly string[],
  uid: string | null | undefined
): Ed25519KeyPair {
  if (codeCoversStoredSessions(ctx, entryNodeId, codeNodeIds)) {
    return generateEd25519KeyPair();
  }
  const stored = reusableSelfPopKey(ctx.sessions, ctx.globals.entry, uid);
  if (!stored) return generateEd25519KeyPair();
  const copy = copyPopKey(stored);
  return { secretKey: copy.sessSk, publicKey: copy.sessPk };
}

/** 经入口访问任何节点都要先有入口自己的会话：命令没覆盖入口时提前说清楚。 */
function warnEntryNotCovered(
  ctx: CliContext,
  nodeIds: readonly string[],
  entryNodeId: string
): void {
  if (nodeIds.includes(entryNodeId)) return;
  ctx.out.warn(
    `this login command does not include the entry ${ctx.globals.entry} (node ${entryNodeId.slice(0, 8)}); commands through this entry will need its session. Generate the command for all nodes, or pass --entry pointing at a node it includes.`
  );
}

/** 用一次性登录命令兑换入口及码里点名的节点；会话密钥对本机生成、用完即清零。 */
export async function loginWithCode(ctx: CliContext, opts: LoginCodeOptions): Promise<number> {
  const parts = decodeLoginCode(opts.code);
  if (!parts) {
    throw new UsageError('invalid login code', 'copy the whole command from the web UI again');
  }
  try {
    const mode = await fetchAuthMode(ctx.http, SELF_NODE_ID);
    if (!mode || !requiresLogin(mode)) {
      throw new AuthError(
        `${ctx.globals.entry} does not use accounts; a login code cannot be used here`
      );
    }
    warnEntryNotCovered(ctx, parts.nodeIds, mode.nodeId);
    const pair = resolveRedeemKeyPair(ctx, mode.nodeId, parts.nodeIds, mode.uid);
    try {
      const ordered = orderNodeIds(parts.nodeIds, mode.nodeId);
      const identitySet = { value: false };
      const attempt = (target: LoginTarget) =>
        redeemToNode({
          ctx,
          target,
          entryNodeId: mode.nodeId,
          secret: parts.secret,
          pair,
          timeoutMs: opts.timeoutMs,
          identitySet,
        });
      const firstTargets = asTargets(ordered.slice(0, 1), mode.nodeId, []);
      const first = await runFanoutTarget({
        out: ctx.out,
        target: firstTargets[0],
        attempt: () => attempt(firstTargets[0]),
        emitDone: true,
      });
      let roster = first.ok ? await loadRoster(ctx) : [];
      const restIds = ordered.slice(1);
      const rest = await mapBounded(
        asTargets(restIds, mode.nodeId, roster),
        opts.concurrency,
        (target) =>
          runFanoutTarget({
            out: ctx.out,
            target,
            attempt: () => attempt(target),
            emitDone: true,
          })
      );
      const raw = [first, ...rest];
      if (!roster.length && raw.some((row) => row.ok)) roster = await loadRoster(ctx);
      return finishLoginCode(ctx, mode, relabelOutcomes(raw, mode.nodeId, roster));
    } finally {
      pair.secretKey.fill(0);
    }
  } finally {
    parts.secret.fill(0);
  }
}
