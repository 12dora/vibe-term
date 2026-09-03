import { isIP } from 'node:net';
import type { TlsConfigStore } from '../../../../apps/gateway/src/tls/tls-config-store';
import type {
  AcmeChallengeType,
  DnsProviderId,
  TlsConfigPatch,
  TlsConfigPublic,
  TlsMode,
  TlsPrivateMaterial,
} from '../../../../apps/gateway/src/tls/types';
import { readEnvFile, writeEnvFile } from '../lib/env-file';
import { withEnvLock } from '../lib/env-mutation';
import type { FetchLike } from '../lib/fetch-like';
import type { AcmeHttp01Challenge } from './acme-challenge';
import { resolveAcmeDnsPatch } from './acme-dns-patch';
import {
  ACME_RENEW_LEAD_MS,
  type AcmeIssueInput,
  type AcmeIssuedMaterial,
  RENEWAL_BACKOFF_MIN_MS,
  RenewalScheduler,
  acmeDirectoryUrl,
  issue as issueAcmeCert,
} from './acme-service';
import {
  CA_MIN_REMAINING_MS,
  type CaMaterial,
  createCa,
  issueLeaf,
  parseCertificate,
  spkiFingerprint,
} from './cert-authority';
import { CloudflareDnsClient } from './cloudflare-dns';
import { CloudflareDnsProvider, type DnsCredentials, type DnsProvider } from './dns-provider';
import { DnspodDnsClient } from './dnspod-dns';
import { TlsApiError } from './errors';
import type { HttpsListenerConfig, HttpsListenerState } from './https-listener';

const SELF_SIGNED_DAYS = 398;
const TLS_STATUS_CACHE_TTL_MS = 10_000;
const HOSTNAME_RE =
  /^(?=.{1,253}$)(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))*$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type ApplyModeInput =
  | { mode: 'none' }
  | { mode: 'external'; trustProxy: boolean }
  | { mode: 'selfsigned'; sans: string[]; tlsPort: number; bindHost: string }
  | {
      mode: 'acme';
      domain: string;
      email: string;
      challenge: AcmeChallengeType;
      cloudflareToken?: string;
      dnsProvider?: DnsProviderId;
      dnsCredentials?: DnsCredentials;
      staging: boolean;
      tlsPort: number;
      bindHost: string;
    };

export type TlsStatus = {
  mode: TlsMode;
  trustProxy: boolean;
  tlsPort: number;
  bindHost: string;
  sans: string[];
  caFingerprint: string | null;
  certificate: {
    subject: string;
    sans: string[];
    notBefore: number;
    notAfter: number;
    issuer: string;
  } | null;
  listener: HttpsListenerState;
  acme: {
    email: string;
    domain: string;
    challenge: AcmeChallengeType;
    staging: boolean;
    status: TlsConfigPublic['acmeStatus'];
    lastError: string | null;
    lastAttemptAt: number | null;
    nextRenewAt: number | null;
    hasCloudflareToken: boolean;
    dns: { provider: DnsProviderId | null; hasCredentials: boolean };
  } | null;
  restartRequired: boolean;
};

export type TlsListener = {
  apply(cfg: HttpsListenerConfig | null): Promise<void>;
  state(): HttpsListenerState;
  stop(): Promise<void>;
};

type AcmeRunReason = 'apply' | 'renew' | 'scheduler' | 'startup';

export type TlsServiceOptions = {
  store: TlsConfigStore;
  listener: TlsListener;
  challenge: AcmeHttp01Challenge;
  envPath: string;
  trustProxy?: boolean;
  now?: () => number;
  log?: (message: string) => void;
  fetch?: FetchLike;
  dns?: DnsProvider;
  issueAcme?: (input: AcmeIssueInput) => Promise<AcmeIssuedMaterial>;
  scheduleBackground?: (work: () => Promise<void>) => void;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (id: unknown) => void;
  onStatusChange?: () => void;
};

type AcmeJobTuple = { domain: string; challenge: AcmeChallengeType | null; staging: boolean };

