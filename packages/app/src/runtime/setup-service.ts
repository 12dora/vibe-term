import { randomBytes } from 'node:crypto';
import { rename as fsRename, rm as fsRm, writeFile as fsWriteFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { PROCESS_STARTED_AT } from '../../../../apps/gateway/src/api/system-routes';
import { ensureNodeIdentity } from '../../../../apps/gateway/src/auth/node-identity-service';
import { resolveInstallDir as resolveGatewayInstallDir } from '../../../../apps/gateway/src/system/install-info';
import { canonicalHubUrl } from '../../../../packages/shared/src/auth';
import {
  type EnvName,
  readNodeEnv,
  resolveEnvName,
} from '../../../../packages/shared/src/env/load-env';
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
  writeEnvFile as defaultWriteEnvFile,
  resolveEnvWriteTarget,
  stringifyEnv,
} from '../lib/env-file';
import { withEnvLock } from '../lib/env-mutation';
import { createInstallLayout } from '../lib/install-layout';
import type { LocalAuthContext } from '../lib/local-auth';
import { readInstalledNativeManifest } from '../lib/native-datachannel';
import { detectCurrentNativePin } from '../lib/native-manifest';
import { type TmexRoleName, type TmexRoles, roleNameFromFlags } from '../lib/roles';
import { fingerprintPublicKey } from '../lib/totp-uri';

export const SETUP_RESTART_DELAY_MS = 300;
export const DIRECT_ENABLE_TIMEOUT_MS = 60_000;
export const PRECHECK_TIMEOUT_MS = 5_000;

const USERNAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

export class SetupError extends Error {
  readonly code: string;
  readonly httpStatus: number;

