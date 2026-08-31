import { describe, expect, test } from 'bun:test';
import { handlePreflightHttp, preflightHealthzBody, readRuntimeMode } from './mode';

describe('runtime mode', () => {
  test('reads TMEX_RUNTIME_MODE', () => {
    expect(readRuntimeMode({})).toBe('normal');
    expect(readRuntimeMode({ TMEX_RUNTIME_MODE: 'preflight' })).toBe('preflight');
  });

  test('preflight HTTP only exposes /healthz', async () => {
    const health = handlePreflightHttp(new Request('http://127.0.0.1/healthz'), '1.2.3', 42);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual(preflightHealthzBody('1.2.3', 42));
    const other = handlePreflightHttp(new Request('http://127.0.0.1/api/system/info'), '1.2.3', 42);
    expect(other.status).toBe(404);
  });
});