class SerialQueue {
  private chain: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asTlsFailed(error: unknown): TlsApiError {
  return error instanceof TlsApiError ? error : new TlsApiError('tls_failed', 500, errMsg(error));
}

export class TlsService {
  private trustProxy: boolean;
  private restartRequired = false;
  private epoch = 0;
  private abortController = new AbortController();
  private acmeInFlight: Promise<void> | null = null;
  private statusCache: { value: TlsStatus; expiresAt: number; generation: number } | null = null;
  private statusGeneration = 0;
  private mutations = 0;
  private listenerAppliedOk = false;
  private readonly mutex = new SerialQueue();
  private readonly scheduler: RenewalScheduler;
  private readonly now: () => number;
  private readonly issueAcmeFn: (input: AcmeIssueInput) => Promise<AcmeIssuedMaterial>;
  private readonly scheduleBackground: (work: () => Promise<void>) => void;

  constructor(private readonly opts: TlsServiceOptions) {
    this.trustProxy = opts.trustProxy ?? false;
    this.now = opts.now ?? Date.now;
    this.issueAcmeFn = opts.issueAcme ?? issueAcmeCert;
    this.scheduleBackground =
      opts.scheduleBackground ??
      ((work) => {
        void work().catch((error) => {
          opts.log?.(`tls background task failed: ${errMsg(error)}`);
        });
      });
    this.scheduler = new RenewalScheduler({
      isDue: async () => {
        const row = await this.opts.store.get();
        return (
          row.mode === 'acme' && row.acmeNextRenewAt !== null && this.now() >= row.acmeNextRenewAt
        );
      },
      renew: async () => {
        await this.runAcme('scheduler', this.epoch, this.abortController.signal);
      },
      now: this.now,
      setTimeoutFn: opts.setTimeoutFn,
      clearTimeoutFn: opts.clearTimeoutFn,
      log: opts.log,
    });
  }

  async load(): Promise<TlsConfigPublic> {
    const fromEnv = await readTrustProxy(this.opts.envPath);
    if (fromEnv !== null) {
      if (fromEnv !== this.trustProxy) {
        this.beginMutation();
        this.trustProxy = fromEnv;
        this.endMutation();
      } else {
        this.trustProxy = fromEnv;
      }
    }
    return this.opts.store.get();
  }

  async startup(): Promise<void> {
    await this.mutex.run(async () => {
      await this.load();
      const row = await this.opts.store.get();
      await (row.mode === 'selfsigned' || row.mode === 'acme'
        ? this.applyListener()
        : this.withListenerApply(() => this.opts.listener.apply(null)));
      if (row.mode !== 'acme') return;
      this.scheduler.start();
      const due = row.acmeNextRenewAt !== null && this.now() >= row.acmeNextRenewAt;
      if (
        row.acmeStatus === 'pending' ||
        row.acmeStatus === 'error' ||
        !row.certPem ||
        due ||
        this.opts.listener.state().error
      ) {
        this.queueAcmeIssue('startup');
      }
    });
  }

  async status(): Promise<TlsStatus> {
    const now = this.now();
    if (this.mutations === 0 && this.statusCache && now < this.statusCache.expiresAt) {
      return this.statusCache.value;
    }
    const generation = this.statusGeneration;
    const value = await this.computeStatus();
    if (this.mutations === 0 && generation === this.statusGeneration) {
      this.statusCache = { value, expiresAt: now + TLS_STATUS_CACHE_TTL_MS, generation };
    }
    return value;
  }

