import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Device } from '@tmex/shared';
import type { AgentAuthMethod, ConnectConfig, PublicKeyAuthMethod } from 'ssh2';

import type { decryptWithContext } from '../crypto';
import { resolveSshAgentSocket, resolveSshUsername } from '../tmux/ssh-auth';

type SshAuthEnv = Partial<Record<'SSH_AUTH_SOCK' | 'USER' | 'LOGNAME', string | undefined>>;

interface RunSyncResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface ResolvedSshConfigRef {
  host: string;
  port?: number;
  username?: string;
  identityAgent?: string;
  identityFiles: string[];
}

export interface ResolveSshConnectConfigDeps {
  env: NodeJS.ProcessEnv;
  runSync: (cmd: string[]) => RunSyncResult;
  fileExists: (path: string) => boolean;
  readTextFile: (path: string) => string;
}

export interface SshConnectTarget {
  host: string;
  port: number;
  username: string;
  resolvedConfig: ResolvedSshConfigRef | null;
  configAgent: string | undefined;
  envAgent: string | undefined;
  configPrivateKey: string | undefined;
  implicitAgentFallbackPrivateKeys: string[];
  sshEnv: SshAuthEnv;
  deps: ResolveSshConnectConfigDeps;
}

type DecryptFn = typeof decryptWithContext;

function defaultRunSync(cmd: string[]): RunSyncResult {
  const result = Bun.spawnSync(cmd, {
    env: process.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  return {
    exitCode: result.exitCode,
    stdout: Buffer.from(result.stdout).toString('utf8'),
    stderr: Buffer.from(result.stderr).toString('utf8'),
  };
}

function expandHomePath(value: string, env: NodeJS.ProcessEnv): string {
  const trimmed = value.trim();
  if (trimmed === '~') {
    return env.HOME?.trim() || trimmed;
  }
  if (trimmed.startsWith('~/') && env.HOME?.trim()) {
    return join(env.HOME.trim(), trimmed.slice(2));
  }
  return trimmed;
}

function parseSshConfigOutput(stdout: string, env: NodeJS.ProcessEnv): ResolvedSshConfigRef {
  let host = '';
  let port: number | undefined;
  let username: string | undefined;
  let identityAgent: string | undefined;
  const identityFiles: string[] = [];

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const firstSpace = line.indexOf(' ');
    if (firstSpace <= 0) {
      continue;
    }

    const key = line.slice(0, firstSpace).trim().toLowerCase();
    const value = line.slice(firstSpace + 1).trim();
    if (!value) {
      continue;
    }

    switch (key) {
      case 'hostname':
        host = value;
        break;
      case 'port': {
        const parsedPort = Number.parseInt(value, 10);
        port = Number.isNaN(parsedPort) ? undefined : parsedPort;
        break;
      }
      case 'user':
        username = value;
        break;
      case 'identityagent':
        identityAgent = value;
        break;
      case 'identityfile':
        identityFiles.push(expandHomePath(value, env));
        break;
    }
  }

  if (!host) {
    throw new Error('ssh_config_ref_invalid: SSH Config 引用未解析到 hostname');
  }

  return {
    host,
    port,
    username,
    identityAgent,
    identityFiles,
  };
}

function toSshAuthEnv(env: NodeJS.ProcessEnv): SshAuthEnv {
  return {
    SSH_AUTH_SOCK: env.SSH_AUTH_SOCK,
    USER: env.USER,
    LOGNAME: env.LOGNAME,
  };
}

function resolveAgentFromConfig(
  identityAgent: string | undefined,
  deps: ResolveSshConnectConfigDeps
): string | undefined {
  const trimmed = identityAgent?.trim();
  if (!trimmed || trimmed.toLowerCase() === 'none') {
    return undefined;
  }
  if (trimmed === 'SSH_AUTH_SOCK' || trimmed === '$SSH_AUTH_SOCK') {
    return resolveSshAgentSocket('auto', toSshAuthEnv(deps.env));
  }

  const expanded = expandHomePath(trimmed, deps.env);
  return deps.fileExists(expanded) ? expanded : undefined;
}

function resolvePrivateKeyFromConfig(
  identityFiles: readonly string[],
  deps: ResolveSshConnectConfigDeps
): string | undefined {
  for (const identityFile of identityFiles) {
    if (!deps.fileExists(identityFile)) {
      continue;
    }
    return deps.readTextFile(identityFile);
  }

  return undefined;
}

function resolvePrivateKeysFromConfig(
  identityFiles: readonly string[],
  deps: ResolveSshConnectConfigDeps
): string[] {
  const privateKeys: string[] = [];

  for (const identityFile of identityFiles) {
    if (!deps.fileExists(identityFile)) {
      continue;
    }
    privateKeys.push(deps.readTextFile(identityFile));
  }

  return privateKeys;
}

function resolveSshConfigRef(
  device: Device,
  deps: ResolveSshConnectConfigDeps
): ResolvedSshConfigRef | null {
  const ref = device.sshConfigRef?.trim();
  if (!ref) {
    return null;
  }

  const result = deps.runSync(['ssh', '-G', ref]);
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || ref;
    throw new Error(`ssh_config_ref_resolve_failed: ${detail}`);
  }

  return parseSshConfigOutput(result.stdout, deps.env);
}

