import { describe, expect, test } from 'bun:test';
import { wsBorsh } from '@tmex/shared';
import { API_VERSION, GATEWAY_CAPABILITIES } from '@tmex/shared';
import { getDisplayVersion } from '../system/version';
import { handleCapabilitiesApiRequest } from './capabilities';

function call(method: string, path: string): Response | null {
  const req = new Request(`http://localhost${path}`, { method });
  return handleCapabilitiesApiRequest(req, path);
}

describe('GET /api/capabilities', () => {
  test('返回服务实现、版本与能力列表', async () => {
    const response = call('GET', '/api/capabilities');
    expect(response).not.toBeNull();
    expect(response?.status).toBe(200);

    const body = (await response?.json()) as Record<string, unknown>;
    expect(body.serverImpl).toBe('tmex-gateway');
    expect(body.serverVersion).toBe(getDisplayVersion());
    expect(body.apiVersion).toBe(API_VERSION);
    expect(body.wsProtocolVersion).toBe(wsBorsh.CURRENT_VERSION);
    expect(body.capabilities).toEqual([...GATEWAY_CAPABILITIES]);
  });

  test('serverVersion 非占位硬编码', async () => {
    const response = call('GET', '/api/capabilities');
    const body = (await response?.json()) as Record<string, unknown>;
    expect(typeof body.serverVersion).toBe('string');
    expect(body.serverVersion).not.toBe('0.1.0');
    expect((body.serverVersion as string).length).toBeGreaterThan(0);
  });

  test('非 GET 方法不匹配', () => {
    expect(call('POST', '/api/capabilities')).toBeNull();
    expect(call('DELETE', '/api/capabilities')).toBeNull();
  });

  test('其他路径不匹配', () => {
    expect(call('GET', '/api/capabilities/extra')).toBeNull();
  });
});
