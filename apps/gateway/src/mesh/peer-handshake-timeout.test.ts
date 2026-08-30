import { describe, expect, test } from 'bun:test';
import { withPeerHandshakeTimeout } from './peer-handshake-timeout';
import { PeerHandshakeError } from './types';

describe('withPeerHandshakeTimeout', () => {
  test('inner resolve 后返回值，超时定时器被清掉', async () => {
    const result = await withPeerHandshakeTimeout(Promise.resolve(7), 50, 'late');
    expect(result).toBe(7);
    await new Promise((resolve) => setTimeout(resolve, 60));
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
    const boom = new Error('boom');
    await expect(withPeerHandshakeTimeout(Promise.reject(boom), 50, 'late')).rejects.toBe(boom);
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
});
