import { X509Certificate, createHash } from 'node:crypto';
import { canonicalHubUrl, hubHostFromUrl } from '@tmex/shared/auth';
import type { LinkSession, LinkStream } from '@tmex/shared/link';
import type {
  HubAdvertisement,
  HubAttachmentsMessage,
  HubForwardMessage,
  HubMode,
  HubTokensMessage,
  HubWriteForwardMessage,
} from '@tmex/shared/uplink';
import type { HubTrustStore } from '../auth/hub-trust-store';
import type { MeshHubRecord } from '../auth/mesh-hub-store';
import { hubListToRecords, pickWriterHub } from '../auth/mesh-hub-store';
import type { UserStore } from '../auth/user-store';
import { nodeVersionSupportsHubAuthRecords } from '../hub/hub-authorization';
import { backoffDelayMs, defaultScheduler } from './ctl';
import { stamp } from './mesh-log';
import type {
  InboundRelayHandler,
  KeyLogApplier,
  KeyLogForkEvent,
  MeshIdentity,
  MeshScheduler,
  PooledUplink,
  UplinkState,
  UplinkStatus,
} from './types';
import {
  UPLINK_BACKOFF_MAX_MS,
  UPLINK_BACKOFF_MIN_MS,
  UplinkClient,
  type UplinkClientOptions,
  type UplinkWsFactory,
  uplinkWebSocketTls,
} from './uplink-client';
import { type UrlDiag, emptyUplinkDiag, mergeUplinkDiag } from './uplink-pool-diag';
import { defaultFetchCaPem, defaultProbeHealthz } from './uplink-pool-http';
import { runUplinkSwitch, terminalErrorOf } from './uplink-pool-switch';

export {
  CA_BOOTSTRAP_MAX_BYTES,
  CA_BOOTSTRAP_TIMEOUT_MS,
  defaultFetchCaPem,
  defaultProbeHealthz,
  joinHubPath,
  readResponseTextLimited,
} from './uplink-pool-http';
import type {
  UplinkCtlMessage,
  UplinkEnrollRedeemed,
  UplinkNodeList,
  UplinkRtcSignal,
} from './uplink-protocol';

export const UPLINK_POOL_FAIL_LIMIT = 3;
export const UPLINK_POOL_AUTH_DEADLINE_MS = 20_000;
export const UPLINK_POOL_PROBE_INTERVAL_MS = 60_000;
export const UPLINK_POOL_PROBE_TIMEOUT_MS = 5_000;
export const UPLINK_POOL_PROBE_JITTER = 0.2;
export const UPLINK_POOL_FAILBACK_DEBOUNCE_MS = 5_000;
export const UPLINK_POOL_RTT_PROBE_INTERVAL_MS = 300_000;
export const UPLINK_RTT_EWMA_ALPHA = 0.3;
export const UPLINK_RTT_MIN_SAMPLES = 2;
export const UPLINK_RTT_SWITCH_MIN_RATIO = 0.3;
export const UPLINK_RTT_SWITCH_MIN_MS = 15;
export const UPLINK_RTT_SWITCH_DWELL_MS = 10 * 60 * 1000;
export const UPLINK_SEED_PRIORITY_BASE = 1_000;
export const UPLINK_POOL_PROBE_NOW_DEBOUNCE_MS = 2_000;
export const UPLINK_POOL_FAIL_LOG_INTERVAL_MS = 60_000;

export type UplinkCandidate = {
  hubNodeId: string | null;
  publicUrl: string;
  mode: HubMode;
  writerEpoch: number;
  priority: number;
  caFingerprint: string | null;
  lastError?: string | null;
  lastErrorAt?: number | null;
  lastAttemptAt?: number | null;
  rttMs?: number | null;
  rttAt?: number | null;
  version?: string | null;
};

export type AttachedHub = {
  hubNodeId: string | null;
  publicUrl: string;
  mode: HubMode | null;
  writerEpoch: number | null;
  since: number;
};

export type UplinkPoolNodeListMeta = {
  hubNodeId: string | null;
  generation: number;
};

export type UplinkPoolCtlSource = {
  hubNodeId: string;
  generation: number;
};

export type CreatePooledUplink = (opts: UplinkClientOptions) => PooledUplink;

export type UplinkPoolOptions = {
  identity: MeshIdentity;
  userId: string | (() => string);
  keyLogApplier: KeyLogApplier;
  userStore: UserStore;
  statusProvider: () => UplinkStatus & { hub?: HubAdvertisement };
  candidates: () => UplinkCandidate[];
  hubTrust: HubTrustStore;
  wsFactory?: UplinkWsFactory;
  scheduler?: MeshScheduler;
  pingIntervalMs?: number;
  createClient?: CreatePooledUplink;
  probeHealthz?: (publicUrl: string, tlsCa: string[] | null, timeoutMs: number) => Promise<boolean>;
  fetchCaPem?: (publicUrl: string) => Promise<string>;
  fingerprintPem?: (pem: string) => string;
  isLocalCandidate?: (cand: UplinkCandidate) => boolean;
  connectLocal?: (client: PooledUplink, signal: AbortSignal) => Promise<void>;
  probeJitter?: number;
  failbackDebounceMs?: number;
  probeNowDebounceMs?: number;
  rttProbeIntervalMs?: number;
  enablePeriodicRttProbe?: boolean;
  /** `null` = auto (on when >1 authorized hub is known). `false` forces off. */
  preferNearest?: boolean | null;
  localRoles?: { hub?: boolean; node?: boolean; relay?: boolean };
  rttSwitchDwellMs?: number;
  onNodeList?: (list: UplinkNodeList, meta: UplinkPoolNodeListMeta) => void;
  onRtcSignal?: (msg: UplinkRtcSignal) => void;
  onEnrollRedeemed?: (msg: UplinkEnrollRedeemed) => void;
  onKeyLogFork?: (event: KeyLogForkEvent) => void;
  onHubTokens?: (msg: HubTokensMessage, source: UplinkPoolCtlSource) => void;
  onHubAttachments?: (msg: HubAttachmentsMessage, source: UplinkPoolCtlSource) => void;
  onHubForward?: (msg: HubForwardMessage, source: UplinkPoolCtlSource) => void;
  onHubWriteForward?: (msg: HubWriteForwardMessage, source: UplinkPoolCtlSource) => void;
  onHubRelayStream?: (stream: LinkStream, source: UplinkPoolCtlSource) => void;
  failLimit?: number;
  authDeadlineMs?: number;
  probeIntervalMs?: number;
  probeTimeoutMs?: number;
};

