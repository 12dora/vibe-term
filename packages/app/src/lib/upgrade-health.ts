import { join } from 'node:path';
import { formatHttpEndpoint } from '../../../shared/src/network';
import { t } from '../i18n';
import type { ServiceMode } from '../types';
import { readEnvFile } from './env-file';
import { pathExists } from './fs-utils';
import type { UpgradeJournal } from './upgrade-state';

export type HealthzTls = {
  mode?: unknown;
  listenerRunning?: unknown;
};

export type HealthzBody = {
  status?: unknown;
  version?: unknown;
  startedAt?: unknown;
  tls?: HealthzTls;
};

export type HealthCheckOpts = {
  url: string;
  expectedVersion?: string;
  minStartedAt?: string;
  timeoutMs: number;
  requireTlsListener?: boolean;
  statusOnly?: boolean;
};

export type HealthCheckFn = (opts: HealthCheckOpts) => Promise<void>;

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function parseHealthTimestamp(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === 'string' && value.trim()) {
    const trimmed = value.trim();
    if (/^\d+(\.\d+)?$/.test(trimmed)) {
      const asNum = Number(trimmed);
      return asNum < 1e12 ? asNum * 1000 : asNum;
    }
    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Number.NaN;
}

function tlsModeOf(body: HealthzBody): string {
  const tls = body.tls;
  if (!tls || typeof tls !== 'object') return '';
  return typeof tls.mode === 'string' ? tls.mode : '';
}

function tlsListenerRunning(body: HealthzBody): boolean {
  const tls = body.tls;
  if (!tls || typeof tls !== 'object') return false;
  return tls.listenerRunning === true;
}

function rejectMissingTlsListener(body: HealthzBody, requireTlsListener?: boolean): string | null {
  if (!requireTlsListener) return null;
  const mode = tlsModeOf(body);
  if (mode !== 'selfsigned' && mode !== 'acme') return null;
  if (tlsListenerRunning(body)) return null;
  return t('upgrade.healthTlsListenerDown', { mode });
}

export function acceptHealthzBody(
  body: HealthzBody,
  opts: {
    expectedVersion?: string;
    minStartedAt?: string;
    requireTlsListener?: boolean;
    statusOnly?: boolean;
  }
): string | null {
  if (body.status !== 'ok') {
    return t('upgrade.healthFailed', { status: String(body.status ?? '') });
  }
  if (opts.statusOnly) return null;
  if (opts.expectedVersion && body.version !== opts.expectedVersion) {
    return t('upgrade.healthVersionMismatch', {
      expected: opts.expectedVersion,
      actual: String(body.version ?? ''),
    });
  }
  if (opts.minStartedAt) {
    const actual = parseHealthTimestamp(body.startedAt);
    const min = parseHealthTimestamp(opts.minStartedAt);
    if (!Number.isFinite(actual) || !Number.isFinite(min) || actual < min) {
      return t('upgrade.healthStaleStartedAt', {
        expected: opts.minStartedAt,
        actual: String(body.startedAt ?? ''),
      });
    }
  }
  return rejectMissingTlsListener(body, opts.requireTlsListener);
}

export async function liveHealthUrl(installDir: string): Promise<string | null> {
  const envPath = join(installDir, 'app.env');
  if (!(await pathExists(envPath))) return null;
  const env = await readEnvFile(envPath).catch(() => null);
  if (!env) return null;
  const port = String(env.GATEWAY_PORT || '9883');
  const host = String(env.TMEX_BIND_HOST || '127.0.0.1');
  const bind = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  return formatHttpEndpoint(bind, port, '/healthz');
}

export function isLegacy102(version: string): boolean {
  return version === '1.0.2';
}

export function oldServiceHealthOpts(input: {
  fromVersion: string;
  serviceMode?: ServiceMode;
  restarted: boolean;
  restartAt?: string;
}): Pick<HealthCheckOpts, 'expectedVersion' | 'minStartedAt' | 'statusOnly'> {
  if (isLegacy102(input.fromVersion)) {
    return { statusOnly: true };
  }
  return {
    minStartedAt: input.restarted ? input.restartAt : undefined,
  };
}

export async function verifyOldHealthz(
  journal: UpgradeJournal,
  healthCheck: HealthCheckFn,
  url: string | null,
  options: {
    serviceMode?: ServiceMode;
    restarted: boolean;
    restartAt?: string;
    timeoutMs: number;
  }
): Promise<void> {
  if (!url) {
    throw new Error(t('upgrade.healthFailed', { status: 'missing-env' }));
  }
  const extra = oldServiceHealthOpts({
    fromVersion: journal.fromVersion,
    serviceMode: options.serviceMode,
    restarted: options.restarted,
    restartAt: options.restartAt,
  });
  await healthCheck({
    url,
    timeoutMs: options.timeoutMs,
    ...extra,
  });
}

export async function pollHealthz(opts: HealthCheckOpts): Promise<void> {
  const startedAt = Date.now();
  let lastError: Error | null = null;
  while (Date.now() - startedAt < opts.timeoutMs) {
    try {
      const response = await fetch(opts.url, { signal: AbortSignal.timeout(4_000) });
      if (!response.ok) {
        lastError = new Error(t('upgrade.healthFailed', { status: response.status }));
      } else {
        const body = (await response.json()) as HealthzBody;
        const reject = acceptHealthzBody(body, {
          expectedVersion: opts.expectedVersion,
          minStartedAt: opts.minStartedAt,
          requireTlsListener: opts.requireTlsListener,
          statusOnly: opts.statusOnly,
        });
        if (reject) {
          lastError = new Error(reject);
        } else {
          return;
        }
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
    await sleepMs(500);
  }
  throw lastError || new Error(t('upgrade.healthFailed', { status: 'timeout' }));
}
