import { describe, expect, test } from 'bun:test';
import { handleSystemApiRequest } from '../../../../apps/gateway/src/api/system';
import { createVibeTermGatewayRuntime } from './gateway';

describe('createVibeTermGatewayRuntime', () => {
  test('passes the system API handler to the bundled gateway runtime', async () => {
    let receivedHandler: unknown;

    await createVibeTermGatewayRuntime(async (options) => {
      receivedHandler = options?.systemApiHandler;
      const response = await options?.systemApiHandler?.(
        new Request('http://localhost/api/system/info'),
        '/api/system/info'
      );
      expect(response).toBeInstanceOf(Response);
      expect(response?.status).toBe(200);
      return {} as never;
    });

    expect(receivedHandler).toBe(handleSystemApiRequest);
  });
});