export function redactUrl(raw: string): string {
  try {
    return new URL(raw).origin;
  } catch {
    const stripped = raw
      .replace(/[?#].*$/, '')
      .replace(/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/?#]*@/, '$1');
    try {
      return new URL(stripped).origin;
    } catch {
      return stripped.replace(/\/+$/, '') || raw;
    }
  }
}

export function normalizeHubEndpointUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  try {
    return canonicalHubUrl(trimmed);
  } catch {
    return trimmed.replace(/\/+$/, '');
  }
}

export function sameHubUrl(a: string, b: string): boolean {
  return normalizeHubEndpointUrl(a) === normalizeHubEndpointUrl(b);
}

export function isSelfHubCandidate(
  cand: Pick<UplinkCandidate, 'hubNodeId' | 'publicUrl'>,
  self: { nodeId?: string | null; publicUrl?: string | null }
): boolean {
  if (self.nodeId && cand.hubNodeId && cand.hubNodeId === self.nodeId) return true;
  if (self.publicUrl && sameHubUrl(cand.publicUrl, self.publicUrl)) return true;
  return false;
}

export function isCaFingerprintHex(value: string): boolean {
  return /^[0-9a-f]{64}$/i.test(value.trim());
}

const KEY_USAGE_OID = Buffer.from([0x06, 0x03, 0x55, 0x1d, 0x0f]);
const KEY_USAGE_NAMES = [
  'digitalSignature',
  'nonRepudiation',
  'keyEncipherment',
  'dataEncipherment',
  'keyAgreement',
  'keyCertSign',
  'cRLSign',
  'encipherOnly',
  'decipherOnly',
] as const;

function parseKeyUsageFromRaw(raw: ArrayBuffer | Uint8Array): string[] | undefined {
  const buf = Buffer.from(raw instanceof ArrayBuffer ? new Uint8Array(raw) : raw);
  const idx = buf.indexOf(KEY_USAGE_OID);
  if (idx < 0) return undefined;
  let i = idx + KEY_USAGE_OID.length;
  if (buf[i] === 0x01 && buf[i + 1] === 0x01) i += 3;
  if (buf[i] !== 0x04) return undefined;
  const octLen = buf[i + 1];
  if (octLen == null || octLen > 127) return undefined;
  i += 2;
  if (buf[i] !== 0x03) return undefined;
  const bitStrLen = buf[i + 1];
  const unused = buf[i + 2];
  if (bitStrLen == null || unused == null || bitStrLen < 2) return undefined;
  const value = buf.subarray(i + 3, i + 2 + bitStrLen);
  const totalBits = value.length * 8 - unused;
  const out: string[] = [];
  for (let b = 0; b < totalBits && b < KEY_USAGE_NAMES.length; b += 1) {
    const byte = value[b >> 3] ?? 0;
    const bit = 7 - (b & 7);
    if ((byte & (1 << bit)) !== 0) out.push(KEY_USAGE_NAMES[b]);
  }
  return out;
}

function certificateKeyUsage(cert: X509Certificate): string[] | undefined {
  if (cert.keyUsage && cert.keyUsage.length > 0) return [...cert.keyUsage];
  return parseKeyUsageFromRaw(cert.raw);
}

export function parseSingleCaCertificate(pem: string): X509Certificate {
  const matches = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
  if (matches.length !== 1) throw new Error('ca_pem_count');
  const cert = new X509Certificate(matches[0]);
  const usages = certificateKeyUsage(cert);
  if (usages && !usages.includes('keyCertSign')) throw new Error('ca_no_key_cert_sign');
  if (cert.ca !== true) throw new Error('ca_not_ca');
  return cert;
}

export function jitteredIntervalMs(baseMs: number, jitter = UPLINK_POOL_PROBE_JITTER): number {
  const ratio = Math.min(Math.max(jitter, 0), 1);
  const delta = baseMs * ratio;
  return Math.max(1, Math.floor(baseMs - delta + Math.random() * (2 * delta)));
}

export function mergeUplinkCandidates(
  stored: Array<{
    hubNodeId: string;
    publicUrl: string;
    mode: HubMode;
    writerEpoch: number;
    priority: number;
    caFingerprint: string | null;
  }>,
  seeds: string[]
): UplinkCandidate[] {
  const seen = new Set<string>();
  const out: UplinkCandidate[] = [];
  for (const row of stored) {
    const key = normalizeHubEndpointUrl(row.publicUrl);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({
      hubNodeId: row.hubNodeId,
      publicUrl: row.publicUrl,
      mode: row.mode,
      writerEpoch: row.writerEpoch,
      priority: row.priority,
      caFingerprint: row.caFingerprint,
    });
  }
  let seedIndex = 0;
  for (const raw of seeds) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const key = normalizeHubEndpointUrl(trimmed);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({
      hubNodeId: null,
      publicUrl: trimmed,
      mode: 'active',
      writerEpoch: 0,
      priority: UPLINK_SEED_PRIORITY_BASE + seedIndex,
      caFingerprint: null,
    });
    seedIndex += 1;
  }
  out.sort(compareUplinkCandidates);
  return out;
}

function modeRank(mode: HubMode | string): number {
  if (mode === 'active') return 0;
  if (mode === 'standby') return 1;
  return 2;
}

function compareUplinkCandidates(a: UplinkCandidate, b: UplinkCandidate): number {
  const rank = modeRank(a.mode) - modeRank(b.mode);
  if (rank !== 0) return rank;
  if (a.mode === 'active' && a.writerEpoch !== b.writerEpoch) return b.writerEpoch - a.writerEpoch;
  if (a.priority !== b.priority) return a.priority - b.priority;
  return 0;
}

export function isRttSwitchWorth(currentMs: number, bestMs: number): boolean {
  if (!(currentMs > 0) || !(bestMs >= 0)) return false;
  const delta = currentMs - bestMs;
  if (delta < UPLINK_RTT_SWITCH_MIN_MS) return false;
  return delta / currentMs >= UPLINK_RTT_SWITCH_MIN_RATIO;
}

export function hubSupportsNearestAttach(version: string | null | undefined): boolean {
  return nodeVersionSupportsHubAuthRecords(version);
}

export function writerHubIdOf(cands: UplinkCandidate[]): string | null {
  return pickWriterHub(
    cands
      .filter((row): row is UplinkCandidate & { hubNodeId: string } => Boolean(row.hubNodeId))
      .map((row) => ({
        hubNodeId: row.hubNodeId,
        mode: row.mode,
        writerEpoch: row.writerEpoch,
        priority: row.priority,
      }))
  );
}

export function orderCandidatesByNearest(
  cands: UplinkCandidate[],
  opts: {
    rttOf: (publicUrl: string) => { ewma: number; samples: number } | null;
    writerHubId: string | null;
    versionOf: (cand: UplinkCandidate) => string | null | undefined;
  }
): UplinkCandidate[] {
  if (cands.length <= 1) return cands;
  const eligible: UplinkCandidate[] = [];
  const rest: UplinkCandidate[] = [];
  for (const cand of cands) {
    const rtt = opts.rttOf(cand.publicUrl);
    const isWriter = Boolean(cand.hubNodeId) && cand.hubNodeId === opts.writerHubId;
    const supports = isWriter || hubSupportsNearestAttach(opts.versionOf(cand));
    if (rtt && rtt.samples >= UPLINK_RTT_MIN_SAMPLES && supports) eligible.push(cand);
    else rest.push(cand);
  }
  if (eligible.length === 0) return cands;
  eligible.sort((a, b) => {
    const ar = opts.rttOf(a.publicUrl)?.ewma ?? Number.POSITIVE_INFINITY;
    const br = opts.rttOf(b.publicUrl)?.ewma ?? Number.POSITIVE_INFINITY;
    if (ar !== br) return ar - br;
    return compareUplinkCandidates(a, b);
  });
  const writerIdx = rest.findIndex((row) => row.hubNodeId === opts.writerHubId);
  if (writerIdx > 0) {
    const writer = rest[writerIdx];
    const before = rest.slice(0, writerIdx);
    const after = rest.slice(writerIdx + 1);
    const keep: UplinkCandidate[] = [];
    const demote: UplinkCandidate[] = [];
    for (const row of before) {
      const isWriter = row.hubNodeId === opts.writerHubId;
      if (isWriter || hubSupportsNearestAttach(opts.versionOf(row))) keep.push(row);
      else demote.push(row);
    }
    rest.length = 0;
    rest.push(...keep);
    if (writer) rest.push(writer);
    rest.push(...demote, ...after);
  }
  return [...eligible, ...rest];
}

export function recordsFromNodeList(list: UplinkNodeList): Array<Omit<MeshHubRecord, 'updatedAt'>> {
  if (list.hubs && list.hubs.length > 0) return hubListToRecords(list.hubs);
  if (!list.hub) return [];
  return [
    {
      hubNodeId: list.hub.nodeId,
      publicUrl: list.hub.publicUrl,
      name: list.hub.name ?? null,
      mode: 'active',
      priority: 100,
      writerEpoch: list.writerEpoch ?? 1,
      caFingerprint: null,
      online: true,
      lastSeenAt: null,
    },
  ];
}

export function spkiFingerprintFromPem(pem: string): string {
  const match = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/);
  if (!match) throw new Error('PEM does not contain a certificate');
  const cert = new X509Certificate(match[0]);
  const spki = cert.publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  return createHash('sha256').update(spki).digest('hex');
}