  constructor(code: string, message: string, httpStatus: number) {
    super(message);
    this.name = 'SetupError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export type DirectStatus = {
  supported: boolean;
  installed: boolean;
  enabled: boolean;
  capable: boolean;
  version: string | null;
  platform: string;
};

export type LocalStatus = {
  role: TmexRoleName;
  nodeEnv: EnvName;
  hubUrl: string | null;
  hubPublicUrl: string | null;
  direct: DirectStatus;
  tls: { mode: 'none' };
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
  token: string;
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

export type SetupServiceDeps = {
  roles: TmexRoles;
  nodeEnv: string;
  auth: LocalAuthContext;
  envPath: string;
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
  readEnvFile?: typeof defaultReadEnvFile;
  writeEnvFile?: typeof defaultWriteEnvFile;
  writeStagedEnvFile?: (path: string, content: string) => Promise<void>;
  renameEnvFile?: (from: string, to: string) => Promise<void>;
  removeStagedEnvFile?: (path: string) => Promise<void>;
  now?: () => number;
  startedAt?: number;
  scheduleRestart?: () => void;
  quiesceMesh?: () => Promise<void> | void;
  directTimeoutMs?: number;
  setupLock?: SetupTransitionLock;
};

export type SetupTransitionLock = {
  begin(): void;
  finish(committed: boolean): void;
};

export function createSetupTransitionLock(): SetupTransitionLock {
  let inFlight = false;
  let committed = false;
  return {
    begin() {
      if (committed) {
        throw new SetupError('setup_committed', 'setup already committed; restart is pending', 409);
      }
      if (inFlight) {
        throw new SetupError('setup_in_progress', 'another setup transition is in progress', 409);
      }
      inFlight = true;
    },
    finish(didCommit: boolean) {
      if (didCommit) committed = true;
      inFlight = false;
    },
  };
}

let processSetupLock = createSetupTransitionLock();

export function resetProcessSetupLockForTests(): void {
  processSetupLock = createSetupTransitionLock();
}

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

function assertStandalone(deps: SetupServiceDeps): void {
  if (deps.roles.hub || deps.roles.node) {
    throw new SetupError('not_standalone', 'setup is only available in standalone mode', 409);
  }
}

export function assertSetupUrl(raw: string, nodeEnv: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SetupError('invalid_url', `invalid url: ${raw}`, 400);
  }
  if (url.protocol === 'https:') return url;
  const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  if (url.protocol === 'http:' && local && nodeEnv !== 'production') return url;
  throw new SetupError(
    'invalid_url',
    'url must be https: (http://127.0.0.1 or http://localhost allowed when not production)',
    400
  );
}

function assertUsername(username: string): string {
  if (!USERNAME_RE.test(username)) {
    throw new SetupError(
      'invalid_username',
      'username must be 1–64 characters matching [A-Za-z0-9._-]',
      400
    );
  }
  return username;
}

function assertPassword(password: string): string {
  if (password.length < 8) {
    throw new SetupError('weak_password', 'password must be at least 8 characters', 400);
  }
  return password;
}

function errorCause(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function wrapEnvWriteError(error: unknown): SetupError {
  return new SetupError(
    'env_write_failed',
    `failed to write environment (${errorCause(error)}); user record may already exist`,
    500
  );
}

export function wrapJoinEnvWriteError(error: unknown, joinedHubUrl?: string): SetupError {
  if (joinedHubUrl) {
    return new SetupError(
      'env_write_failed',
      `node has joined locally; only the env keys TMEX_ROLES=node, TMEX_HUB_URL=${joinedHubUrl} need to be written manually`,
      500
    );
  }
  return new SetupError(
    'env_write_failed',
    `failed to write environment (${errorCause(error)})`,
    500
  );
}

function isUniqueConstraintFailure(error: unknown): boolean {
  const code = (error as { code?: string | number } | null)?.code;
  if (
    code === 'SQLITE_CONSTRAINT_UNIQUE' ||
    code === 'SQLITE_CONSTRAINT' ||
    code === 19 ||
    code === 2067
  ) {
    return true;
  }
  return /UNIQUE constraint failed/i.test(errorCause(error));
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

function lockOf(deps: SetupServiceDeps): SetupTransitionLock {
  return deps.setupLock ?? processSetupLock;
}

export async function withSetupTransition<T>(
  deps: SetupServiceDeps,
  fn: () => Promise<T>
): Promise<T> {
  const lock = lockOf(deps);
  lock.begin();
  let committed = false;
  try {
    const result = await fn();
    deps.scheduleRestart?.();
    committed = true;
    return result;
  } finally {
    lock.finish(committed);
  }
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

async function maybeEnableDirect(
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

export async function patchOwnedEnvKeys(
  deps: SetupServiceDeps,
  patch: Record<string, string>
): Promise<void> {
  await withEnvLock(async () => {
    const read = deps.readEnvFile ?? defaultReadEnvFile;
    const write = deps.writeEnvFile ?? defaultWriteEnvFile;
    let existing: Record<string, string> = {};
    try {
      existing = await read(deps.envPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw wrapEnvWriteError(error);
      }
    }
    try {
      await write(deps.envPath, { ...existing, ...patch });
    } catch (error) {
      throw wrapEnvWriteError(error);
    }
  });
}

export function resolveRepoRoot(): string {
  // Same hop count as packages/shared/src/env/load-env.ts defaultRepoRoot().
  return resolve(import.meta.dir, '../../../..');
}

export function resolveSetupEnvPath(nodeEnv: string = readNodeEnv()): string {
  if (nodeEnv === 'production') {
    return join(resolveGatewayInstallDir(), 'app.env');
  }
  const name = nodeEnv === 'test' ? 'test' : 'development';
  return join(resolveRepoRoot(), `${name}.env.local`);
}

const DIRECT_ENABLED_KEY = 'TMEX_DIRECT_ENABLED';

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
  assertStandalone(deps);
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

export async function readExistingEnv(deps: SetupServiceDeps): Promise<Record<string, string>> {
  const read = deps.readEnvFile ?? defaultReadEnvFile;
  try {
    return await read(deps.envPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw wrapEnvWriteError(error);
    }
    return {};
  }
}

async function defaultWriteStagedEnvFile(path: string, content: string): Promise<void> {
  await fsWriteFile(path, content, { encoding: 'utf8', mode: 0o600 });
}

export async function writeStagedEnv(
  deps: SetupServiceDeps,
  path: string,
  content: string
): Promise<void> {
  const write = deps.writeStagedEnvFile ?? defaultWriteStagedEnvFile;
  await write(path, content);
}

export async function promoteStagedEnv(
  deps: SetupServiceDeps,
  stagedPath: string,
  destPath: string
): Promise<void> {
  const renameFn = deps.renameEnvFile ?? fsRename;
  await renameFn(stagedPath, destPath);
}

export async function removeStagedEnv(
  deps: SetupServiceDeps,
  stagedPath: string | null
): Promise<void> {
  if (!stagedPath) return;
  const remove = deps.removeStagedEnvFile ?? ((path: string) => fsRm(path, { force: true }));
  await remove(stagedPath).catch(() => undefined);
}

export function newStagedEnvPath(envPath: string): string {
  return join(
    dirname(envPath),
    `${basename(envPath)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  );
}

export async function becomeHub(
  input: BecomeHubInput,
  deps: SetupServiceDeps
): Promise<BecomeHubResult> {
  assertStandalone(deps);
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
  assertStandalone(deps);
  if (typeof input.token !== 'string' || input.token.length === 0) {
    throw new SetupError('invalid_token', 'join token is required', 400);
  }
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
    let joined: Awaited<ReturnType<typeof defaultPerformHubJoin>>;
    try {
      joined = await perform(
        {
          hubUrl: input.hubUrl,
          token: input.token,
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
