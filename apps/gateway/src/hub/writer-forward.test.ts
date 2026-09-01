import { describe, expect, test } from 'bun:test';
import { HUB_NOT_WRITER } from '@tmex/shared/uplink';
import {
  WRITER_FORWARD_HEADER,
  WRITER_FORWARD_TIMEOUT_MS,
  forwardWriteToWriter,
  notWriterResponse,
  requestAlreadyForwarded,
} from './writer-forward';

const SELF = 'aa'.repeat(16);
const WRITER = 'bb'.repeat(16);

function target(
  over: Partial<{
    writerHubId: string | null;
    writerPublicUrl: string | null;
    writerEpoch: number | null;
  }> = {}
) {
  return {
    writerHubId: WRITER,
    writerPublicUrl: 'https://writer.example',
    writerEpoch: 4,
    ...over,
  };
}

describe('writer-forward', () => {
  test('未知 writer 返回 null（由调用方发 409）', async () => {
    const req = new Request('http://standby/api/hub/enrollments', { method: 'POST', body: '{}' });
    expect(
      await forwardWriteToWriter(req, {
        selfHubId: SELF,
        target: target({ writerHubId: null, writerPublicUrl: null }),
      })
    ).toBeNull();
    expect(
      await forwardWriteToWriter(req, {
        selfHubId: SELF,
        target: target({ writerPublicUrl: null }),
      })
    ).toBeNull();
    const blocked = notWriterResponse(
      target({ writerHubId: null, writerPublicUrl: null, writerEpoch: null })
    );
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toEqual({
      code: HUB_NOT_WRITER,
      writerHubId: null,
      writerPublicUrl: null,
      writerEpoch: null,
    });
  });

  test('已带 X-Tmex-Forwarded-By 的请求不转发（环路守卫）', async () => {
    const req = new Request('http://standby/api/hub/enrollments', {
      method: 'POST',
      headers: { [WRITER_FORWARD_HEADER]: SELF, cookie: 'tmex_s_self=abc' },
      body: '{}',
    });
    expect(requestAlreadyForwarded(req)).toBe(true);
    let fetched = 0;
    const res = await forwardWriteToWriter(req, {
      selfHubId: SELF,
      target: target(),
      fetch: async () => {
        fetched += 1;
        return new Response('nope', { status: 201 });
      },
    });
    expect(res).toBeNull();
    expect(fetched).toBe(0);
  });

  test('各写路由透传 cookie 并原样回写者 status/body，响应带头', async () => {
    const routes = [
      '/api/hub/enrollments',
      '/api/hub/enrollments/redeem',
      '/api/hub/nodes/n1/rename',
      '/api/hub/nodes/n1/revoke',
      '/api/auth/keylog?hub=sync',
    ];
    for (const path of routes) {
      const seen: Array<{
        url: string;
        cookie: string | null;
        forwarded: string | null;
        body: string;
      }> = [];
      const req = new Request(`http://standby${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: 'tmex_s_self=sess-1' },
        body: JSON.stringify({ name: 'x' }),
      });
      const res = await forwardWriteToWriter(req, {
        selfHubId: SELF,
        target: target(),
        fetch: async (url, init) => {
          const headers = new Headers(init?.headers);
          seen.push({
            url,
            cookie: headers.get('cookie'),
            forwarded: headers.get(WRITER_FORWARD_HEADER),
            body: init?.body ? await new Request(url, init).text() : '',
          });
          return new Response(JSON.stringify({ ok: true, path }), {
            status: 201,
            headers: { 'content-type': 'application/json' },
          });
        },
      });
      expect(res).not.toBeNull();
      expect(res?.status).toBe(201);
      expect(res?.headers.get(WRITER_FORWARD_HEADER)).toBe(SELF);
      expect(await res?.json()).toEqual({ ok: true, path });
      expect(seen).toHaveLength(1);
      expect(seen[0]?.url).toBe(`https://writer.example${path}`);
      expect(seen[0]?.cookie).toBe('tmex_s_self=sess-1');
      expect(seen[0]?.forwarded).toBe(SELF);
      expect(seen[0]?.body).toBe(JSON.stringify({ name: 'x' }));
    }
  });

  test('writer 离线 / 超时回退为 null', async () => {
    expect(
      await forwardWriteToWriter(
        new Request('http://standby/api/hub/enrollments', { method: 'POST', body: '{}' }),
        {
          selfHubId: SELF,
          target: target(),
          fetch: async () => {
            throw new Error('connect failed');
          },
        }
      )
    ).toBeNull();

    const timed = await forwardWriteToWriter(
      new Request('http://standby/api/hub/enrollments', { method: 'POST', body: '{}' }),
      {
        selfHubId: SELF,
        target: target(),
        timeoutMs: 20,
        fetch: async (_url, init) => {
          await new Promise<void>((resolve, reject) => {
            const signal = init?.signal;
            if (!signal) {
              resolve();
              return;
            }
            if (signal.aborted) {
              reject(new Error('aborted'));
              return;
            }
            signal.addEventListener('abort', () => reject(new Error('aborted')));
          });
          return new Response('late', { status: 200 });
        },
      }
    );
    expect(timed).toBeNull();
    expect(WRITER_FORWARD_TIMEOUT_MS).toBe(10_000);
  });
});