function fallbackCandidate(): UplinkCandidate {
  return {
    hubNodeId: null,
    publicUrl: 'http://127.0.0.1',
    mode: 'active',
    writerEpoch: 0,
    priority: UPLINK_SEED_PRIORITY_BASE,
    caFingerprint: null,
  };
}

type HubView = {
  byUrl: Map<string, { online: boolean }>;
  writerHubId: string | null;
  writerEpoch: number | null;
  bestKey: string | null;
  attachedIsBest: boolean;
};

export class UplinkPool {
  readonly identity: MeshIdentity;
  lastConnectError: { reason: string; at: number } | null = null;

  private readonly userIdOf: () => string;
  private readonly opts: UplinkPoolOptions;
  private readonly scheduler: MeshScheduler;
  private readonly createClient: CreatePooledUplink;
  private readonly failLimit: number;
  private readonly authDeadlineMs: number;
  private readonly probeIntervalMs: number;
  private readonly probeTimeoutMs: number;
  private readonly probeJitter: number;
  private readonly failbackDebounceMs: number;
  private readonly probeNowDebounceMs: number;
  private readonly rttProbeIntervalMs: number;
  private readonly preferNearestSetting: boolean | null;
  private readonly rttSwitchDwellMs: number;
  private lastRttSwitchAt = 0;

  private live: PooledUplink | null = null;
  pending: PooledUplink | null = null;
  private attached: AttachedHub | null = null;
  private generation = 0;
  private switchToken = 0;
  private loop: Promise<void> | null = null;
  private stopAbort: AbortController | null = null;
  private probe: { clear: () => void } | null = null;
  private probeInFlight = false;
  private rttProbe: { clear: () => void } | null = null;
  private rttProbeInFlight = false;
  private failbackDebounceAbort: AbortController | null = null;
  private failbackCoalesced = false;
  private coalescedDebounceMs: number;
  private failbackProbeDeadlineAt = 0;
  private lastFailbackProbeAt = 0;
  private lastHubView: HubView | null = null;
  private wrapAttempt = 0;
  private relayHandler: InboundRelayHandler | null = null;
  private readonly caBootstraps = new Map<string, Promise<void>>();
  private readonly diagByUrl = new Map<string, UrlDiag>();
  private readonly candLogAt = new Map<
    string,
    { index: number; error: string | null; transport: string; at: number }
  >();
  private wrapSleepAbort: AbortController | null = null;
  private readonly stateListeners: Array<(state: UplinkState) => void> = [];
  private readonly attachedListeners: Array<(hub: AttachedHub) => void> = [];
  private readonly detachedListeners: Array<() => void> = [];
  private readonly nodeListListeners: Array<
    (list: UplinkNodeList, meta: UplinkPoolNodeListMeta) => void
  > = [];
  private liveStateOff: (() => void) | null = null;

  constructor(opts: UplinkPoolOptions) {
    this.opts = opts;
    this.identity = opts.identity;
    const uid = opts.userId;
    this.userIdOf = typeof uid === 'function' ? uid : () => uid;
    this.scheduler = opts.scheduler ?? defaultScheduler();
    this.createClient = opts.createClient ?? ((clientOpts) => new UplinkClient(clientOpts));
    this.failLimit = opts.failLimit ?? UPLINK_POOL_FAIL_LIMIT;
    this.authDeadlineMs = opts.authDeadlineMs ?? UPLINK_POOL_AUTH_DEADLINE_MS;
    this.probeIntervalMs = opts.probeIntervalMs ?? UPLINK_POOL_PROBE_INTERVAL_MS;
    this.probeTimeoutMs = opts.probeTimeoutMs ?? UPLINK_POOL_PROBE_TIMEOUT_MS;
    this.probeJitter = opts.probeJitter ?? UPLINK_POOL_PROBE_JITTER;
    this.failbackDebounceMs = opts.failbackDebounceMs ?? UPLINK_POOL_FAILBACK_DEBOUNCE_MS;
    this.probeNowDebounceMs = opts.probeNowDebounceMs ?? UPLINK_POOL_PROBE_NOW_DEBOUNCE_MS;
    this.coalescedDebounceMs = this.failbackDebounceMs;
    this.rttProbeIntervalMs = opts.rttProbeIntervalMs ?? UPLINK_POOL_RTT_PROBE_INTERVAL_MS;
    this.preferNearestSetting = opts.preferNearest === undefined ? null : opts.preferNearest;
    this.rttSwitchDwellMs = opts.rttSwitchDwellMs ?? UPLINK_RTT_SWITCH_DWELL_MS;
  }

  get userId(): string {
    return this.live?.userId ?? this.pending?.userId ?? this.userIdOf();
  }

  get state(): UplinkState {
    return this.live?.state ?? this.pending?.state ?? 'offline';
  }

  get link() {
    return this.live?.link ?? this.pending?.link ?? null;
  }

  get lastKeyLogHead() {
    return this.live?.lastKeyLogHead ?? this.pending?.lastKeyLogHead ?? null;
  }

  attachedHub(): AttachedHub | null {
    return this.attached;
  }

