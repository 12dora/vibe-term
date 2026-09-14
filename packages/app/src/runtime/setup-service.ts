import { PROCESS_STARTED_AT } from '../../../../apps/gateway/src/api/system-routes';
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
import { readEnvFile as defaultReadEnvFile } from '../lib/env-file';
import { errorMessage } from '../lib/error-message';
import type { FetchInit, FetchLike } from '../lib/fetch-like';
import { createInstallLayout } from '../lib/install-layout';
import type { LocalAuthContext } from '../lib/local-auth';
import { readInstalledNativeManifest } from '../lib/native-datachannel';
import { detectCurrentNativePin } from '../lib/native-manifest';
import { type VibeTermRoleName, type VibeTermRoles, roleNameFromFlags } from '../lib/roles';
import {
  type SetupEnvHost,
  SetupError,
  assertSetupUrl,
  assertStandalone,
  errorCause,
  patchOwnedEnvKeys,
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

/** 端口探测与确认用哪套健康判据：中继打 `/api/relay/health`。 */
export type PrecheckKind = 'relay';

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
  fetch?: import('../lib/fetch-like').FetchLike;
  precheckCaPem?: () => Promise<string | null>;
  enableDirect?: (opts: EnableDirectOptions) => Promise<DirectEnableResult>;
  disableDirect?: (opts: DisableDirectOptions) => Promise<void>;
  isDirectSupported?: () => boolean;
  readNativeManifest?: (nativeDir: string) => Promise<{ version: string } | null>;
  rtcCapable?: boolean;
  platform?: string;
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

/** 判据与探测同源：中继看 `/api/relay/health.ok`。 */
function healthOutcome(
  kind: PrecheckKind,
  status: number,
  body: { status?: unknown; ok?: unknown; startedAt?: unknown },
  _startedAt: number
): HealthzOutcome {
  const reachable = status === 200 && body.ok === true;
  return {
    reachable,
    isSelf: false,
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

export async function precheckRelayUrl(
  url: string,
  deps: SetupServiceDeps,
  kind: PrecheckKind = 'relay'
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