  private async computeStatus(): Promise<TlsStatus> {
    const row = await this.opts.store.get();
    let certificate: TlsStatus['certificate'] = null;
    if (row.certPem) {
      try {
        const { subject, sans, notBefore, notAfter, issuer } = parseCertificate(row.certPem);
        certificate = { subject, sans, notBefore, notAfter, issuer };
      } catch {
        certificate = null;
      }
    }
    let caFingerprint: string | null = null;
    if (row.mode === 'selfsigned' && row.caCertPem) {
      caFingerprint = await spkiFingerprint(row.caCertPem);
    }
    return {
      mode: row.mode,
      trustProxy: this.trustProxy,
      tlsPort: row.tlsPort,
      bindHost: row.bindHost,
      sans: row.sans,
      caFingerprint,
      certificate,
      listener: this.opts.listener.state(),
      acme:
        row.mode === 'acme'
          ? {
              email: row.acmeEmail ?? '',
              domain: row.acmeDomain ?? '',
              challenge: row.acmeChallenge ?? 'http-01',
              staging: row.acmeStaging,
              status: row.acmeStatus,
              lastError: row.acmeLastError,
              lastAttemptAt: row.acmeLastAttemptAt,
              nextRenewAt: row.acmeNextRenewAt,
              hasCloudflareToken: row.hasCloudflareToken,
              dns: {
                provider: row.acmeDnsProvider,
                hasCredentials: row.hasDnsCredentials,
              },
            }
          : null,
      restartRequired: this.restartRequired,
    };
  }

  private invalidateStatusCache(): void {
    this.statusGeneration += 1;
    this.statusCache = null;
  }

  private beginMutation(): void {
    this.mutations += 1;
    this.invalidateStatusCache();
  }

  private endMutation(): void {
    this.mutations = Math.max(0, this.mutations - 1);
    this.invalidateStatusCache();
    if (this.mutations === 0 && this.listenerAppliedOk) {
      this.listenerAppliedOk = false;
      this.opts.onStatusChange?.();
    }
  }

  private async withMutation<T>(fn: () => Promise<T>): Promise<T> {
    this.beginMutation();
    try {
      return await fn();
    } finally {
      this.endMutation();
    }
  }

  private async withListenerApply(fn: () => Promise<void>): Promise<void> {
    this.beginMutation();
    try {
      await fn();
      if (!this.opts.listener.state().error) this.listenerAppliedOk = true;
    } finally {
      this.endMutation();
    }
  }

  private upsert(partial: TlsConfigPatch): Promise<TlsConfigPublic> {
    return this.withMutation(() => this.opts.store.upsert(partial));
  }

  async caPem(): Promise<string | null> {
    const row = await this.opts.store.get();
    return row.mode === 'selfsigned' && row.caCertPem ? row.caCertPem : null;
  }

  async applyMode(input: ApplyModeInput): Promise<TlsStatus> {
    return this.mutex.run(() => this.applyModeLocked(input));
  }

  async renew(): Promise<TlsStatus> {
    return this.mutex.run(async () => {
      const row = await this.opts.store.get();
      if (row.mode === 'none' || row.mode === 'external') {
        throw new TlsApiError('not_applicable', 409, 'renew is not applicable in this TLS mode');
      }
      if (row.mode === 'selfsigned') {
        await this.reissueSelfSigned(row.sans);
        return this.status();
      }
      await this.upsert({
        acmeStatus: 'pending',
        acmeLastError: null,
        acmeNextRenewAt: this.now() + RENEWAL_BACKOFF_MIN_MS,
      });
      this.queueAcmeIssue('renew');
      return this.status();
    });
  }

  handleChallenge(req: Request): Response | null {
    return this.opts.challenge.handle(req);
  }

  stop(): void {
    this.beginMutation();
    this.invalidateActiveWork();
    this.scheduler.stop();
    this.endMutation();
  }

