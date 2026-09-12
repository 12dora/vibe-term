import { PROCESS_STARTED_AT } from '../../../../apps/gateway/src/api/system-routes';
import { ensureNodeIdentity } from '../../../../apps/gateway/src/auth/node-identity-service';
import { canonicalHubUrl } from '../../../../packages/shared/src/auth';
import { type EnvName, resolveEnvName } from '../../../../packages/shared/src/env/load-env';
import {
  type PortProbeResult,
  type ProbeFetch,
  parseProbeTarget,
  probeAddressPorts,
} from '../../../../packages/shared/src/net/port-candidates';
import {
  DIRECT_ENABLE_TIMEOUT_MS,
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
import { joinErrorHttpStatus, publishPasswordJoinAdmitIfNeeded } from '../commands/hub-join-totp';
import {
  readEnvFile as defaultReadEnvFile,
  resolveEnvWriteTarget,
  stringifyEnv,
} from '../lib/env-file';
import { withEnvLock } from '../lib/env-mutation';
import { errorMessage } from '../lib/error-message';
import type { FetchInit, FetchLike } from '../lib/fetch-like';
import {
  requestEnrollmentByPassword as defaultRequestEnrollmentByPassword,
  wipeRootKey,
} from '../lib/hub-password-join';
import type { PublishHubJoinSelfAdmitInput } from '../lib/hub-password-self-admit';
import { createInstallLayout } from '../lib/install-layout';
import type { LocalAuthContext } from '../lib/local-auth';
import { readInstalledNativeManifest } from '../lib/native-datachannel';
import { detectCurrentNativePin } from '../lib/native-manifest';
import { type VibeTermRoleName, type VibeTermRoles, roleNameFromFlags } from '../lib/roles';
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
export { DIRECT_ENABLE_TIMEOUT_MS } from '../commands/direct';
export const PRECHECK_TIMEOUT_MS = 5_000;
/** 单个候选端口的探测超时；比 healthz 的确认短，八个候选交错跑完仍在几秒内。 */
export const PRECHECK_PROBE_TIMEOUT_MS = 4_000;
export const DIRECT_ENABLED_KEY = 'VIBETERM_DIRECT_ENABLED';

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

export type LocalRelayTurnStatus = {
  enabled: boolean;
  source: 'builtin' | 'external' | 'off';
  url: string | null;
  port: number | null;
  externalIp: string | null;
  listening: boolean;
  allocations: number;
  error: string | null;
  relayPortRange: string | null;
};

export type LocalRelayStatus = {
  publicUrl: string | null;
  hasPassword: boolean;
  tenantCount: number;
  nodesOnline: number;
  currentNodes: number;
  turn: LocalRelayTurnStatus;
};

const EMPTY_RELAY_TURN: LocalRelayTurnStatus = {
  enabled: false,
  source: 'off',
  url: null,
  port: null,
  externalIp: null,
  listening: false,
  allocations: 0,
  error: null,
  relayPortRange: null,
};

const EMPTY_RELAY_STATUS: LocalRelayStatus = {
  publicUrl: null,
  hasPassword: false,
  tenantCount: 0,
  nodesOnline: 0,
  currentNodes: 0,
  turn: EMPTY_RELAY_TURN,
};

export type LocalStatus = {
  role: VibeTermRoleName;
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
  directEnable?: boolean;
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
  directEnable?: boolean;
  insecureLocal?: boolean;
  totpCode?: string;
};

export type JoinHubResult = {
  ok: true;
  hubUrl: string;
  username: string;
  direct: SetupDirectOutcome;
  directError: string | null;
  restarting: true;
  admitPending?: boolean;
};

/** 端口探测与确认用哪套健康判据：Hub 打 `/healthz`，中继打 `/api/relay/health`。 */
export type PrecheckKind = 'hub' | 'relay';

export type PrecheckResult = {
  reachable: boolean;
  isSelf: boolean;
  status: number | null;
  error: string | null;
  /** 端口探测确定的地址（含端口）；未探测或一个端口都没答话为 `null`。 */
  resolvedUrl: string | null;
  /** 实际发起过探测的端口；未探测为空。 */
  triedPorts: number[];
  /** 地址没写端口时才探测候选端口。 */
  probed: boolean;
};

export type SetupServiceDeps = SetupEnvHost & {
  roles: VibeTermRoles;
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
  publishHubJoinSelfAdmit?: (
    input: PublishHubJoinSelfAdmitInput
  ) => Promise<{ appended: boolean; admitPending: boolean }>;
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

function asSetupJoinError(error: unknown): SetupError {
  if (error instanceof SetupError) return error;
  if (error instanceof JoinError) {
    return new SetupError(error.code, error.message, joinErrorHttpStatus(error.code));
  }
  const message = errorMessage(error);
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
  directEnable: boolean | undefined,
  deps: SetupServiceDeps
): Promise<{ direct: SetupDirectOutcome; directError: string | null }> {
  if (directEnable === false) return { direct: 'skipped', directError: null };
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
    const message = errorMessage(error);
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

type HealthzOutcome = Pick<PrecheckResult, 'reachable' | 'isSelf' | 'status' | 'error'>;

/** 带本机自签 CA 的 fetch：候选端口探测与 healthz 确认共用同一份 TLS 配置。 */
function precheckFetch(fetchImpl: FetchLike, caPem: string | null): ProbeFetch {
  return (input, init) =>
    fetchImpl(input, { ...init, ...(caPem ? { tls: { ca: [caPem] } } : {}) } as FetchInit);
}

const HEALTH_PROBE: Record<PrecheckKind, { path: string; label: string }> = {
  hub: { path: '/healthz', label: 'healthz' },
  relay: { path: '/api/relay/health', label: 'relay health' },
};

/** 地址没写端口且是 https 时才探候选端口；显式端口与回环 http 一律照原样确认。 */
async function precheckProbePorts(
  url: string,
  kind: PrecheckKind,
  fetchImpl: ProbeFetch
): Promise<PortProbeResult | null> {
  const target = parseProbeTarget(url);
  if (target.explicitPort !== null || target.protocol !== 'https:') return null;
  return await probeAddressPorts(url, {
    kind,
    fetchImpl,
    timeoutMs: PRECHECK_PROBE_TIMEOUT_MS,
  });
}

/** 判据与探测同源：Hub 看 `/healthz.status`，中继看 `/api/relay/health.ok`。 */
function healthOutcome(
  kind: PrecheckKind,
  status: number,
  body: { status?: unknown; ok?: unknown; startedAt?: unknown },
  startedAt: number
): HealthzOutcome {
  const reachable = status === 200 && (kind === 'relay' ? body.ok === true : body.status === 'ok');
  return {
    reachable,
    // 中继的健康接口不下发 startedAt，本机判定只对 Hub 有意义
    isSelf: reachable && kind === 'hub' && body.startedAt === startedAt,
    status,
    error: reachable ? null : `${HEALTH_PROBE[kind].label} status ${status}`,
  };
}

async function readHealth(
  base: string | URL,
  kind: PrecheckKind,
  fetchImpl: ProbeFetch,
  startedAt: number
): Promise<HealthzOutcome> {
  const probe = HEALTH_PROBE[kind];
  const response = await fetchImpl(new URL(probe.path, base).toString(), {
    signal: AbortSignal.timeout(PRECHECK_TIMEOUT_MS),
    redirect: 'error',
  });
  const status = response.status;
  let body: { status?: unknown; ok?: unknown; startedAt?: unknown };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    return {
      reachable: false,
      isSelf: false,
      status,
      error: `${probe.label} response was not JSON`,
    };
  }
  return healthOutcome(kind, status, body, startedAt);
}

export async function precheckHubUrl(
  url: string,
  deps: SetupServiceDeps,
  kind: PrecheckKind = 'hub'
): Promise<PrecheckResult> {
  assertStandalone(deps.roles);
  const parsed = assertSetupUrl(url, deps.nodeEnv);
  const startedAt = deps.startedAt ?? PROCESS_STARTED_AT;
  try {
    const caPem = deps.precheckCaPem ? await deps.precheckCaPem() : null;
    const fetchImpl = precheckFetch(deps.fetch ?? fetch, caPem);
    const probe = await precheckProbePorts(url, kind, fetchImpl);
    if (probe && !probe.url) {
      return {
        reachable: false,
        isSelf: false,
        status: null,
        error: `no response on 443 or the built-in candidate ports (${probe.triedPorts.join(', ')})`,
        resolvedUrl: null,
        triedPorts: probe.triedPorts,
        probed: true,
      };
    }
    const health = await readHealth(probe?.url ?? parsed, kind, fetchImpl, startedAt);
    return {
      ...health,
      resolvedUrl: probe?.url ?? null,
      triedPorts: probe?.triedPorts ?? [],
      probed: probe !== null,
    };
  } catch (error) {
    return {
      reachable: false,
      isSelf: false,
      status: null,
      error: errorMessage(error),
      resolvedUrl: null,
      triedPorts: [],
      probed: false,
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
      VIBETERM_ROLES: 'hub,node',
      VIBETERM_HUB_PUBLIC_URL: hubPublicUrl,
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
          VIBETERM_ROLES: 'node',
          VIBETERM_HUB_URL: url,
          VIBETERM_HUB_PUBLIC_URL: '',
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
    let passwordRootKey: PublishHubJoinSelfAdmitInput['rootKey'] | undefined;
    let joined: Awaited<ReturnType<typeof defaultPerformHubJoin>>;
    let admitPending = false;
    try {
      if (method === 'password') {
        const request = deps.requestEnrollmentByPassword ?? defaultRequestEnrollmentByPassword;
        const material = await request({
          hubUrl: input.hubUrl,
          password: passwordValue,
          fetcher: deps.fetch,
          insecureLocal: input.insecureLocal,
          nodeEnv: deps.nodeEnv,
          now: deps.now,
        });
        token = material.token;
        passwordRootKey = material.rootKey;
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
      admitPending = await publishPasswordJoinAdmitIfNeeded({
        rootKey: passwordRootKey,
        auth: deps.auth,
        hubUrl: joined.hubUrl,
        userId: joined.userId,
        fetcher: deps.fetch,
        now: deps.now,
        totpCode: input.totpCode,
        publish: deps.publishHubJoinSelfAdmit,
      });
    } catch (error) {
      await removeStagedEnv(deps, stagedPath);
      throw asSetupJoinError(error);
    } finally {
      wipeRootKey(passwordRootKey);
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
      ...(admitPending ? { admitPending: true as const } : {}),
    };
  });
}
