import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { formatHttpEndpoint, rewriteWildcardBindHost } from '../../../shared/src/network';
import { t } from '../i18n';
import { checkBunVersion } from '../lib/bun';
import { findLegacyMarkedShims } from '../lib/cli-shim';
import { getInstallHintAsync } from '../lib/dep-install';
import { readEnvFile } from '../lib/env-file';
import { pathExists } from '../lib/fs-utils';
import { isSupportedPlatform } from '../lib/platform';
import { runCommand } from '../lib/process';
import { findLegacyLaunchdPlists } from '../lib/service';
import { getServiceStatus } from '../lib/service';
import { checkTmuxVersion } from '../lib/tmux';
import { LEGACY_SERVICE_NAME } from '../lib/upgrade-migrate-dir';
import type { DoctorCheck } from '../types';

export interface DoctorEnvironmentResult {
  platformChecks: DoctorCheck[];
  installChecks: DoctorCheck[];
  healthHost: string;
  healthPort: string;
  /** app.env 里的对外地址；未配置时为 null。 */
  baseUrl: string | null;
}

export async function checkDependencies(input: {
  explicitBunPath?: string;
  metaBunPath?: string;
}): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];

  const bun = await checkBunVersion(undefined, {
    explicitPath: input.explicitBunPath,
    metaBunPath: input.metaBunPath,
  });
  if (bun.ok) {
    checks.push({
      id: 'bun',
      level: 'pass',
      message: t('doctor.bun.ok', { version: bun.version }),
      detail: bun.path,
    });
  } else {
    checks.push({
      id: 'bun',
      level: 'fail',
      message: t('doctor.bun.fail', { reason: bun.reason || t('bun.checkFailed') }),
      detail: bun.path,
      hint: await getInstallHintAsync('bun'),
      fixable: true,
    });
  }

  const tmux = await checkTmuxVersion();
  if (tmux.ok) {
    checks.push({
      id: 'tmux',
      level: 'pass',
      message: t('doctor.tmux.ok', { version: tmux.versionRaw || 'unknown' }),
      detail: tmux.versionRaw,
    });
  } else if (tmux.reason === 'version-too-low') {
    checks.push({
      id: 'tmux',
      level: 'fail',
      message: t('doctor.tmux.versionLow', { version: tmux.versionRaw || '' }),
      hint: await getInstallHintAsync('tmux'),
      fixable: true,
    });
  } else {
    checks.push({
      id: 'tmux',
      level: 'fail',
      message: t('doctor.tmux.fail'),
      hint: await getInstallHintAsync('tmux'),
      fixable: true,
    });
  }

  const ssh = await runCommand('ssh', ['-V'], { stdio: 'pipe' }).catch(() => null);
  if (ssh?.code === 0) {
    checks.push({
      id: 'ssh',
      level: 'pass',
      message: t('doctor.ssh.ok'),
      detail: (ssh.stderr || ssh.stdout).trim(),
    });
  } else {
    checks.push({ id: 'ssh', level: 'warn', message: t('doctor.ssh.missing') });
  }

  return checks;
}

export async function checkEnvironment(input: {
  installDir: string;
  envPath: string;
}): Promise<DoctorEnvironmentResult> {
  const platformChecks: DoctorCheck[] = [];
  if (!isSupportedPlatform()) {
    platformChecks.push({
      id: 'platform',
      level: 'warn',
      message: t('doctor.platform.unsupported', { platform: process.platform }),
    });
  } else {
    platformChecks.push({
      id: 'platform',
      level: 'pass',
      message: t('doctor.platform.supported', { platform: process.platform }),
    });
  }

  const installChecks: DoctorCheck[] = [];
  let healthHost = '127.0.0.1';
  let healthPort = '9883';
  let baseUrl: string | null = null;

  if (await pathExists(input.installDir)) {
    installChecks.push({
      id: 'install-dir',
      level: 'pass',
      message: t('doctor.installDir.exists', { installDir: input.installDir }),
    });
  } else {
    installChecks.push({
      id: 'install-dir',
      level: 'warn',
      message: t('doctor.installDir.missing', { installDir: input.installDir }),
    });
  }

  if (await pathExists(input.envPath)) {
    installChecks.push({
      id: 'env',
      level: 'pass',
      message: t('doctor.env.exists', { envPath: input.envPath }),
    });

    const env = await readEnvFile(input.envPath);
    const required = ['VIBETERM_MASTER_KEY', 'DATABASE_URL', 'GATEWAY_PORT', 'VIBETERM_BIND_HOST'];
    for (const key of required) {
      if (!env[key]) {
        installChecks.push({
          id: `env.${key}`,
          level: 'fail',
          message: t('doctor.env.keyMissing', { key }),
        });
      }
    }

    const dbPath = env.DATABASE_URL;
    if (dbPath) {
      const resolved = resolve(dbPath);
      const exists = await pathExists(resolved);
      if (!exists) {
        installChecks.push({
          id: 'db',
          level: 'warn',
          message: t('doctor.db.missing', { path: resolved }),
        });
      } else {
        const st = await stat(resolved);
        installChecks.push({
          id: 'db',
          level: 'pass',
          message: t('doctor.db.exists', { path: resolved }),
          detail: `${st.size} bytes`,
        });
      }
    }

    const port = env.GATEWAY_PORT;
    if (port) {
      healthPort = port;
      const portNum = Number(port);
      if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
        installChecks.push({
          id: 'port',
          level: 'fail',
          message: t('doctor.port.invalid', { value: port }),
        });
      }
    }
    if (env.VIBETERM_BIND_HOST) {
      healthHost = env.VIBETERM_BIND_HOST;
    }
    baseUrl = env.VIBETERM_BASE_URL || null;
  } else {
    installChecks.push({
      id: 'env',
      level: 'warn',
      message: t('doctor.env.missing', { envPath: input.envPath }),
    });
  }

  return { platformChecks, installChecks, healthHost, healthPort, baseUrl };
}

