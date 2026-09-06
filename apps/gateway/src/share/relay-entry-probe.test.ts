import { describe, expect, test } from 'bun:test';
import { RelayEntryProbe, type RelayProbeFetch } from './relay-entry-probe';

const NODE = 'ab'.repeat(16);
const RELAY = 'https://relay.example.com';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeProbe(
  handler: RelayProbeFetch,
  options: { timeoutMs?: number; okTtlMs?: number; badTtlMs?: number } = {}
) {
  const calls: string[] = [];
  let clock = 1_000;
  const probe = new RelayEntryProbe({
    localNodeId: () => NODE,
    fetch: (url, init) => {
      calls.push(url);
      return handler(url, init);
    },
    now: () => clock,
    timeoutMs: options.timeoutMs ?? 50,
    okTtlMs: options.okTtlMs ?? 600_000,
    badTtlMs: options.badTtlMs ?? 120_000,
  });
  return {
    probe,
    calls,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe('RelayEntryProbe', () => {
  test('中继转发本机 /n/<self> 时判定 ok，并按 nodeId 校验', async () => {
    const { probe, calls } = makeProbe(async () => jsonResponse({ nodeId: NODE }));
    expect(probe.state(RELAY)).toBe('unknown');
    probe.ensure(RELAY);
    await probe.settle();
    expect(calls).toEqual([`${RELAY}/n/${NODE}/api/auth/mode`]);
    expect(probe.state(RELAY)).toBe('ok');
  });

  test('非 200 / nodeId 不匹配 / 非 JSON 都判定 bad', async () => {
    const notFound = makeProbe(async () => jsonResponse({ error: 'nope' }, 404));
    notFound.probe.ensure(RELAY);
    await notFound.probe.settle();
    expect(notFound.probe.state(RELAY)).toBe('bad');

    const other = makeProbe(async () => jsonResponse({ nodeId: 'cd'.repeat(16) }));
    other.probe.ensure(RELAY);
    await other.probe.settle();
    expect(other.probe.state(RELAY)).toBe('bad');

    const garbage = makeProbe(async () => new Response('<html>', { status: 200 }));
    garbage.probe.ensure(RELAY);
    await garbage.probe.settle();
    expect(garbage.probe.state(RELAY)).toBe('bad');
  });

  test('超时与网络错误判定 bad，不抛出', async () => {
    const hang: RelayProbeFetch = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const timedOut = makeProbe(hang, { timeoutMs: 10 });
    timedOut.probe.ensure(RELAY);
    await timedOut.probe.settle();
    expect(timedOut.probe.state(RELAY)).toBe('bad');

    const failed = makeProbe(async () => {
      throw new Error('econnrefused');
    });
    failed.probe.ensure(RELAY);
    await failed.probe.settle();
    expect(failed.probe.state(RELAY)).toBe('bad');
  });

  test('同一地址并发只发一次请求', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    const { probe, calls } = makeProbe(async () => {
      await gate;
      return jsonResponse({ nodeId: NODE });
    });
    probe.ensure(RELAY);
    probe.ensure(RELAY);
    probe.ensure(`${RELAY}/`);
    expect(calls).toHaveLength(1);
    release();
    await probe.settle();
    expect(calls).toHaveLength(1);
    expect(probe.state(RELAY)).toBe('ok');
  });

  test('ok 缓存 10 分钟、bad 缓存 2 分钟，过期后重新探测', async () => {
    let nodeId = NODE;
    const { probe, calls, advance } = makeProbe(async () => jsonResponse({ nodeId }), {
      okTtlMs: 600_000,
      badTtlMs: 120_000,
    });
    probe.ensure(RELAY);
    await probe.settle();
    expect(probe.state(RELAY)).toBe('ok');

    advance(599_000);
    probe.ensure(RELAY);
    await probe.settle();
    expect(calls).toHaveLength(1);
    expect(probe.state(RELAY)).toBe('ok');

    advance(2_000);
    expect(probe.state(RELAY)).toBe('unknown');
    nodeId = 'ef'.repeat(16);
    probe.ensure(RELAY);
    await probe.settle();
    expect(calls).toHaveLength(2);
    expect(probe.state(RELAY)).toBe('bad');

    advance(119_000);
    probe.ensure(RELAY);
    await probe.settle();
    expect(calls).toHaveLength(2);
    advance(2_000);
    expect(probe.state(RELAY)).toBe('unknown');
  });

  test('invalidate 丢弃缓存结论，下次 ensure 立即重探（末尾斜杠等价）', async () => {
    let nodeId = 'ef'.repeat(16);
    const { probe, calls } = makeProbe(async () => jsonResponse({ nodeId }));
    probe.ensure(RELAY);
    await probe.settle();
    expect(probe.state(RELAY)).toBe('bad');

    probe.invalidate(`${RELAY}/`);
    expect(probe.state(RELAY)).toBe('unknown');
    nodeId = NODE;
    probe.ensure(RELAY);
    await probe.settle();
    expect(calls).toHaveLength(2);
    expect(probe.state(RELAY)).toBe('ok');
  });

  test('没有本机 nodeId 时不发请求', async () => {
    const calls: string[] = [];
    const probe = new RelayEntryProbe({
      localNodeId: () => null,
      fetch: async (url) => {
        calls.push(url);
        return jsonResponse({ nodeId: NODE });
      },
    });
    probe.ensure(RELAY);
    await probe.settle();
    expect(calls).toEqual([]);
    expect(probe.state(RELAY)).toBe('unknown');
  });
});
