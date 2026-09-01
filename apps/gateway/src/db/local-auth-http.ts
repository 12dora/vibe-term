import { isStandaloneRoles } from '@tmex/shared';
import { encodeBase64url } from '@tmex/shared/auth';
import { readJsonObjectBody } from '../api/http';
import type { UserKeyService } from '../auth/user-key-service';
import { kdfParamsFromJson } from '../auth/user-key-service';
import type { UserRecord, UserStore } from '../auth/user-store';
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

export function meshAuthModeUserFields(
  user: UserRecord | null,
  origin: string,
  userStore: UserStore,
  hub: { nodeId: string | null; publicUrl: string | null }
) {
  return {
    mode: 'mesh' as const,
    uid: user?.id ?? null,
    username: user?.username ?? null,
    kdfParams: user ? publicKdfParams(user.kdfParamsJson) : null,
    passkeysForThisOrigin: user
      ? userStore.listKeysByUser(user.id).some((k) => k.origin === origin)
      : false,
    totpEnabled: user?.totpRecordSeq != null,
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
