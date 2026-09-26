import type { LinkSession, LinkStream } from '@vibeterm/shared/link';
import { encodeJsonBytes } from './ctl';
import { logLine } from './mesh-log';
import { parseEchoedSentAt } from './peer-manager-state';
import { parseOpenPayload } from './peer-protocol';
import { quiet } from './peer-ws-race';

const ROUTE_PROMOTED_CTL = 'route-promoted';

export type SessionRole = 'candidate' | 'parked' | 'side' | 'live' | 'retiring' | 'dead';

export type InstallMeta = {
  remoteAddress?: string | null;
  dcAttemptId?: string | null;
  quiesceCapable?: boolean;
  rtcEpoch?: number;
};

export type BindingHandlers = {
  role: SessionRole;
  peerId: string;
  owner: object | null;
  /** 未降级测量：先排队，升成 live 再派发，避免 pending-measure 隔离对端。 */
  queueStreams?: boolean;
  onStream?: (stream: LinkStream) => void;
  onCtl?: (bytes: Uint8Array) => void;
};

type Binding = {
  session: LinkSession;
  role: SessionRole;
  peerId: string;
  owner: object | null;
  queueStreams: boolean;
  onStream: ((stream: LinkStream) => void) | null;
  onCtl: ((bytes: Uint8Array) => void) | null;
  claimed: boolean;
  closedOnce: boolean;
  ctlBuf: Uint8Array[];
  heldForOwner: Uint8Array[];
  streamBuf: LinkStream[];
};

const bindings = new WeakMap<LinkSession, Binding>();
const installMeta = new WeakMap<LinkSession, InstallMeta>();
const promotedHandlers = new Set<(peerId: string, session: LinkSession) => void>();

export function rememberInstallMeta(session: LinkSession, meta: InstallMeta): void {
  const prev = installMeta.get(session) ?? {};
  installMeta.set(session, { ...prev, ...meta });
}

/** 登记安装元数据，且不用 false / undefined 盖掉已经记下的代次和 quiesce。 */
export function stampInstallMeta(
  session: LinkSession,
  meta: InstallMeta & { quiesceCapable?: boolean }
): void {
  touchSession(session);
  rememberInstallMeta(session, {
    remoteAddress: meta.remoteAddress,
    dcAttemptId: meta.dcAttemptId,
    ...(meta.quiesceCapable ? { quiesceCapable: true } : {}),
    ...(meta.rtcEpoch !== undefined ? { rtcEpoch: meta.rtcEpoch } : {}),
  });
}

export function readInstallMeta(session: LinkSession): InstallMeta {
  return installMeta.get(session) ?? {};
}

export function onRoutePromoted(fn: (peerId: string, session: LinkSession) => void): () => void {
  promotedHandlers.add(fn);
  return () => {
    promotedHandlers.delete(fn);
  };
}

export function bindingRole(session: LinkSession): SessionRole | null {
  return bindings.get(session)?.role ?? null;
}

const rtcUnsubs = new WeakMap<LinkSession, () => void>();

/** 重掷候选还在测量时，先把信令订阅挂在 session 上，接受后再转到 live。 */
export function stashSessionRtcUnsub(session: LinkSession, unsub: () => void): void {
  rtcUnsubs.set(session, unsub);
}

export function takeSessionRtcUnsub(session: LinkSession): (() => void) | null {
  const unsub = rtcUnsubs.get(session) ?? null;
  if (unsub) rtcUnsubs.delete(session);
  return unsub;
}

export function touchSession(session: LinkSession): void {
  ensure(session);
}

export function claimSession(session: LinkSession, handlers: BindingHandlers): void {
  const binding = ensure(session);
  binding.role = handlers.role;
  binding.peerId = handlers.peerId;
  binding.owner = handlers.owner;
  binding.queueStreams = handlers.queueStreams === true;
  binding.onStream = handlers.onStream ?? null;
  binding.onCtl = handlers.onCtl ?? null;
  binding.claimed = true;
  flushCtl(binding);
  flushStreams(binding);
}

export function setSessionRole(session: LinkSession, role: SessionRole): void {
  const binding = bindings.get(session);
  if (!binding || binding.role === 'dead') return;
  binding.role = role;
  if (role !== 'live' && role !== 'retiring') return;
  binding.queueStreams = false;
  flushStreams(binding);
  replayHeld(binding);
}

