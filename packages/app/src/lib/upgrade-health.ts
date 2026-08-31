import { t } from '../i18n';

export type HealthzBody = {
  status?: unknown;
  version?: unknown;
  startedAt?: unknown;
};

export type HealthCheckOpts = {
  url: string;
  expectedVersion?: string;
  minStartedAt?: string;
  timeoutMs: number;
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

export function acceptHealthzBody(
  body: HealthzBody,
  opts: { expectedVersion?: string; minStartedAt?: string }
): string | null {
  if (body.status !== 'ok') {
    return t('upgrade.healthFailed', { status: String(body.status ?? '') });
  }
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
  return null;
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