  private async applyModeLocked(input: ApplyModeInput): Promise<TlsStatus> {
    if (input.mode === 'external') {
      try {
        await this.withMutation(async () => {
          await withEnvLock(async () => {
            await writeTrustProxy(this.opts.envPath, input.trustProxy);
          });
          this.trustProxy = input.trustProxy;
        });
      } catch (error) {
        throw new TlsApiError('tls_failed', 500, errMsg(error));
      }
      this.invalidateActiveWork();
      await this.stopTls('external');
      this.restartRequired = true;
      return this.status();
    }

    this.invalidateActiveWork();

    if (input.mode === 'none') {
      await this.stopTls('none');
      return this.status();
    }

    if (input.mode === 'selfsigned') {
      const sans = validateSans(input.sans);
      await this.upsert({
        mode: 'selfsigned',
        sans,
        tlsPort: validatePort(input.tlsPort),
        bindHost: validateBindHost(input.bindHost),
      });
      this.scheduler.stop();
      await this.reissueSelfSigned(sans);
      return this.status();
    }

    const domain = validateDomain(input.domain);
    const email = validateEmail(input.email);
    if (input.challenge !== 'http-01' && input.challenge !== 'dns-01') {
      throw new TlsApiError('invalid_domain', 400, 'challenge must be http-01 or dns-01');
    }
    const current = await this.opts.store.get();
    const dnsPatch = resolveAcmeDnsPatch(input, current);
    const directoryUrl = acmeDirectoryUrl(Boolean(input.staging));
    await this.upsert({
      mode: 'acme',
      tlsPort: validatePort(input.tlsPort),
      bindHost: validateBindHost(input.bindHost),
      sans: [domain],
      acmeDomain: domain,
      acmeEmail: email,
      acmeChallenge: input.challenge,
      acmeStaging: Boolean(input.staging),
      acmeStatus: 'pending',
      acmeLastError: null,
      acmeNextRenewAt: this.now() + RENEWAL_BACKOFF_MIN_MS,
      acmeAccountDirectory: directoryUrl,
      ...(current.acmeAccountDirectory !== directoryUrl ? { acmeAccountUrl: null } : {}),
      ...dnsPatch,
    });
    this.queueAcmeIssue('apply');
    this.scheduler.start();
    return this.status();
  }

  private async stopTls(mode: 'none' | 'external'): Promise<void> {
    await this.upsert({ mode });
    this.scheduler.stop();
    await this.withListenerApply(() => this.opts.listener.apply(null));
  }

  private async reissueSelfSigned(sans: string[]): Promise<void> {
    try {
      await this.issueSelfSigned(sans);
      await this.applyListener();
    } catch (error) {
      throw asTlsFailed(error);
    }
    this.throwIfBindFailed();
  }

  private invalidateActiveWork(): void {
    this.epoch += 1;
    this.abortController.abort();
    this.abortController = new AbortController();
  }

  private queueAcmeIssue(reason: AcmeRunReason): void {
    const epoch = this.epoch;
    const signal = this.abortController.signal;
    this.scheduleBackground(async () => {
      try {
        await this.runAcme(reason, epoch, signal);
      } catch {
        this.scheduler.retryAfterFailure();
      }
    });
  }

  private async runAcme(reason: AcmeRunReason, epoch: number, signal: AbortSignal): Promise<void> {
    if (this.acmeInFlight) {
      await this.acmeInFlight.catch(() => undefined);
    }
    if (epoch !== this.epoch || signal.aborted) return;
    const work = this.doRunAcme(reason, epoch, signal);
    this.acmeInFlight = work.finally(() => {
      if (this.acmeInFlight === work) {
        this.acmeInFlight = null;
      }
    });
    await this.acmeInFlight;
  }