  candidates(): UplinkCandidate[] {
    const list = this.opts.candidates();
    const base = list.length > 0 ? list : [fallbackCandidate()];
    const withDiag = base.map((row) => {
      const diag = this.diagByUrl.get(normalizeHubEndpointUrl(row.publicUrl));
      let version = row.version ?? null;
      if (version == null && row.hubNodeId) {
        try {
          version = this.opts.userStore.getNode(row.hubNodeId)?.version ?? null;
        } catch {
          version = null;
        }
      }
      return {
        ...row,
        lastError: diag?.lastError ?? row.lastError ?? null,
        lastErrorAt: diag?.lastErrorAt ?? row.lastErrorAt ?? null,
        lastAttemptAt: diag?.lastAttemptAt ?? row.lastAttemptAt ?? null,
        rttMs: diag?.rttMs ?? row.rttMs ?? null,
        rttAt: diag?.rttAt ?? row.rttAt ?? null,
        version,
      };
    });
    if (!this.preferNearestActive(withDiag)) return withDiag;
    return orderCandidatesByNearest(withDiag, {
      rttOf: (publicUrl) => this.rttState(publicUrl),
      writerHubId: writerHubIdOf(withDiag),
      versionOf: (cand) => cand.version,
    });
  }

  currentGeneration(): number {
    return this.generation;
  }

  liveClient(): PooledUplink | null {
    return this.live;
  }

  onAttached(cb: (hub: AttachedHub) => void): () => void {
    this.attachedListeners.push(cb);
    return () => {
      const idx = this.attachedListeners.indexOf(cb);
      if (idx >= 0) this.attachedListeners.splice(idx, 1);
    };
  }

  onDetached(cb: () => void): () => void {
    this.detachedListeners.push(cb);
    return () => {
      const idx = this.detachedListeners.indexOf(cb);
      if (idx >= 0) this.detachedListeners.splice(idx, 1);
    };
  }

  onNodeList(cb: (list: UplinkNodeList, meta: UplinkPoolNodeListMeta) => void): () => void {
    this.nodeListListeners.push(cb);
    return () => {
      const idx = this.nodeListListeners.indexOf(cb);
      if (idx >= 0) this.nodeListListeners.splice(idx, 1);
    };
  }

  onStateChange(cb: (state: UplinkState) => void): () => void {
    this.stateListeners.push(cb);
    return () => {
      const idx = this.stateListeners.indexOf(cb);
      if (idx >= 0) this.stateListeners.splice(idx, 1);
    };
  }

  setOnRelayStream(handler: InboundRelayHandler | null): void {
    this.relayHandler = handler;
    this.live?.setOnRelayStream(handler);
  }

  start(_connectOnce?: (signal: AbortSignal) => Promise<void>): void {
    if (this.loop) return;
    this.stopAbort = new AbortController();
    this.loop = this.run(this.stopAbort.signal);
  }

  async connectWithLink(link: LinkSession, signal?: AbortSignal): Promise<void> {
    const client = this.requireLive();
    await client.connectWithLink(link, signal);
  }

  async stop(): Promise<void> {
    this.stopAbort?.abort();
    this.stopAbort = null;
    this.stopProbe();
    this.stopRttProbe();
    this.cancelFailbackDebounce();
    this.failbackCoalesced = false;
    const live = this.live;
    const pending = this.pending;
    this.live = null;
    this.pending = null;
    if (this.attached) {
      this.attached = null;
      this.emitDetached();
    }
    this.unbindLiveState();
    const loop = this.loop;
    this.loop = null;
    await pending?.stop();
    await live?.stop();
    try {
      if (loop) await loop;
    } catch {
      /* cancelled */
    }
    this.emitState('offline');
  }

  sendCtl(msg: UplinkCtlMessage): void {
    this.requireLive().sendCtl(msg);
  }

  sendStatus(): void {
    this.live?.sendStatus();
  }

  sendStatusIfChanged(): boolean {
    return this.live?.sendStatusIfChanged() ?? false;
  }

  openRelay(toNodeId: string) {
    return this.requireLive().openRelay(toNodeId);
  }

  queryHubHead() {
    return this.requireLive().queryHubHead();
  }

  queryKeyLogAt(seq: bigint, timeoutMs?: number) {
    return this.requireLive().queryKeyLogAt(seq, timeoutMs);
  }

  appendAndAck(
    record: { bytes: Uint8Array; sig: Uint8Array },
    timeoutMs?: number,
    generation?: number
  ) {
    return this.requireLive().appendAndAck(record, timeoutMs, generation);
  }

  requestProbeNow(): void {
    this.scheduleProbe(this.probeNowDebounceMs);
  }

  async switchTo(publicUrl: string, signal?: AbortSignal): Promise<void> {
    return runUplinkSwitch(this, publicUrl, signal);
  }

  stopSignal(): AbortSignal | null {
    return this.stopAbort?.signal ?? null;
  }

  private requireLive(): PooledUplink {
    const live = this.live;
    if (!live) throw new Error('uplink is not online');
    return live;
  }

  private async run(signal: AbortSignal): Promise<void> {
    this.syncRttProbe();
    while (!signal.aborted) {
      const cands = this.candidates();
      let session = false;
      for (let i = 0; i < cands.length; i += 1) {
        const cand = cands[i];
        if (!cand || signal.aborted) return;
        session = await this.tryCandidate(cand, signal, i, cands.length);
        if (session) break;
        const next = cands[i + 1];
        if (next) {
          const nextTransport = this.isLocalTransport(next) ? 'memory' : 'ws';
          this.logCandidateEvent(next, i + 1, nextTransport, this.lastErrorOf(next), 'failover');
        }
      }
      if (signal.aborted) return;
      if (session) {
        this.wrapAttempt = 0;
        try {
          await this.scheduler.sleep(
            backoffDelayMs(0, UPLINK_BACKOFF_MIN_MS, UPLINK_BACKOFF_MAX_MS),
            signal
          );
        } catch {
          return;
        }
        continue;
      }
      const delay = backoffDelayMs(this.wrapAttempt, UPLINK_BACKOFF_MIN_MS, UPLINK_BACKOFF_MAX_MS);
      this.wrapAttempt += 1;
      this.wrapSleepAbort = new AbortController();
      const combined = anyAbort(signal, this.wrapSleepAbort.signal);
      try {
        await this.scheduler.sleep(delay, combined);
      } catch {
        if (signal.aborted) return;
      } finally {
        this.wrapSleepAbort = null;
      }
    }
  }

  beginSwitch(): number {
    this.switchToken += 1;
    return this.switchToken;
  }

  isSwitchCurrent(token: number): boolean {
    return token === this.switchToken && !this.stopAbort?.signal.aborted;
  }

  isLocalTransport(cand: UplinkCandidate): boolean {
    return this.opts.isLocalCandidate?.(cand) === true && Boolean(this.opts.connectLocal);
  }

  async connectCandidate(
    client: PooledUplink,
    cand: UplinkCandidate,
    signal: AbortSignal
  ): Promise<void> {
    if (this.isLocalTransport(cand) && this.opts.connectLocal) {
      await this.opts.connectLocal(client, signal);
      return;
    }
    await client.attemptConnect(signal);
  }

