import { describe, expect, test } from 'bun:test';
import {
  UPSTREAM_BODY_MAX_BYTES,
  consumeBoundedBody,
  describeUpstream,
  pushPackageManifest,
} from './remote-upgrade-io';
import type { AuthorizedUpgradeForward } from './upgrade-service';

/** 头发完就把 body 挂住的回包；`cancelled` 记录读流有没有被真的取消掉。 */
function stalledResponse(
  head: string,
  status = 200
): { response: Response; cancelled: () => boolean } {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (head) controller.enqueue(new TextEncoder().encode(head));
    },
    pull() {
      // 永不推进：模拟对端把 body 吊着不发完
      return new Promise<void>(() => {});
    },
    cancel() {
      cancelled = true;
    },
  });
  return { response: new Response(body, { status }), cancelled: () => cancelled };
}

function floodResponse(bytes: number, status = 200): { response: Response; sent: () => number } {
  let sent = 0;
  const chunk = new Uint8Array(8 * 1024).fill(0x61);
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= bytes) {
        controller.close();
        return;
      }
      sent += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
  return { response: new Response(body, { status }), sent: () => sent };
}

describe('consumeBoundedBody', () => {
  test('reads a small body in full', async () => {
    const res = new Response('{"ok":true}', { status: 200 });
    expect(await consumeBoundedBody(res)).toBe('{"ok":true}');
  });

  test('a body with no stream is an empty string', async () => {
    expect(await consumeBoundedBody(new Response(null, { status: 204 }))).toBe('');
  });

  test('a stalled body ends at the deadline and cancels the reader', async () => {
    const { response, cancelled } = stalledResponse('partial');
    const started = Date.now();
    const text = await consumeBoundedBody(response, { timeoutMs: 40 });
    expect(text).toBe('partial');
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(cancelled()).toBe(true);
  });

  test('an oversized body stops at the cap and cancels the reader', async () => {
    const { response, sent } = floodResponse(4 * UPSTREAM_BODY_MAX_BYTES);
    const text = await consumeBoundedBody(response, { limitBytes: 32 * 1024, timeoutMs: 5_000 });
    expect(text.length).toBeLessThanOrEqual(32 * 1024);
    expect(sent()).toBeLessThan(4 * UPSTREAM_BODY_MAX_BYTES);
  });
});

describe('describeUpstream', () => {
  test('bounds an oversized error body instead of buffering it all', async () => {
    const { response } = floodResponse(4 * UPSTREAM_BODY_MAX_BYTES, 500);
    const detail = await describeUpstream(response, 5_000);
    expect(detail.startsWith('HTTP 500 ')).toBe(true);
    expect(detail.length).toBeLessThanOrEqual(810);
  });

  test('a stalled error body still produces a verdict', async () => {
    const { response, cancelled } = stalledResponse('{"code":"NOPE"}', 400);
    expect(await describeUpstream(response, 40)).toBe('HTTP 400 NOPE');
    expect(cancelled()).toBe(true);
  });
});

describe('pushPackageManifest', () => {
  const base = {
    req: new Request('http://localhost/api/mesh/nodes/x/upgrade'),
    nodeId: 'ab'.repeat(16),
    version: '1.1.39',
    sums: `${'ab'.repeat(32)}  vibeterm-cli-1.1.39.tgz\n`,
    sig: 'tmex-release-sig v1 tk AAAA',
    asset: 'vibeterm-cli-1.1.39.tgz',
    signal: new AbortController().signal,
  };

  function forwardWith(response: Response): AuthorizedUpgradeForward {
    return { forwardAuthorizedHttp: async () => response };
  }

  test('a 2xx whose body never completes still returns within the budget', async () => {
    const { response, cancelled } = stalledResponse('{}');
    const started = Date.now();
    const result = await pushPackageManifest({
      ...base,
      forward: forwardWith(response),
      timeoutMs: 60,
    });
    expect(result).toEqual({ ok: true });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(cancelled()).toBe(true);
  });

  test('a rejected manifest with a stalled body reports the code within the budget', async () => {
    const { response } = stalledResponse('{"code":"RELEASE_SIGNATURE_INVALID"}', 400);
    const result = await pushPackageManifest({
      ...base,
      forward: forwardWith(response),
      timeoutMs: 60,
    });
    expect(result).toMatchObject({ ok: false });
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toContain('RELEASE_SIGNATURE_INVALID');
  });

  test('an oversized 404 body does not get buffered whole', async () => {
    const { response, sent } = floodResponse(4 * UPSTREAM_BODY_MAX_BYTES, 404);
    const result = await pushPackageManifest({
      ...base,
      forward: forwardWith(response),
      timeoutMs: 5_000,
    });
    expect(result).toEqual({ ok: true });
    // 读到上限就停：远没有把 4 倍上限的 body 全灌进内存
    expect(sent()).toBeLessThan(2 * UPSTREAM_BODY_MAX_BYTES);
  });
});
