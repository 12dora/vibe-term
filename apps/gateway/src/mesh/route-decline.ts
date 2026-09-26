import type { LinkSession } from '@vibeterm/shared/link';
import { encodeJsonBytes } from './ctl';
import type { LivePeer } from './peer-reconnect-wake';
import { quiet } from './peer-ws-race';
import { DC_PROMOTE_BACKOFF_MS } from './route-policy';
import { peerRtcSession } from './rtc/ice';
import { dcOfferDeclineCtl } from './rtc/rtc-offer-decline';
import { takeSessionRtcUnsub } from './session-binding';

const ROUTE_DECLINE_REASONS = new Set([
  'dc-promote-reject',
  'dc-promote-backoff',
  'route-measure-reject',
  'route-relay',
]);

/** 路由主动拆已建立的 DC 前，先在这条 session 上发 link.route-close，再发 decline。 */
export function signalRouteDecline(input: {
  selfId: string;
  peerId: string;
  session: LinkSession;
  also?: LinkSession | null;
  reason: string;
  epoch?: number;
  retryAfterMs?: number;
}): void {
  if (!ROUTE_DECLINE_REASONS.has(input.reason)) return;
  const retryAfterMs = input.retryAfterMs ?? DC_PROMOTE_BACKOFF_MS;
  const routeClose = encodeJsonBytes({
    t: 'link.route-close',
    reason: input.reason,
    retryAfterMs,
  });
  const bytes = encodeJsonBytes(
    dcOfferDeclineCtl({
      rtcSession: peerRtcSession(input.selfId, input.peerId),
      to: input.peerId,
      reason: 'cooling',
      retryAfterMs,
      epoch: input.epoch,
    })
  );
  quiet(() => input.session.ctl.send(routeClose));
  const seen = new Set<LinkSession>();
  for (const target of [input.also, input.session]) {
    if (!target || seen.has(target)) continue;
    seen.add(target);
    quiet(() => target.ctl.send(bytes));
  }
}

export function closeRouteSession(input: {
  selfId: string;
  peerId: string;
  session: LinkSession;
  also?: LinkSession | null;
  reason: string;
  epoch?: number;
}): void {
  takeSessionRtcUnsub(input.session)?.();
  signalRouteDecline(input);
  quiet(() => input.session.close(input.reason));
}

export function releaseHeldRtcUnsub(session: LinkSession): void {
  takeSessionRtcUnsub(session)?.();
}

/** held 的重掷信令在安装成 live 时挂上；装不上就丢掉订阅。 */
export function adoptSessionRtcUnsub(session: LinkSession, live: LivePeer | undefined): void {
  const unsub = takeSessionRtcUnsub(session);
  if (live && unsub) live.unsubRtc = unsub;
  else unsub?.();
}
