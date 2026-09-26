import type { LinkSession } from '@vibeterm/shared/link';
import { noteDialDcFailure } from './peer-dialer-dc-gate';
import { stashSessionRtcUnsub } from './session-binding';

type DcTrack = (
  session: LinkSession,
  peerNodeId: string,
  transport: 'dc',
  initiatedBy: string,
  gen: number,
  quiesceCapable: boolean,
  remoteAddress: string | null,
  dcAttemptId: string,
  rtcEpoch?: number
) => LinkSession | null;

export function dcRerollPermitted(input: {
  stopped: boolean;
  liveTransport: string | undefined;
  dcCapable: boolean;
  answer: boolean;
  selfLower: string;
  peerLower: string;
  breakerAllows: boolean;
  degraded: boolean;
}): boolean {
  if (input.stopped || input.liveTransport !== 'dc' || !input.dcCapable || input.degraded) {
    return false;
  }
  if (input.answer) return input.selfLower > input.peerLower;
  return input.selfLower < input.peerLower && input.breakerAllows;
}

export function rerollSessionCurrent(input: {
  reroll: boolean;
  degraded: boolean;
  expected: LinkSession | undefined;
  live: LinkSession | undefined;
}): boolean {
  if (!input.reroll) return true;
  if (input.degraded) return false;
  return !input.expected || input.live === input.expected;
}

export function noteDcDialFailure(input: {
  stopped: boolean;
  nodeId: string;
  err: unknown;
  connectP: Promise<{ pc: { close(): void } }> | null;
  attemptId: string;
  peerInitiated: boolean;
  reroll: boolean;
  dcBreaker: Parameters<typeof noteDialDcFailure>[0]['dcBreaker'];
}): string {
  return noteDialDcFailure({
    stopped: input.stopped,
    nodeId: input.nodeId,
    err: input.err,
    connectP: input.connectP,
    attemptId: input.attemptId,
    peerInitiated: input.peerInitiated,
    reroll: input.reroll,
    dcBreaker: input.dcBreaker,
  });
}

type DcOffer = (input: {
  session: LinkSession;
  peerNodeId: string;
  transport: 'dc';
  initiatedBy: string;
  gen: number;
  remoteAddress: string | null;
  dcAttemptId: string;
  rtcEpoch?: number;
}) => 'held' | 'installed' | 'rejected';

export function installFinishedDc(input: {
  reroll?: boolean;
  offer?: DcOffer;
  liveSession?: () => LinkSession | null;
  track: DcTrack;
  release: (unsub: (() => void) | null) => void;
  attach: (unsub: (() => void) | null) => void;
  gen: number;
  unsub: (() => void) | null;
  result: { peerNodeId: string; epoch?: number };
  attemptId: string;
  session: LinkSession;
  initiatedBy: string;
  remoteAddress: string | null;
}): LinkSession | null {
  if (input.reroll && input.offer) {
    const verdict = input.offer({
      session: input.session,
      peerNodeId: input.result.peerNodeId,
      transport: 'dc',
      initiatedBy: input.initiatedBy,
      gen: input.gen,
      remoteAddress: input.remoteAddress,
      dcAttemptId: input.attemptId,
      rtcEpoch: input.result.epoch,
    });
    if (verdict === 'installed') {
      input.attach(input.unsub);
      return input.liveSession?.() ?? input.session;
    }
    if (verdict === 'held') {
      if (input.unsub) stashSessionRtcUnsub(input.session, input.unsub);
      return null;
    }
    input.release(input.unsub);
    return null;
  }
  const kept = input.track(
    input.session,
    input.result.peerNodeId,
    'dc',
    input.initiatedBy,
    input.gen,
    false,
    input.remoteAddress,
    input.attemptId,
    input.result.epoch
  );
  if (kept === input.session) {
    input.attach(input.unsub);
    return kept;
  }
  input.release(input.unsub);
  return kept;
}
