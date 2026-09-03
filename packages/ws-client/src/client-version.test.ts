import { describe, expect, test } from 'bun:test';
import { BorshWebSocketClient, getDefaultClientVersion, setDefaultClientVersion } from './client';

describe('default client version', () => {
  test('new clients pick up the version injected by the host app', () => {
    const before = getDefaultClientVersion();
    try {
      setDefaultClientVersion('1.1.23_dev');
      const client = new BorshWebSocketClient();
      expect(client.getClientVersion()).toBe('1.1.23_dev');
      expect(new BorshWebSocketClient({ clientVersion: '9.9.9' }).getClientVersion()).toBe('9.9.9');
    } finally {
      setDefaultClientVersion(before);
    }
  });
});
