import { performRelayPasswordJoin as defaultPerformRelayPasswordJoin } from '../commands/relay-password-join';
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
    const joined = await perform(
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
