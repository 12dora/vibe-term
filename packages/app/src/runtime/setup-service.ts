import { PROCESS_STARTED_AT } from '../../../../apps/gateway/src/api/system-routes';
import { ensureNodeIdentity } from '../../../../apps/gateway/src/auth/node-identity-service';
import { canonicalHubUrl } from '../../../../packages/shared/src/auth';
import { type EnvName, resolveEnvName } from '../../../../packages/shared/src/env/load-env';
import {
  type DirectEnableResult,
  type DisableDirectOptions,
  type EnableDirectOptions,
  disableDirect as defaultDisableDirect,
  enableDirect as defaultEnableDirect,
} from '../commands/direct';
import {
  JoinError,
  type PerformHubJoinDeps,
  type PerformHubJoinInput,
  performHubJoin as defaultPerformHubJoin,
} from '../commands/hub';
import {
  readEnvFile as defaultReadEnvFile,
  resolveEnvWriteTarget,
  stringifyEnv,
} from '../lib/env-file';
import { withEnvLock } from '../lib/env-mutation';
import { requestEnrollmentByPassword as defaultRequestEnrollmentByPassword } from '../lib/hub-password-join';
import { createInstallLayout } from '../lib/install-layout';
import type { LocalAuthContext } from '../lib/local-auth';
import { readInstalledNativeManifest } from '../lib/native-datachannel';
import { detectCurrentNativePin } from '../lib/native-manifest';
import { type TmexRoleName, type TmexRoles, roleNameFromFlags } from '../lib/roles';
import { fingerprintPublicKey } from '../lib/totp-uri';
import {
  type SetupEnvHost,
  SetupError,
  assertPassword,
  assertSetupUrl,
  assertStandalone,
  assertUsername,
  errorCause,
  isUniqueConstraintFailure,
  newStagedEnvPath,
  parseJoinHubCredentials,
  patchOwnedEnvKeys,
  promoteStagedEnv,
  readExistingEnv,
  removeStagedEnv,
  withSetupTransition,
  wrapJoinEnvWriteError,
  writeStagedEnv,
} from './setup-shared';

export const SETUP_RESTART_DELAY_MS = 300;
export const DIRECT_ENABLE_TIMEOUT_MS = 60_000;
export const PRECHECK_TIMEOUT_MS = 5_000;
export const DIRECT_ENABLED_KEY = 'TMEX_DIRECT_ENABLED';

export {
  SetupError,
  assertSetupUrl,
  createSetupTransitionLock,
  newStagedEnvPath,
  patchOwnedEnvKeys,
  promoteStagedEnv,
  readExistingEnv,
  removeStagedEnv,
  resetProcessSetupLockForTests,
  resolveRepoRoot,
  resolveSetupEnvPath,
  withSetupTransition,
  wrapJoinEnvWriteError,
  writeStagedEnv,
} from './setup-shared';
export type { SetupEnvHost, SetupTransitionLock } from './setup-shared';

export type DirectStatus = {
  supported: boolean;
  installed: boolean;
  enabled: boolean;
  capable: boolean;
  version: string | null;
  platform: string;
};

export type LocalRelayStatus = {
  publicUrl: string | null;
  hasPassword: boolean;
  tenantCount: number;
  nodesOnline: number;
  currentNodes: number;
};

const EMPTY_RELAY_STATUS: LocalRelayStatus = {
  publicUrl: null,
  hasPassword: false,
  tenantCount: 0,
  nodesOnline: 0,
  currentNodes: 0,
};

export type LocalStatus = {
  role: TmexRoleName;
  nodeEnv: EnvName;
  hubUrl: string | null;
  hubPublicUrl: string | null;
  direct: DirectStatus;
  tls: { mode: 'none' };
  relay: LocalRelayStatus | null;
};

export type DirectAction = 'install' | 'remove' | 'enable' | 'disable';

export type DirectSetResult = {
  ok: true;
  installed: boolean;
  enabled: boolean;
  capable: boolean;
  restartRequired: true;
};

export type SetupDirectOutcome = 'enabled' | 'failed' | 'skipped';

export type BecomeHubInput = {
  hubPublicUrl: string;
  username: string;
  password: string;
  directEnable: boolean;
};

export type BecomeHubResult = {
  ok: true;
  fingerprint: string;
  direct: SetupDirectOutcome;
  directError: string | null;
  restarting: true;
};

export type JoinHubInput = {
  hubUrl: string;
  token?: string;
  password?: string;
  method?: 'token' | 'password';
  name: string;
  directEnable: boolean;
  insecureLocal?: boolean;
};

export type JoinHubResult = {
  ok: true;
  hubUrl: string;
  username: string;
  direct: SetupDirectOutcome;
  directError: string | null;
  restarting: true;
};