  private async doRunAcme(
    reason: AcmeRunReason,
    epoch: number,
    signal: AbortSignal
  ): Promise<void> {
    if (epoch !== this.epoch || signal.aborted) return;
    const row = await this.opts.store.get();
    if (row.mode !== 'acme') return;
    const tuple: AcmeJobTuple = {
      domain: row.acmeDomain ?? '',
      challenge: row.acmeChallenge,
      staging: row.acmeStaging,
    };
    const secrets = await this.opts.store.getPrivateMaterial();
    if (await this.tryReuseValidCert(row, secrets, reason, epoch, tuple)) return;

    await this.runIfJob(epoch, tuple, async () => {
      await this.upsert({
        acmeStatus: 'pending',
        acmeLastAttemptAt: this.now(),
        acmeLastError: null,
      });
    });
    if (!(await this.jobStillValid(epoch, tuple)) || signal.aborted) return;

    let material: AcmeIssuedMaterial;
    try {
      material = await this.issueAcmeFn({
        config: {
          domain: row.acmeDomain,
          email: row.acmeEmail,
          challenge: row.acmeChallenge,
          staging: row.acmeStaging,
        },
        store: this.opts.store,
        challenge: this.opts.challenge,
        dns: this.createDnsProvider(row.acmeDnsProvider ?? 'cloudflare', row.acmeEmail ?? ''),
        log: this.opts.log,
        now: this.now,
        signal,
      });
    } catch (error) {
      await this.runIfJob(epoch, tuple, async () => {
        await this.persistAcmeFailure(errMsg(error));
      });
      throw error;
    }

    await this.runIfJob(
      epoch,
      tuple,
      async () => {
        await this.upsert({
          certPem: material.certPem,
          keyPem: material.keyPem,
          certNotBefore: material.notBefore,
          certNotAfter: material.notAfter,
          sans: [material.domain],
          acmeAccountKey: material.accountKey,
          acmeAccountUrl: material.accountUrl || null,
          acmeAccountDirectory: material.directoryUrl,
          acmeLastAttemptAt: this.now(),
          acmeNextRenewAt: material.nextRenewAt,
          acmeStatus: 'ok',
          acmeLastError: material.cleanupWarning,
        });
        await this.applyListenerOrFail();
        this.scheduler.resetBackoff();
      },
      signal,
      () => this.opts.log?.('discarding stale acme issuance')
    );
  }

  private async tryReuseValidCert(
    row: TlsConfigPublic,
    secrets: TlsPrivateMaterial,
    reason: AcmeRunReason,
    epoch: number,
    tuple: AcmeJobTuple
  ): Promise<boolean> {
    const certDue =
      row.certNotAfter !== null && this.now() >= row.certNotAfter - ACME_RENEW_LEAD_MS;
    if (
      Boolean(row.certPem) &&
      Boolean(secrets.keyPem) &&
      !certDue &&
      (reason === 'scheduler' || reason === 'startup')
    ) {
      await this.runIfJob(epoch, tuple, async () => {
        await this.applyListenerOrFail();
        await this.upsert({
          acmeStatus: 'ok',
          acmeLastError: null,
          acmeLastAttemptAt: this.now(),
          acmeNextRenewAt: (row.certNotAfter ?? this.now()) - ACME_RENEW_LEAD_MS,
        });
        this.scheduler.resetBackoff();
      });
      return true;
    }
    return false;
  }

  private async runIfJob(
    epoch: number,
    tuple: AcmeJobTuple,
    fn: () => Promise<void>,
    signal?: AbortSignal,
    onStale?: () => void
  ): Promise<void> {
    await this.mutex.run(async () => {
      if (!(await this.jobStillValid(epoch, tuple)) || signal?.aborted) return onStale?.();
      await fn();
    });
  }

  private async applyListenerOrFail(): Promise<void> {
    await this.applyListener();
    const error = this.opts.listener.state().error;
    if (!error) return;
    await this.persistAcmeFailure(error);
    throw new Error(error);
  }

  private async jobStillValid(epoch: number, tuple: AcmeJobTuple): Promise<boolean> {
    if (epoch !== this.epoch) return false;
    const current = await this.opts.store.get();
    return (
      current.mode === 'acme' &&
      (current.acmeDomain ?? '') === tuple.domain &&
      current.acmeChallenge === tuple.challenge &&
      Boolean(current.acmeStaging) === Boolean(tuple.staging)
    );
  }

  private async persistAcmeFailure(message: string): Promise<void> {
    await this.upsert({
      acmeStatus: 'error',
      acmeLastError: message,
      acmeLastAttemptAt: this.now(),
      acmeNextRenewAt: this.now() + this.scheduler.nextBackoffMs,
    });
  }

  private async issueSelfSigned(sans: string[]): Promise<void> {
    const ca = await this.ensureCa();
    const leaf = await issueLeaf({ ca, sans, days: SELF_SIGNED_DAYS, now: this.now() });
    const parsed = parseCertificate(leaf.certPem);
    await this.upsert({
      certPem: `${leaf.certPem.trim()}\n${ca.certPem.trim()}\n`,
      keyPem: leaf.keyPem,
      certNotBefore: parsed.notBefore,
      certNotAfter: parsed.notAfter,
      sans,
    });
  }

