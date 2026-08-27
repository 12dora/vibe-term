import { describe, expect, test } from 'bun:test';
import { LinkMux } from '@tmex/shared/link';
import { DataChannelLink } from './data-channel-link';
import { FRAGMENT_PAYLOAD_SIZE } from './fragmenter';
import { pairDataChannels } from './test-fakes';

describe('DataChannelLink', () => {
  test('is a ByteTransport that round-trips fragmented payloads', async () => {
    const [a, b] = pairDataChannels('peer');
    const left = new DataChannelLink(a);
    const right = new DataChannelLink(b);
    const got = new Promise<Uint8Array>((resolve) => right.onData(resolve));
    const payload = new Uint8Array(FRAGMENT_PAYLOAD_SIZE + 4).fill(11);
    left.send(payload);
    expect(await got).toEqual(payload);
  });

  test('carries LinkMux streams', async () => {
    const [a, b] = pairDataChannels('peer');
    const left = new LinkMux(new DataChannelLink(a), { role: 'initiator' });
    const right = new LinkMux(new DataChannelLink(b), { role: 'acceptor' });
    const incoming = new Promise<import('@tmex/shared/link').LinkStream>((resolve) =>
      right.onStream(resolve)
    );
    const open = new TextEncoder().encode('{"type":"http"}');
    const out = await left.openStream(open);
    const inn = await incoming;
    expect(inn.openPayload).toEqual(open);
    const read = inn.readable.getReader();
    await out.write(new Uint8Array([1, 2, 3]));
    const chunk = await read.read();
    expect(chunk.value?.bytes).toEqual(new Uint8Array([1, 2, 3]));
    out.end();
    inn.end();
  });

  test('close notifies the peer transport', async () => {
    const [a, b] = pairDataChannels('peer');
    const left = new DataChannelLink(a);
    const right = new DataChannelLink(b);
    const closed = new Promise<string | undefined>((resolve) => right.onClose(resolve));
    left.close('bye');
    expect(await closed).toBe('channel-closed');
  });
});
