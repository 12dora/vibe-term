// 签发一次性登录命令：逐台节点登记 sha256(节点码)，命令里只放签发成功的节点。
// 仅由登录命令对话框动态 import；命令的 secret 只活在本模块的 WeakMap 里。

import { SELF_NODE_ID } from '@vibeterm/api-client';
import type { AuthApi, AuthModeResponse, MeshNode } from '@vibeterm/api-client/auth/index';
import { defaultAuthApi } from '@vibeterm/api-client/auth/index';
import type { LoginCodeState } from '@vibeterm/shared';
import { compareSemver } from '@vibeterm/shared';
import {
  LOGIN_CODE_MAX_NODES,
  MIN_LOGIN_CODE_VERSION,
  deriveNodeLoginCode,
  encodeBase64url,
  encodeLoginCode,
  generateLoginCodeSecret,
} from '@vibeterm/shared/auth';
import { issueOnTarget, runLimited } from './login-code-node';
import {
  type LoginCodeProof,
  type LoginCodeProofDeps,
  type LoginCodeProofMaterial,
  buildLoginCodeProof,
  totpProofUsable,
} from './login-code-proof';
import { pausedPasskeyHint } from './login-throttle';
import { readSessionSecrets } from './session-key-store';
import type { SessionKeySecrets } from './session-key-types';

export type { LoginCodeProof } from './login-code-proof';

export type LoginCodeProofKind = 'totp' | 'passkey' | 'password';

export interface LoginCodeContext {
  mode: AuthModeResponse;
  selfMeshId: string;
  proofKinds: LoginCodeProofKind[];
  totpEnabled: boolean;
}

export interface LoginCodeContextDeps {
  api?: AuthApi;
  now?: number;
  readSecrets?: () => SessionKeySecrets | null;
  webauthnSupported?: boolean;
}

/** 可用的证明方式，按偏好排序；都不可用时退回密码。 */
export function loginCodeProofKinds(
  mode: AuthModeResponse,
  secrets: SessionKeySecrets | null,
  opts: { now: number; webauthnSupported?: boolean }
): LoginCodeProofKind[] {
  const kinds: LoginCodeProofKind[] = [];
  if (totpProofUsable(mode, secrets, opts.now)) kinds.push('totp');
  if (pausedPasskeyHint(mode, opts.webauthnSupported).passkeyUsable) kinds.push('passkey');
  return kinds.length > 0 ? kinds : ['password'];
}

export async function loadLoginCodeContext(
  deps: LoginCodeContextDeps = {}
): Promise<LoginCodeContext> {
  const mode = await (deps.api ?? defaultAuthApi).getMode();
  const secrets = (deps.readSecrets ?? readSessionSecrets)();
  return {
    mode,
    selfMeshId: mode.nodeId,
    proofKinds: loginCodeProofKinds(mode, secrets, {
      now: deps.now ?? Date.now(),
      webauthnSupported: deps.webauthnSupported,
    }),
    totpEnabled: Boolean(mode.totpEnabled),
  };
}

export interface LoginCodeTarget {
  meshId: string;
  runtimeId: string;
  name: string;
  publicKey: string;
}

export type LoginCodeSkipReason = 'offline' | 'outdated' | 'paused';

export interface LoginCodeSkipped {
  meshId: string;
  name: string;
  reason: LoginCodeSkipReason;
}

/** 缺版本即视为过旧；版本解析不了（开发版）交给请求本身裁决（老节点回 404）。 */
function isOutdated(version: string | null): boolean {
  if (!version) return true;
  return compareSemver(version, MIN_LOGIN_CODE_VERSION) === -1;
}

function skipReasonOf(node: MeshNode): LoginCodeSkipReason | null {
  if (!node.online) return 'offline';
  if (node.paused === true) return 'paused';
  if (isOutdated(node.version)) return 'outdated';
  return null;
}