  private async tryCandidate(
    cand: UplinkCandidate,
    signal: AbortSignal,
    index = 0,
    total = 1
  ): Promise<boolean> {
    const deadline = new AbortController();
    const combined = anyAbort(signal, deadline.signal);
    const deadlineStarted = this.scheduler.now();
    const sleeper = this.scheduler.sleep(this.authDeadlineMs, deadline.signal).then(
      () => {
        if (this.scheduler.now() - deadlineStarted < this.authDeadlineMs) return;
        if (!deadline.signal.aborted) deadline.abort();
      },
      () => {}
    );
    const token = this.beginSwitch();
    const client = this.spawn(cand);
    this.pending = client;
    const transport = this.isLocalTransport(cand) ? 'memory' : 'ws';
    this.noteAttempt(cand);
    this.logCandidateEvent(cand, index, transport, this.lastErrorOf(cand), 'try', { total });
    let failures = 0;
    try {
      while (failures < this.failLimit && !combined.aborted) {
        try {
          await this.connectCandidate(client, cand, combined);
          if (!this.isSwitchCurrent(token)) {
            if (this.live?.state === 'online') {
              await this.waitActiveSession(this.live, signal);
              return true;
            }
            return false;
          }
          deadline.abort();
          await this.promote(client, cand, token);
          const reason = await this.waitActiveSession(this.live ?? client, signal);
          if (reason) this.noteFailure(cand, reason);
          return true;
        } catch (err) {
          failures += 1;
          const msg = errMessage(err);
          this.lastConnectError = { reason: msg, at: this.scheduler.now() };
          this.noteFailure(cand, msg);
          this.logCandidateFailed(cand, msg, failures, index, transport);
          this.logMissingCaPin(cand, err);
          if (combined.aborted || failures >= this.failLimit) break;
        }
      }
      return false;
    } finally {
      deadline.abort();
      await sleeper.catch(() => {});
      if (this.pending === client) this.pending = null;
      if (this.live === client) {
        this.persistTerminalError(client, cand.publicUrl);
        this.clearLive(client);
      }
      if (this.live !== client) {
        try {
          await client.stop();
        } catch {
          /* ignore */
        }
      }
    }
  }

  spawn(cand: UplinkCandidate): PooledUplink {
    const pin = this.opts.hubTrust.get(cand.publicUrl);
    const tlsCa = pin?.caPem ? [pin.caPem] : null;
    const wsFactory = this.opts.wsFactory ?? defaultWsFactory(tlsCa);
    const slot: { client: PooledUplink | null } = { client: null };
    const sourceOf = (): UplinkPoolCtlSource => ({
      hubNodeId: this.attached?.hubNodeId ?? cand.hubNodeId ?? '',
      generation: this.generation,
    });
    const ifLive = <T>(fn: (source: UplinkPoolCtlSource) => T): T | undefined => {
      if (!slot.client || this.live !== slot.client) return undefined;
      return fn(sourceOf());
    };
    const client = this.createClient({
      hubUrl: cand.publicUrl,
      identity: this.opts.identity,
      userId: this.userIdOf,
      keyLogApplier: this.opts.keyLogApplier,
      userStore: this.opts.userStore,
      statusProvider: this.opts.statusProvider,
      wsFactory,
      tlsCa,
      scheduler: this.scheduler,
      pingIntervalMs: this.opts.pingIntervalMs,
      onNodeList: (list) => this.dispatchNodeList(client, list, cand.hubNodeId),
      onRtcSignal: (msg) => {
        if (this.live !== client) return;
        this.opts.onRtcSignal?.(msg);
      },
      onEnrollRedeemed: (msg) => {
        if (this.live !== client) return;
        this.opts.onEnrollRedeemed?.(msg);
      },
      onKeyLogFork: (event) => {
        if (this.live !== client) return;
        this.opts.onKeyLogFork?.(event);
      },
      onHubTokens: (msg) => {
        ifLive((source) => this.opts.onHubTokens?.(msg, source));
      },
      onHubAttachments: (msg) => {
        ifLive((source) => this.opts.onHubAttachments?.(msg, source));
      },
      onHubForward: (msg) => {
        ifLive((source) => this.opts.onHubForward?.(msg, source));
      },
      onHubWriteForward: (msg) => {
        ifLive((source) => this.opts.onHubWriteForward?.(msg, source));
      },
      onHubRelayStream: (stream) => {
        if (!slot.client || this.live !== slot.client) {
          stream.reset('stale');
          return;
        }
        this.opts.onHubRelayStream?.(stream, sourceOf());
      },
    });
    slot.client = client;
    return client;
  }

  async promote(client: PooledUplink, cand: UplinkCandidate, token: number): Promise<void> {
    if (!this.isSwitchCurrent(token)) {
      await client.stop();
      return;
    }
    const old = this.live !== client ? this.live : null;
    this.generation += 1;
    this.pending = null;
    this.live = client;
    this.bindLiveState(client);
    client.setOnRelayStream(this.relayHandler);
    this.attached = {
      hubNodeId: cand.hubNodeId,
      publicUrl: cand.publicUrl,
      mode: cand.mode,
      writerEpoch: cand.writerEpoch,
      since: this.scheduler.now(),
    };
    this.emitAttached(this.attached);
    this.emitState(client.state);
    this.noteSuccess(cand);
    client.sendStatusIfChanged();
    this.syncProbe();
    this.syncRttProbe();
    if (old) {
      old.setOnRelayStream(null);
      try {
        await old.stop();
      } catch {
        /* ignore */
      }
    }
  }

  private dispatchNodeList(
    client: PooledUplink,
    list: UplinkNodeList,
    hubNodeId: string | null
  ): void {
    if (this.live !== client) return;
    this.opts.onNodeList?.(list, {
      hubNodeId: this.attached?.hubNodeId ?? hubNodeId,
      generation: this.generation,
    });
    this.refreshAttachedFromList(list);
    this.refreshAttachedFromCandidates();
    const meta = {
      hubNodeId: this.attached?.hubNodeId ?? hubNodeId,
      generation: this.generation,
    };
    for (const cb of this.nodeListListeners) {
      try {
        cb(list, meta);
      } catch {
        /* listener errors must not break the pool */
      }
    }
    const shouldFailback = this.shouldTriggerFailbackProbe(list);
    this.lastHubView = this.captureHubView(list);
    if (shouldFailback) this.requestFailbackProbeFromNodeList();
    this.syncProbe();
    this.syncRttProbe();
    void this.pinAdvertisedCas(list);
    void this.pinCandidateFingerprints();
  }

  private applyAttachedMatch(match: Pick<AttachedHub, 'hubNodeId' | 'mode' | 'writerEpoch'>): void {
    if (!this.attached) return;
    this.attached.hubNodeId = match.hubNodeId;
    this.attached.mode = match.mode;
    this.attached.writerEpoch = match.writerEpoch;
  }
  private refreshAttachedFromList(list: UplinkNodeList): void {
    const attached = this.attached;
    if (!attached) return;
    const recs = recordsFromNodeList(list);
    const match = recs.find((row) => sameHubUrl(row.publicUrl, attached.publicUrl));
    if (match) this.applyAttachedMatch(match);
  }

