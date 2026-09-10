import { type DtlsFingerprint, encodeBase64url, normalizeFingerprint } from '@vibeterm/shared/auth';
import type { UserStore } from '../../auth/user-store';
import type { Carrier } from '../../ws/carrier';
import type { GatewaySession } from '../../ws/gateway-session';
import type {
  RtcAuthorizeBrowserInput,
  RtcAuthorizeBrowserResult,
  RtcFingerprintProvider,
} from '../mesh-deps';
import type { MeshIdentity } from '../types';
import { PeerHandshakeError } from '../types';
import {
  type AttachDirectOptions,
  CarrierSwitchController,
  type CarrierSwitchOptions,
  type DirectCarrier,
  type SendControl,
  type VerifyInbound,
} from './carrier-switch';
import { fanoutDataChannel } from './channel-fanout';
import { DataChannelCarrier } from './data-channel-carrier';
import type { DataChannelLink, DataChannelLinkOptions } from './data-channel-link';
import {
  type RtcSignaling,
  buildRtcIceConfig,
  buildRtcIceConfigResolved,
  peerRtcSession,
} from './ice';
import type {
  DataChannelLike,
  IceServerConfig,
  LoadNative,
  NodeDatachannelModule,
  PeerConnectionLike,
} from './native';
import {
  createRtcDialProgress,
  isRtcTimeoutFailure,
  isSupersededDcLoss,
} from './rtc-dial-progress';
import {
  type RtcLogContext,
  createIceCandidateTrace,
  rtcLog,
  runWithRtcLogContext,
} from './rtc-log';
import { bindPeerSignaling, runPeerHandshake } from './rtc-peer-connect';
import {
  type LocalDescriptionEvent,
  type LocalDescriptionHub,
  type RtcDialAggregate,
  attachPcDiagnostics,
  createRtcDialAggregate,
  emptyPairCounts,
  fingerprintsEqual,
  formatPairCounts,
  logRtcDialStart,
  logRtcDialTimeout,
  parseNonceMessage,
  selectedCandidatePairType,
  timeoutFailureMessage,
  waitChannelOpen,
  waitDataChannel,
  waitFirstMessage,
  waitForLocalFingerprint,
} from './rtc-peer-helpers';

export const RTC_AUTHORIZE_TTL_MS = 120_000;
export const RTC_AUTHORIZE_MAX = 64;
export const RTC_AUTHORIZE_SWEEP_INTERVAL_MS = 15_000;
export const SESS_CHANNEL_LABEL = 'sess';
export const PEER_CHANNEL_LABEL = 'peer';
export const CONNECT_TIMEOUT_MS = 15_000;
export const RTC_SUMMARY_INTERVAL_MS = 60_000;

export type IceConfigProvider = () => IceServerConfig;

export type ConnectToPeerOptions = {
  attemptId?: string;
};

export type RtcLivenessOptions = Omit<DataChannelLinkOptions, 'reassembler' | 'peer' | 'liveness'>;

export type RtcPeerManagerOptions = {
  loadNative: LoadNative;
  iceConfigProvider: IceConfigProvider;
  identity: MeshIdentity;
  userStore: UserStore;
  now?: () => number;
  sendControl?: SendControl;
  deliverInbound?: (session: GatewaySession, bytes: Uint8Array) => void;
  verifyInbound?: VerifyInbound;
  handshakeTimeoutMs?: number;
  authorizeTtlMs?: number;
  authorizeMax?: number;
  sweepIntervalMs?: number;
  liveness?: RtcLivenessOptions | false;
  canLoadNative?: () => boolean;
};

export type CreatedPeerConnection = {
  pc: PeerConnectionLike;
  fingerprint: DtlsFingerprint;
  channel: DataChannelLike | null;
};

export type DcPeerConnectResult = {
  link: DataChannelLink;
  pc: PeerConnectionLike;
  peerNodeId: string;
  role: 'initiator' | 'acceptor';
};

