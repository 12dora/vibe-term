import { describe, expect, test } from 'bun:test';
import { wsBorsh } from '@vibeterm/shared';
import { encodeNodeEventFrame } from './node-event-wire';

describe('encodeNodeEventFrame', () => {
  test('encodes viaRelay / relayPresence from the event and from lookup fallbacks', () => {
    const fromEvent = wsBorsh.decodeNodeEvent(
      wsBorsh.decodeEnvelope(
        encodeNodeEventFrame(
          {
            nodeId: 'aa'.repeat(16),
            status: 'online',
            reach: 'relay',
            transport: 'relay',
            viaRelay: 'https://sh.example',
            relayPresence: ['https://sh.example'],
          },
          1
        )
      ).payload
    );
    expect(fromEvent.viaRelay).toBe('https://sh.example');
    expect(fromEvent.relayPresence).toEqual(['https://sh.example']);

    const fromLookup = wsBorsh.decodeNodeEvent(
      wsBorsh.decodeEnvelope(
        encodeNodeEventFrame({ nodeId: 'bb'.repeat(16), status: 'online', transport: 'relay' }, 2, {
          viaRelayOf: () => 'https://ty.example',
          relayPresenceOf: () => ['https://ty.example', 'https://sh.example'],
        })
      ).payload
    );
    expect(fromLookup.viaRelay).toBe('https://ty.example');
    expect(fromLookup.relayPresence).toEqual(['https://ty.example', 'https://sh.example']);

    const fromDetail = wsBorsh.decodeNodeEvent(
      wsBorsh.decodeEnvelope(
        encodeNodeEventFrame({ nodeId: 'cc'.repeat(16), status: 'online', transport: 'relay' }, 3, {
          linkDetailOf: () => ({
            viaRelay: 'https://detail.example',
            relayPresence: ['https://detail.example'],
          }),
        })
      ).payload
    );
    expect(fromDetail.viaRelay).toBe('https://detail.example');
    expect(fromDetail.relayPresence).toEqual(['https://detail.example']);
  });
});