/** selection = 'all' 或一个 mesh id；self 由 selfMeshId 认出（runtimeId 为 'self'），恒在首位。 */
export function planLoginCodeTargets(
  nodes: readonly MeshNode[],
  selection: 'all' | string,
  selfMeshId: string
): { targets: LoginCodeTarget[]; skipped: LoginCodeSkipped[] } {
  const chosen = nodes.filter((node) => selection === 'all' || node.id === selection);
  const ordered = [
    ...chosen.filter((node) => node.id === selfMeshId),
    ...chosen.filter((node) => node.id !== selfMeshId),
  ];
  const targets: LoginCodeTarget[] = [];
  const skipped: LoginCodeSkipped[] = [];
  for (const node of ordered) {
    const isSelf = node.id === selfMeshId;
    const reason = isSelf ? null : skipReasonOf(node);
    if (reason) {
      skipped.push({ meshId: node.id, name: node.name, reason });
      continue;
    }
    targets.push({
      meshId: node.id,
      runtimeId: isSelf ? SELF_NODE_ID : node.id,
      name: node.name,
      publicKey: node.publicKey,
    });
  }
  return { targets, skipped };
}

export type LoginCodeNodeOutcome =
  | { meshId: string; name: string; ok: true; expiresAt: number }
  | { meshId: string; name: string; ok: false; code: string; retryAfterMs?: number };

export interface LoginCodeHandle {
  readonly command: string;
  readonly expiresAt: number;
  readonly meshIds: readonly string[];
}

export type IssueLoginCodeResult =
  | { ok: true; handle: LoginCodeHandle; nodes: LoginCodeNodeOutcome[] }
  | { ok: false; code: string; retryAfterMs?: number; nodes: LoginCodeNodeOutcome[] };

/** 首台节点出现这些码说明证明本身不成立，整次签发中止（用户需重新验证）。 */
export const LOGIN_CODE_PROOF_FAILURES: ReadonlySet<string> = new Set([
  'TOTP_INVALID',
  'TOTP_ALREADY_USED',
  'TOTP_REQUIRED',
  'PASSKEY_REQUIRED',
  'PASSKEY_INVALID',
  'PASSKEY_CANCELLED',
  'INVALID_CREDENTIALS',
  'STEP_UP_REQUIRED',
  'RATE_LIMITED',
  'PASSWORD_LOGIN_PAUSED',
  'NODE_PK_MISMATCH',
]);

const LOGIN_CODE_CONCURRENCY = 4;

interface HandleState {
  secret: Uint8Array;
  nodes: { meshId: string; runtimeId: string }[];
  api: AuthApi;
}

const handles = new WeakMap<LoginCodeHandle, HandleState>();

export interface IssueLoginCodeInput {
  context: LoginCodeContext;
  targets: LoginCodeTarget[];
  proof: LoginCodeProof;
  signal?: AbortSignal;
  api?: AuthApi;
  now?: number;
  /** 测试注入：argon2id、会话密钥对生成、origin。 */
  deps?: Pick<
    LoginCodeProofDeps,
    'deriveSeed' | 'generateSessionKeyPair' | 'origin' | 'readSecrets'
  >;
}

function abortedRow(target: LoginCodeTarget): LoginCodeNodeOutcome {
  return { meshId: target.meshId, name: target.name, ok: false, code: 'ABORTED' };
}

function failureOf(row: LoginCodeNodeOutcome, nodes: LoginCodeNodeOutcome[]): IssueLoginCodeResult {
  if (row.ok) return { ok: false, code: 'ISSUE_FAILED', nodes };
  return row.retryAfterMs === undefined
    ? { ok: false, code: row.code, nodes }
    : { ok: false, code: row.code, retryAfterMs: row.retryAfterMs, nodes };
}

function createHandle(
  secret: Uint8Array,
  targets: readonly LoginCodeTarget[],
  rows: readonly LoginCodeNodeOutcome[],
  api: AuthApi
): LoginCodeHandle {
  const okTargets = targets.filter((_, index) => rows[index]?.ok);
  const meshIds = okTargets.map((target) => target.meshId);
  const expiresAt = Math.min(
    ...rows.map((row) => (row.ok ? row.expiresAt : Number.POSITIVE_INFINITY))
  );
  const handle: LoginCodeHandle = Object.freeze({
    command: `vibeterm login --code ${encodeLoginCode({ secret, nodeIds: meshIds })}`,
    expiresAt,
    meshIds: Object.freeze(meshIds),
  });
  handles.set(handle, {
    secret,
    nodes: okTargets.map(({ meshId, runtimeId }) => ({ meshId, runtimeId })),
    api,
  });
  return handle;
}

