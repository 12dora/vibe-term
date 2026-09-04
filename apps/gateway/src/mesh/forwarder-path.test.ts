import { describe, expect, test } from 'bun:test';
import { parseNodePrefix } from './forwarder-path';

describe('parseNodePrefix', () => {
  test('解析 /n/:nodeId 与 rest，缺省 rest 为 /', () => {
    expect(parseNodePrefix('/n/self/api/devices')).toEqual({
      nodeId: 'self',
      rest: '/api/devices',
    });
    expect(parseNodePrefix('/n/aabbccddeeff00112233445566778899/ws')).toEqual({
      nodeId: 'aabbccddeeff00112233445566778899',
      rest: '/ws',
    });
    expect(parseNodePrefix('/n/self')).toEqual({ nodeId: 'self', rest: '/' });
    expect(parseNodePrefix('/n/self/')).toEqual({ nodeId: 'self', rest: '/' });
  });

  test('对 nodeId 做 decodeURIComponent，非 /n/ 前缀返回 null', () => {
    expect(parseNodePrefix('/n/self%3D/ws')).toEqual({ nodeId: 'self=', rest: '/ws' });
    expect(parseNodePrefix('/n/aa%3Btmex_s_self/api')).toEqual({
      nodeId: 'aa;tmex_s_self',
      rest: '/api',
    });
    expect(parseNodePrefix('/api/devices')).toBeNull();
    expect(parseNodePrefix('/n')).toBeNull();
    expect(parseNodePrefix('/')).toBeNull();
  });
});
