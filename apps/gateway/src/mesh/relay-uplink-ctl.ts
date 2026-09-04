import type { LinkSession } from '@tmex/shared/link';
import {
  type RelayCtlMessage,
  type RelayKickReason,
  type RelayQuota,
  type RelayRtcConfig,
  relaySeqFromWire,
} from '@tmex/shared/relay';
import type { UserStore } from '../auth/user-store';
import { stamp } from './mesh-log';
import type { RelayKeyLogSync } from './relay-key-log-sync';
import {
  acceptRelayEnrollRedeemed,
  acceptRelayRtcSignal,
  buildRelayStatusMessage,
  relayListToNodeList,
} from './relay-node-list';
import type { RelaySecrets } from './relay-secrets';
import {
  type RelayAuthContext,
  type RelayEnrollChannel,
  buildRelayAuth,
} from './relay-uplink-auth';
import type {
  KeyLogApplier,
  MeshIdentity,
  MeshScheduler,
  UplinkState,
  UplinkStatus,
} from './types';
import type { UplinkCtlMessage, UplinkEnrollRedeemed, UplinkNodeList } from './uplink-protocol';

export type AuthPhase = 'idle' | 'awaiting-challenge' | 'challenge-accepted';

export type RelayUplinkCtlHost = {
  connectGeneration: number;
  authenticatedGeneration: number;
  authPhase: AuthPhase;
  authWaiter: { resolve: () => void; reject: (err: Error) => void } | null;
  tenantId: string | null;
  rtcConfig: RelayRtcConfig;
  quota: RelayQuota | null;
  kickedReason: RelayKickReason | null;
  listVersion: number;
  nodesViaRelay: number;
  lastStatusJson: string;
  listChain: Promise<void>;
  state: UplinkState;
  link: LinkSession | null;
  readonly identity: MeshIdentity;
  readonly hubUrl: string;
  readonly relayHost: string;
  readonly userId: string;
  readonly scheduler: MeshScheduler;
  readonly keyLog: RelayKeyLogSync;
  readonly enroll: RelayEnrollChannel;
  readonly secrets: RelaySecrets;
  readonly userStore: UserStore;
  readonly applier: KeyLogApplier;
  readonly clientVersion: string;
  readonly authTimeoutMs: number;
  readonly statusProvider: () => UplinkStatus;
  nodeName(): string;
  isAuthenticated(): boolean;
  rawSend(msg: RelayCtlMessage): void;
  tearDownLink(reason: string): void;
  markUnkicked(): void;
  onNodeList?: (list: UplinkNodeList) => void;
  onRtcSignal?: (msg: Extract<UplinkCtlMessage, { t: 'rtc.signal' }>) => void;
  onEnrollRedeemed?: (msg: UplinkEnrollRedeemed) => void;
  onQuota?: (quota: RelayQuota) => void;
  onKicked?: (reason: RelayKickReason) => void;
};

export function dispatchRelayAuthedCtl(host: RelayUplinkCtlHost, msg: RelayCtlMessage): void {
  if (msg.t === 'relay.list') enqueueRelayList(host, msg);
  else if (msg.t === 'relay.keylog.res') host.keyLog.handleRes(msg);
  else if (msg.t === 'relay.keylog.ack') host.keyLog.handleAck(msg);
  else if (msg.t === 'relay.keylog.push') host.keyLog.handlePush(msg);
  else if (msg.t === 'relay.rtc') {
    void acceptRelayRtcSignal(msg, host.secrets, (signal) => host.onRtcSignal?.(signal));
  } else if (msg.t === 'relay.enroll.ack') host.enroll.settle(msg);
  else if (msg.t === 'enroll.redeemed') handleEnrollRedeemed(host, msg);
  else if (msg.t === 'relay.quota') applyRelayQuota(host, msg);
  else if (msg.t === 'relay.kicked') {
    host.kickedReason = msg.reason;
    host.onKicked?.(msg.reason);
    host.tearDownLink(`kicked:${msg.reason}`);
  }
}

export function handleEnrollRedeemed(
  host: RelayUplinkCtlHost,
  msg: Extract<RelayCtlMessage, { t: 'enroll.redeemed' }>
): void {
  const redeemed = acceptRelayEnrollRedeemed(host.userStore, msg, host.scheduler.now());
  if (redeemed) host.onEnrollRedeemed?.(redeemed);
}

export function enqueueRelayList(
  host: RelayUplinkCtlHost,
  msg: Extract<RelayCtlMessage, { t: 'relay.list' }>
): void {
  const generation = host.connectGeneration;
  host.listChain = host.listChain
    .then(() => {
      if (generation !== host.connectGeneration || msg.version < host.listVersion) return;
      return applyRelayList(host, msg);
    })
    .catch((err) => {
      console.warn(stamp(`[relay] node list failed err=${errMessage(err)}`));
    });
}

