import type { DataChannelLike } from './native';

export function fanoutDataChannel(channel: DataChannelLike): DataChannelLike {
  const open: Array<() => void> = [];
  const closed: Array<() => void> = [];
  const error: Array<(err: string) => void> = [];
  const message: Array<(msg: string | Buffer | ArrayBuffer) => void> = [];
  const low: Array<() => void> = [];
  const pendingMessages: Array<string | Buffer | ArrayBuffer> = [];

  channel.onOpen(() => {
    for (const cb of open) cb();
  });
  channel.onClosed(() => {
    for (const cb of closed) cb();
  });
  channel.onError((err) => {
    for (const cb of error) cb(err);
  });
  channel.onMessage((msg) => {
    if (message.length === 0) {
      pendingMessages.push(msg);
      return;
    }
    for (const cb of message) cb(msg);
  });
  channel.onBufferedAmountLow(() => {
    for (const cb of low) cb();
  });

  return {
    close: () => channel.close(),
    sendMessage: (msg) => channel.sendMessage(msg),
    sendMessageBinary: (buffer) => channel.sendMessageBinary(buffer),
    isOpen: () => channel.isOpen(),
    bufferedAmount: () => channel.bufferedAmount(),
    maxMessageSize: () => channel.maxMessageSize(),
    setBufferedAmountLowThreshold: (bytes) => channel.setBufferedAmountLowThreshold(bytes),
    onBufferedAmountLow: (cb) => {
      low.push(cb);
    },
    onOpen: (cb) => {
      open.push(cb);
      if (channel.isOpen()) cb();
    },
    onClosed: (cb) => {
      closed.push(cb);
    },
    onError: (cb) => {
      error.push(cb);
    },
    onMessage: (cb) => {
      message.push(cb);
      while (pendingMessages.length > 0) {
        const next = pendingMessages.shift();
        if (next !== undefined) cb(next);
      }
    },
    getLabel: channel.getLabel ? () => channel.getLabel?.() ?? '' : undefined,
  };
}