export type AuthorizeBrowserInput = RtcAuthorizeBrowserInput;
export type AuthorizeBrowserResult = RtcAuthorizeBrowserResult;

export type AcceptBrowserResult = {
  carrier: DataChannelCarrier;
  pc: PeerConnectionLike;
  uid: string;
  sid: string;
  via: string;
  rtcSession: string;
  connectionId: string;
};

export type BrowserAuthorization = {
  rtcSession: string;
  uid: string;
  sid: string;
  via: string;
  connectionId: string;
};

type BrowserRecord = {
  rtcSession: string;
  uid: string;
  sid: string;
  via: string;
  connectionId: string;
  nonce: Uint8Array | null;
  fpBrowser: DtlsFingerprint | null;
  fpNode: DtlsFingerprint | null;
  exp: number;
  pc: PeerConnectionLike;
};

export class RtcPeerManager implements RtcFingerprintProvider {
  readonly identity: MeshIdentity;
  private readonly loadNative: LoadNative;
  private readonly iceConfigProvider: IceConfigProvider;
  private readonly userStore: UserStore;
  private readonly now: () => number;
  private readonly handshakeTimeoutMs: number;
  private readonly authorizeTtlMs: number;
  private readonly authorizeMax: number;
  private readonly switcher: CarrierSwitchController | null;
  private readonly liveness: RtcLivenessOptions | false;
  private readonly canLoadNative?: () => boolean;
  private loadPromise: Promise<NodeDatachannelModule | null> | null = null;
  private native: NodeDatachannelModule | null = null;
  private nativeMissing = false;
  private readonly browser = new Map<string, BrowserRecord>();
  private readonly livePcs = new Set<PeerConnectionLike>();
  private readonly localDescriptionHubs = new WeakMap<PeerConnectionLike, LocalDescriptionHub>();
  private readonly dialAggregates = new Map<string, RtcDialAggregate>();
  private rtcAttemptEpoch = 0;
  private logSeq = 0;
  private probePc: PeerConnectionLike | null = null;
  private probeFp: DtlsFingerprint | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: RtcPeerManagerOptions) {
    this.identity = opts.identity;
    this.loadNative = opts.loadNative;
    this.iceConfigProvider = opts.iceConfigProvider;
    this.userStore = opts.userStore;
    this.now = opts.now ?? Date.now;
    this.handshakeTimeoutMs = opts.handshakeTimeoutMs ?? CONNECT_TIMEOUT_MS;
    this.authorizeTtlMs = opts.authorizeTtlMs ?? RTC_AUTHORIZE_TTL_MS;
    this.authorizeMax = opts.authorizeMax ?? RTC_AUTHORIZE_MAX;
    this.liveness = opts.liveness === undefined ? {} : opts.liveness;
    this.canLoadNative = opts.canLoadNative;
    const sweepIntervalMs = opts.sweepIntervalMs ?? RTC_AUTHORIZE_SWEEP_INTERVAL_MS;
    if (sweepIntervalMs > 0) {
      this.sweepTimer = setInterval(() => this.sweepBrowser(), sweepIntervalMs);
    }
    if (opts.sendControl) {
      const switchOpts: CarrierSwitchOptions = {
        sendControl: opts.sendControl,
        deliverInbound: opts.deliverInbound ?? (() => {}),
        ...(opts.verifyInbound ? { verifyInbound: opts.verifyInbound } : {}),
      };
      this.switcher = new CarrierSwitchController(switchOpts);
    } else {
      this.switcher = null;
    }
  }

  get available(): boolean {
    if (this.nativeMissing) return false;
    return this.nativeLoadAllowed();
  }

  currentIceConfig(): IceServerConfig {
    return this.iceConfigProvider();
  }

  async ready(): Promise<boolean> {
    await this.ensureNative();
    return this.available;
  }

  fingerprintProvider(): RtcFingerprintProvider {
    return this;
  }

  async getFingerprint(): Promise<DtlsFingerprint> {
    await this.ready();
    if (this.probeFp) return this.probeFp;
    const created = await this.createPeerConnection('offerer', 'probe');
    this.probePc = created.pc;
    this.probeFp = created.fingerprint;
    return created.fingerprint;
  }

  async createPeerConnection(
    role: 'offerer' | 'answerer',
    channelLabel = PEER_CHANNEL_LABEL
  ): Promise<CreatedPeerConnection> {
    await this.ready();
    const native = this.requireNative();
    const pc = new native.PeerConnection(
      `${this.identity.nodeId}:${role}`,
      buildRtcIceConfig(this.iceConfigProvider())
    );
    this.prepareLocalDescriptions(pc);
    let channel: DataChannelLike | null = null;
    if (role === 'offerer') {
      channel = pc.createDataChannel(channelLabel);
    } else {
      pc.setLocalDescription?.();
    }
    const fingerprint = await this.waitLocalFingerprint(pc);
    return { pc, fingerprint, channel };
  }

  async connectToPeer(
    peerNodeId: string,
    signaling: RtcSignaling,
    opts?: ConnectToPeerOptions
  ): Promise<DcPeerConnectResult> {
    if (!this.nativeLoadAllowed()) {
      throw new PeerHandshakeError('protocol', 'node-datachannel is not available');
    }
    await this.ensureNative();
    const deadline = performance.now() + this.handshakeTimeoutMs;
    const ctx: RtcLogContext = {
      peer: peerNodeId,
      attempt: opts?.attemptId ?? `pc:${this.nextLogSeq()}`,
    };
    return runWithRtcLogContext(ctx, () =>
      this.connectToPeerUntilDeadline(peerNodeId, signaling, deadline, ctx)
    );
  }

  private nextLogSeq(): number {
    this.logSeq = (this.logSeq % Number.MAX_SAFE_INTEGER) + 1;
    return this.logSeq;
  }

  private async connectToPeerUntilDeadline(
    peerNodeId: string,
    signaling: RtcSignaling,
    deadline: number,
    ctx: RtcLogContext
  ): Promise<DcPeerConnectResult> {
    for (;;) {
      try {
        return await this.connectToPeerOnce(peerNodeId, signaling, deadline, ctx);
      } catch (err) {
        if (!isSupersededDcLoss(err) || performance.now() >= deadline) throw err;
      }
    }
  }

  private async connectToPeerOnce(
    peerNodeId: string,
    signaling: RtcSignaling,
    deadline: number,
    ctx: RtcLogContext
  ): Promise<DcPeerConnectResult> {
    const dialStartedAt = performance.now();
    const native = this.requireNative();
    const self = this.identity.nodeId.toLowerCase();
    const peer = peerNodeId.toLowerCase();
    const offerer = self < peer;
    const rtcSession = peerRtcSession(self, peer);
    const ice = this.iceConfigProvider();
    const rtcConfig = await buildRtcIceConfigResolved(ice);
    const role = offerer ? 'offerer' : 'answerer';
    const epoch = offerer ? this.nextRtcAttemptEpoch() : undefined;
    ctx.epoch = epoch;
    logRtcDialStart(peerNodeId, role, ice, rtcConfig);
    const pc = new native.PeerConnection(`${self}->${peer}`, rtcConfig);
    const trace = createIceCandidateTrace();
    const progress = createRtcDialProgress();
    let unsubDiag = () => {};
    let unsubSignaling = () => {};
    let summaryNoted = false;
    let rejectSuperseded: ((err: Error) => void) | null = null;
    const superseded = new Promise<never>((_, reject) => {
      rejectSuperseded = reject;
    });
    try {
      this.trackPc(pc);
      this.prepareLocalDescriptions(pc);
      unsubDiag = attachPcDiagnostics(pc, peerNodeId, trace, { ice, progress, ctx });
      unsubSignaling = bindPeerSignaling(
        pc,
        signaling,
        rtcSession,
        peer,
        offerer ? 'answer' : 'offer',
        (target, listener) => this.onLocalDescription(target, listener),
        epoch,
        trace,
        {
          ctx,
          onSuperseded: () => {
            unsubSignaling();
            rejectSuperseded?.(new Error('superseded'));
          },
          onEpoch: (next) => {
            ctx.epoch = next;
          },
          onRemoteDescriptionApplied: () => {
            progress.remoteDescriptionApplied = true;
          },
        }
      );
      const work = runPeerHandshake({
        pc,
        peerNodeId,
        offerer,
        deadline,
        progress,
        identity: this.identity,
        userStore: this.userStore,
        liveness: this.liveness,
        waitLocalFingerprint: (target, timeoutMs) => this.waitLocalFingerprint(target, timeoutMs),
      });
      void work.catch(() => undefined);
      const result = await Promise.race([work, superseded]);
      this.noteDialSummary(peerNodeId, pc, 'success', performance.now() - dialStartedAt);
      summaryNoted = true;
      result.link.onClose(() => {
        unsubSignaling();
        unsubDiag();
        this.untrackAndClose(pc);
      });
      return result;
    } catch (err) {
      if (!summaryNoted) {
        this.noteDialSummary(peerNodeId, pc, 'failure', performance.now() - dialStartedAt);
      }
      const reason = err instanceof Error ? err.message : String(err);
      if (isRtcTimeoutFailure(reason)) {
        logRtcDialTimeout(peerNodeId, pc, trace, progress, ice, reason);
      }
      unsubSignaling();
      unsubDiag();
      this.untrackAndClose(pc);
      if (isRtcTimeoutFailure(reason)) {
        throw new PeerHandshakeError(
          'timeout',
          timeoutFailureMessage(progress, ice, trace.localCounts, reason)
        );
      }
      throw err;
    }
  }

  async authorizeBrowser(
    input: RtcAuthorizeBrowserInput
  ): Promise<RtcAuthorizeBrowserResult | null> {
    if (!(await this.ready())) return null;
    if (!input.sid) return null;
    this.sweepBrowser();
    const existing = this.browser.get(input.rtcSession);
    if (!existing && this.browser.size >= this.authorizeMax) return null;
    const rec = this.createBrowser(input.rtcSession);
    rec.uid = input.uid;
    rec.sid = input.sid;
    rec.via = input.via;
    rec.connectionId = input.connectionId ?? '';
    rec.fpBrowser = normalizeFingerprint(input.fpBrowser);
    rec.exp = this.now() + this.authorizeTtlMs;
    const fpNode = rec.fpNode ?? (await this.waitLocalFingerprint(rec.pc));
    rec.fpNode = fpNode;
    rec.nonce = crypto.getRandomValues(new Uint8Array(32));
    return { nonce: rec.nonce, fpNode };
  }

  async acceptBrowser(rtcSession: string, signaling: RtcSignaling): Promise<AcceptBrowserResult> {
    await this.ready();
    this.sweepBrowser();
    const rec = this.browser.get(rtcSession);
    if (!rec || !rec.nonce || !rec.fpBrowser || rec.exp <= this.now()) {
      throw new PeerHandshakeError('protocol', 'rtc session is not authorized');
    }
    const unsubSignaling = bindPeerSignaling(
      rec.pc,
      signaling,
      rtcSession,
      this.identity.nodeId.toLowerCase(),
      'offer',
      (target, listener) => this.onLocalDescription(target, listener)
    );
    let keepSignaling = false;
    try {
      const channel = fanoutDataChannel(
        await waitDataChannel(rec.pc, this.handshakeTimeoutMs, SESS_CHANNEL_LABEL),
        { peer: rtcSession }
      );
      await waitChannelOpen(channel, this.handshakeTimeoutMs);
      const nonceRaw = await waitFirstMessage(channel, this.handshakeTimeoutMs);
      this.sweepBrowser();
      const live = this.browser.get(rtcSession);
      if (!live || live !== rec || !live.nonce || !live.fpBrowser || live.exp <= this.now()) {
        this.untrackAndClose(rec.pc);
        throw new PeerHandshakeError('protocol', 'rtc session is not authorized');
      }
      const nonce = live.nonce;
      const fpBrowser = live.fpBrowser;
      const uid = live.uid;
      const sid = live.sid;
      const via = live.via;
      const connectionId = live.connectionId;
      const got = parseNonceMessage(nonceRaw);
      if (got !== encodeBase64url(nonce)) {
        this.browser.delete(rtcSession);
        this.untrackAndClose(rec.pc);
        throw new PeerHandshakeError('protocol', 'sess nonce mismatch');
      }
      const remote = rec.pc.remoteFingerprint();
      if (!fingerprintsEqual(remote, fpBrowser)) {
        this.browser.delete(rtcSession);
        this.untrackAndClose(rec.pc);
        throw new PeerHandshakeError('protocol', 'browser dtls fingerprint mismatch');
      }
      this.browser.delete(rtcSession);
      const carrier = new DataChannelCarrier(channel, { peer: rtcSession });
      carrier.onClose(() => {
        unsubSignaling();
        this.untrackAndClose(rec.pc);
      });
      keepSignaling = true;
      return {
        carrier,
        pc: rec.pc,
        uid,
        sid,
        via,
        rtcSession,
        connectionId,
      };
    } finally {
      if (!keepSignaling) unsubSignaling();
    }
  }

  authorizationOf(rtcSession: string): BrowserAuthorization | null {
    const rec = this.browser.get(rtcSession);
    if (!rec || rec.exp <= this.now()) return null;
    return {
      rtcSession,
      uid: rec.uid,
      sid: rec.sid,
      via: rec.via,
      connectionId: rec.connectionId,
    };
  }

  notifySessionClosed(session: GatewaySession): void {
    this.switcher?.notifyClosed(session);
  }

  attachDirect(session: GatewaySession, carrier: Carrier, options?: AttachDirectOptions): void {
    if (this.switcher) {
      this.switcher.attachDirect(session, carrier as DirectCarrier, options);
      return;
    }
    session.attachCarrier(carrier, 'direct');
    session.switchActiveCarrier(carrier);
  }

  handleCarrierSwitchAck(session: GatewaySession, epoch: number, rtcSession = ''): void {
    this.switcher?.handleAck(session, epoch, rtcSession);
  }

  handleDirectClose(session: GatewaySession, carrier?: Carrier): void {
    this.switcher?.handleDirectClose(session, carrier);
  }

  close(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    this.probePc?.close();
    this.probePc = null;
    for (const pc of this.livePcs) {
      try {
        pc.close();
      } catch {
        // ignore
      }
    }
    this.livePcs.clear();
    this.browser.clear();
    this.dialAggregates.clear();
  }

  private nextRtcAttemptEpoch(): number {
    this.rtcAttemptEpoch = (this.rtcAttemptEpoch % Number.MAX_SAFE_INTEGER) + 1;
    return this.rtcAttemptEpoch;
  }

  private noteDialSummary(
    peer: string,
    pc: PeerConnectionLike,
    outcome: 'success' | 'failure',
    durationMs: number
  ): void {
    const aggregate = this.dialAggregates.get(peer) ?? createRtcDialAggregate();
    this.dialAggregates.set(peer, aggregate);
    const pairType = selectedCandidatePairType(pc);
    aggregate[outcome === 'success' ? 'successes' : 'failures'][pairType] += 1;
    aggregate.attempts += 1;
    aggregate.durationTotalMs += durationMs;
    aggregate.durationMaxMs = Math.max(aggregate.durationMaxMs, durationMs);
    const now = this.now();
    if (
      aggregate.lastEmittedAt !== null &&
      now - aggregate.lastEmittedAt < RTC_SUMMARY_INTERVAL_MS
    ) {
      return;
    }
    rtcLog('summary', {
      peer,
      success_by_pair: formatPairCounts(aggregate.successes),
      failure_by_pair: formatPairCounts(aggregate.failures),
      attempts: aggregate.attempts,
      dial_ms_avg: Math.round(aggregate.durationTotalMs / aggregate.attempts),
      dial_ms_max: Math.round(aggregate.durationMaxMs),
    });
    aggregate.lastEmittedAt = now;
    aggregate.successes = emptyPairCounts();
    aggregate.failures = emptyPairCounts();
    aggregate.attempts = 0;
    aggregate.durationTotalMs = 0;
    aggregate.durationMaxMs = 0;
  }

  private nativeLoadAllowed(): boolean {
    return this.canLoadNative?.() !== false;
  }

  private ensureNative(): Promise<NodeDatachannelModule | null> {
    if (!this.nativeLoadAllowed()) return Promise.resolve(this.native);
    if (!this.loadPromise) {
      this.loadPromise = this.loadNative()
        .then((mod) => {
          this.native = mod;
          this.nativeMissing = mod == null;
          return mod;
        })
        .catch((err) => {
          this.nativeMissing = true;
          throw err;
        });
    }
    return this.loadPromise;
  }

  private requireNative(): NodeDatachannelModule {
    if (!this.native) {
      throw new PeerHandshakeError('protocol', 'node-datachannel is not available');
    }
    return this.native;
  }

  private createBrowser(rtcSession: string): BrowserRecord {
    const existing = this.browser.get(rtcSession);
    if (existing) return existing;
    const native = this.requireNative();
    const pc = new native.PeerConnection(
      `${this.identity.nodeId}:browser:${rtcSession}`,
      buildRtcIceConfig(this.iceConfigProvider())
    );
    this.prepareLocalDescriptions(pc);
    this.trackPc(pc);
    const rec: BrowserRecord = {
      rtcSession,
      uid: '',
      sid: '',
      via: '',
      connectionId: '',
      nonce: null,
      fpBrowser: null,
      fpNode: null,
      exp: this.now() + this.authorizeTtlMs,
      pc,
    };
    this.browser.set(rtcSession, rec);
    return rec;
  }

  private sweepBrowser(): void {
    const now = this.now();
    for (const [id, rec] of this.browser) {
      if (rec.exp <= now) {
        this.untrackAndClose(rec.pc);
        this.browser.delete(id);
      }
    }
  }

  private trackPc(pc: PeerConnectionLike): void {
    this.livePcs.add(pc);
  }

  private prepareLocalDescriptions(pc: PeerConnectionLike): LocalDescriptionHub {
    const existing = this.localDescriptionHubs.get(pc);
    if (existing) return existing;
    const hub: LocalDescriptionHub = { latest: null, listeners: new Set() };
    this.localDescriptionHubs.set(pc, hub);
    pc.onLocalDescription((sdp, type) => {
      const description = { sdp, type };
      hub.latest = description;
      for (const listener of hub.listeners) listener(description);
    });
    return hub;
  }

  private onLocalDescription(
    pc: PeerConnectionLike,
    listener: (description: LocalDescriptionEvent) => void
  ): () => void {
    const hub = this.prepareLocalDescriptions(pc);
    hub.listeners.add(listener);
    return () => hub.listeners.delete(listener);
  }

  private untrackAndClose(pc: PeerConnectionLike): void {
    this.livePcs.delete(pc);
    try {
      pc.close();
    } catch {
      // ignore
    }
  }

  private waitLocalFingerprint(
    pc: PeerConnectionLike,
    timeoutMs = this.handshakeTimeoutMs
  ): Promise<DtlsFingerprint> {
    const latest = this.prepareLocalDescriptions(pc).latest;
    return waitForLocalFingerprint(
      pc,
      latest,
      (listener) => this.onLocalDescription(pc, listener),
      timeoutMs
    );
  }
}
