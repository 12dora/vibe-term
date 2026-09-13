import os from 'node:os';
import type { LinkSession } from '@vibeterm/shared/link';
import { defaultScheduler } from './ctl';
import type { RtcSignalMessage } from './mesh-deps';
import { DcRerollCoordinator } from './peer-dc-reroll';
import { DcUpgradeCoordinator } from './peer-dc-upgrade';
import { PeerDialer } from './peer-dialer';
import { PeerLinkDrain } from './peer-link-drain';
import { PeerLinkWaiters } from './peer-link-waiters';
import { PeerLiveRegistry } from './peer-live-registry';
import {
  PEER_CONNECT_TIMEOUT_MS,
  PEER_IDLE_MS,
  PEER_MAX_CONCURRENT_STREAMS,
  type PeerManagerState,
} from './peer-manager-state';
import type { PeerManagerOptions } from './peer-manager-types';
import { sendPeerCtlQuiet } from './peer-path-view';
import type { LivePeer } from './peer-reconnect-wake';
import { type PeerUpgradeOpts, RtcWakeGate } from './peer-rtc-wake';
import { PeerServer } from './peer-server';
import { PeerStatusSync } from './peer-status-sync';
import { defaultPeerWsFactory, sharedDirectDialLimiter } from './peer-ws-race';
import { RouteDegradeCoordinator, defaultRouteModeHolder } from './route-degrade';
import { rtcLog } from './rtc/rtc-log';
import type { MeshIdentity, MeshScheduler } from './types';

export type PeerWireHooks = {
  maybeUpgrade: (nodeId: string, opts: PeerUpgradeOpts) => void;
  requireTrusted: (nodeId: string) => void;
  isTrusted: (nodeId: string) => boolean;
  getLink: (nodeId: string) => Promise<LinkSession>;
  handlePeerCtl: (live: LivePeer, bytes: Uint8Array) => void;
  notifyPeerEndpointsChanged: (nodeId?: string) => void;
  wantsUpgrade: (live: LivePeer) => boolean;
  nextDcAttemptId: () => string;
  armDcHealthTimer: (nodeId: string, attemptId: string) => void;
  cancelDcHealthTimer: (nodeId: string) => void;
  armDcUpgradeRetry: (nodeId: string) => void;
  cancelDcUpgradeRetry: (nodeId: string) => void;
  ensureGate: (nodeId: string) => ReturnType<DcUpgradeCoordinator['ensureGate']>;
  ensureIncomingWakeGate: (nodeId: string) => ReturnType<RtcWakeGate['ensureIncomingWakeGate']>;
  dispatchRtcWake: (peerNodeId: string) => void;
  releaseRtcWakeAttempt: (peerNodeId: string) => void;
  signalingFor: (peerNodeId: string) => ReturnType<RtcWakeGate['signalingFor']>;
};

export type PeerCollaborators = {
  routes: RouteDegradeCoordinator;
  dcUpgrade: DcUpgradeCoordinator;
  rtcWake: RtcWakeGate;
  statusSync: PeerStatusSync;
  waiters: PeerLinkWaiters;
  drain: PeerLinkDrain;
  reroll: DcRerollCoordinator;
  registry: PeerLiveRegistry;
  dialer: PeerDialer;
  server: PeerServer | null;
};

export function wrapPeerScheduler(opts: PeerManagerOptions): MeshScheduler {
  const inner = opts.scheduler ?? defaultScheduler();
  if (!opts.now) return inner;
  const now = opts.now;
  return {
    now,
    sleep: inner.sleep.bind(inner),
    interval: inner.interval.bind(inner),
  };
}

type WireCtx = {
  opts: PeerManagerOptions;
  state: PeerManagerState;
  identity: MeshIdentity;
  scheduler: MeshScheduler;
  rtcListeners: Map<string, Set<(msg: RtcSignalMessage) => void>>;
  dispatchHttp: () => import('./types').DispatchHttp | undefined;
  ensureDcSession: ((peerNodeId: string, rtcSession: string) => void) | null;
  hooks: PeerWireHooks;
  parts: PeerCollaborators;
};

