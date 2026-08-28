import {
  type DtlsFingerprint,
  encodeBase64url,
  normalizeFingerprint,
  parseSdpFingerprint,
} from '@tmex/shared/auth';
import type { UserStore } from '../../auth/user-store';
import type { Carrier } from '../../ws/carrier';
import type { GatewaySession } from '../../ws/gateway-session';
import type {
  RtcAuthorizeBrowserInput,
  RtcAuthorizeBrowserResult,
  RtcFingerprintProvider,
  RtcSignalMessage,
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
import { DataChannelLink } from './data-channel-link';
import { handshakeDataChannel } from './dc-handshake';
import {
  type RtcSignaling,
  buildRtcIceConfig,
  decodeCandidateSignal,
  decodeSdpSignal,
  encodeCandidateSignal,
  encodeSdpSignal,
  isEmptyCandidate,
  maskIceAddress,
  parseIceCandidateType,
  peerRtcSession,
} from './ice';
import type {
  DataChannelLike,
  IceServerConfig,
  LoadNative,
  NodeDatachannelModule,
  PeerConnectionLike,
} from './native';
import { toUint8Array } from './native';
import {
  type IceCandidateTrace,
  createIceCandidateTrace,
  rtcLog,
  rtcLogCandidate,
  rtcLogIceFailed,
} from './rtc-log';

export const RTC_AUTHORIZE_TTL_MS = 120_000;
export const RTC_AUTHORIZE_MAX = 64;
export const RTC_AUTHORIZE_SWEEP_INTERVAL_MS = 15_000;
export const SESS_CHANNEL_LABEL = 'sess';
export const PEER_CHANNEL_LABEL = 'peer';
export const CONNECT_TIMEOUT_MS = 15_000;

export type IceConfigProvider = () => IceServerConfig;

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new PeerHandshakeError('timeout', message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

function fingerprintsEqual(a: DtlsFingerprint, b: DtlsFingerprint): boolean {
  const left = normalizeFingerprint(a);
  const right = normalizeFingerprint(b);
  return left.algorithm === right.algorithm && left.value === right.value;
}

function parseNonceMessage(msg: string | Buffer | ArrayBuffer): string | null {
  if (typeof msg === 'string') {
    try {
      const parsed = JSON.parse(msg) as { nonce?: unknown };
      return typeof parsed.nonce === 'string' ? parsed.nonce : null;
    } catch {
      return msg;
    }
  }
  const bytes = toUint8Array(msg);
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as { nonce?: unknown };
    if (typeof parsed.nonce === 'string') return parsed.nonce;
  } catch {
    if (bytes.byteLength === 32) return encodeBase64url(bytes);
  }
  return null;
}

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
  private readonly loadPromise: Promise<NodeDatachannelModule | null>;
  private native: NodeDatachannelModule | null = null;
  private readonly browser = new Map<string, BrowserRecord>();
  private readonly livePcs = new Set<PeerConnectionLike>();
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
    this.loadPromise = this.loadNative().then((mod) => {
      this.native = mod;
      return mod;
    });
  }

  get available(): boolean {
    return this.native !== null;
  }

  async ready(): Promise<boolean> {
    await this.loadPromise;
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
    let channel: DataChannelLike | null = null;
    if (role === 'offerer') {
      channel = pc.createDataChannel(channelLabel);
    } else {
      pc.setLocalDescription?.();
    }
    const fingerprint = await this.waitLocalFingerprint(pc);
    return { pc, fingerprint, channel };
  }

  async connectToPeer(peerNodeId: string, signaling: RtcSignaling): Promise<DcPeerConnectResult> {
    await this.ready();
    const native = this.requireNative();
    const self = this.identity.nodeId.toLowerCase();
    const peer = peerNodeId.toLowerCase();
    const offerer = self < peer;
    const rtcSession = peerRtcSession(self, peer);
    const ice = this.iceConfigProvider();
    const role = offerer ? 'offerer' : 'answerer';
    rtcLog('dial start', {
      peer: peerNodeId,
      role,
      stun_count: ice.stun.length,
      turn_enabled: Boolean(ice.turn),
    });
    const pc = new native.PeerConnection(`${self}->${peer}`, buildRtcIceConfig(ice));
    this.trackPc(pc);
    const trace = createIceCandidateTrace();
    const unsubDiag = attachPcDiagnostics(pc, peerNodeId, trace);
    const unsubSignaling = this.bindSignaling(pc, signaling, rtcSession, peer, trace);
    const channelP = offerer
      ? Promise.resolve(logCreatedChannel(pc.createDataChannel(PEER_CHANNEL_LABEL), peerNodeId))
      : waitDataChannel(pc, this.handshakeTimeoutMs, undefined, peerNodeId);
    try {
      const channel = fanoutDataChannel(
        await withTimeout(channelP, this.handshakeTimeoutMs, 'datachannel missing')
      );
      bindChannelDiagnostics(channel, peerNodeId);
      await waitChannelOpen(channel, this.handshakeTimeoutMs);
      const localFp = await this.waitLocalFingerprint(pc);
      const hs = await handshakeDataChannel({
        channel,
        pc,
        identity: this.identity,
        userStore: this.userStore,
        localFingerprint: localFp,
        timeoutMs: this.handshakeTimeoutMs,
      });
      const link = new DataChannelLink(channel);
      if (hs.peerNodeId !== peer) {
        unsubSignaling();
        unsubDiag();
        throw new PeerHandshakeError('protocol', 'connected peer node_id mismatch');
      }
      link.onClose(() => {
        unsubSignaling();
        unsubDiag();
        this.untrackAndClose(pc);
      });
      return {
        link,
        pc,
        peerNodeId: hs.peerNodeId,
        role: offerer ? 'initiator' : 'acceptor',
      };
    } catch (err) {
      rtcLog('dial failed', {
        peer: peerNodeId,
        reason: err instanceof Error ? err.message : String(err),
      });
      unsubSignaling();
      unsubDiag();
      this.untrackAndClose(pc);
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
    const unsubSignaling = this.bindSignaling(
      rec.pc,
      signaling,
      rtcSession,
      this.identity.nodeId.toLowerCase()
    );
    let keepSignaling = false;
    try {
      const channel = fanoutDataChannel(
        await waitDataChannel(rec.pc, this.handshakeTimeoutMs, SESS_CHANNEL_LABEL)
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
      const carrier = new DataChannelCarrier(channel);
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

  private untrackAndClose(pc: PeerConnectionLike): void {
    this.livePcs.delete(pc);
    try {
      pc.close();
    } catch {
      // ignore
    }
  }

  private async waitLocalFingerprint(pc: PeerConnectionLike): Promise<DtlsFingerprint> {
    const deadline = Date.now() + this.handshakeTimeoutMs;
    while (Date.now() <= deadline) {
      const desc = pc.localDescription();
      if (desc?.sdp) {
        const fp = parseSdpFingerprint(desc.sdp);
        if (fp) return fp;
      }
      await sleep(5);
    }
    throw new PeerHandshakeError('timeout', 'local DTLS fingerprint unavailable');
  }

  private bindSignaling(
    pc: PeerConnectionLike,
    signaling: RtcSignaling,
    rtcSession: string,
    to: string,
    trace?: IceCandidateTrace
  ): () => void {
    const iceTrace = trace ?? createIceCandidateTrace();
    pc.onLocalDescription((sdp, type) => {
      rtcLog('signal send', { peer: to, kind: 'sdp', sdp_type: type });
      signaling.send({
        rtcSession,
        from: 'node',
        to,
        sdp: encodeSdpSignal({ type, sdp }),
      });
    });
    pc.onLocalCandidate((candidate, mid) => {
      if (isEmptyCandidate(candidate)) return;
      rtcLogCandidate('send', to, candidate, iceTrace);
      signaling.send({
        rtcSession,
        from: 'node',
        to,
        candidate: encodeCandidateSignal(candidate, mid),
      });
    });
    const apply = (msg: RtcSignalMessage) => {
      if (msg.sdp) {
        const decoded = decodeSdpSignal(msg.sdp);
        if (decoded) {
          rtcLog('signal recv', { peer: to, kind: 'sdp', sdp_type: decoded.type });
          pc.setRemoteDescription(decoded.sdp, decoded.type);
        }
      }
      if (msg.candidate) {
        const decoded = decodeCandidateSignal(msg.candidate);
        if (decoded && !isEmptyCandidate(decoded.candidate)) {
          rtcLogCandidate('recv', to, decoded.candidate, iceTrace);
          pc.addRemoteCandidate(decoded.candidate, decoded.mid);
        }
      }
    };
    return signaling.onMessage(apply);
  }
}

function logCreatedChannel(dc: DataChannelLike, peer: string): DataChannelLike {
  rtcLog('datachannel created', { peer, label: dc.getLabel?.() ?? PEER_CHANNEL_LABEL });
  return dc;
}

function attachPcDiagnostics(
  pc: PeerConnectionLike,
  peer: string,
  trace: IceCandidateTrace
): () => void {
  let iceFailedLogged = false;
  const logIceFailed = () => {
    if (iceFailedLogged) return;
    iceFailedLogged = true;
    rtcLogIceFailed(peer, trace);
  };
  pc.onGatheringStateChange?.((state) => {
    rtcLog('gathering', { peer, state });
  });
  pc.onIceStateChange?.((state) => {
    rtcLog('ice', { peer, state });
    if (state === 'failed') logIceFailed();
    if (state === 'connected' || state === 'completed') {
      const pair = pc.getSelectedCandidatePair?.();
      if (pair) {
        rtcLog('selected pair', {
          peer,
          local_type:
            pair.local?.type ?? parseIceCandidateType(pair.local?.candidate ?? '') ?? undefined,
          remote_type:
            pair.remote?.type ?? parseIceCandidateType(pair.remote?.candidate ?? '') ?? undefined,
          local_addr: pair.local?.address ? maskIceAddress(pair.local.address) : undefined,
          remote_addr: pair.remote?.address ? maskIceAddress(pair.remote.address) : undefined,
        });
      }
    }
  });
  pc.onStateChange?.((state) => {
    rtcLog('peer state', { peer, state });
    if (state === 'failed') logIceFailed();
  });
  return () => {
    iceFailedLogged = true;
  };
}

function bindChannelDiagnostics(dc: DataChannelLike, peer: string): void {
  const label = dc.getLabel?.() ?? PEER_CHANNEL_LABEL;
  dc.onOpen(() => {
    rtcLog('datachannel open', { peer, label });
  });
  dc.onError((err) => {
    rtcLog('datachannel error', { peer, label, err });
  });
  dc.onClosed(() => {
    rtcLog('datachannel closed', { peer, label });
  });
}

function waitDataChannel(
  pc: PeerConnectionLike,
  timeoutMs: number,
  label?: string,
  peer?: string
): Promise<DataChannelLike> {
  return withTimeout(
    new Promise((resolve) => {
      pc.onDataChannel((dc) => {
        if (label && dc.getLabel && dc.getLabel() !== label) return;
        if (peer) rtcLog('datachannel received', { peer, label: dc.getLabel?.() ?? label ?? '' });
        resolve(dc);
      });
    }),
    timeoutMs,
    'datachannel open timeout'
  );
}

function waitChannelOpen(dc: DataChannelLike, timeoutMs: number): Promise<void> {
  if (dc.isOpen()) {
    return Promise.resolve();
  }
  return withTimeout(
    new Promise((resolve, reject) => {
      dc.onOpen(() => resolve());
      dc.onError((err) => reject(new Error(err)));
      dc.onClosed(() => reject(new Error('channel closed before open')));
    }),
    timeoutMs,
    'datachannel open timeout'
  );
}

function waitFirstMessage(
  dc: DataChannelLike,
  timeoutMs: number
): Promise<string | Buffer | ArrayBuffer> {
  return withTimeout(
    new Promise((resolve) => {
      dc.onMessage((msg) => resolve(msg));
    }),
    timeoutMs,
    'sess nonce timeout'
  );
}
