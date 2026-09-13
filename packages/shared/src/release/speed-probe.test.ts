import { describe, expect, test } from 'bun:test';
import { probeReleaseAssetSpeed } from './speed-probe';

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function rangeOf(init?: RequestInit): string | null {
  return new Headers(init?.headers).get('range');
}

describe('probeReleaseAssetSpeed', () => {
  test('fast: 206 在期限内给出足够字节', async () => {
    const result = await probeReleaseAssetSpeed('https://github.example/asset.tgz', {
      minBytes: 8,
      deadlineMs: 1000,
      fetch: async () =>
        new Response(Buffer.from('abcdefghijklmnop'), {
          status: 206,
          headers: {
            'Content-Range': 'bytes 0-15/1024',
            'Accept-Ranges': 'bytes',
          },
        }),
    });
    expect(result.verdict).toBe('fast');
    expect(result.finalUrl).toBe('https://github.example/asset.tgz');
    expect(result.bytes).toBeGreaterThanOrEqual(8);
    expect(result.acceptsRanges).toBe(true);
    expect(result.totalBytes).toBe(1024);
  });

  test('whole asset smaller than minBytes and completed is fast', async () => {
    const result = await probeReleaseAssetSpeed('https://cdn.example/tiny.tgz', {
      minBytes: 64 * 1024,
      fetch: async () =>
        new Response(Buffer.from('tiny'), {
          status: 206,
          headers: {
            'Content-Range': 'bytes 0-3/4',
            'Accept-Ranges': 'bytes',
          },
        }),
    });
    expect(result.verdict).toBe('fast');
    expect(result.bytes).toBe(4);
    expect(result.totalBytes).toBe(4);
  });

  test('slow: 拿得到头但期限内字节不够', async () => {
    const result = await probeReleaseAssetSpeed('https://cdn.example/slow.tgz', {
      minBytes: 64,
      deadlineMs: 80,
      fetch: async (_input, init) => {
        const signal = init?.signal;
        const body = new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3, 4]));
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, 500);
              signal?.addEventListener(
                'abort',
                () => {
                  clearTimeout(timer);
                  resolve();
                },
                { once: true }
              );
            });
            try {
              controller.close();
            } catch {
              // 已被 cancel
            }
          },
        });
        return new Response(body, {
          status: 206,
          headers: {
            'Content-Range': 'bytes 0-63/1000000',
            'Accept-Ranges': 'bytes',
          },
        });
      },
    });
    expect(result.verdict).toBe('slow');
    expect(result.finalUrl).toBe('https://cdn.example/slow.tgz');
    expect(result.bytes).toBeLessThan(64);
    expect(result.acceptsRanges).toBe(true);
  });

  test('redirect chain: Range 打在最终 CDN 地址上', async () => {
    const seen: Array<{ url: string; range: string | null; redirect?: RequestRedirect }> = [];
    const result = await probeReleaseAssetSpeed(
      'https://github.com/owner/repo/releases/download/v1/a.tgz',
      {
        minBytes: 4,
        fetch: async (input, init) => {
          const url = urlOf(input);
          seen.push({ url, range: rangeOf(init), redirect: init?.redirect });
          if (url === 'https://github.com/owner/repo/releases/download/v1/a.tgz') {
            return new Response(null, {
              status: 302,
              headers: { Location: 'https://objects.githubusercontent.com/hop' },
            });
          }
          if (url === 'https://objects.githubusercontent.com/hop') {
            return new Response(null, {
              status: 302,
              headers: { Location: '/release-assets/final' },
            });
          }
          expect(url).toBe('https://objects.githubusercontent.com/release-assets/final');
          return new Response(Buffer.from('abcdxxxx'), {
            status: 206,
            headers: {
              'Content-Range': 'bytes 0-7/99',
              'Accept-Ranges': 'bytes',
            },
          });
        },
      }
    );
    expect(result.verdict).toBe('fast');
    expect(result.finalUrl).toBe('https://objects.githubusercontent.com/release-assets/final');
    expect(result.totalBytes).toBe(99);
    expect(seen.every((call) => call.redirect === 'manual')).toBe(true);
    expect(seen.every((call) => call.range === 'bytes=0-3')).toBe(true);
    expect(seen.map((call) => call.url)).toEqual([
      'https://github.com/owner/repo/releases/download/v1/a.tgz',
      'https://objects.githubusercontent.com/hop',
      'https://objects.githubusercontent.com/release-assets/final',
    ]);
  });

  test('403 is unreachable', async () => {
    const result = await probeReleaseAssetSpeed('https://github.example/nope.tgz', {
      fetch: async () => new Response('forbidden', { status: 403 }),
    });
    expect(result.verdict).toBe('unreachable');
    expect(result.finalUrl).toBeNull();
    expect(result.bytes).toBe(0);
    expect(result.error).toBe('HTTP 403');
    expect(result.acceptsRanges).toBe(false);
  });

  test('abort before headers is unreachable', async () => {
    const result = await probeReleaseAssetSpeed('https://cdn.example/hang.tgz', {
      deadlineMs: 40,
      fetch: (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })),
            { once: true }
          );
        }),
    });
    expect(result.verdict).toBe('unreachable');
    expect(result.finalUrl).toBeNull();
    expect(result.error).toMatch(/timeout|abort/i);
  });

  test('DNS/connect failure is unreachable', async () => {
    const result = await probeReleaseAssetSpeed('https://no.such.host/asset.tgz', {
      fetch: async () => {
        throw new TypeError('fetch failed');
      },
    });
    expect(result.verdict).toBe('unreachable');
    expect(result.finalUrl).toBeNull();
    expect(result.error).toMatch(/fetch failed/);
  });

  test('Accept-Ranges: bytes on 200 still marks acceptsRanges', async () => {
    const result = await probeReleaseAssetSpeed('https://cdn.example/asset.tgz', {
      minBytes: 4,
      fetch: async () =>
        new Response(Buffer.from('abcdef'), {
          status: 200,
          headers: {
            'Accept-Ranges': 'bytes',
            'Content-Length': '999',
          },
        }),
    });
    expect(result.verdict).toBe('fast');
    expect(result.acceptsRanges).toBe(true);
    expect(result.totalBytes).toBe(999);
  });

  test('caller abort throws AbortError instead of returning unreachable', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      probeReleaseAssetSpeed('https://cdn.example/asset.tgz', {
        signal: ac.signal,
        fetch: async () => new Response('x', { status: 200 }),
      })
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