/** 非当前、非退役的绑定：RST stale-link 并只关一次。 */
export function markSessionDead(session: LinkSession, peerId: string): void {
  const binding = ensure(session);
  if (binding.role === 'dead' && binding.closedOnce) return;
  binding.role = 'dead';
  binding.peerId = peerId || binding.peerId;
  binding.queueStreams = false;
  binding.claimed = true;
  binding.onStream = null;
  binding.onCtl = null;
  closeOnce(binding, 'stale-link');
  flushStreams(binding);
}

/**
 * 转发层看见对端 RST 时调用。stale-link 关掉本端 session（dead 角色），
 * 不再让同一条链路一直重放。pending-measure / parked 由 pending-measure-hold 接着处理。
 */
export function noteSessionRefusal(session: LinkSession, reason: string, peerId = ''): void {
  if (reason !== 'stale-link') return;
  markSessionDead(session, peerId);
}

function ensure(session: LinkSession): Binding {
  const existing = bindings.get(session);
  if (existing) return existing;
  const binding = blank(session);
  bindings.set(session, binding);
  session.onStream((stream) => dispatchStream(binding, stream));
  if (typeof session.ctl?.onMessage === 'function') {
    session.ctl.onMessage((bytes) => dispatchCtl(binding, bytes));
  }
  return binding;
}

function blank(session: LinkSession): Binding {
  return {
    session,
    role: 'parked',
    peerId: '',
    owner: null,
    queueStreams: true,
    onStream: null,
    onCtl: null,
    claimed: false,
    closedOnce: false,
    ctlBuf: [],
    heldForOwner: [],
    streamBuf: [],
  };
}

function dispatchStream(binding: Binding, stream: LinkStream): void {
  if (stream.dead) return;
  if (!binding.claimed || binding.queueStreams) {
    binding.streamBuf.push(stream);
    return;
  }
  if (binding.role === 'dead') {
    quiet(() => stream.reset('stale-link'));
    closeOnce(binding, 'stale-link');
    return;
  }
  if (binding.role === 'parked') {
    quiet(() => stream.reset('parked'));
    return;
  }
  if (binding.role === 'candidate') {
    quiet(() => stream.reset('pending-measure'));
    return;
  }
  binding.onStream?.(stream);
}

function flushStreams(binding: Binding): void {
  if (binding.queueStreams) return;
  const pending = binding.streamBuf.splice(0);
  for (const stream of pending) dispatchStream(binding, stream);
}

function dispatchCtl(binding: Binding, bytes: Uint8Array): void {
  const msg = parseOpenPayload(bytes);
  const type = msg && typeof msg.t === 'string' ? msg.t : '';
  if (type === ROUTE_PROMOTED_CTL) {
    for (const handler of promotedHandlers) handler(binding.peerId, binding.session);
    return;
  }
  if (!binding.claimed) {
    binding.ctlBuf.push(bytes);
    return;
  }
  if (type === 'ping' && answersCtlPing(binding.role)) {
    answerPing(binding, msg);
    return;
  }
  if (binding.role === 'candidate' && type !== 'pong') {
    binding.heldForOwner.push(bytes);
    return;
  }
  if (binding.role === 'parked' || binding.role === 'dead') return;
  binding.onCtl?.(bytes);
}

function flushCtl(binding: Binding): void {
  const pending = binding.ctlBuf.splice(0);
  for (const bytes of pending) dispatchCtl(binding, bytes);
  if (binding.role === 'live' || binding.role === 'retiring') replayHeld(binding);
}

function replayHeld(binding: Binding): void {
  const held = binding.heldForOwner.splice(0);
  for (const bytes of held) binding.onCtl?.(bytes);
}

function answersCtlPing(role: SessionRole): boolean {
  return role === 'live' || role === 'retiring' || role === 'candidate' || role === 'side';
}

function answerPing(binding: Binding, msg: Record<string, unknown> | null): void {
  const sentAt = parseEchoedSentAt(msg?.sentAt);
  const payload = sentAt == null ? { t: 'pong' } : { t: 'pong', sentAt };
  quiet(() => binding.session.ctl.send(encodeJsonBytes(payload)));
}

function closeOnce(binding: Binding, reason: string): void {
  if (binding.closedOnce) return;
  binding.closedOnce = true;
  if (reason === 'stale-link') {
    logLine('[mesh][peer]', `stale-link close peer=${binding.peerId}`);
  }
  quiet(() => binding.session.close(reason));
}
