import { performRelayPasswordJoin as defaultPerformRelayPasswordJoin } from '../commands/relay-password-join';
import { RelayPasswordJoinError } from '../lib/relay-password-join-flow';
import { jsonOk } from './http';
import { DIRECT_ENABLED_KEY, type SetupServiceDeps, maybeEnableDirect } from './setup-service';
import {
  SetupError,
  assertSetupUrl,
  assertStandalone,
  commitRelayPasswordJoinEnv,
  patchOwnedEnvKeys,
  withSetupTransition,
} from './setup-shared';

function readString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === 'string' ? value : '';
}

export const RELAY_JOIN_ERROR_STATUS: Record<string, number> = {
  relay_password_invalid: 401,
  relay_tenant_unknown: 404,
  relay_pack_invalid: 409,
  relay_unreachable: 502,
  local_user_exists: 409,
  relay_not_authorized: 403,
};

const RELAY_JOIN_ERROR_CODES = new Set(Object.keys(RELAY_JOIN_ERROR_STATUS));

export function asSetupRelayJoinError(error: unknown): SetupError {
  if (error instanceof SetupError) return error;
  if (error instanceof RelayPasswordJoinError) {
    const code = error.code === 'head_hash_mismatch' ? 'relay_pack_invalid' : error.code;
    if (RELAY_JOIN_ERROR_CODES.has(code)) {
      return new SetupError(code, error.message, RELAY_JOIN_ERROR_STATUS[code] ?? 400);
    }
    return new SetupError('join_failed', error.message, 400);
  }
  const message = error instanceof Error ? error.message : String(error);
  return new SetupError('join_failed', message, 400);
}

export type RelayJoinSetupDeps = SetupServiceDeps & {
  performRelayPasswordJoin?: typeof defaultPerformRelayPasswordJoin;
};

export async function handleRelayJoinRequest(
  body: Record<string, unknown>,
  deps: RelayJoinSetupDeps
): Promise<Response> {
  assertStandalone(deps.roles);
  const relayUrl = readString(body, 'relayUrl');
  const tenantId = readString(body, 'tenantId');
  const password = readString(body, 'password');
  const name = readString(body, 'name');
  if (!relayUrl || !tenantId || !password || !name.trim()) {
    throw new SetupError('invalid_body', 'relayUrl, tenantId, password and name are required', 400);
  }
  let normalizedUrl: string;
  try {
    normalizedUrl = assertSetupUrl(relayUrl, deps.nodeEnv).toString().replace(/\/+$/, '');
  } catch (error) {
    if (error instanceof SetupError) throw error;
    throw new SetupError(
      'invalid_url',
      error instanceof Error ? error.message : String(error),
      400
    );
  }
  const caFingerprint = readString(body, 'caFingerprint') || undefined;
  const perform = deps.performRelayPasswordJoin ?? defaultPerformRelayPasswordJoin;
  return await withSetupTransition(deps, async () => {
    let joined: Awaited<ReturnType<typeof defaultPerformRelayPasswordJoin>>;
    try {
      joined = await perform(
        {
          relayUrl: normalizedUrl,
          tenantId,
          password,
          name: name.trim(),
          caFingerprint,
        },
        {
          auth: deps.auth,
          now: deps.now,
          fetcher: deps.fetch,
        }
      );
    } catch (error) {
      throw asSetupRelayJoinError(error);
    }
    await commitRelayPasswordJoinEnv(deps);
    const direct = await maybeEnableDirect(body.directEnable === true, deps);
    if (direct.direct === 'enabled') {
      await patchOwnedEnvKeys(deps, { [DIRECT_ENABLED_KEY]: 'true' });
    }
    return jsonOk({
      ok: true,
      relayUrl: joined.relayUrl,
      tenantId: joined.tenantId,
      username: joined.userId,
      direct: direct.direct,
      directError: direct.directError,
      restarting: true,
    });
  });
}
