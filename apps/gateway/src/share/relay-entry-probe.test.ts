import { describe, expect, test } from 'bun:test';
import {
  RELAY_PROBE_BAD_TTL_CAP_MS,
  RELAY_PROBE_BAD_TTL_MS,
  RelayEntryProbe,
  type RelayProbeFetch,
  relayProbeBadTtlMs,
} from './relay-entry-probe';

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

  test('连续失败按 2→4→8→16 分钟升级，封顶 30 分钟', async () => {
    const { probe, calls, advance } = makeProbe(async () => jsonResponse({ error: 'nope' }, 503), {
      badTtlMs: RELAY_PROBE_BAD_TTL_MS,
    });
    const ttls = [2, 4, 8, 16, 30, 30].map((minutes) => minutes * 60_000);
    for (const ttl of ttls) {
      probe.ensure(RELAY);
      await probe.settle();
      expect(probe.state(RELAY)).toBe('bad');
      const n = calls.length;
      advance(ttl - 1_000);
      probe.ensure(RELAY);
      await probe.settle();
      expect(calls).toHaveLength(n);
      advance(2_000);
      expect(probe.state(RELAY)).toBe('unknown');
    }
    expect(calls).toHaveLength(ttls.length);
  });

  test('成功后失败次数归零，下一次失败重新从 2 分钟计', async () => {
    let nodeId = 'ef'.repeat(16);
    const { probe, calls, advance } = makeProbe(async () => jsonResponse({ nodeId }), {
      okTtlMs: 600_000,
      badTtlMs: RELAY_PROBE_BAD_TTL_MS,
    });
    probe.ensure(RELAY);
    await probe.settle();
    advance(RELAY_PROBE_BAD_TTL_MS + 1);
    probe.ensure(RELAY);
    await probe.settle();
    expect(calls).toHaveLength(2);

    nodeId = NODE;
    advance(4 * 60_000 + 1);
    probe.ensure(RELAY);
    await probe.settle();
    expect(probe.state(RELAY)).toBe('ok');
    expect(calls).toHaveLength(3);

    nodeId = 'ef'.repeat(16);
    advance(600_000 + 1);
    probe.ensure(RELAY);
    await probe.settle();
    expect(probe.state(RELAY)).toBe('bad');
    expect(calls).toHaveLength(4);
    advance(RELAY_PROBE_BAD_TTL_MS - 1_000);
    probe.ensure(RELAY);
    await probe.settle();
    expect(calls).toHaveLength(4);
    advance(2_000);
    expect(probe.state(RELAY)).toBe('unknown');
  });

  test('force 可在 bad TTL 内绕过退避立刻重探，失败则继续升级', async () => {
    const { probe, calls, advance } = makeProbe(async () => jsonResponse({ error: 'nope' }, 503), {
      badTtlMs: RELAY_PROBE_BAD_TTL_MS,
    });
    probe.ensure(RELAY);
    await probe.settle();
    expect(calls).toHaveLength(1);

    probe.ensure(RELAY);
    await probe.settle();
    expect(calls).toHaveLength(1);

    probe.ensure(RELAY, { force: true });
    await probe.settle();
    expect(calls).toHaveLength(2);
    expect(probe.state(RELAY)).toBe('bad');

    advance(4 * 60_000 - 1_000);
    probe.ensure(RELAY);
    await probe.settle();
    expect(calls).toHaveLength(2);
    advance(2_000);
    expect(probe.state(RELAY)).toBe('unknown');
  });

  test('invalidate 绕过当前等待但保留失败次数', async () => {
    const { probe, calls, advance } = makeProbe(async () => jsonResponse({ error: 'nope' }, 503), {
      badTtlMs: RELAY_PROBE_BAD_TTL_MS,
    });
    probe.ensure(RELAY);
    await probe.settle();
    probe.invalidate(RELAY);
    expect(probe.state(RELAY)).toBe('unknown');
    probe.ensure(RELAY);
    await probe.settle();
    expect(calls).toHaveLength(2);

    advance(4 * 60_000 - 1_000);
    probe.ensure(RELAY);
    await probe.settle();
    expect(calls).toHaveLength(2);
    advance(2_000);
    expect(probe.state(RELAY)).toBe('unknown');
  });

  test('失败次数按目标隔离', async () => {
    const other = 'https://relay-b.example.com';
    const { probe, calls, advance } = makeProbe(async () => jsonResponse({ error: 'nope' }, 503), {
      badTtlMs: RELAY_PROBE_BAD_TTL_MS,
    });
    probe.ensure(RELAY);
    await probe.settle();
    advance(RELAY_PROBE_BAD_TTL_MS + 1);
    probe.ensure(RELAY);
    await probe.settle();

    probe.ensure(other);
    await probe.settle();
    expect(calls).toHaveLength(3);
    advance(RELAY_PROBE_BAD_TTL_MS - 1_000);
    probe.ensure(other);
    await probe.settle();
    expect(calls).toHaveLength(3);
    advance(2_000);
    expect(probe.state(other)).toBe('unknown');
    expect(probe.state(RELAY)).toBe('bad');
  });
});

describe('relayProbeBadTtlMs', () => {
  test('首次 2 分钟，之后翻倍，封顶 30 分钟', () => {
    expect(relayProbeBadTtlMs(1)).toBe(RELAY_PROBE_BAD_TTL_MS);
    expect(relayProbeBadTtlMs(2)).toBe(4 * 60_000);
    expect(relayProbeBadTtlMs(3)).toBe(8 * 60_000);
    expect(relayProbeBadTtlMs(4)).toBe(16 * 60_000);
    expect(relayProbeBadTtlMs(5)).toBe(RELAY_PROBE_BAD_TTL_CAP_MS);
    expect(relayProbeBadTtlMs(20)).toBe(RELAY_PROBE_BAD_TTL_CAP_MS);
    expect(relayProbeBadTtlMs(0)).toBe(RELAY_PROBE_BAD_TTL_MS);
  });
});
