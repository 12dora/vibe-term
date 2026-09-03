import type { RtcSignalMessage } from '../mesh-deps';
import type { RtcSignaling } from './ice';

export function loopbackSignaling(): [RtcSignaling, RtcSignaling] {
  const aCbs: Array<(msg: RtcSignalMessage) => void> = [];
  const bCbs: Array<(msg: RtcSignalMessage) => void> = [];
  const aInbox: RtcSignalMessage[] = [];
  const bInbox: RtcSignalMessage[] = [];

  function deliver(
    cbs: Array<(msg: RtcSignalMessage) => void>,
    inbox: RtcSignalMessage[],
    msg: RtcSignalMessage
  ): void {
    if (cbs.length === 0) {
      inbox.push(msg);
      return;
    }
    for (const cb of cbs) cb(msg);
  }

  function subscribe(
    cbs: Array<(msg: RtcSignalMessage) => void>,
    inbox: RtcSignalMessage[],
    cb: (msg: RtcSignalMessage) => void
  ): () => void {
    cbs.push(cb);
    while (inbox.length > 0) {
      const next = inbox.shift();
      if (next) cb(next);
    }
    return () => {
      const idx = cbs.indexOf(cb);
      if (idx >= 0) cbs.splice(idx, 1);
    };
  }

  return [
    {
      send: (msg) => deliver(bCbs, bInbox, msg),
      onMessage: (cb) => subscribe(aCbs, aInbox, cb),
    },
    {
      send: (msg) => deliver(aCbs, aInbox, msg),
      onMessage: (cb) => subscribe(bCbs, bInbox, cb),
    },
  ];
}