  private refreshAttachedFromCandidates(): void {
    const attached = this.attached;
    if (!attached) return;
    const match = this.candidates().find((row) => sameHubUrl(row.publicUrl, attached.publicUrl));
    if (match) this.applyAttachedMatch(match);
  }

  private async pinAdvertisedCas(list: UplinkNodeList): Promise<void> {
    const hubs = list.hubs ?? [];
    await Promise.all(hubs.map((hub) => this.pinAdvertisedCa(hub)));
  }

  private pinAdvertisedCa(hub: {
    publicUrl: string;
    caFingerprint?: string | null;
  }): Promise<void> {
    const advertised = hub.caFingerprint?.trim().toLowerCase() ?? '';
    if (!advertised || !isCaFingerprintHex(advertised)) return Promise.resolve();
    if (this.opts.hubTrust.get(hub.publicUrl)) return Promise.resolve();
    const key = normalizeHubEndpointUrl(hub.publicUrl);
    const existing = this.caBootstraps.get(key);
    if (existing) return existing;
    const work = this.doPinAdvertisedCa(hub.publicUrl, advertised).finally(() => {
      if (this.caBootstraps.get(key) === work) this.caBootstraps.delete(key);
    });
    this.caBootstraps.set(key, work);
    return work;
  }

  private async pinCandidateFingerprints(): Promise<void> {
    await Promise.all(
      this.candidates().map((cand) =>
        this.pinAdvertisedCa({ publicUrl: cand.publicUrl, caFingerprint: cand.caFingerprint })
      )
    );
  }

  private async doPinAdvertisedCa(publicUrl: string, advertised: string): Promise<void> {
    try {
      const pem = await (this.opts.fetchCaPem ?? defaultFetchCaPem)(publicUrl);
      if (!this.opts.fingerprintPem) parseSingleCaCertificate(pem);
      const fingerprint = (this.opts.fingerprintPem ?? spkiFingerprintFromPem)(pem).toLowerCase();
      if (fingerprint !== advertised) {
        this.logInfo(
          `[uplink] ca bootstrap failed url=${redactUrl(publicUrl)} err=fingerprint_mismatch`
        );
        return;
      }
      this.opts.hubTrust.put({
        hubUrl: publicUrl,
        caPem: pem,
        fingerprint,
      });
      this.logInfo(`[uplink] ca pin stored url=${redactUrl(publicUrl)} fp=${fingerprint}`);
      this.wakeWrapSleep();
    } catch (err) {
      this.logInfo(
        `[uplink] ca bootstrap failed url=${redactUrl(publicUrl)} err=${errMessage(err)}`
      );
    }
  }

  private async waitActiveSession(
    origin: PooledUplink,
    signal: AbortSignal
  ): Promise<string | null> {
    let current = origin;
    let reason: string | null = null;
    while (this.live && !signal.aborted) {
      current = this.live;
      await this.waitWhileLive(current, signal);
      reason = terminalErrorOf(current);
      if (this.live === current) break;
    }
    return reason;
  }

  private persistTerminalError(client: PooledUplink, publicUrl: string): void {
    const reason = terminalErrorOf(client);
    if (!reason) return;
    this.noteFailure({ publicUrl }, reason);
  }