export type PrecheckResult = {
  reachable: boolean;
  isSelf: boolean;
  status: number | null;
  error: string | null;
};

export type SetupServiceDeps = SetupEnvHost & {
  roles: TmexRoles;
  nodeEnv: string;
  auth: LocalAuthContext;
  installDir: string;
  hubUrl?: string | null;
  hubPublicUrl?: string | null;
  fetch?: import('../lib/fetch-like').FetchLike;
  precheckCaPem?: () => Promise<string | null>;
  enableDirect?: (opts: EnableDirectOptions) => Promise<DirectEnableResult>;
  disableDirect?: (opts: DisableDirectOptions) => Promise<void>;
  isDirectSupported?: () => boolean;
  readNativeManifest?: (nativeDir: string) => Promise<{ version: string } | null>;
  rtcCapable?: boolean;
  platform?: string;
  performHubJoin?: (
    input: PerformHubJoinInput,
    deps: PerformHubJoinDeps
  ) => ReturnType<typeof defaultPerformHubJoin>;
  requestEnrollmentByPassword?: typeof defaultRequestEnrollmentByPassword;
  now?: () => number;
  startedAt?: number;
  quiesceMesh?: () => Promise<void> | void;
  directTimeoutMs?: number;
  relayStatus?: () => Promise<LocalRelayStatus>;
};

function platformString(deps: SetupServiceDeps): string {
  return deps.platform ?? `${process.platform}-${process.arch}`;
}

function nativeDirOf(deps: SetupServiceDeps): string {
  return createInstallLayout(deps.installDir).nativeDir;
}

