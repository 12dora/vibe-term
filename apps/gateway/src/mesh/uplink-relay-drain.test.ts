import { describe, expect, test } from 'bun:test';
import type { LinkStream } from '@vibeterm/shared/link';
import type { InboundRelayHandler, PooledUplink } from './types';
import { UplinkRelayDrain } from './uplink-relay-drain';

function fakeClient(hubUrl: string): PooledUplink & {
  handler: InboundRelayHandler | null;
  emit(from: string): void;
} {
  const client = {
    hubUrl,
    handler: null as InboundRelayHandler | null,
    setOnRelayStream(handler: InboundRelayHandler | null) {
      client.handler = handler;
    },
    emit(from: string) {
      const stream = { closed: Promise.resolve() } as unknown as LinkStream;
      client.handler?.(stream, from, hubUrl);
    },
  };
  return client as unknown as PooledUplink & {
    handler: InboundRelayHandler | null;
    emit(from: string): void;
  };
}

describe('UplinkRelayDrain inbound viaRelay', () => {
  test('bind 把 live client 的 hubUrl 传给入站 handler', () => {
    const drain = new UplinkRelayDrain({
      scheduler: { now: () => 1, sleep: async () => undefined, interval: () => ({ clear() {} }) },
      log: () => {},
    });
    const seen: Array<{ from: string; viaRelay?: string }> = [];
    drain.setHandler((_stream, from, viaRelay) => {
      seen.push({ from, viaRelay });
    });
    const client = fakeClient('https://sh.example');
    drain.bind(client, () => true);
    client.emit('aa'.repeat(16));
    expect(seen).toEqual([{ from: 'aa'.repeat(16), viaRelay: 'https://sh.example' }]);
  });
});