/** 对外地址是不是一个真正的域名：本机名与 IP 字面量都不算（那上面注册不了通行密钥）。 */
export function isDomainOrigin(origin: string): boolean {
  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    return false;
  }
  if (!host || host === 'localhost' || host.endsWith('.localhost')) return false;
  if (host.includes(':') || /^[0-9.]+$/.test(host)) return false;
  return host.includes('.');
}

/**
 * 通行密钥二次验证按 origin 生效：名下有钥匙、但对外那个域名上一把都没有时，那个地址的登录
 * 只剩密码把关。对外地址不是域名（默认就是回环）时判断不出来，直接不产生这条检查。
 */
export function classifyPasskeyOrigin(input: {
  origin: string;
  mode: { passkeysForThisOrigin?: boolean; passkeysRegisteredElsewhere?: boolean } | null;
}): DoctorCheck[] {
  if (!isDomainOrigin(input.origin)) return [];
  if (!input.mode?.passkeysRegisteredElsewhere) return [];
  return [
    {
      id: 'passkey-origin',
      level: 'warn',
      message: t('doctor.passkey.otherOrigin', { origin: input.origin }),
    },
  ];
}

/** 从本机 gateway 读 `/api/auth/mode`（登录前公开面），Origin 声明成对外地址。 */
export async function checkPasskeyOrigins(input: {
  healthHost: string;
  healthPort: string;
  baseUrl: string | null;
}): Promise<DoctorCheck[]> {
  if (!input.baseUrl || !isDomainOrigin(input.baseUrl)) return [];
  const origin = new URL(input.baseUrl).origin;
  const url = formatHttpEndpoint(
    rewriteWildcardBindHost(input.healthHost),
    input.healthPort,
    '/api/auth/mode'
  );
  const res = await fetch(url, {
    headers: { origin },
    signal: AbortSignal.timeout(3000),
  }).catch(() => null);
  if (!res?.ok) return [];
  const mode = (await res.json().catch(() => null)) as {
    passkeysForThisOrigin?: boolean;
    passkeysRegisteredElsewhere?: boolean;
  } | null;
  return classifyPasskeyOrigin({ origin, mode });
}

export async function checkService(input: {
  serviceName: string;
  installDir: string;
}): Promise<DoctorCheck[]> {
  const status = await getServiceStatus(input.serviceName, input.installDir);
  if (status.manager === 'none') {
    return [
      {
        id: 'service',
        level: 'warn',
        message: t('doctor.service.noManager', { detail: status.detail || '' }),
      },
    ];
  }
  if (!status.installed) {
    return [
      {
        id: 'service',
        level: 'warn',
        message: t('doctor.service.notInstalled', { serviceName: input.serviceName }),
        detail: status.detail,
      },
    ];
  }
  if (!status.running) {
    return [
      {
        id: 'service',
        level: 'warn',
        message: t('doctor.service.notRunning', { serviceName: input.serviceName }),
        detail: status.detail,
      },
    ];
  }
  return [
    {
      id: 'service',
      level: 'pass',
      message: t('doctor.service.running', { serviceName: input.serviceName }),
      detail: status.detail,
    },
  ];
}

export async function checkHealth(host: string, port: string): Promise<DoctorCheck[]> {
  const url = formatHttpEndpoint(rewriteWildcardBindHost(host), port, '/healthz');
  const healthResponse = await fetch(url, {
    signal: AbortSignal.timeout(3000),
  }).catch(() => null);
  if (healthResponse?.ok) {
    return [
      {
        id: 'healthz',
        level: 'pass',
        message: t('doctor.health.pass', { url }),
      },
    ];
  }
  return [
    {
      id: 'healthz',
      level: 'warn',
      message: t('doctor.health.fail', { url }),
    },
  ];
}

export function renderDoctorResult(checks: DoctorCheck[], json: boolean): void {
  if (json) {
    console.log(JSON.stringify({ checks }, null, 2));
    return;
  }

  for (const check of checks) {
    const prefix = check.level === 'pass' ? 'PASS' : check.level === 'warn' ? 'WARN' : 'FAIL';
    console.log(`[${prefix}] ${check.message}`);
    if (check.detail) {
      console.log(`  ${check.detail.trim()}`);
    }
    if (check.hint && check.level !== 'pass') {
      console.log(`  ${t('deps.install.hint', { command: check.hint })}`);
    }
  }
}

/**
 * 迁移到新安装目录后可能残留改名前的 launchd plist 或 shim；留着它们会让旧 CLI
 * 拉起第二个实例抢端口。没有残留就不产生这条检查，避免噪音。
 */
export async function checkLegacyLeftovers(input: {
  serviceName: string;
  installDir: string;
}): Promise<DoctorCheck[]> {
  const leftovers = [
    ...(await findLegacyLaunchdPlists(
      [...new Set([input.serviceName, LEGACY_SERVICE_NAME])],
      input.installDir
    )),
    ...(await findLegacyMarkedShims()),
  ];
  if (leftovers.length === 0) return [];
  return [
    {
      id: 'legacy-layout',
      level: 'warn',
      message: t('doctor.legacyLayout.leftovers'),
      detail: leftovers.join('\n'),
    },
  ];
}
