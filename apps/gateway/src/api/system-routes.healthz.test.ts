import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { Server } from 'bun';
import { readNodeEnv } from '../../../../packages/shared/src/env/load-env';
import { handleApiRequest } from './index';

const fakeServer = {} as Server<unknown>;

describe('GET /healthz env', () => {
  test('reports the runtime NODE_ENV, not a missing-value fallback', async () => {
    const res = await handleApiRequest(new Request('http://localhost/healthz'), fakeServer);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; env: string; version: string };
    expect(body.status).toBe('ok');
    expect(body.env).toBe(readNodeEnv());
    expect(typeof body.version).toBe('string');
    expect(body.version.length).toBeGreaterThan(0);
  });

  test('bun build does not inline healthz env as the compile-time NODE_ENV', async () => {
    const result = await Bun.build({
      entrypoints: [join(import.meta.dir, 'system-routes.ts')],
      target: 'bun',
      packages: 'external',
    });
    expect(result.success).toBe(true);
    const text = await result.outputs[0]?.text();
    expect(text).toBeDefined();
    const healthz = text?.match(/path:\s*"\/healthz"[\s\S]{0,800}/)?.[0];
    expect(healthz).toBeDefined();
    expect(healthz).not.toMatch(/env:\s*"(development|test|production)"/);
  });
});