  private async waitWhileLive(client: PooledUplink, signal: AbortSignal): Promise<void> {
    if (this.live !== client || signal.aborted) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        off();
        signal.removeEventListener('abort', finish);
        resolve();
      };
      const off = client.onStateChange((state) => {
        if (state === 'offline' || this.live !== client) finish();
      });
      if (signal.aborted || this.live !== client || client.state === 'offline') {
        finish();
        return;
      }
      signal.addEventListener('abort', finish, { once: true });
      void client.waitUntilClosed(signal).then(finish);
    });
  }

  private clearLive(client: PooledUplink): void {
    if (this.live !== client) return;
    this.live = null;
    this.unbindLiveState();
    this.stopProbe();
    if (this.attached) {
      this.attached = null;
      this.emitDetached();
    }
    this.emitState('offline');
  }

  private bindLiveState(client: PooledUplink): void {
    this.unbindLiveState();
    this.liveStateOff = client.onStateChange((state) => {
      if (this.live === client) this.emitState(state);
    });
  }

  private unbindLiveState(): void {
    this.liveStateOff?.();
    this.liveStateOff = null;
  }

  private syncProbe(): void {
    this.stopProbe();
    const attached = this.attached;
    if (!attached) return;
    const idx = this.candidates().findIndex((row) => sameHubUrl(row.publicUrl, attached.publicUrl));
    if (idx <= 0) return;
    this.probe = this.scheduler.interval(
      () => {
        void this.probePreferred();
      },
      jitteredIntervalMs(this.probeIntervalMs, this.probeJitter)
    );
  }

  private stopProbe(): void {
    this.probe?.clear();
    this.probe = null;
  }

  private periodicRttEnabled(): boolean {
    return this.opts.enablePeriodicRttProbe ?? process.env.NODE_ENV !== 'test';
  }

  private syncRttProbe(): void {
    if (!this.periodicRttEnabled() || this.candidates().length < 2) {
      this.stopRttProbe();
      return;
    }
    if (this.rttProbe) return;
    this.rttProbe = this.scheduler.interval(
      () => {
        void this.probeAllCandidateRtts();
      },
      jitteredIntervalMs(this.rttProbeIntervalMs, this.probeJitter)
    );
  }

  private stopRttProbe(): void {
    this.rttProbe?.clear();
    this.rttProbe = null;
  }

  private async probeAllCandidateRtts(): Promise<void> {
    if (this.rttProbeInFlight) return;
    this.rttProbeInFlight = true;
    try {
      const cands = this.candidates();
      if (cands.length < 2) return;
      for (const cand of cands) {
        if (this.stopAbort?.signal.aborted) return;
        await this.probeHealthzTimed(cand.publicUrl);
      }
      await this.considerNearestSwitch();
    } finally {
      this.rttProbeInFlight = false;
    }
  }

  private preferNearestActive(cands?: UplinkCandidate[]): boolean {
    if (this.opts.localRoles?.hub) return false;
    if (this.preferNearestSetting === false) return false;
    const list = cands ?? this.opts.candidates();
    return list.filter((row) => row.hubNodeId).length > 1;
  }

  private rttState(publicUrl: string): { ewma: number; samples: number } | null {
    const diag = this.diagByUrl.get(normalizeHubEndpointUrl(publicUrl));
    if (!diag || diag.rttMs == null || diag.rttSamples < 1) return null;
    return { ewma: diag.rttMs, samples: diag.rttSamples };
  }

  private async considerNearestSwitch(): Promise<void> {
    if (!this.preferNearestActive()) return;
    const attached = this.attached;
    if (!attached || this.live?.state !== 'online') return;
    const now = this.scheduler.now();
    if (this.lastRttSwitchAt > 0 && now - this.lastRttSwitchAt < this.rttSwitchDwellMs) return;
    const currentRtt = this.rttState(attached.publicUrl);
    if (!currentRtt || currentRtt.samples < UPLINK_RTT_MIN_SAMPLES) return;
    const ordered = this.candidates();
    const best = ordered[0];
    if (!best || sameHubUrl(best.publicUrl, attached.publicUrl)) return;
    const bestRtt = this.rttState(best.publicUrl);
    if (!bestRtt || bestRtt.samples < UPLINK_RTT_MIN_SAMPLES) return;
    if (!isRttSwitchWorth(currentRtt.ewma, bestRtt.ewma)) return;
    const writerId = writerHubIdOf(ordered);
    const isWriter = Boolean(best.hubNodeId) && best.hubNodeId === writerId;
    if (!isWriter && !hubSupportsNearestAttach(best.version)) return;
    const ok = await this.probeHealthzTimed(best.publicUrl);
    if (!ok) return;
    try {
      await this.switchTo(best.publicUrl);
      this.lastRttSwitchAt = this.scheduler.now();
      this.logInfo(`[uplink] nearest → hub=${redactUrl(best.publicUrl)}`);
    } catch {
      /* keep current attachment */
    }
  }

  private captureHubView(list: UplinkNodeList): HubView {
    const recs = recordsFromNodeList(list);
    const byUrl = new Map<string, { online: boolean }>();
    for (const rec of recs) {
      byUrl.set(normalizeHubEndpointUrl(rec.publicUrl), { online: rec.online === true });
    }
    const writerHubId = list.writerHubId ?? pickWriterHub(recs);
    const writerEpoch =
      list.writerEpoch ?? recs.find((row) => row.hubNodeId === writerHubId)?.writerEpoch ?? null;
    const cands = this.candidates();
    const attached = this.attached;
    const attachedIdx = attached
      ? cands.findIndex((row) => sameHubUrl(row.publicUrl, attached.publicUrl))
      : -1;
    return {
      byUrl,
      writerHubId,
      writerEpoch,
      bestKey: cands[0] ? normalizeHubEndpointUrl(cands[0].publicUrl) : null,
      attachedIsBest: attachedIdx === 0,
    };
  }

  private shouldTriggerFailbackProbe(list: UplinkNodeList): boolean {
    const attached = this.attached;
    if (!attached) return false;
    const next = this.captureHubView(list);
    const prev = this.lastHubView;
    const cands = this.candidates();
    const attachedIdx = cands.findIndex((row) => sameHubUrl(row.publicUrl, attached.publicUrl));
    let aheadCameOnline = false;
    if (attachedIdx > 0) {
      for (let i = 0; i < attachedIdx; i += 1) {
        const cand = cands[i];
        if (!cand) continue;
        const key = normalizeHubEndpointUrl(cand.publicUrl);
        const nowOnline = next.byUrl.get(key)?.online === true;
        const wasOnline = prev?.byUrl.get(key)?.online === true;
        if (nowOnline && !wasOnline) {
          aheadCameOnline = true;
          break;
        }
      }
    }
    const writerChanged =
      prev != null &&
      (prev.writerHubId !== next.writerHubId || prev.writerEpoch !== next.writerEpoch);
    const lostBest =
      !next.attachedIsBest &&
      (prev == null || prev.attachedIsBest || prev.bestKey !== next.bestKey);
    return aheadCameOnline || writerChanged || lostBest;
  }

  private requestFailbackProbeFromNodeList(): void {
    this.logFailbackFromNodeList();
    this.scheduleProbe(this.failbackDebounceMs);
  }

  private probeDelayRemaining(debounceMs: number): number {
    if (this.lastFailbackProbeAt <= 0) return 0;
    return Math.max(0, debounceMs - (this.scheduler.now() - this.lastFailbackProbeAt));
  }

  private cancelFailbackDebounce(): void {
    this.failbackDebounceAbort?.abort();
    this.failbackDebounceAbort = null;
    this.failbackProbeDeadlineAt = 0;
  }

  private noteProbeCoalesce(debounceMs: number): void {
    this.failbackCoalesced = true;
    this.coalescedDebounceMs = Math.min(this.coalescedDebounceMs, debounceMs);
  }

  private scheduleProbe(debounceMs: number): void {
    if (this.probeInFlight) {
      this.noteProbeCoalesce(debounceMs);
      return;
    }
    const now = this.scheduler.now();
    const delay = this.probeDelayRemaining(debounceMs);
    const deadline = now + delay;
    if (this.failbackDebounceAbort) {
      if (deadline >= this.failbackProbeDeadlineAt) return;
      this.cancelFailbackDebounce();
    }
    if (delay <= 0) {
      this.failbackProbeDeadlineAt = 0;
      void this.runFailbackProbe();
      return;
    }
    const ac = new AbortController();
    this.failbackDebounceAbort = ac;
    this.failbackProbeDeadlineAt = deadline;
    const stop = this.stopAbort?.signal;
    const combined = stop ? anyAbort(stop, ac.signal) : ac.signal;
    void this.scheduler.sleep(delay, combined).then(
      () => {
        if (this.failbackDebounceAbort !== ac) return;
        this.failbackDebounceAbort = null;
        this.failbackProbeDeadlineAt = 0;
        void this.runFailbackProbe();
      },
      () => {
        if (this.failbackDebounceAbort !== ac) return;
        this.failbackDebounceAbort = null;
        this.failbackProbeDeadlineAt = 0;
      }
    );
  }

  private async runFailbackProbe(): Promise<void> {
    if (this.probeInFlight) {
      this.noteProbeCoalesce(this.failbackDebounceMs);
      return;
    }
    this.lastFailbackProbeAt = this.scheduler.now();
    await this.probePreferred();
  }

  private logFailbackFromNodeList(): void {
    const now = this.scheduler.now();
    const key = 'failback\0node.list';
    const prev = this.candLogAt.get(key);
    if (prev && now - prev.at < UPLINK_POOL_FAIL_LOG_INTERVAL_MS) return;
    this.candLogAt.set(key, { index: 0, error: null, transport: '', at: now });
    this.logInfo('[uplink] failback probe triggered by node.list');
  }

  private async probePreferred(): Promise<void> {
    if (this.probeInFlight) return;
    this.probeInFlight = true;
    try {
      const attached = this.attached;
      if (!attached) return;
      const cands = this.candidates();
      const idx = cands.findIndex((row) => sameHubUrl(row.publicUrl, attached.publicUrl));
      if (idx <= 0) {
        this.stopProbe();
        return;
      }
      for (let i = 0; i < idx; i += 1) {
        const pref = cands[i];
        if (!pref) continue;
        const ok = await this.probeHealthzTimed(pref.publicUrl);
        if (!ok) {
          this.logInfo(`[uplink] probe fail hub=${redactUrl(pref.publicUrl)}`);
          continue;
        }
        this.logInfo(`[uplink] probe ok hub=${redactUrl(pref.publicUrl)}`);
        try {
          await this.switchTo(pref.publicUrl);
          const transport = this.isLocalTransport(pref) ? 'memory' : 'ws';
          this.logCandidateEvent(pref, i, transport, this.lastErrorOf(pref), 'switch-back');
        } catch {
          /* keep current attachment */
        }
        return;
      }
    } finally {
      this.probeInFlight = false;
      if (this.failbackCoalesced) {
        this.failbackCoalesced = false;
        const debounce = this.coalescedDebounceMs;
        this.coalescedDebounceMs = this.failbackDebounceMs;
        this.scheduleProbe(debounce);
      }
    }
  }

  private async probeHealthzTimed(publicUrl: string): Promise<boolean> {
    if (this.stopAbort?.signal.aborted) return false;
    let tlsCa: string[] | null = null;
    try {
      const pin = this.opts.hubTrust.get(publicUrl);
      tlsCa = pin?.caPem ? [pin.caPem] : null;
    } catch {
      tlsCa = null;
    }
    const probe = this.opts.probeHealthz ?? defaultProbeHealthz;
    const started = performance.now();
    let ok = false;
    try {
      ok = await probe(publicUrl, tlsCa, this.probeTimeoutMs);
    } catch {
      ok = false;
    }
    if (this.stopAbort?.signal.aborted) return false;
    if (ok) {
      this.noteRtt(publicUrl, Math.max(0, Math.round(performance.now() - started)));
    } else {
      this.patchDiag(publicUrl, { rttMs: null, rttAt: null, rttSamples: 0 });
    }
    return ok;
  }

  private patchDiag(publicUrl: string, patch: Partial<UrlDiag>): void {
    const key = normalizeHubEndpointUrl(publicUrl);
    this.diagByUrl.set(key, mergeUplinkDiag(this.diagByUrl.get(key) ?? emptyUplinkDiag(), patch));
  }

  private noteRtt(publicUrl: string, rttMs: number): void {
    const prev = this.diagByUrl.get(normalizeHubEndpointUrl(publicUrl)) ?? emptyUplinkDiag();
    const samples = prev.rttSamples + 1;
    const ewma =
      samples === 1 || prev.rttMs == null
        ? rttMs
        : Math.round(UPLINK_RTT_EWMA_ALPHA * rttMs + (1 - UPLINK_RTT_EWMA_ALPHA) * prev.rttMs);
    this.patchDiag(publicUrl, { rttMs: ewma, rttAt: this.scheduler.now(), rttSamples: samples });
  }

  noteAttempt(cand: UplinkCandidate): void {
    this.patchDiag(cand.publicUrl, { lastAttemptAt: this.scheduler.now() });
  }

  noteFailure(cand: Pick<UplinkCandidate, 'publicUrl'>, msg: string): void {
    const at = this.scheduler.now();
    this.patchDiag(cand.publicUrl, { lastError: msg, lastErrorAt: at, lastAttemptAt: at });
  }

  private noteSuccess(cand: UplinkCandidate): void {
    this.lastConnectError = null;
    this.patchDiag(cand.publicUrl, { lastError: null, lastErrorAt: null });
  }

  lastErrorOf(cand: UplinkCandidate): string | null {
    return this.diagByUrl.get(normalizeHubEndpointUrl(cand.publicUrl))?.lastError ?? null;
  }

  logCandidateFailed(
    cand: UplinkCandidate,
    msg: string,
    fails: number,
    index: number,
    transport: string
  ): void {
    this.logCandidateEvent(cand, index, transport, msg, 'failed', { fails });
  }

  logCandidateEvent(
    cand: UplinkCandidate,
    index: number,
    transport: string,
    error: string | null,
    kind: 'try' | 'failover' | 'switch-back' | 'failed',
    extra?: { fails?: number; total?: number }
  ): void {
    const origin = redactUrl(cand.publicUrl);
    const key = `${normalizeHubEndpointUrl(cand.publicUrl)}\0${kind}`;
    const now = this.scheduler.now();
    const stateError = kind === 'failed' ? error : null;
    const prev = this.candLogAt.get(key);
    if (
      prev &&
      prev.index === index &&
      prev.error === stateError &&
      prev.transport === transport &&
      now - prev.at < UPLINK_POOL_FAIL_LOG_INTERVAL_MS
    ) {
      return;
    }
    this.candLogAt.set(key, { index, error: stateError, transport, at: now });
    if (kind === 'try') {
      this.logInfo(
        `[uplink] try hub=${origin} mode=${cand.mode} epoch=${cand.writerEpoch} idx=${index + 1}/${extra?.total ?? this.candidates().length} transport=${transport}`
      );
      return;
    }
    if (kind === 'failover') {
      this.logInfo(`[uplink] failover → hub=${origin}`);
      return;
    }
    if (kind === 'switch-back') {
      this.logInfo(`[uplink] switch-back → hub=${origin}`);
      return;
    }
    this.logInfo(
      `[uplink] candidate failed hub=${origin} err=${error ?? ''} fails=${extra?.fails ?? 1}`
    );
  }

  logMissingCaPin(cand: UplinkCandidate, err: unknown): void {
    if (!isTlsCertificateError(err)) return;
    if (this.opts.hubTrust.get(cand.publicUrl)) return;
    const advertised = cand.caFingerprint?.trim() ?? '';
    if (advertised && isCaFingerprintHex(advertised)) return;
    this.logInfo(
      `[uplink] no CA pin for ${redactUrl(cand.publicUrl)} and no advertised fingerprint`
    );
  }

  private wakeWrapSleep(): void {
    const wake = this.wrapSleepAbort;
    if (!wake || wake.signal.aborted) return;
    wake.abort();
  }

  private logInfo(line: string): void {
    console.info(stamp(line));
  }

  private emitState(state: UplinkState): void {
    for (const cb of this.stateListeners) {
      try {
        cb(state);
      } catch {
        /* listener errors must not break the pool */
      }
    }
  }

  private emitAttached(hub: AttachedHub): void {
    for (const cb of this.attachedListeners) {
      try {
        cb(hub);
      } catch {
        /* ignore */
      }
    }
  }

  private emitDetached(): void {
    for (const cb of this.detachedListeners) {
      try {
        cb();
      } catch {
        /* ignore */
      }
    }
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isTlsCertificateError(err: unknown): boolean {
  const msg = errMessage(err).toLowerCase();
  return /tls|certificate|cert_|unable to verify|self[- ]signed|untrusted|err_cert|ssl|hostname/.test(
    msg
  );
}

function defaultWsFactory(tlsCa: string[] | null): UplinkWsFactory {
  return (url) => {
    const tls = uplinkWebSocketTls(tlsCa);
    return tls ? new WebSocket(url, tls as never) : new WebSocket(url);
  };
}

export function anyAbort(a: AbortSignal, b: AbortSignal): AbortSignal {
  const out = new AbortController();
  const abort = () => {
    if (!out.signal.aborted) out.abort();
  };
  if (a.aborted || b.aborted) {
    abort();
    return out.signal;
  }
  a.addEventListener('abort', abort, { once: true });
  b.addEventListener('abort', abort, { once: true });
  return out.signal;
}

export function attachedHubHost(
  attached: AttachedHub | null,
  fallbackUrl?: string | null
): string | null {
  const url = attached?.publicUrl ?? fallbackUrl;
  if (!url) return null;
  try {
    return hubHostFromUrl(url);
  } catch {
    return null;
  }
}