function wireRoutesAndUpgrade(ctx: WireCtx): void {
  const { opts, state, scheduler, hooks, parts } = ctx;
  parts.routes = new RouteDegradeCoordinator({
    state,
    mode: opts.routeMode ?? defaultRouteModeHolder(),
    openRelay: (nodeId) => parts.dialer.dialRelayOnly(nodeId),
    forceInstall: (s, p, t, i, g, r, d) => parts.registry.forceInstall(s, p, t, i, g, r ?? null, d),
    finishRetire: (live, reason) => parts.drain.finishRetire(live, reason),
    maybeUpgrade: (nodeId) => hooks.maybeUpgrade(nodeId, { cooldown: false, userPath: true }),
  });
  parts.dcUpgrade = new DcUpgradeCoordinator({
    scheduler,
    live: () => state.live,
    dialDc: (nodeId) => parts.dialer.dial(nodeId),
    shouldTryDc: (nodeId) => parts.dialer.shouldTryDc(nodeId),
    dcCapable: (nodeId) => parts.dialer.dcCapable(nodeId),
    emitLinkInfo: (live) => parts.registry.emitLinkInfo(live as LivePeer),
    log: rtcLog,
    stopped: () => state.stopped,
    stopSignal: () => state.stopAbort.signal,
    isTrusted: (nodeId) => hooks.isTrusted(nodeId),
    pending: () => state.pending,
    upgrading: () => state.upgrading,
    hasDcInflight: (nodeId) => parts.dialer.hasDcInflight(nodeId),
    probeQuiesce: (live) => parts.drain.probeQuiesce(live as LivePeer),
    hasWsSecureCandidate: (nodeId) => parts.dialer.hasWsSecureCandidate(nodeId),
    lostDirect: () => state.lostDirect,
  });
}

function wireRtcWake(ctx: WireCtx): void {
  const { opts, state, identity, scheduler, rtcListeners, hooks, parts } = ctx;
  parts.rtcWake = new RtcWakeGate({
    identity,
    userStore: opts.userStore,
    scheduler,
    sendRtcSignal: (peerNodeId, msg) => parts.rtcWake.sendRtcSignal(peerNodeId, msg),
    dcCapable: (nodeId) => parts.dialer.dcCapable(nodeId),
    maybeUpgrade: (nodeId, upgradeOpts) => hooks.maybeUpgrade(nodeId, upgradeOpts),
    stopSignal: () => state.stopAbort.signal,
    stopped: () => state.stopped,
    isTrusted: (nodeId) => hooks.isTrusted(nodeId),
    live: () => state.live,
    shouldTryDc: (nodeId) => parts.dialer.shouldTryDc(nodeId),
    pending: () => state.pending,
    upgrading: () => state.upgrading,
    wantsUpgrade: (live) => hooks.wantsUpgrade(live as LivePeer),
    getLink: (nodeId) => hooks.getLink(nodeId),
    rtcListeners: () => rtcListeners,
    rtcInbox: () => state.rtcInbox,
    hasDcInflight: (nodeId) => parts.dialer.hasDcInflight(nodeId),
    sendPeerCtl: (live, payload) => sendPeerCtlQuiet(live as LivePeer, payload),
    ensureDcSession: ctx.ensureDcSession,
    uplinkSendCtl: (payload) => state.uplink.sendCtl(payload),
  });
}