function emptyToNull(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function mapDirectEnableFailure(
  result: Extract<DirectEnableResult, { ok: false }>
): SetupError {
  if (result.unsupported || result.kind === 'unsupported') {
    return new SetupError('direct_unsupported', result.reason, 409);
  }
  if (result.kind === 'integrity' || result.kind === 'install') {
    return new SetupError('direct_failed', result.reason, 500);
  }
  return new SetupError('direct_download_failed', result.reason, 502);
}

function joinHttpStatus(code: JoinError['code']): number {
  switch (code) {
    case 'invalid_token':
    case 'invalid_url':
    case 'join_failed':
      return 400;
    case 'node_revoked':
    case 'node_exists':
      return 409;
    case 'hub_unreachable':
      return 502;
  }
}

function asSetupJoinError(error: unknown): SetupError {
  if (error instanceof SetupError) return error;
  if (error instanceof JoinError) {
    return new SetupError(error.code, error.message, joinHttpStatus(error.code));
  }
  const message = error instanceof Error ? error.message : String(error);
  return new SetupError('join_failed', message, 400);
}

async function readManifest(deps: SetupServiceDeps): Promise<{ version: string } | null> {
  const reader = deps.readNativeManifest ?? readInstalledNativeManifest;
  return reader(nativeDirOf(deps));
}

async function runEnableDirect(deps: SetupServiceDeps): Promise<DirectEnableResult> {
  const enable = deps.enableDirect ?? defaultEnableDirect;
  const signal = AbortSignal.timeout(deps.directTimeoutMs ?? DIRECT_ENABLE_TIMEOUT_MS);
  return await enable({
    installDir: deps.installDir,
    fetchImpl: deps.fetch,
    signal,
  });
}

export async function maybeEnableDirect(
  directEnable: boolean,
  deps: SetupServiceDeps
): Promise<{ direct: SetupDirectOutcome; directError: string | null }> {
  if (!directEnable) return { direct: 'skipped', directError: null };
  try {
    const result = await runEnableDirect(deps);
    if (result.ok) return { direct: 'enabled', directError: null };
    const mapped = mapDirectEnableFailure(result);
    return { direct: 'failed', directError: mapped.message };
  } catch (error) {
    if (error instanceof SetupError) {
      return { direct: 'failed', directError: error.message };
    }
    return {
      direct: 'failed',
      directError: errorCause(error),
    };
  }
}

function isDirectEnabledValue(value: string | undefined): boolean {
  return value !== 'false';
}

async function readDirectEnabledFlag(deps: SetupServiceDeps): Promise<boolean> {
  const read = deps.readEnvFile ?? defaultReadEnvFile;
  try {
    const env = await read(deps.envPath);
    return isDirectEnabledValue(env[DIRECT_ENABLED_KEY]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
}

async function installDirectAddon(deps: SetupServiceDeps): Promise<void> {
  const supported = (deps.isDirectSupported ?? (() => detectCurrentNativePin() != null))();
  if (!supported) {
    throw new SetupError(
      'direct_unsupported',
      `no pinned manifest for ${platformString(deps)}`,
      409
    );
  }
  let result: DirectEnableResult;
  try {
    result = await runEnableDirect(deps);
  } catch (error) {
    if (error instanceof SetupError) throw error;
    throw new SetupError('direct_download_failed', errorCause(error), 502);
  }
  if (!result.ok) {
    throw mapDirectEnableFailure(result);
  }
}

async function removeDirectAddon(deps: SetupServiceDeps): Promise<void> {
  const disableFn = deps.disableDirect ?? defaultDisableDirect;
  try {
    await disableFn({ installDir: deps.installDir });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SetupError('direct_failed', message, 500);
  }
}

async function resolveRelayBlock(deps: SetupServiceDeps): Promise<LocalRelayStatus | null> {
  if (!deps.roles.relay) return null;
  return deps.relayStatus ? await deps.relayStatus() : EMPTY_RELAY_STATUS;
}

export async function getLocalStatus(deps: SetupServiceDeps): Promise<LocalStatus> {
  const manifest = await readManifest(deps);
  const supported = (deps.isDirectSupported ?? (() => detectCurrentNativePin() != null))();
  return {
    role: roleNameFromFlags(deps.roles),
    nodeEnv: resolveEnvName(deps.nodeEnv),
    hubUrl: emptyToNull(deps.hubUrl),
    hubPublicUrl: emptyToNull(deps.hubPublicUrl),
    direct: {
      supported,
      installed: manifest != null,
      enabled: await readDirectEnabledFlag(deps),
      capable: deps.rtcCapable === true,
      version: manifest?.version ?? null,
      platform: platformString(deps),
    },
    tls: { mode: 'none' },
    relay: await resolveRelayBlock(deps),
  };
}

export async function setLocalDirect(
  action: DirectAction,
  deps: SetupServiceDeps
): Promise<DirectSetResult> {
  switch (action) {
    case 'install':
      await installDirectAddon(deps);
      await patchOwnedEnvKeys(deps, { [DIRECT_ENABLED_KEY]: 'true' });
      break;
    case 'remove':
      await removeDirectAddon(deps);
      await patchOwnedEnvKeys(deps, { [DIRECT_ENABLED_KEY]: 'false' });
      break;
    case 'enable': {
      const manifest = await readManifest(deps);
      if (manifest == null) {
        throw new SetupError('direct_not_installed', 'direct add-on is not installed', 409);
      }
      await patchOwnedEnvKeys(deps, { [DIRECT_ENABLED_KEY]: 'true' });
      break;
    }
    case 'disable':
      await patchOwnedEnvKeys(deps, { [DIRECT_ENABLED_KEY]: 'false' });
      break;
  }
  const manifest = await readManifest(deps);
  const enabled = action === 'install' || action === 'enable';
  return {
    ok: true,
    installed: action === 'install' || action === 'enable' ? true : manifest != null,
    enabled,
    capable: deps.rtcCapable === true,
    restartRequired: true,
  };
}

export async function precheckHubUrl(url: string, deps: SetupServiceDeps): Promise<PrecheckResult> {
  assertStandalone(deps.roles);
  const parsed = assertSetupUrl(url, deps.nodeEnv);
  const fetchImpl = deps.fetch ?? fetch;
  const startedAt = deps.startedAt ?? PROCESS_STARTED_AT;
  try {
    const caPem = deps.precheckCaPem ? await deps.precheckCaPem() : null;
    const response = await fetchImpl(new URL('/healthz', parsed), {
      signal: AbortSignal.timeout(PRECHECK_TIMEOUT_MS),
      redirect: 'error',
      ...(caPem ? { tls: { ca: [caPem] } } : {}),
    } as RequestInit);
    const status = response.status;
    let body: { status?: unknown; startedAt?: unknown } = {};
    try {
      body = (await response.json()) as { status?: unknown; startedAt?: unknown };
    } catch {
      return {
        reachable: false,
        isSelf: false,
        status,
        error: 'healthz response was not JSON',
      };
    }
    const reachable = status === 200 && body.status === 'ok';
    const isSelf = reachable && body.startedAt === startedAt;
    return {
      reachable,
      isSelf,
      status,
      error: reachable ? null : `healthz status ${status}`,
    };
  } catch (error) {
    return {
      reachable: false,
      isSelf: false,
      status: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function becomeHub(
  input: BecomeHubInput,
  deps: SetupServiceDeps
): Promise<BecomeHubResult> {
  assertStandalone(deps.roles);
  const hubPublicUrl = assertSetupUrl(input.hubPublicUrl, deps.nodeEnv)
    .toString()
    .replace(/\/+$/, '');
  const username = assertUsername(input.username);
  const password = assertPassword(input.password);
  return await withSetupTransition(deps, async () => {
    if (deps.auth.userStore.getByUsername(username)) {
      throw new SetupError('user_exists', `user already exists: ${username}`, 409);
    }
    const identity = await ensureNodeIdentity(deps.auth.identityStore);
    let boot: Awaited<ReturnType<typeof deps.auth.userKeys.bootstrapUserWithSelfAdmit>>;
    try {
      boot = await deps.auth.userKeys.bootstrapUserWithSelfAdmit({
        username,
        password,
        identity,
        now: deps.now?.() ?? Date.now(),
      });
    } catch (error) {
      if (isUniqueConstraintFailure(error)) {
        throw new SetupError('user_exists', `user already exists: ${username}`, 409);
      }
      throw error;
    }
    const direct = await maybeEnableDirect(input.directEnable, deps);
    await patchOwnedEnvKeys(deps, {
      TMEX_ROLES: 'hub,node',
      TMEX_HUB_PUBLIC_URL: hubPublicUrl,
      ...(direct.direct === 'enabled' ? { [DIRECT_ENABLED_KEY]: 'true' } : {}),
    });
    return {
      ok: true as const,
      fingerprint: fingerprintPublicKey(boot.rootPublicKey),
      direct: direct.direct,
      directError: direct.directError,
      restarting: true as const,
    };
  });
}

export async function joinHub(input: JoinHubInput, deps: SetupServiceDeps): Promise<JoinHubResult> {
  assertStandalone(deps.roles);
  const { method, token: tokenValue, password: passwordValue } = parseJoinHubCredentials(input);
  if (typeof input.name !== 'string' || input.name.trim().length === 0) {
    throw new SetupError('join_failed', 'node name is required', 400);
  }
  let hubUrl: string;
  try {
    hubUrl = canonicalHubUrl(assertSetupUrl(input.hubUrl, deps.nodeEnv).toString());
  } catch (error) {
    if (error instanceof SetupError) throw error;
    throw new SetupError('invalid_url', errorCause(error), 400);
  }
  return await withSetupTransition(deps, async () => {
    let envTarget: string;
    try {
      envTarget = await resolveEnvWriteTarget(deps.envPath);
    } catch (error) {
      throw wrapJoinEnvWriteError(error);
    }
    const stagedPath = newStagedEnvPath(envTarget);
    const writeJoinEnv = async (url: string, base: Record<string, string>) => {
      await writeStagedEnv(
        deps,
        stagedPath,
        stringifyEnv({
          ...base,
          TMEX_ROLES: 'node',
          TMEX_HUB_URL: url,
          TMEX_HUB_PUBLIC_URL: '',
        })
      );
    };
    try {
      await withEnvLock(async () => {
        const existing = await readExistingEnv(deps);
        await writeJoinEnv(hubUrl, existing);
      });
    } catch (error) {
      await removeStagedEnv(deps, stagedPath);
      throw wrapJoinEnvWriteError(error);
    }

    const perform = deps.performHubJoin ?? defaultPerformHubJoin;
    let token = tokenValue;
    let joined: Awaited<ReturnType<typeof defaultPerformHubJoin>>;
    try {
      if (method === 'password') {
        const request = deps.requestEnrollmentByPassword ?? defaultRequestEnrollmentByPassword;
        token = (
          await request({
            hubUrl: input.hubUrl,
            password: passwordValue,
            fetcher: deps.fetch,
            insecureLocal: input.insecureLocal,
            nodeEnv: deps.nodeEnv,
            now: deps.now,
          })
        ).token;
      }
      joined = await perform(
        {
          hubUrl: input.hubUrl,
          token,
          name: input.name.trim(),
          insecureLocal: input.insecureLocal,
          nodeEnv: deps.nodeEnv,
        },
        {
          auth: deps.auth,
          now: deps.now,
          fetcher: deps.fetch,
        }
      );
    } catch (error) {
      await removeStagedEnv(deps, stagedPath);
      throw asSetupJoinError(error);
    }

    try {
      await withEnvLock(async () => {
        const latest = await readExistingEnv(deps);
        await writeJoinEnv(joined.hubUrl, latest);
        await promoteStagedEnv(deps, stagedPath, envTarget);
      });
    } catch (error) {
      await removeStagedEnv(deps, stagedPath);
      throw wrapJoinEnvWriteError(error, joined.hubUrl);
    }

    const direct = await maybeEnableDirect(input.directEnable, deps);
    if (direct.direct === 'enabled') {
      await patchOwnedEnvKeys(deps, { [DIRECT_ENABLED_KEY]: 'true' });
    }
    return {
      ok: true as const,
      hubUrl: joined.hubUrl,
      username: joined.username,
      direct: direct.direct,
      directError: direct.directError,
      restarting: true as const,
    };
  });
}
