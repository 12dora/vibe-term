import { isStandaloneRoles } from '@vibeterm/shared';
import { encodeBase64url } from '@vibeterm/shared/auth';
import { readJsonObjectBody } from '../api/http';
import type { UserKeyService } from '../auth/user-key-service';
import { kdfParamsFromJson } from '../auth/user-key-service';
import type { UserRecord, UserStore } from '../auth/user-store';
import { passkeyOriginScope } from '../mesh/auth-passkey-origin';
import { requestIsLoopback } from '../mesh/client-ip';
import type { MeshRoles } from '../mesh/mesh-deps';
import {
  type SessionMiddlewareDeps,
  authenticateRequest,
  jsonBody,
  jsonError,
} from '../mesh/session-middleware';
import {
  type LocalAuthStoreLike,
  buildLocalAuthStatus,
  decideLocalAuthBootstrap,
  decideLocalAuthToggle,
  validateLocalAuthPassword,
  validateLocalAuthUsername,
} from './local-auth-settings';

export type LocalAuthHttpCtx = {
  roles: MeshRoles;
  userStore: UserStore;
  keyLogService: UserKeyService;
  localAuth: LocalAuthStoreLike;
  sessionDeps: SessionMiddlewareDeps;
};

export function localAuthPayload(ctx: LocalAuthHttpCtx) {
  return buildLocalAuthStatus({
    standalone: isStandaloneRoles(ctx.roles),
    enabled: ctx.localAuth.getEnabled(),
    credentialsPresent: ctx.userStore.listUsers().length > 0,
  });
}

export function isLocalAuthEffective(ctx: LocalAuthHttpCtx): boolean {
  return localAuthPayload(ctx).effective;
}

/** 登录页 / CLI 用来决定二次验证要交哪一种因子。旧客户端忽略即可。 */
export type SecondFactorPolicy = 'either' | 'totp' | 'passkey' | 'none';

export function secondFactorPolicyForMode(input: {
  totpEnabled: boolean;
  passkeySecondFactor: boolean;
}): SecondFactorPolicy {
  if (input.totpEnabled && input.passkeySecondFactor) return 'either';
  if (input.totpEnabled) return 'totp';
  if (input.passkeySecondFactor) return 'passkey';
  return 'none';
}

/** 与 `checkTotp` 同一口径：投影序号和密钥日志里的密文都在才算已启用。 */
export function accountHasTotp(
  user: { totpRecordSeq: bigint | number | null } | null,
  totpSecretPresent: boolean
): boolean {
  return user != null && user.totpRecordSeq != null && totpSecretPresent;
}

export function meshAuthModeUserFields(
  user: UserRecord | null,
  origin: string,
  userStore: UserStore,
  hub: { nodeId: string | null; publicUrl: string | null },
  opts?: { waivePasskeySecondFactor?: boolean; totpSecretPresent?: boolean }
) {
  const keys = user ? userStore.listKeysByUser(user.id) : [];
  const scope = passkeyOriginScope(keys, origin);
  const hasKeysHere = scope.here.length > 0;
  const waived = Boolean(opts?.waivePasskeySecondFactor) && hasKeysHere;
  const totpEnabled = accountHasTotp(user, opts?.totpSecretPresent === true);
  const passkeySecondFactor = hasKeysHere && !waived;
  return {
    mode: 'mesh' as const,
    uid: user?.id ?? null,
    username: user?.username ?? null,
    kdfParams: user ? publicKdfParams(user.kdfParamsJson) : null,
    passkeysForThisOrigin: hasKeysHere,
    // 断言只能在注册它的 origin 上完成：本 origin 没有凭证就不能要求二次验证，
    // 否则换入口域名后密码正确也永远登不进来（见 auth-passkey-origin.ts）。
    passkeySecondFactor,
    passkeySecondFactorWaived: waived,
    passkeysRegisteredElsewhere: scope.registeredElsewhere,
    totpEnabled,
    secondFactorPolicy: secondFactorPolicyForMode({ totpEnabled, passkeySecondFactor }),
    rootEpoch: user?.rootEpoch ?? null,
    rootPublicKey: user ? encodeBase64url(user.rootPublicKey) : null,
    hubNodeId: hub.nodeId,
    hubPublicUrl: hub.publicUrl,
  };
}

function publicKdfParams(jsonStr: string) {
  const params = kdfParamsFromJson(jsonStr);
  return {
    salt: encodeBase64url(params.salt),
    memory_kib: params.memory_kib,
    iterations: params.iterations,
    parallelism: params.parallelism,
  };
}

function loopbackAndAuth(req: Request, sessionDeps: SessionMiddlewareDeps) {
  const auth = authenticateRequest(req, sessionDeps);
  return {
    loopback: requestIsLoopback(req),
    authenticated: auth.ok && Boolean(auth.userId),
  };
}

export async function handleLocalAuthToggle(
  req: Request,
  ctx: LocalAuthHttpCtx
): Promise<Response> {
  const body = await readJsonObjectBody(req);
  if (!body || typeof body.enabled !== 'boolean') return jsonError('MALFORMED', 400);
  const decided = decideLocalAuthToggle({
    standalone: isStandaloneRoles(ctx.roles),
    wantEnabled: body.enabled,
    credentialsPresent: ctx.userStore.listUsers().length > 0,
    ...loopbackAndAuth(req, ctx.sessionDeps),
  });
  if (!decided.ok) return jsonError(decided.code, decided.status);
  ctx.localAuth.setEnabled(decided.enabled);
  return jsonBody({ ok: true, localAuth: localAuthPayload(ctx) });
}

export async function handleLocalAuthBootstrap(
  req: Request,
  ctx: LocalAuthHttpCtx
): Promise<Response> {
  const body = await readJsonObjectBody(req);
  const username = typeof body?.username === 'string' ? body.username : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  const userOk = validateLocalAuthUsername(username);
  if (!userOk.ok) return jsonError(userOk.code, userOk.status);
  const passOk = validateLocalAuthPassword(password);
  if (!passOk.ok) return jsonError(passOk.code, passOk.status);
  const decided = decideLocalAuthBootstrap({
    standalone: isStandaloneRoles(ctx.roles),
    enabled: ctx.localAuth.getEnabled(),
    credentialsPresent: ctx.userStore.listUsers().length > 0,
    loopback: requestIsLoopback(req),
  });
  if (!decided.ok) return jsonError(decided.code, decided.status);
  await ctx.keyLogService.bootstrapUser({ username, password });
  return jsonBody({ ok: true, localAuth: localAuthPayload(ctx) });
}
