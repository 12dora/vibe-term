import { promises as dnsPromises } from 'node:dns';
import { Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';
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
export const DNS_PROPAGATION_INTERVAL_MS = 2000;
export const DNS_PROPAGATION_TIMEOUT_MS = 120_000;

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

export type ResolveTxtFn = (hostname: string, nameservers?: string[]) => Promise<string[][]>;

export type AcmeIssuedMaterial = {
  certPem: string;
  keyPem: string;
  notBefore: number;
  notAfter: number;
  nextRenewAt: number;
  accountKey: string;
  accountUrl: string;
  directoryUrl: string;
  domain: string;
  cleanupWarning: string | null;
};

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
  signal?: AbortSignal;
  resolveTxt?: ResolveTxtFn;
  dnsIntervalMs?: number;
  dnsTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

function asPem(value: string | Buffer): string {
  return Buffer.isBuffer(value) ? value.toString('utf8') : value;
}

export function acmeDirectoryUrl(staging: boolean): string {
  return staging ? acme.directory.letsencrypt.staging : acme.directory.letsencrypt.production;
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

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error('acme issuance aborted');
  }
}

async function resolveNameserverIps(nameservers: string[]): Promise<string[]> {
  const ips: string[] = [];
  for (const ns of nameservers) {
    if (isIP(ns) !== 0) {
      ips.push(ns);
      continue;
    }
    try {
      ips.push(...(await dnsPromises.resolve4(ns)));
    } catch {
      // try AAAA
    }
    try {
      ips.push(...(await dnsPromises.resolve6(ns)));
    } catch {
      // skip unresolvable NS
    }
  }
  return ips;
}

export const DOH_ENDPOINT = 'https://cloudflare-dns.com/dns-query';
const RESOLVE_ATTEMPT_TIMEOUT_MS = 8_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

/** UDP 53 在代理/受限网络下常不可达，先走 DNS-over-HTTPS（可过 HTTP 代理），再退到权威 NS 与系统解析器。 */
export async function resolveTxtOverHttps(
  hostname: string,
  fetchImpl: typeof fetch = fetch,
  endpoint = DOH_ENDPOINT
): Promise<string[][]> {
  const url = new URL(endpoint);
  url.searchParams.set('name', hostname);
  url.searchParams.set('type', 'TXT');
  const response = await fetchImpl(url, {
    headers: { accept: 'application/dns-json' },
    signal: AbortSignal.timeout(RESOLVE_ATTEMPT_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`doh ${response.status}`);
  }
  const body = (await response.json()) as { Answer?: Array<{ type: number; data: string }> };
  return (body.Answer ?? [])
    .filter((answer) => answer.type === 16)
    .map((answer) => [answer.data.replace(/^"|"$/g, '').replace(/"\s*"/g, '')]);
}

export async function defaultResolveTxt(
  hostname: string,
  nameservers?: string[]
): Promise<string[][]> {
  try {
    return await resolveTxtOverHttps(hostname);
  } catch {
    // fall through to UDP resolvers
  }
  if (nameservers && nameservers.length > 0) {
    try {
      const ips = await withTimeout(
        resolveNameserverIps(nameservers),
        RESOLVE_ATTEMPT_TIMEOUT_MS,
        'nameserver lookup'
      );
      if (ips.length > 0) {
        const resolver = new Resolver({ timeout: 3_000, tries: 1 });
        resolver.setServers(ips);
        return await withTimeout(
          resolver.resolveTxt(hostname),
          RESOLVE_ATTEMPT_TIMEOUT_MS,
          'authoritative TXT lookup'
        );
      }
    } catch {
      // fall through to the system resolver
    }
  }
  const system = new Resolver({ timeout: 3_000, tries: 1 });
  return withTimeout(system.resolveTxt(hostname), RESOLVE_ATTEMPT_TIMEOUT_MS, 'system TXT lookup');
}

export async function waitForTxt(opts: {
  hostname: string;
  value: string;
  nameservers?: string[];
  resolveTxt?: ResolveTxtFn;
  intervalMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  signal?: AbortSignal;
}): Promise<void> {
  const intervalMs = opts.intervalMs ?? DNS_PROPAGATION_INTERVAL_MS;
  const timeoutMs = opts.timeoutMs ?? DNS_PROPAGATION_TIMEOUT_MS;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const resolveTxt = opts.resolveTxt ?? defaultResolveTxt;
  const deadline = now() + timeoutMs;

  const visible = async (): Promise<boolean> => {
    throwIfAborted(opts.signal);
    try {
      const records = await resolveTxt(opts.hostname, opts.nameservers);
      return records.flat().includes(opts.value);
    } catch {
      return false;
    }
  };

  if (await visible()) return;
  while (now() < deadline) {
    throwIfAborted(opts.signal);
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(intervalMs, remaining));
    if (await visible()) return;
  }
  throw new Error(`dns-01 TXT ${opts.hostname} did not propagate within ${timeoutMs}ms`);
}

