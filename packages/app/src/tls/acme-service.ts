import acme from 'acme-client';
import type { TlsConfigStore } from '../../../../apps/gateway/src/tls/tls-config-store';
import type { AcmeChallengeType } from '../../../../apps/gateway/src/tls/types';
import type { AcmeHttp01Challenge } from './acme-challenge';
import { parseCertificate } from './cert-authority';
import type { CloudflareDnsClient } from './cloudflare-dns';

export const ACME_RENEW_LEAD_MS = 30 * 24 * 60 * 60 * 1000;
export const RENEWAL_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;
export const RENEWAL_BACKOFF_MIN_MS = 60 * 60 * 1000;
export const RENEWAL_BACKOFF_MAX_MS = 24 * 60 * 60 * 1000;

type AcmeAuthorization = {
  identifier: { type: string; value: string };
};

type AcmeChallenge = {
  type: string;
  token: string;
};

export type AcmeClientLike = {
  createAccount(data?: { contact?: string[]; termsOfServiceAgreed?: boolean }): Promise<unknown>;
  getAccountUrl(): string;
  auto(opts: {
    csr: string | Buffer;
    email?: string;
    termsOfServiceAgreed?: boolean;
    challengePriority?: string[];
    challengeCreateFn: (
      authz: AcmeAuthorization,
      challenge: AcmeChallenge,
      keyAuthorization: string
    ) => Promise<unknown>;
    challengeRemoveFn: (
      authz: AcmeAuthorization,
      challenge: AcmeChallenge,
      keyAuthorization: string
    ) => Promise<unknown>;
  }): Promise<string>;
};

export type AcmeClientFactory = (opts: {
  directoryUrl: string;
  accountKey: string;
  accountUrl?: string;
}) => AcmeClientLike | Promise<AcmeClientLike>;

export type AcmeIssueInput = {
  config?: {
    domain?: string | null;
    email?: string | null;
    challenge?: AcmeChallengeType | null;
    staging?: boolean;
  };
  store: TlsConfigStore;
  challenge: AcmeHttp01Challenge;
  dns: CloudflareDnsClient;
  fetch?: typeof fetch;
  log?: (message: string) => void;
  now?: () => number;
  clientFactory?: AcmeClientFactory;
};

function asPem(value: string | Buffer): string {
  return Buffer.isBuffer(value) ? value.toString('utf8') : value;
}

function defaultClientFactory(opts: {
  directoryUrl: string;
  accountKey: string;
  accountUrl?: string;
}): AcmeClientLike {
  return new acme.Client({
    directoryUrl: opts.directoryUrl,
    accountKey: opts.accountKey,
    accountUrl: opts.accountUrl,
  }) as unknown as AcmeClientLike;
}

