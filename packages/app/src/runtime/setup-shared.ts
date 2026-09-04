import { randomBytes } from 'node:crypto';
import { rename as fsRename, rm as fsRm, writeFile as fsWriteFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { resolveInstallDir as resolveGatewayInstallDir } from '../../../../apps/gateway/src/system/install-info';
import { readNodeEnv } from '../../../../packages/shared/src/env/load-env';
import {
  readEnvFile as defaultReadEnvFile,
  writeEnvFile as defaultWriteEnvFile,
  resolveEnvWriteTarget,
  stringifyEnv,
} from '../lib/env-file';
import { withEnvLock } from '../lib/env-mutation';
import { type TmexRoles, isStandaloneRoles, parseTmexRoles, roleNameFromFlags } from '../lib/roles';

export const USERNAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

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

export type SetupTransitionLock = {
  begin(): void;
  finish(committed: boolean): void;
};

export type SetupLockHost = {
  setupLock?: SetupTransitionLock;
  scheduleRestart?: () => void;
};

export type SetupEnvHost = SetupLockHost & {
  envPath: string;
  readEnvFile?: typeof defaultReadEnvFile;
  writeEnvFile?: typeof defaultWriteEnvFile;
  writeStagedEnvFile?: (path: string, content: string) => Promise<void>;
  renameEnvFile?: (from: string, to: string) => Promise<void>;
  removeStagedEnvFile?: (path: string) => Promise<void>;
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

function lockOf(deps: SetupLockHost): SetupTransitionLock {
  return deps.setupLock ?? processSetupLock;
}

export async function withSetupTransition<T>(
  deps: SetupLockHost,
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

export function errorCause(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function wrapEnvWriteError(error: unknown): SetupError {
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

export function isUniqueConstraintFailure(error: unknown): boolean {
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

export function assertStandalone(roles: TmexRoles): void {
  if (!isStandaloneRoles(roles)) {
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

export function assertUsername(username: string): string {
  if (!USERNAME_RE.test(username)) {
    throw new SetupError(
      'invalid_username',
      'username must be 1–64 characters matching [A-Za-z0-9._-]',
      400
    );
  }
  return username;
}

export function assertPassword(password: string): string {
  if (password.length < 8) {
    throw new SetupError('weak_password', 'password must be at least 8 characters', 400);
  }
  return password;
}

export async function patchOwnedEnvKeys(
  deps: SetupEnvHost,
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

export async function readExistingEnv(deps: SetupEnvHost): Promise<Record<string, string>> {
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
  deps: SetupEnvHost,
  path: string,
  content: string
): Promise<void> {
  const write = deps.writeStagedEnvFile ?? defaultWriteStagedEnvFile;
  await write(path, content);
}

export async function promoteStagedEnv(
  deps: SetupEnvHost,
  stagedPath: string,
  destPath: string
): Promise<void> {
  const renameFn = deps.renameEnvFile ?? fsRename;
  await renameFn(stagedPath, destPath);
}

export async function removeStagedEnv(
  deps: SetupEnvHost,
  stagedPath: string | null
): Promise<void> {
  if (!stagedPath) return;
  const remove = deps.removeStagedEnvFile ?? ((path: string) => fsRm(path, { force: true }));
  await remove(stagedPath).catch(() => undefined);
}

export function parseJoinHubCredentials(input: {
  token?: string;
  password?: string;
  method?: 'token' | 'password';
}): {
  method: 'token' | 'password';
  token: string;
  password: string;
} {
  const token = typeof input.token === 'string' ? input.token : '';
  const password = typeof input.password === 'string' ? input.password : '';
  if (token && password) {
    throw new SetupError('invalid_body', 'token and password are mutually exclusive', 400);
  }
  if (!token && !password) {
    throw new SetupError('invalid_body', 'token or password is required', 400);
  }
  const method: 'token' | 'password' =
    input.method === 'password'
      ? 'password'
      : input.method === 'token'
        ? 'token'
        : password && !token
          ? 'password'
          : 'token';
  if (method === 'password' && !password) {
    throw new SetupError('invalid_password', 'mesh account password is required', 400);
  }
  if (method === 'token' && !token) {
    throw new SetupError('invalid_token', 'join token is required', 400);
  }
  return { method, token, password };
}

export function newStagedEnvPath(envPath: string): string {
  return join(
    dirname(envPath),
    `${basename(envPath)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  );
}

/** 密码加入中继后的角色：本机已是 relay 则 `relay,node`，否则 `node`。 */
export function relayPasswordJoinRoleName(current: string | undefined): string {
  let roles: TmexRoles;
  try {
    roles = parseTmexRoles(current);
  } catch {
    roles = { hub: false, node: false, relay: false };
  }
  return roleNameFromFlags({ hub: false, node: true, relay: roles.relay });
}

export function applyRelayPasswordJoinEnv(
  existing: Record<string, string>
): Record<string, string> {
  return {
    ...existing,
    TMEX_ROLES: relayPasswordJoinRoleName(existing.TMEX_ROLES),
    TMEX_HUB_URL: '',
    TMEX_HUB_PUBLIC_URL: '',
  };
}

export async function commitRelayPasswordJoinEnv(deps: SetupEnvHost): Promise<void> {
  let envTarget: string;
  try {
    envTarget = await resolveEnvWriteTarget(deps.envPath);
  } catch (error) {
    throw wrapJoinEnvWriteError(error);
  }
  const stagedPath = newStagedEnvPath(envTarget);
  try {
    await withEnvLock(async () => {
      const existing = await readExistingEnv(deps);
      await writeStagedEnv(deps, stagedPath, stringifyEnv(applyRelayPasswordJoinEnv(existing)));
      await promoteStagedEnv(deps, stagedPath, envTarget);
    });
  } catch (error) {
    await removeStagedEnv(deps, stagedPath);
    throw wrapJoinEnvWriteError(error);
  }
}
