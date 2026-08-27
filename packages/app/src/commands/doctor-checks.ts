import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { formatHttpEndpoint, rewriteWildcardBindHost } from '../../../shared/src/network';
import { t } from '../i18n';
import { checkBunVersion } from '../lib/bun';
import { getInstallHintAsync } from '../lib/dep-install';
import { readEnvFile } from '../lib/env-file';
import { pathExists } from '../lib/fs-utils';
import { isSupportedPlatform } from '../lib/platform';
import { runCommand } from '../lib/process';
import { getServiceStatus } from '../lib/service';
import { checkTmuxVersion } from '../lib/tmux';
import type { DoctorCheck } from '../types';

export interface DoctorEnvironmentResult {
  platformChecks: DoctorCheck[];
  installChecks: DoctorCheck[];
  healthHost: string;
  healthPort: string;
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
    const required = ['TMEX_MASTER_KEY', 'DATABASE_URL', 'GATEWAY_PORT', 'TMEX_BIND_HOST'];
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
    if (env.TMEX_BIND_HOST) {
      healthHost = env.TMEX_BIND_HOST;
    }
  } else {
    installChecks.push({
      id: 'env',
      level: 'warn',
      message: t('doctor.env.missing', { envPath: input.envPath }),
    });
  }

  return { platformChecks, installChecks, healthHost, healthPort };
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
