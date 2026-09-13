import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Device } from '@vibeterm/shared';
import type { ConnectConfig } from 'ssh2';
import { decryptWithContext } from '../crypto';
import { resolveSshConnectConfig } from '../tmux-client/ssh-connect-config';

export const SSH_BASE_OPTS = ['-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=10'];

export type OpenSshTarget = {
  dest: string;
  sshArgs: string[];
  env: Record<string, string>;
  cleanup: () => void;
  interactive: boolean;
};

export type OpenSshTargetResult =
  | { ok: true; target: OpenSshTarget }
  | { ok: false; code: 'connection_failed' | 'auth_unsupported'; message: string };

type DecryptFn = typeof decryptWithContext;
type ResolveConfigFn = typeof resolveSshConnectConfig;

export function writeTempSshKey(privateKey: string): { keyPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'vibeterm-rsync-key-'));
  const keyPath = join(dir, 'id');
  writeFileSync(keyPath, privateKey, { mode: 0o600 });
  chmodSync(keyPath, 0o600);
  return { keyPath, cleanup: () => rmQuiet(dir) };
}

export function setupSshAskpass(secret: string): {
  env: Record<string, string>;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), 'vibeterm-rsync-ap-'));
  const scriptPath = join(dir, 'askpass.sh');
  writeFileSync(scriptPath, '#!/bin/sh\nprintf \'%s\\n\' "$VIBETERM_RSYNC_SECRET"\n', {
    mode: 0o700,
  });
  chmodSync(scriptPath, 0o700);
  return {
    env: {
      SSH_ASKPASS: scriptPath,
      SSH_ASKPASS_REQUIRE: 'force',
      VIBETERM_RSYNC_SECRET: secret,
      DISPLAY: process.env.DISPLAY || ':0',
    },
    cleanup: () => rmQuiet(dir),
  };
}

export async function resolveOpenSshTarget(
  device: Device,
  decrypt: DecryptFn = decryptWithContext,
  resolveConfig: ResolveConfigFn = resolveSshConnectConfig
): Promise<OpenSshTargetResult> {
  if (device.authMode === 'configRef' && device.sshConfigRef?.trim()) {
    return configRefTarget(device.sshConfigRef.trim());
  }
  const cfg = await resolveConfig(device, decrypt);
  if (!cfg.host) {
    return { ok: false, code: 'connection_failed', message: 'SSH 设备缺少 host' };
  }
  return fromConnectConfig(cfg);
}

function rmQuiet(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // 已删
  }
}

function configRefTarget(alias: string): OpenSshTargetResult {
  return {
    ok: true,
    target: {
      dest: alias,
      sshArgs: ['ssh', ...SSH_BASE_OPTS, '-o', 'BatchMode=yes'],
      env: {},
      cleanup: () => {},
      interactive: false,
    },
  };
}

function fromConnectConfig(cfg: ConnectConfig): OpenSshTargetResult {
  const port = cfg.port ?? 22;
  const dest = cfg.username ? `${cfg.username}@${cfg.host}` : String(cfg.host);
  const sshArgs = ['ssh', '-p', String(port), ...SSH_BASE_OPTS];
  const env: Record<string, string> = {};
  const cleanups: Array<() => void> = [];
  const mode = cfg.privateKey
    ? appendKeyAuth(cfg, sshArgs, env, cleanups)
    : appendNonKeyAuth(cfg, sshArgs, env, cleanups);
  if (!mode) {
    return {
      ok: false,
      code: 'auth_unsupported',
      message: '未找到可用于 rsync 的认证方式（密钥 / ssh-agent / 密码）',
    };
  }
  if (mode === 'batch') sshArgs.push('-o', 'BatchMode=yes');
  return {
    ok: true,
    target: {
      dest,
      sshArgs,
      env,
      cleanup: () => {
        for (const c of cleanups) c();
      },
      interactive: mode === 'interactive',
    },
  };
}

function appendKeyAuth(
  cfg: ConnectConfig,
  sshArgs: string[],
  env: Record<string, string>,
  cleanups: Array<() => void>
): 'batch' | 'interactive' {
  const { keyPath, cleanup } = writeTempSshKey(String(cfg.privateKey));
  sshArgs.push('-i', keyPath, '-o', 'IdentitiesOnly=yes');
  cleanups.push(cleanup);
  if (cfg.agent) {
    env.SSH_AUTH_SOCK = String(cfg.agent);
    return 'batch';
  }
  if (cfg.passphrase) {
    const ap = setupSshAskpass(String(cfg.passphrase));
    Object.assign(env, ap.env);
    cleanups.push(ap.cleanup);
    return 'interactive';
  }
  return 'batch';
}

function appendNonKeyAuth(
  cfg: ConnectConfig,
  sshArgs: string[],
  env: Record<string, string>,
  cleanups: Array<() => void>
): 'batch' | 'interactive' | null {
  if (cfg.agent) {
    env.SSH_AUTH_SOCK = String(cfg.agent);
    return 'batch';
  }
  if (!cfg.password) return null;
  const ap = setupSshAskpass(String(cfg.password));
  Object.assign(env, ap.env);
  cleanups.push(ap.cleanup);
  sshArgs.push(
    '-o',
    'PreferredAuthentications=password,keyboard-interactive',
    '-o',
    'NumberOfPasswordPrompts=1'
  );
  return 'interactive';
}