function wireStatusDrainReroll(ctx: WireCtx): void {
  const { opts, state, hooks, parts } = ctx;
  parts.statusSync = new PeerStatusSync(state, {
    keyLogApplier: opts.keyLogApplier,
    statusProvider: opts.statusProvider,
    deps: {
      sendPeerCtl: (live, msg) => sendPeerCtlQuiet(live, msg),
      notifyPeerEndpointsChanged: (nodeId) => hooks.notifyPeerEndpointsChanged(nodeId),
      listenPort: () => parts.server?.port,
    },
  });
  parts.waiters = new PeerLinkWaiters(state, {
    maybeUpgrade: (nodeId, upgradeOpts) => hooks.maybeUpgrade(nodeId, upgradeOpts),
  });
  parts.drain = new PeerLinkDrain(state, {
    clearIdle: (live) => parts.registry.clearIdle(live),
    sendPeerCtl: (live, msg) => sendPeerCtlQuiet(live, msg),
    maybeUpgrade: (nodeId, upgradeOpts) => hooks.maybeUpgrade(nodeId, upgradeOpts),
    armDcUpgradeRetry: (nodeId) => hooks.armDcUpgradeRetry(nodeId),
    onPeerReconnected: (nodeId) => parts.dcUpgrade.onPeerReconnected(nodeId),
    hasCoalescedUpgrade: (nodeId) => parts.dcUpgrade.upgradeGate.get(nodeId)?.coalesced === true,
    extraHelloCaps: () => parts.reroll.helloCaps(),
    noteHelloCaps: (live, caps) => parts.reroll.noteHelloCaps(live, caps),
    onRerollRequest: (live, msg) => parts.reroll.handlePeerRequest(live, msg),
    track: (...args) => parts.registry.track(...args),
  });
  parts.reroll = new DcRerollCoordinator(state, {
    breakerAllows: (nodeId) => parts.dcUpgrade.dcBreaker.shouldTry(nodeId).allow,
    hasDcInflight: (nodeId) => parts.dialer.hasDcInflight(nodeId),
    hasWsRerollInflight: (nodeId) => parts.dialer.hasWsRerollInflight(nodeId),
    dcCapable: (nodeId) => parts.dialer.dcCapable(nodeId),
    willAttemptUpgrade: (nodeId) => parts.dcUpgrade.willAttemptUpgrade(nodeId),
    dialReroll: (nodeId, rerollOpts) => parts.dialer.dialDcReroll(nodeId, rerollOpts),
    finishRetire: (live, reason) => parts.drain.finishRetire(live, reason),
    answererAllows: (nodeId) => parts.dcUpgrade.dcBreaker.shouldAcceptAnswer(nodeId),
  });
}

function wireRegistry(ctx: WireCtx): void {
  const { opts, state, hooks, parts } = ctx;
  parts.registry = new PeerLiveRegistry(state, {
    idleMs: opts.idleMs ?? PEER_IDLE_MS,
    maxConcurrentStreams: opts.maxConcurrentStreams ?? PEER_MAX_CONCURRENT_STREAMS,
    sessionStore: opts.sessionStore,
    dispatchHttp: () => ctx.dispatchHttp(),
    wsServer: opts.wsServer,
    onGatewaySession: opts.onGatewaySession ?? null,
    onGatewaySessionClose: opts.onGatewaySessionClose ?? null,
    onLinkInfo: opts.onLinkInfo ?? null,
    deps: {
      dcBreaker: parts.dcUpgrade.dcBreaker,
      sendPeerCtl: (live, msg) => sendPeerCtlQuiet(live, msg),
      handlePeerCtl: (live, bytes) => hooks.handlePeerCtl(live, bytes),
      sendPeerStatus: (live) => parts.statusSync.sendPeerStatus(live),
      sendLinkHello: (live) => parts.drain.sendLinkHello(live),
      restartQuiesce: (live) => parts.drain.restartQuiesce(live),
      probeQuiesce: (live) => parts.drain.probeQuiesce(live),
      clearDirectFailure: (nodeId) => parts.dialer.clearDirectFailure(nodeId),
      parkInbound: (peerNodeId, session, transport, initiatedBy, gen, remoteAddress) =>
        parts.drain.parkInbound(peerNodeId, session, transport, initiatedBy, gen, remoteAddress),
      dropParked: (nodeId, reason) => parts.drain.dropParked(nodeId, reason),
      activateParked: (nodeId) => parts.drain.activateParked(nodeId),
      retirePeer: (prev, reason) => parts.drain.retirePeer(prev, reason),
      finishRetire: (live, reason) => parts.drain.finishRetire(live, reason),
      armRetireTimer: (live, reason) => parts.drain.armRetireTimer(live, reason),
      maybeFinishRetire: (live, reason) => parts.drain.maybeFinishRetire(live, reason),
      nextDcAttemptId: () => hooks.nextDcAttemptId(),
      armDcHealthTimer: (nodeId, attemptId) => hooks.armDcHealthTimer(nodeId, attemptId),
      cancelDcHealthTimer: (nodeId) => hooks.cancelDcHealthTimer(nodeId),
      armDcUpgradeRetry: (nodeId) => hooks.armDcUpgradeRetry(nodeId),
      cancelDcUpgradeRetry: (nodeId) => hooks.cancelDcUpgradeRetry(nodeId),
      ensureGate: (nodeId) => hooks.ensureGate(nodeId),
      ensureIncomingWakeGate: (nodeId) => hooks.ensureIncomingWakeGate(nodeId),
      onPeerReconnected: (nodeId) => parts.dcUpgrade.onPeerReconnected(nodeId),
      notifyTransport: (nodeId) => parts.waiters.notifyTransport(nodeId),
      notifyLive: (nodeId, session) => parts.waiters.notifyLive(nodeId, session),
      onRttSample: (live, sampleMs) => {
        parts.routes.onRttSample(live, sampleMs);
        parts.reroll.onRttSample(live, sampleMs);
      },
      interceptTrack: (trackInput) => parts.routes.interceptTrack(trackInput),
    },
  });
}