export async function issue(input: AcmeIssueInput): Promise<void> {
  const now = input.now ?? Date.now;
  const attemptedAt = now();
  const current = await input.store.get();
  const domain = (input.config?.domain ?? current.acmeDomain ?? '').trim();
  const email = (input.config?.email ?? current.acmeEmail ?? '').trim();
  const challengeType = input.config?.challenge ?? current.acmeChallenge;
  const staging = input.config?.staging ?? current.acmeStaging;
  await input.store.upsert({
    acmeStatus: 'pending',
    acmeLastAttemptAt: attemptedAt,
    acmeLastError: null,
  });
  try {
    if (!domain || !email || !challengeType) {
      throw new Error('acme issuance is missing domain, email, or challenge');
    }
    const secrets = await input.store.getPrivateMaterial();
    let accountKey = secrets.acmeAccountKey;
    if (!accountKey) {
      accountKey = asPem(await acme.crypto.createPrivateEcdsaKey('P-256'));
    }
    void input.fetch;
    const directoryUrl = staging
      ? acme.directory.letsencrypt.staging
      : acme.directory.letsencrypt.production;
    const client = await (input.clientFactory ?? defaultClientFactory)({
      directoryUrl,
      accountKey,
      accountUrl: current.acmeAccountUrl ?? undefined,
    });
    if (!current.acmeAccountUrl) {
      await client.createAccount({
        termsOfServiceAgreed: true,
        contact: [`mailto:${email}`],
      });
    }
    const accountUrl = client.getAccountUrl();
    await input.store.upsert({
      acmeAccountKey: accountKey,
      acmeAccountUrl: accountUrl || current.acmeAccountUrl,
    });

    const leafKey = asPem(await acme.crypto.createPrivateEcdsaKey('P-256'));
    const [, csr] = await acme.crypto.createCsr(
      { commonName: domain, altNames: [domain] },
      leafKey
    );
    const dnsRecords = new Map<string, { zoneId: string; recordId: string }>();

    const certPem = await client.auto({
      csr: asPem(csr),
      email,
      termsOfServiceAgreed: true,
      challengePriority: [challengeType],
      challengeCreateFn: async (authz, challenge, keyAuthorization) => {
        if (challenge.type === 'http-01') {
          input.challenge.set(challenge.token, keyAuthorization);
          return;
        }
        if (challenge.type === 'dns-01') {
          const token = secrets.acmeCfToken;
          if (!token) {
            throw new Error('cloudflare token required for dns-01');
          }
          const zoneId = await input.dns.findZoneId(token, authz.identifier.value);
          const name = `_acme-challenge.${authz.identifier.value}`;
          const recordId = await input.dns.createTxt(token, zoneId, name, keyAuthorization);
          dnsRecords.set(challenge.token, { zoneId, recordId });
          return;
        }
        throw new Error(`unsupported acme challenge ${challenge.type}`);
      },
      challengeRemoveFn: async (_authz, challenge) => {
        if (challenge.type === 'http-01') {
          input.challenge.clear(challenge.token);
          return;
        }
        if (challenge.type === 'dns-01') {
          const token = secrets.acmeCfToken;
          const stored = dnsRecords.get(challenge.token);
          if (token && stored) {
            await input.dns.deleteRecord(token, stored.zoneId, stored.recordId);
            dnsRecords.delete(challenge.token);
          }
        }
      },
    });

    const parsed = parseCertificate(certPem);
    await input.store.upsert({
      certPem,
      keyPem: leafKey,
      certNotBefore: parsed.notBefore,
      certNotAfter: parsed.notAfter,
      sans: [domain],
      acmeStatus: 'ok',
      acmeLastError: null,
      acmeLastAttemptAt: attemptedAt,
      acmeNextRenewAt: parsed.notAfter - ACME_RENEW_LEAD_MS,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    input.log?.(`acme issuance failed: ${message}`);
    await input.store.upsert({
      acmeStatus: 'error',
      acmeLastError: message,
      acmeLastAttemptAt: attemptedAt,
    });
    throw error;
  }
}

export type RenewalSchedulerOptions = {
  isDue: () => boolean | Promise<boolean>;
  renew: () => Promise<void>;
  now?: () => number;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (id: unknown) => void;
  checkIntervalMs?: number;
  log?: (message: string) => void;
};

export class RenewalScheduler {
  private timer: unknown = null;
  private stopped = true;
  private backoffMs: number;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => unknown;
  private readonly clearTimeoutFn: (id: unknown) => void;
  private readonly checkIntervalMs: number;

  constructor(private readonly opts: RenewalSchedulerOptions) {
    this.setTimeoutFn = opts.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutFn = opts.clearTimeoutFn ?? ((id) => clearTimeout(id as NodeJS.Timeout));
    this.checkIntervalMs = opts.checkIntervalMs ?? RENEWAL_CHECK_INTERVAL_MS;
    this.backoffMs = RENEWAL_BACKOFF_MIN_MS;
  }

  start(): void {
    this.stopped = false;
    this.backoffMs = RENEWAL_BACKOFF_MIN_MS;
    this.arm(this.checkIntervalMs);
  }

  stop(): void {
    this.stopped = true;
    this.clearTimer();
  }

  async runNow(): Promise<void> {
    await this.tick(true);
  }

  private arm(ms: number): void {
    if (this.stopped) return;
    this.clearTimer();
    this.timer = this.setTimeoutFn(() => {
      void this.tick(false);
    }, ms);
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    this.clearTimeoutFn(this.timer);
    this.timer = null;
  }

  private async tick(force: boolean): Promise<void> {
    if (this.stopped && !force) return;
    try {
      if (force || (await this.opts.isDue())) {
        await this.opts.renew();
      }
      this.backoffMs = RENEWAL_BACKOFF_MIN_MS;
      this.arm(this.checkIntervalMs);
    } catch (error) {
      const wait = this.backoffMs;
      this.backoffMs = Math.min(this.backoffMs * 2, RENEWAL_BACKOFF_MAX_MS);
      this.opts.log?.(
        `tls renewal failed, retry in ${wait}ms: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      this.arm(wait);
    }
  }
}
