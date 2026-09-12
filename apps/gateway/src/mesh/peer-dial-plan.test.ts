import { describe, expect, test } from 'bun:test';
import { peerKnownRelayOnline, raceDirectWithRelay, settleDialWithRelay } from './peer-dial-plan';
import { NodeUnreachableError } from './types';

describe('peerKnownRelayOnline', () => {
  const nodeId = 'bb'.repeat(16);

  test('true when relayPresence lists the peer', () => {
    expect(
      peerKnownRelayOnline({
        nodeId,
        relaysFor: (id) => (id === nodeId ? ['https://relay.example'] : []),
      })
    ).toBe(true);
  });

  test('true when uplink roster union contains the peer', () => {
    expect(
      peerKnownRelayOnline({
        nodeId,
        relaysFor: () => [],
        onlineUnion: () => new Set([nodeId]),
      })
    ).toBe(true);
  });

  test('false when the target is not on any relay', () => {
    expect(
      peerKnownRelayOnline({
        nodeId,
        relaysFor: () => [],
        onlineUnion: () => new Set(['cc'.repeat(16)]),
      })
    ).toBe(false);
    expect(peerKnownRelayOnline({ nodeId })).toBe(false);
  });
});

describe('raceDirectWithRelay', () => {
  type Session = { id: string; closed: string | null };

  test('relay win returns immediately and does not abort the direct leg', async () => {
    const settled: Array<Session | null> = [];
    let abortRelay = 0;
    let finishDirect: ((session: Session) => void) | undefined;
    const won = await raceDirectWithRelay<Session>({
      nodeId: 'n',
      direct: new Promise((resolve) => {
        finishDirect = (session) => resolve({ session, pending: null });
      }),
      relay: Promise.resolve({ id: 'relay', closed: null }),
      abortRelay: () => {
        abortRelay += 1;
      },
      onDirectSettled: (result) => settled.push(result.session),
    });
    expect(won.id).toBe('relay');
    expect(abortRelay).toBe(0);
    finishDirect?.({ id: 'dc-late', closed: null });
    await Bun.sleep(0);
    expect(settled).toEqual([{ id: 'dc-late', closed: null }]);
  });

  test('direct win aborts the relay loser', async () => {
    let abortRelay = 0;
    const won = await raceDirectWithRelay<Session>({
      nodeId: 'n',
      direct: Promise.resolve({ session: { id: 'dc', closed: null }, pending: null }),
      relay: new Promise(() => {}),
      abortRelay: () => {
        abortRelay += 1;
      },
    });
    expect(won.id).toBe('dc');
    expect(abortRelay).toBe(1);
  });

  test('direct miss then relay success uses the in-flight relay', async () => {
    let finishRelay: ((session: Session) => void) | undefined;
    const pending = raceDirectWithRelay<Session>({
      nodeId: 'n',
      direct: Promise.resolve({ session: null, pending: null }),
      relay: new Promise((resolve) => {
        finishRelay = resolve;
      }),
      abortRelay: () => {
        throw new Error('must not abort');
      },
    });
    await Bun.sleep(0);
    finishRelay?.({ id: 'relay-late', closed: null });
    expect((await pending).id).toBe('relay-late');
  });

  test('both miss then a late direct pending is the last straw', async () => {
    const won = await raceDirectWithRelay<Session>({
      nodeId: 'n',
      direct: Promise.resolve({
        session: null,
        pending: Promise.resolve({ id: 'dc-pending', closed: null }),
      }),
      relay: Promise.reject(new NodeUnreachableError('n', 'offline')),
      abortRelay: () => undefined,
    });
    expect(won.id).toBe('dc-pending');
  });

  test('both miss with no pending wraps a generic relay error', async () => {
    await expect(
      raceDirectWithRelay<Session>({
        nodeId: 'dead',
        direct: Promise.resolve({ session: null, pending: null }),
        relay: Promise.reject(new Error('uplink is not online')),
        abortRelay: () => undefined,
      })
    ).rejects.toMatchObject({ name: 'NodeUnreachableError', message: 'uplink is not online' });
  });
});

describe('settleDialWithRelay', () => {
  type Session = { id: string; closed: string | null };

  test('serial path waits for direct before starting relay', async () => {
    const order: string[] = [];
    const session = await settleDialWithRelay<Session>({
      nodeId: 'n',
      raceRelay: false,
      direct: Promise.resolve({ session: null, pending: null }).then((row) => {
        order.push('direct');
        return row;
      }),
      startRelay: async () => {
        order.push('relay');
        return { id: 'relay', closed: null };
      },
      onDirectSettled: () => order.push('settled'),
    });
    expect(session.id).toBe('relay');
    expect(order).toEqual(['direct', 'settled', 'relay']);
  });

  test('serial path returns a direct winner without starting relay', async () => {
    let relay = 0;
    const session = await settleDialWithRelay<Session>({
      nodeId: 'n',
      raceRelay: false,
      direct: Promise.resolve({ session: { id: 'dc', closed: null }, pending: null }),
      startRelay: async () => {
        relay += 1;
        return { id: 'relay', closed: null };
      },
      onDirectSettled: () => undefined,
    });
    expect(session.id).toBe('dc');
    expect(relay).toBe(0);
  });
});
