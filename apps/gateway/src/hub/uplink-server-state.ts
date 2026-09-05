import type { LinkSession } from '@tmex/shared/link';
import type { HubMode } from '@tmex/shared/uplink';
import type { AttachmentRouter } from './attachment-router';
import type { UplinkCtlMessage } from './uplink-protocol';
import { IdleLruMap, KeyLogReqLimiter } from './uplink-rate-limit';
import type { UplinkTimer } from './uplink-server-timers';
import { UplinkTimerSet } from './uplink-server-timers';

export type PendingAuth = {
  nonce: Uint8Array;
};

export type LiveConnection = {
  nodeId: string;
  userId: string;
  link: LinkSession;
  generation: number;
  misses: number;
  awaitingPong: boolean;
  heartbeat: UplinkTimer | null;
};

export type LogSuppressState = { lastAt: number; suppressed: number };

/** 被多个协作者共享的可变状态，由 UplinkServer 构造一次后传给各协作者。 */
export type UplinkServerState = {
  stopped: boolean;
  readonly live: Map<LinkSession, LiveConnection>;
  readonly accepted: Set<LinkSession>;
  readonly authTimers: Map<LinkSession, UplinkTimer>;
  readonly lastNodeListFp: Map<string, string>;
  readonly lastNodeListSent: Map<string, Uint8Array>;
  readonly timers: UplinkTimerSet;
  readonly attachments: AttachmentRouter;
  readonly keyLogReqLimiter: KeyLogReqLimiter;
  readonly keyLogReqLogs: IdleLruMap<LogSuppressState>;
};

export type UplinkRoleDeps = {
  hubNodeId: () => string | undefined;
  isWriter: () => boolean;
  isAuthorizedHub: (nodeId: string, userId?: string | null) => boolean;
};

export type UplinkSendDeps = {
  send: (link: LinkSession, msg: UplinkCtlMessage) => void;
  sendBytes: (link: LinkSession, bytes: Uint8Array) => void;
};

export type OwnHubSnapshot = {
  hubNodeId: string;
  publicUrl: string;
  name: string | null;
  mode: HubMode;
  priority: number;
  writerEpoch: number;
  caFingerprint: string | null;
  online: boolean;
  lastSeenAt: number | null;
};

export function createUplinkServerState(opts: {
  attachments: AttachmentRouter;
  logStateMax: number;
  logIdleTtlMs: number;
}): UplinkServerState {
  return {
    stopped: false,
    live: new Map(),
    accepted: new Set(),
    authTimers: new Map(),
    lastNodeListFp: new Map(),
    lastNodeListSent: new Map(),
    timers: new UplinkTimerSet(),
    attachments: opts.attachments,
    keyLogReqLimiter: new KeyLogReqLimiter({ max: opts.logStateMax, ttlMs: opts.logIdleTtlMs }),
    keyLogReqLogs: new IdleLruMap(opts.logStateMax, opts.logIdleTtlMs),
  };
}
