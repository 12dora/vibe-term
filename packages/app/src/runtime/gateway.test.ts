import { describe, expect, test } from 'bun:test';
import { handleSystemApiRequest } from '../../../../apps/gateway/src/api/system';
import { createTmexGatewayRuntime } from './gateway';

describe('createTmexGatewayRuntime', () => {
  test('passes the system API handler to the bundled gateway runtime', async () => {
    let receivedHandler: unknown;

    await createTmexGatewayRuntime(async (options) => {
      receivedHandler = options?.systemApiHandler;
      const response = options?.systemApiHandler?.(
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
