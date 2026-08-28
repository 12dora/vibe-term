import { MAX_LINK_UNACKED } from '@tmex/shared/link';
import type { DataChannelLike } from './native';
import { rtcLog } from './rtc-log';

export const FANOUT_MAX_PENDING_BYTES = MAX_LINK_UNACKED;
export const FANOUT_MAX_PENDING_MESSAGES = 32;

function messageByteLength(msg: string | Buffer | ArrayBuffer): number {
  if (typeof msg === 'string') return Buffer.byteLength(msg);
  return msg.byteLength;
}

export type FanoutOptions = {
  peer?: string;
};

export type FanoutDataChannel = DataChannelLike & {
  reinjectMessages(msgs: Array<string | Buffer | ArrayBuffer>): void;
  shiftPendingMessage(): string | Buffer | ArrayBuffer | undefined;
};

function addListener<T>(list: T[], item: T): () => void {
  list.push(item);
  return () => {
    const idx = list.indexOf(item);
    if (idx >= 0) list.splice(idx, 1);
  };
}

export function fanoutDataChannel(
  channel: DataChannelLike,
  opts?: FanoutOptions
): FanoutDataChannel {
  const peer = opts?.peer ?? 'unknown';
  const open: Array<() => void> = [];
  const closed: Array<() => void> = [];
  const error: Array<(err: string) => void> = [];
  const message: Array<(msg: string | Buffer | ArrayBuffer) => void> = [];
  const low: Array<() => void> = [];
  const pendingMessages: Array<string | Buffer | ArrayBuffer> = [];
  let pendingBytes = 0;
  let closedFired = false;
  let errorFired: string | null = null;

  const overflow = (dropped: number) => {
    if (closedFired) return;
    closedFired = true;
    pendingMessages.length = 0;
    pendingBytes = 0;
    rtcLog('buffer overflow', { peer, dropped });
    try {
      channel.close();
    } catch {
      // already closed
    }
    for (const cb of [...closed]) cb();
  };

  const enqueue = (msg: string | Buffer | ArrayBuffer) => {
    if (closedFired) return;
    const size = messageByteLength(msg);
    if (pendingBytes + size > FANOUT_MAX_PENDING_BYTES) {
      overflow(pendingMessages.length + 1);
      return;
    }
    pendingMessages.push(msg);
    pendingBytes += size;
  };

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
    if (closedFired) return;
    if (message.length === 0) {
      enqueue(msg);
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
      pendingBytes = 0;
      for (let i = 0; i < queued.length; i++) {
        if (!message.includes(cb)) {
          const rest = queued.slice(i);
          pendingMessages.push(...rest);
          for (const held of rest) pendingBytes += messageByteLength(held);
          break;
        }
        const next = queued[i];
        if (next !== undefined) cb(next);
      }
      return unsub;
    },
    getLabel: channel.getLabel ? () => channel.getLabel?.() ?? '' : undefined,
    shiftPendingMessage() {
      if (closedFired) return undefined;
      const next = pendingMessages.shift();
      if (next !== undefined) pendingBytes = Math.max(0, pendingBytes - messageByteLength(next));
      return next;
    },
    reinjectMessages(msgs) {
      if (closedFired || msgs.length === 0) return;
      if (message.length === 0) {
        const combined = [...msgs, ...pendingMessages];
        let total = 0;
        for (const item of combined) total += messageByteLength(item);
        if (total > FANOUT_MAX_PENDING_BYTES) {
          overflow(combined.length);
          return;
        }
        pendingMessages.length = 0;
        pendingMessages.push(...combined);
        pendingBytes = total;
        return;
      }
      for (const msg of msgs) {
        for (const cb of [...message]) cb(msg);
      }
    },
  };
}