export async function sendRelayStatusNow(host: RelayUplinkCtlHost): Promise<void> {
  if (host.state !== 'online' || !host.link || !host.isAuthenticated()) return;
  try {
    const built = await buildRelayStatusMessage(
      host.secrets,
      host.statusProvider(),
      host.nodeName()
    );
    if (!built) return;
    host.rawSend(built.msg);
    host.lastStatusJson = built.json;
  } catch (err) {
    console.warn(stamp(`[relay] status seal failed err=${errMessage(err)}`));
  }
}

export function acceptRelayAuthOk(
  host: RelayUplinkCtlHost,
  msg: Extract<RelayCtlMessage, { t: 'auth.ok' }>,
  generation: number
): void {
  if (host.authPhase !== 'challenge-accepted' || generation !== host.connectGeneration) return;
  host.authPhase = 'idle';
  host.authenticatedGeneration = generation;
  host.tenantId = msg.tenant_id;
  host.rtcConfig = msg.rtc;
  host.kickedReason = null;
  host.markUnkicked();
  host.authWaiter?.resolve();
  host.keyLog.noteRemoteHead(relaySeqFromWire(msg.key_log_head_seq));
}

export async function acceptRelayChallenge(
  host: RelayUplinkCtlHost,
  nonceB64: string,
  generation: number
): Promise<void> {
  if (host.authPhase !== 'awaiting-challenge' || generation !== host.connectGeneration) return;
  const built = await buildRelayAuth(relayAuthContext(host), nonceB64);
  if (!built.ok) {
    host.authWaiter?.reject(new Error(built.error));
    return;
  }
  if (generation !== host.connectGeneration) return;
  host.authPhase = 'challenge-accepted';
  try {
    host.rawSend(built.msg);
  } catch (err) {
    host.authWaiter?.reject(err instanceof Error ? err : new Error('auth-send-failed'));
  }
}

export function authenticateRelayLink(
  host: RelayUplinkCtlHost,
  link: LinkSession,
  signal: AbortSignal,
  generation: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    host.authPhase = 'awaiting-challenge';
    const timer = setTimeout(() => finish(new Error('auth-timeout')), host.authTimeoutMs);
    const finish = (err?: Error) => {
      if (!host.authWaiter) return;
      host.authWaiter = null;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      if (err) {
        host.authPhase = 'idle';
        try {
          link.close(err.message);
        } catch {
          /* already closed */
        }
        reject(err);
      } else resolve();
    };
    const onAbort = () => finish(new Error('aborted'));
    if (signal.aborted) {
      clearTimeout(timer);
      host.authPhase = 'idle';
      reject(new Error('aborted'));
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    host.authWaiter = { resolve: () => finish(), reject: (err) => finish(err) };
    void link.closed.then((info) => {
      if (host.authWaiter && generation === host.connectGeneration) {
        finish(new Error(info.reason || 'link-closed'));
      }
    });
  });
}

export function relayAuthContext(host: RelayUplinkCtlHost): RelayAuthContext {
  return {
    identity: host.identity,
    relayUrl: host.hubUrl,
    relayHost: host.relayHost,
    clientVersion: host.clientVersion,
    secrets: host.secrets,
    userStore: host.userStore,
    applier: host.applier,
    userId: host.userId,
  };
}

function applyRelayQuota(
  host: RelayUplinkCtlHost,
  msg: Extract<RelayCtlMessage, { t: 'relay.quota' }>
): void {
  const { maxNodes, maxStreams, bandwidthBytesPerSec, currentNodes, usage } = msg;
  host.quota = {
    maxNodes,
    maxStreams,
    bandwidthBytesPerSec,
    ...(currentNodes !== undefined ? { currentNodes } : {}),
    ...(usage ? { usage } : {}),
  };
  host.onQuota?.(host.quota);
}

async function applyRelayList(
  host: RelayUplinkCtlHost,
  msg: Extract<RelayCtlMessage, { t: 'relay.list' }>
): Promise<void> {
  host.listVersion = msg.version;
  host.rtcConfig = msg.rtc;
  const list = await relayListToNodeList(msg, {
    selfNodeId: host.identity.nodeId,
    userId: host.userId,
    userStore: host.userStore,
    secrets: host.secrets,
    now: host.scheduler.now(),
  });
  if (msg.version < host.listVersion) return;
  host.nodesViaRelay = list.nodes.length;
  host.keyLog.noteRemoteHead(relaySeqFromWire(msg.key_log_head_seq));
  host.onNodeList?.(list);
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