function resolveImplicitIdentityFilesForAgentAuth(
  device: Device,
  host: string,
  port: number,
  username: string,
  deps: ResolveSshConnectConfigDeps
): string[] {
  if (device.authMode !== 'agent') {
    return [];
  }

  const target = username ? `${username}@${host}` : host;

  try {
    const result = deps.runSync(['ssh', '-G', '-p', String(port), target]);
    if (result.exitCode !== 0) {
      return [];
    }

    return parseSshConfigOutput(result.stdout, deps.env).identityFiles;
  } catch {
    return [];
  }
}

export function createSshConnectDeps(
  inputDeps: Partial<ResolveSshConnectConfigDeps> = {}
): ResolveSshConnectConfigDeps {
  return {
    env: inputDeps.env ?? process.env,
    runSync: inputDeps.runSync ?? defaultRunSync,
    fileExists: inputDeps.fileExists ?? existsSync,
    readTextFile: inputDeps.readTextFile ?? ((path) => readFileSync(path, 'utf8')),
  };
}

export function resolveSshTarget(
  device: Device,
  deps: ResolveSshConnectConfigDeps
): SshConnectTarget {
  const sshEnv = toSshAuthEnv(deps.env);
  const resolvedConfig = device.authMode === 'configRef' ? resolveSshConfigRef(device, deps) : null;
  const host = resolvedConfig?.host ?? device.host;
  const port = resolvedConfig?.port ?? device.port ?? 22;
  const username =
    resolvedConfig?.username ?? resolveSshUsername(device.username, device.authMode, sshEnv);

  if (!host) {
    throw new Error('SSH device missing host');
  }

  return {
    host,
    port,
    username,
    resolvedConfig,
    configAgent: resolveAgentFromConfig(resolvedConfig?.identityAgent, deps),
    envAgent: resolveSshAgentSocket('auto', sshEnv),
    configPrivateKey: resolvePrivateKeyFromConfig(resolvedConfig?.identityFiles ?? [], deps),
    implicitAgentFallbackPrivateKeys: resolvePrivateKeysFromConfig(
      resolveImplicitIdentityFilesForAgentAuth(device, host, port, username, deps),
      deps
    ),
    sshEnv,
    deps,
  };
}

export async function resolvePasswordAuth(
  device: Device,
  decrypt: DecryptFn
): Promise<Pick<ConnectConfig, 'password'>> {
  if (!device.passwordEnc) {
    throw new Error('auth_password_missing: 密码认证未提供密码');
  }
  return {
    password: await decrypt(device.passwordEnc, {
      scope: 'device',
      entityId: device.id,
      field: 'password_enc',
    }),
  };
}