function wireDialerAndServer(ctx: WireCtx): void {
  const { opts, state, identity, scheduler, hooks, parts } = ctx;
  parts.dialer = new PeerDialer(state, {
    rtc: opts.rtc ?? null,
    linkFactory: opts.linkFactory ?? null,
    wsFactory: opts.wsFactory ?? defaultPeerWsFactory(),
    connectTimeoutMs: opts.connectTimeoutMs ?? PEER_CONNECT_TIMEOUT_MS,
    dialLimiter: opts.dialLimiter ?? sharedDirectDialLimiter(),
    interfacesFn: opts.interfacesFn ?? (() => os.networkInterfaces()),
    refreshLocalInterfaces: opts.refreshLocalInterfaces ?? null,
    deps: {
      dcBreaker: parts.dcUpgrade.dcBreaker,
      track: (...args) => parts.registry.track(...args),
      requireTrusted: (nodeId) => hooks.requireTrusted(nodeId),
      getLink: (nodeId) => hooks.getLink(nodeId),
      maybeUpgrade: (nodeId, upgradeOpts) => hooks.maybeUpgrade(nodeId, upgradeOpts),
      nextDcAttemptId: () => hooks.nextDcAttemptId(),
      signalingFor: (peerNodeId) => hooks.signalingFor(peerNodeId),
      dispatchRtcWake: (peerNodeId) => hooks.dispatchRtcWake(peerNodeId),
      releaseRtcWakeAttempt: (peerNodeId) => hooks.releaseRtcWakeAttempt(peerNodeId),
      onLocalFingerprintChanged: () => parts.dcUpgrade.onLocalFingerprintChanged(),
      onPeerEndpointChanged: (nodeId) => parts.dcUpgrade.onPeerEndpointChanged(nodeId),
      listenPort: () => parts.server?.port,
      allowsOutboundDirect: (nodeId) => parts.routes.allowsOutboundDirect(nodeId),
      allowsInboundDirect: () => parts.routes.allowsInboundDirect(),
      trackRelay: (session, id, g) =>
        parts.registry.forceInstall(session, id, 'relay', identity.nodeId, g),
    },
  });
  state.uplink.setOnRelayStream((stream, from, viaRelay) => {
    void parts.dialer.acceptRelay(stream, from, viaRelay);
  });
  if (opts.startServer === false) {
    parts.server = null;
    return;
  }
  parts.server = new PeerServer({
    port: opts.peerPort,
    hostname: opts.hostname,
    scheduler,
    onAccept: (socket, remoteIp) => {
      void parts.dialer.acceptDirect(socket, remoteIp === 'unknown' ? null : remoteIp);
    },
  });
}

export function createPeerCollaborators(input: {
  opts: PeerManagerOptions;
  state: PeerManagerState;
  identity: MeshIdentity;
  scheduler: MeshScheduler;
  rtcListeners: Map<string, Set<(msg: RtcSignalMessage) => void>>;
  dispatchHttp: () => import('./types').DispatchHttp | undefined;
  ensureDcSession: ((peerNodeId: string, rtcSession: string) => void) | null;
  hooks: PeerWireHooks;
}): PeerCollaborators {
  const ctx: WireCtx = { ...input, parts: {} as PeerCollaborators };
  wireRoutesAndUpgrade(ctx);
  wireRtcWake(ctx);
  wireStatusDrainReroll(ctx);
  wireRegistry(ctx);
  wireDialerAndServer(ctx);
  return ctx.parts;
}