function revokeNodes(
  api: AuthApi,
  secret: Uint8Array,
  nodes: readonly { meshId: string; runtimeId: string }[]
): Promise<unknown> {
  // 先把各节点码派生好：作废途中句柄被销毁（secret 清零）也不影响已排队的请求。
  const codes = nodes.map((node) => ({
    runtimeId: node.runtimeId,
    code: encodeBase64url(deriveNodeLoginCode(secret, node.meshId)),
  }));
  return runLimited(codes, LOGIN_CODE_CONCURRENCY, (node) =>
    api.revokeLoginCode(node.runtimeId, node.code).catch(() => null)
  );
}

async function issueAll(
  input: IssueLoginCodeInput,
  material: LoginCodeProofMaterial,
  secret: Uint8Array,
  api: AuthApi
): Promise<IssueLoginCodeResult> {
  const { targets, signal } = input;
  const issueOne = (target: LoginCodeTarget): Promise<LoginCodeNodeOutcome> =>
    signal?.aborted
      ? Promise.resolve(abortedRow(target))
      : issueOnTarget({ api, material, secret, target });

  const first = await issueOne(targets[0] as LoginCodeTarget);
  if (!first.ok && (LOGIN_CODE_PROOF_FAILURES.has(first.code) || first.code === 'ABORTED')) {
    return failureOf(first, [first]);
  }
  const rest = await runLimited(targets.slice(1), LOGIN_CODE_CONCURRENCY, issueOne);
  const rows = [first, ...rest];
  if (signal?.aborted) {
    // 中止时已登记的节点码顺手作废：secret 随即清零，这些码本来也没人能兑换。
    await revokeNodes(
      api,
      secret,
      targets.filter((_, index) => rows[index]?.ok)
    );
    return { ok: false, code: 'ABORTED', nodes: rows };
  }
  if (!rows.some((row) => row.ok)) return failureOf(rows.find((row) => !row.ok) ?? first, rows);
  return { ok: true, handle: createHandle(secret, targets, rows, api), nodes: rows };
}

export async function issueLoginCode(input: IssueLoginCodeInput): Promise<IssueLoginCodeResult> {
  if (input.targets.length === 0) return { ok: false, code: 'NO_TARGETS', nodes: [] };
  if (input.targets.length > LOGIN_CODE_MAX_NODES) {
    return { ok: false, code: 'TOO_MANY_NODES', nodes: [] };
  }
  const api = input.api ?? defaultAuthApi;
  const proof = await buildLoginCodeProof(input.context, input.proof, {
    ...input.deps,
    api,
    now: input.now ?? Date.now(),
  });
  if (!proof.ok) return { ok: false, code: proof.code, nodes: [] };
  const secret = generateLoginCodeSecret();
  let kept = false;
  try {
    if (input.signal?.aborted) return { ok: false, code: 'ABORTED', nodes: [] };
    const result = await issueAll(input, proof.material, secret, api);
    kept = result.ok;
    return result;
  } finally {
    proof.material.destroy();
    if (!kept) secret.fill(0);
  }
}

/** 按 meshId 给出每台节点上这条码的状态；查询失败或句柄已销毁为 'unknown'。 */
export type LoginCodeNodeState = LoginCodeState | 'unknown';

export async function pollLoginCodeStates(
  handle: LoginCodeHandle
): Promise<Record<string, LoginCodeNodeState>> {
  const states: Record<string, LoginCodeNodeState> = {};
  for (const meshId of handle.meshIds) states[meshId] = 'unknown';
  const state = handles.get(handle);
  if (!state) return states;
  await runLimited(state.nodes, LOGIN_CODE_CONCURRENCY, async (node) => {
    if (handles.get(handle) !== state) return;
    const code = encodeBase64url(deriveNodeLoginCode(state.secret, node.meshId));
    const status = await state.api.loginCodeStatus(node.runtimeId, code).catch(() => null);
    // 轮询途中句柄被销毁：secret 已清零，派生出的码不可信，结果一律作废。
    if (status && handles.get(handle) === state) states[node.meshId] = status.state;
  });
  return states;
}

export async function revokeLoginCode(handle: LoginCodeHandle): Promise<void> {
  const state = handles.get(handle);
  if (state) await revokeNodes(state.api, state.secret, state.nodes);
}

export function disposeLoginCode(handle: LoginCodeHandle): void {
  const state = handles.get(handle);
  if (!state) return;
  handles.delete(handle);
  state.secret.fill(0);
}
