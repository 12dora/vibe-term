import { describe, expect, mock, test } from 'bun:test';
import type { GatewayTransportCommand, GatewayTransportEvent } from './transport';
import { createSharedGatewayTransport } from './transport';

describe('shared gateway transport', () => {
  test('forwards typed commands and externally published events without opening a socket', () => {
    const commands: GatewayTransportCommand[] = [];
    const events: GatewayTransportEvent[] = [];
    const onConnect = mock(() => {});
    const onDisconnect = mock(() => {});
    const transport = createSharedGatewayTransport({
      onConnect,
      onDisconnect,
      onCommand: (command) => {
        commands.push(command);
      },
    });
    const unsubscribe = transport.onEvent((event) => events.push(event));

    transport.connect();
    expect(onConnect).toHaveBeenCalledTimes(1);
    expect(transport.getState()).toBe('WS_CONNECTING');
    expect(events).toEqual([{ type: 'connection-state', state: 'WS_CONNECTING' }]);

    transport.publish({ type: 'connection-state', state: 'READY' });
    expect(transport.isReady()).toBe(true);
    expect(transport.hasConnectedOnce).toBe(true);

    const command: GatewayTransportCommand = {
      type: 'set-pane-subscriptions',
      deviceId: 'device-a',
      generation: 4n,
      paneIds: ['%1'],
    };
    expect(transport.send(command)).toBe(true);
    expect(commands).toEqual([command]);

    transport.publish({
      type: 'terminal-data',
      frame: {
        deviceId: 'device-a',
        paneId: '%1',
        paneEpoch: new Uint8Array(16).fill(1),
        seqStart: 0n,
        seqEnd: 3n,
        data: new Uint8Array([1, 2, 3]),
      },
    });
    expect(events.at(-1)?.type).toBe('terminal-data');
    expect(commands).toHaveLength(1);

    unsubscribe();
    transport.disconnect();
    expect(onDisconnect).toHaveBeenCalledTimes(1);
    expect(transport.getState()).toBe('CLOSED');
  });

  test('allows the shared owner to reject a command', () => {
    const transport = createSharedGatewayTransport({ onCommand: () => false });
    expect(transport.send({ type: 'connect-device', deviceId: 'not-authorized' })).toBe(false);
  });
});