  private async ensureCa(): Promise<CaMaterial> {
    const row = await this.opts.store.get();
    const secrets = await this.opts.store.getPrivateMaterial();
    if (row.caCertPem && secrets.caKeyPem) {
      const parsed = parseCertificate(row.caCertPem);
      if (parsed.notAfter - this.now() >= CA_MIN_REMAINING_MS) {
        return { certPem: row.caCertPem, keyPem: secrets.caKeyPem };
      }
      this.opts.log?.(
        'tls CA remaining validity below 30 days, rotating CA; joined nodes must re-join'
      );
    }
    const ca = await createCa({ name: 'tmex local CA', now: this.now() });
    await this.upsert({ caCertPem: ca.certPem, caKeyPem: ca.keyPem });
    return ca;
  }

  private async applyListener(): Promise<void> {
    const row = await this.opts.store.get();
    const { keyPem } = await this.opts.store.getPrivateMaterial();
    const { certPem, tlsPort, bindHost } = row;
    if (!certPem || !keyPem) {
      await this.withListenerApply(() => this.opts.listener.apply(null));
      return;
    }
    await this.withListenerApply(() =>
      this.opts.listener.apply({ port: tlsPort, host: bindHost, certPem, keyPem })
    );
  }

  private throwIfBindFailed(): void {
    const error = this.opts.listener.state().error;
    if (error) throw new TlsApiError('port_in_use', 409, error);
  }

  private createDnsProvider(id: DnsProviderId, email: string): DnsProvider {
    if (this.opts.dns?.id === id) return this.opts.dns;
    if (id === 'dnspod') {
      return new DnspodDnsClient({ fetch: this.opts.fetch, email });
    }
    return new CloudflareDnsProvider(new CloudflareDnsClient(this.opts.fetch));
  }
}

function validatePort(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new TlsApiError('invalid_port', 400, 'tlsPort must be an integer in 1..65535');
  }
  return value;
}

function validateBindHost(value: string): string {
  const host = value.trim();
  if (!host) throw new TlsApiError('invalid_port', 400, 'bindHost is required');
  return host;
}

function validateSans(sans: string[]): string[] {
  if (!Array.isArray(sans) || sans.length < 1 || sans.length > 20) {
    throw new TlsApiError('invalid_sans', 400, 'sans must contain 1 to 20 hostnames or IPs');
  }
  const normalized = sans.map((item) => item.trim()).filter(Boolean);
  if (normalized.length !== sans.length || !normalized.every(isValidSan)) {
    throw new TlsApiError('invalid_sans', 400, 'each SAN must be a valid hostname or IP');
  }
  return normalized;
}

function validateDomain(value: string): string {
  const domain = value.trim().toLowerCase();
  if (!domain || domain.includes('*') || isIP(domain) !== 0 || !HOSTNAME_RE.test(domain)) {
    throw new TlsApiError('invalid_domain', 400, 'domain must be a hostname without wildcards');
  }
  return domain;
}

function validateEmail(value: string): string {
  const email = value.trim();
  if (!EMAIL_RE.test(email)) throw new TlsApiError('invalid_email', 400, 'email is invalid');
  return email;
}

function isValidSan(value: string): boolean {
  return isIP(value) !== 0 || HOSTNAME_RE.test(value);
}

async function readTrustProxy(envPath: string): Promise<boolean | null> {
  try {
    const raw = (await readEnvFile(envPath)).TMEX_TRUST_PROXY;
    if (raw === undefined) return null;
    const normalized = raw.trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function writeTrustProxy(envPath: string, trustProxy: boolean): Promise<void> {
  let existing: Record<string, string> = {};
  try {
    existing = await readEnvFile(envPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await writeEnvFile(envPath, { ...existing, TMEX_TRUST_PROXY: trustProxy ? 'true' : 'false' });
}
