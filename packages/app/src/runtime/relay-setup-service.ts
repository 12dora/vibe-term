import { ensureNodeIdentity } from '../../../../apps/gateway/src/auth/node-identity-service';
import { RelayConfigStore } from '../../../../apps/gateway/src/relay/relay-config-store';
import {
  hashRelayPassword,
  relayPasswordTooShort,
} from '../../../../apps/gateway/src/relay/relay-password';
import { RelayJoinTokenError, normalizeRelayUrl } from '../../../../packages/shared/src/relay';
import { generateRelayAdminToken } from '../lib/install';
import { fingerprintPublicKey } from '../lib/totp-uri';
import { DIRECT_ENABLED_KEY, type SetupServiceDeps, maybeEnableDirect } from './setup-service';
import {
  SetupError,
  assertPassword,
  assertStandalone,
  assertUsername,
  isUniqueConstraintFailure,
  patchOwnedEnvKeys,
  readExistingEnv,
  withSetupTransition,
} from './setup-shared';

export type SetupRelayRole = 'relay' | 'relay,node';

export type BecomeRelayInput = {
  role: SetupRelayRole;
  relayPublicUrl: string;
  relayPassword?: string | null;
  username?: string;
  password?: string;
  directEnable?: boolean;
};

export type BecomeRelayResult = {
  ok: true;
  role: SetupRelayRole;
  relayPublicUrl: string;
  hasPassword: boolean;
  restarting: true;
  fingerprint?: string;
};

function assertRelayRole(value: unknown): SetupRelayRole {
  if (value === 'relay' || value === 'relay,node') return value;
  throw new SetupError('invalid_role', "role must be 'relay' or 'relay,node'", 400);
}

function assertRelayPublicUrl(raw: string): string {
  const value = raw.trim();
  if (!value) {
    throw new SetupError('invalid_url', 'relay public URL cannot be empty', 400);
  }
  try {
    return normalizeRelayUrl(value);
  } catch (error) {
    const message = error instanceof RelayJoinTokenError ? error.message : String(error);
    throw new SetupError('invalid_url', `invalid relay public URL: ${message}`, 400);
  }
}

function normalizeRelayPassword(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (relayPasswordTooShort(trimmed)) {
    throw new SetupError('weak_password', 'password must be at least 8 characters', 400);
  }
  return trimmed;
}

async function persistRelayPassword(
  deps: SetupServiceDeps,
  password: string | null,
  now: number
): Promise<boolean> {
  const store = new RelayConfigStore(deps.auth.db);
  store.ensure(now);
  if (password === null) return false;
  const passwordHash = await hashRelayPassword(password);
  store.rotatePassword({ passwordHash, kick: false, now });
  return true;
}

async function resolveRelayAdminToken(deps: SetupServiceDeps): Promise<string> {
  const existing = await readExistingEnv(deps);
  const current = existing.TMEX_RELAY_ADMIN_TOKEN?.trim();
  return current && current.length > 0 ? current : generateRelayAdminToken();
}

async function bootstrapRelayNodeUser(
  input: BecomeRelayInput,
  deps: SetupServiceDeps
): Promise<string> {
  const username = assertUsername(input.username ?? '');
  const password = assertPassword(input.password ?? '');
  if (deps.auth.userStore.getByUsername(username)) {
    throw new SetupError('user_exists', `user already exists: ${username}`, 409);
  }
  const identity = await ensureNodeIdentity(deps.auth.identityStore);
  try {
    const boot = await deps.auth.userKeys.bootstrapUserWithSelfAdmit({
      username,
      password,
      identity,
      now: deps.now?.() ?? Date.now(),
    });
    return fingerprintPublicKey(boot.rootPublicKey);
  } catch (error) {
    if (isUniqueConstraintFailure(error)) {
      throw new SetupError('user_exists', `user already exists: ${username}`, 409);
    }
    throw error;
  }
}

export async function becomeRelay(
  input: BecomeRelayInput,
  deps: SetupServiceDeps
): Promise<BecomeRelayResult> {
  assertStandalone(deps.roles);
  const role = assertRelayRole(input.role);
  const relayPublicUrl = assertRelayPublicUrl(input.relayPublicUrl);
  const relayPassword = normalizeRelayPassword(input.relayPassword);
  return await withSetupTransition(deps, async () => {
    const fingerprint =
      role === 'relay,node' ? await bootstrapRelayNodeUser(input, deps) : undefined;
    const hasPassword = await persistRelayPassword(deps, relayPassword, deps.now?.() ?? Date.now());
    const adminToken = await resolveRelayAdminToken(deps);
    const direct = await maybeEnableDirect(input.directEnable === true, deps);
    await patchOwnedEnvKeys(deps, {
      TMEX_ROLES: role,
      TMEX_RELAY_PUBLIC_URL: relayPublicUrl,
      TMEX_HUB_URL: '',
      TMEX_HUB_PUBLIC_URL: '',
      TMEX_RELAY_ADMIN_TOKEN: adminToken,
      ...(direct.direct === 'enabled' ? { [DIRECT_ENABLED_KEY]: 'true' } : {}),
    });
    return {
      ok: true as const,
      role,
      relayPublicUrl,
      hasPassword,
      restarting: true as const,
      ...(fingerprint ? { fingerprint } : {}),
    };
  });
}