export async function resolveKeyAuth(
  device: Device,
  decrypt: DecryptFn
): Promise<Pick<ConnectConfig, 'privateKey' | 'passphrase'>> {
  if (!device.privateKeyEnc) {
    throw new Error('auth_key_missing: 私钥认证未提供私钥');
  }
  const fragment: Pick<ConnectConfig, 'privateKey' | 'passphrase'> = {
    privateKey: await decrypt(device.privateKeyEnc, {
      scope: 'device',
      entityId: device.id,
      field: 'private_key_enc',
    }),
  };
  if (device.privateKeyPassphraseEnc) {
    fragment.passphrase = await decrypt(device.privateKeyPassphraseEnc, {
      scope: 'device',
      entityId: device.id,
      field: 'private_key_passphrase_enc',
    });
  }
  return fragment;
}

export function resolveAgentAuth(
  target: SshConnectTarget
): Pick<ConnectConfig, 'agent' | 'authHandler'> {
  const agent = target.configAgent ?? resolveSshAgentSocket('agent', target.sshEnv);
  const fragment: Pick<ConnectConfig, 'agent' | 'authHandler'> = { agent };
  if (target.implicitAgentFallbackPrivateKeys.length > 0) {
    const publicKeyFallbacks = target.implicitAgentFallbackPrivateKeys.map<PublicKeyAuthMethod>(
      (key) => ({
        type: 'publickey',
        username: target.username,
        key,
      })
    );
    const authHandler: [AgentAuthMethod, ...PublicKeyAuthMethod[]] = [
      {
        type: 'agent',
        username: target.username,
        agent,
      },
      ...publicKeyFallbacks,
    ];
    fragment.authHandler = authHandler;
  }
  return fragment;
}

export function resolveConfigRefAuth(
  target: SshConnectTarget
): Pick<ConnectConfig, 'agent' | 'privateKey'> {
  if (!target.resolvedConfig) {
    throw new Error('ssh_config_ref_missing: SSH Config 引用不能为空');
  }
  const fragment: Pick<ConnectConfig, 'agent' | 'privateKey'> = {};
  if (target.configAgent ?? target.envAgent) {
    fragment.agent = target.configAgent ?? target.envAgent;
  }
  if (target.configPrivateKey) {
    fragment.privateKey = target.configPrivateKey;
  }
  if (!fragment.agent && !fragment.privateKey) {
    throw new Error(
      'ssh_config_ref_auth_missing: SSH Config 引用未解析到可用认证方式（IdentityAgent / IdentityFile / SSH_AUTH_SOCK）'
    );
  }
  return fragment;
}

export async function resolveAutoAuth(
  device: Device,
  target: SshConnectTarget,
  decrypt: DecryptFn
): Promise<Pick<ConnectConfig, 'agent' | 'privateKey' | 'password'>> {
  const fragment: Pick<ConnectConfig, 'agent' | 'privateKey' | 'password'> = {};
  if (target.configAgent ?? target.envAgent) {
    fragment.agent = target.configAgent ?? target.envAgent;
  }
  if (device.privateKeyEnc) {
    fragment.privateKey = await decrypt(device.privateKeyEnc, {
      scope: 'device',
      entityId: device.id,
      field: 'private_key_enc',
    });
  } else if (target.configPrivateKey) {
    fragment.privateKey = target.configPrivateKey;
  } else if (device.passwordEnc) {
    fragment.password = await decrypt(device.passwordEnc, {
      scope: 'device',
      entityId: device.id,
      field: 'password_enc',
    });
  }
  if (!fragment.agent && !fragment.privateKey && !fragment.password) {
    throw new Error(
      'auth_auto_missing: auto 模式下未找到可用认证方式（SSH_AUTH_SOCK / 私钥 / 密码）'
    );
  }
  return fragment;
}
