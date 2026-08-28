import type { DataChannelLike } from './native';

export const FANOUT_MAX_PENDING_MESSAGES = 32;

function addListener<T>(list: T[], item: T): () => void {
  list.push(item);
  return () => {
    const idx = list.indexOf(item);
    if (idx >= 0) list.splice(idx, 1);
  };
}

export function fanoutDataChannel(channel: DataChannelLike): DataChannelLike {
  const open: Array<() => void> = [];
  const closed: Array<() => void> = [];
  const error: Array<(err: string) => void> = [];
  const message: Array<(msg: string | Buffer | ArrayBuffer) => void> = [];
  const low: Array<() => void> = [];
  const pendingMessages: Array<string | Buffer | ArrayBuffer> = [];
  let closedFired = false;
  let errorFired: string | null = null;

  channel.onOpen(() => {
    if (closedFired) return;
    for (const cb of [...open]) cb();
  });
  channel.onClosed(() => {
    if (closedFired) return;
    closedFired = true;
    for (const cb of [...closed]) cb();
  });
  channel.onError((err) => {
    errorFired = err;
    for (const cb of [...error]) cb(err);
  });
  channel.onMessage((msg) => {
    if (message.length === 0) {
      if (pendingMessages.length >= FANOUT_MAX_PENDING_MESSAGES) pendingMessages.shift();
      pendingMessages.push(msg);
      return;
    }
    for (const cb of [...message]) cb(msg);
  });
  channel.onBufferedAmountLow(() => {
    for (const cb of [...low]) cb();
  });

  return {
    close: () => channel.close(),
    sendMessage: (msg) => channel.sendMessage(msg),
    sendMessageBinary: (buffer) => channel.sendMessageBinary(buffer),
    isOpen: () => !closedFired && channel.isOpen(),
    bufferedAmount: () => channel.bufferedAmount(),
    maxMessageSize: () => channel.maxMessageSize(),
    setBufferedAmountLowThreshold: (bytes) => channel.setBufferedAmountLowThreshold(bytes),
    onBufferedAmountLow: (cb) => {
      low.push(cb);
    },
    onOpen: (cb) => {
      const unsub = addListener(open, cb);
      if (!closedFired && channel.isOpen()) cb();
      return unsub;
    },
    onClosed: (cb) => {
      const unsub = addListener(closed, cb);
      if (closedFired) cb();
      return unsub;
    },
    onError: (cb) => {
      const unsub = addListener(error, cb);
      if (errorFired !== null) cb(errorFired);
      return unsub;
    },
    onMessage: (cb) => {
      const unsub = addListener(message, cb);
      const queued = pendingMessages.splice(0);
      for (const next of queued) cb(next);
      return unsub;
    },
    getLabel: channel.getLabel ? () => channel.getLabel?.() ?? '' : undefined,
  };
}