export async function issue(input: AcmeIssueInput): Promise<AcmeIssuedMaterial> {
  const now = input.now ?? Date.now;
  throwIfAborted(input.signal);
  const current = await input.store.get();
  const domain = (input.config?.domain ?? current.acmeDomain ?? '').trim();
  const email = (input.config?.email ?? current.acmeEmail ?? '').trim();
  const challengeType = input.config?.challenge ?? current.acmeChallenge;
  const staging = input.config?.staging ?? current.acmeStaging;
  if (!domain || !email || !challengeType) {
    throw new Error('acme issuance is missing domain, email, or challenge');
  }
  const secrets = await input.store.getPrivateMaterial();
  let accountKey = secrets.acmeAccountKey;
  if (!accountKey) {
    accountKey = asPem(await acme.crypto.createPrivateEcdsaKey('P-256'));
  }
  void input.fetch;
  const directoryUrl = acmeDirectoryUrl(Boolean(staging));
  const reuseAccount =
    Boolean(current.acmeAccountUrl) && current.acmeAccountDirectory === directoryUrl;
  const client = await (input.clientFactory ?? defaultClientFactory)({
    directoryUrl,
    accountKey,
    accountUrl: reuseAccount ? (current.acmeAccountUrl ?? undefined) : undefined,
  });
  if (!reuseAccount) {
    await client.createAccount({
      termsOfServiceAgreed: true,
      contact: [`mailto:${email}`],
    });
  }
  throwIfAborted(input.signal);
  const accountUrl = client.getAccountUrl() || (reuseAccount ? (current.acmeAccountUrl ?? '') : '');

  const leafKey = asPem(await acme.crypto.createPrivateEcdsaKey('P-256'));
  const [, csr] = await acme.crypto.createCsr({ commonName: domain, altNames: [domain] }, leafKey);
  const outstandingDns: Array<{ zoneId: string; recordId: string; token: string }> = [];
  const httpTokens: string[] = [];
  const cleanupFailures: string[] = [];

  const deleteOutstanding = async (): Promise<void> => {
    const cfToken = secrets.acmeCfToken;
    while (outstandingDns.length > 0) {
      const rec = outstandingDns.pop();
      if (!rec) continue;
      if (!cfToken) {
        cleanupFailures.push(`missing cloudflare token for ${rec.recordId}`);
        continue;
      }
      try {
        await input.dns.deleteRecord(cfToken, rec.zoneId, rec.recordId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        cleanupFailures.push(`${rec.recordId}: ${message}`);
        input.log?.(`acme dns-01 cleanup failed for ${rec.recordId}: ${message}`);
      }
    }
    for (const token of httpTokens) {
      input.challenge.clear(token);
    }
    httpTokens.length = 0;
  };

  let certPem: string | undefined;
  try {
    certPem = await client.auto({
      csr: asPem(csr),
      email,
      termsOfServiceAgreed: true,
      challengePriority: [challengeType],
      skipChallengeVerification: true,
      challengeCreateFn: async (authz, challenge, keyAuthorization) => {
        throwIfAborted(input.signal);
        if (challenge.type === 'http-01') {
          input.challenge.set(challenge.token, keyAuthorization);
          httpTokens.push(challenge.token);
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
          outstandingDns.push({ zoneId, recordId, token: challenge.token });
          let nameservers: string[] = [];
          try {
            nameservers = await input.dns.getNameServers(token, zoneId);
          } catch (error) {
            input.log?.(
              `acme dns-01 nameserver lookup failed, using system resolver: ${
                error instanceof Error ? error.message : String(error)
              }`
            );
          }
          await waitForTxt({
            hostname: name,
            value: keyAuthorization,
            nameservers: nameservers.length > 0 ? nameservers : undefined,
            resolveTxt: input.resolveTxt,
            intervalMs: input.dnsIntervalMs,
            timeoutMs: input.dnsTimeoutMs,
            sleep: input.sleep,
            now,
            signal: input.signal,
          });
          return;
        }
        throw new Error(`unsupported acme challenge ${challenge.type}`);
      },
      challengeRemoveFn: async (_authz, challenge) => {
        if (challenge.type === 'http-01') {
          input.challenge.clear(challenge.token);
          const idx = httpTokens.indexOf(challenge.token);
          if (idx >= 0) httpTokens.splice(idx, 1);
          return;
        }
        if (challenge.type === 'dns-01') {
          const cfToken = secrets.acmeCfToken;
          const storedIdx = outstandingDns.findIndex((item) => item.token === challenge.token);
          const stored = storedIdx >= 0 ? outstandingDns[storedIdx] : undefined;
          if (cfToken && stored) {
            try {
              await input.dns.deleteRecord(cfToken, stored.zoneId, stored.recordId);
              outstandingDns.splice(storedIdx, 1);
            } catch (error) {
              input.log?.(
                `acme dns-01 challengeRemoveFn failed for ${stored.recordId}: ${
                  error instanceof Error ? error.message : String(error)
                }`
              );
            }
          }
        }
      },
    });

    throwIfAborted(input.signal);
  } finally {
    await deleteOutstanding();
  }
  if (!certPem) {
    throw new Error('acme auto returned an empty certificate');
  }
  const parsed = parseCertificate(certPem);
  return {
    certPem,
    keyPem: leafKey,
    notBefore: parsed.notBefore,
    notAfter: parsed.notAfter,
    nextRenewAt: parsed.notAfter - ACME_RENEW_LEAD_MS,
    accountKey,
    accountUrl,
    directoryUrl,
    domain,
    cleanupWarning:
      cleanupFailures.length > 0 ? `dns-01 cleanup failed: ${cleanupFailures.join('; ')}` : null,
  };
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

  get nextBackoffMs(): number {
    return this.backoffMs;
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

  resetBackoff(): void {
    this.backoffMs = RENEWAL_BACKOFF_MIN_MS;
  }

  retryAfterFailure(): void {
    const wait = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, RENEWAL_BACKOFF_MAX_MS);
    this.opts.log?.(`tls renewal failed, retry in ${wait}ms`);
    this.arm(wait);
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
