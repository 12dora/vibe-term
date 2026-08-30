import { describe, expect, test } from 'bun:test';
import { withPeerHandshakeTimeout } from './peer-handshake-timeout';
import { PeerHandshakeError } from './types';

function trackingTimers() {
  const cleared: unknown[] = [];
  return {
    cleared,
    timers: {
      setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
      clearTimeout: (id: unknown) => {
        cleared.push(id);
        clearTimeout(id as ReturnType<typeof setTimeout>);
      },
    },
  };
}

describe('withPeerHandshakeTimeout', () => {
  test('inner resolve 后返回值，超时定时器被清掉', async () => {
    const { cleared, timers } = trackingTimers();
    const result = await withPeerHandshakeTimeout(Promise.resolve(7), 50, 'late', timers);
    expect(result).toBe(7);
    expect(cleared).toHaveLength(1);
  });

  test('超时以 PeerHandshakeError(timeout) 拒绝', async () => {
    const pending = withPeerHandshakeTimeout(new Promise(() => {}), 15, 'too slow');
    await expect(pending).rejects.toBeInstanceOf(PeerHandshakeError);
    await pending.catch((err: PeerHandshakeError) => {
      expect(err.code).toBe('timeout');
      expect(err.message).toBe('too slow');
    });
  });

  test('inner reject 原样抛出且清掉超时定时器', async () => {
    const { cleared, timers } = trackingTimers();
    const boom = new Error('boom');
    await expect(withPeerHandshakeTimeout(Promise.reject(boom), 50, 'late', timers)).rejects.toBe(
      boom
    );
    expect(cleared).toHaveLength(1);
  });
});
