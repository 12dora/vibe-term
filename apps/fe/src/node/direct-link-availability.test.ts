import { afterEach, describe, expect, test } from 'bun:test';
import {
  DIRECT_LINK_NEGATIVE_TTL_MS,
  clearDirectLinkAvailability,
  isDirectLinkUnavailable,
  markDirectLinkUnavailable,
  watchDirectNegotiation,
} from './direct-link-availability';

const NODE_A = '0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a';
const ENTRY_B = '0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b';
const ENTRY_C = '0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c';

afterEach(() => {
  clearDirectLinkAvailability();
});

/** 钩子里的判定要读一次 body，等微任务队列排空。 */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function clientReturning(res: () => Response): { fetch: (path: string) => Promise<Response> } {
  return { fetch: () => Promise.resolve(res()) };
}

describe('负缓存', () => {
  test('按 entry+node 记账并在 TTL 内命中', () => {
    const now = 1_000_000;
    markDirectLinkUnavailable(NODE_A, ENTRY_B, now);
    expect(isDirectLinkUnavailable(NODE_A, ENTRY_B, now + 1)).toBe(true);
    // 换一个入口不受影响
    expect(isDirectLinkUnavailable(NODE_A, ENTRY_C, now + 1)).toBe(false);
  });

  test('TTL 到期即失效', () => {
    const now = 1_000_000;
    markDirectLinkUnavailable(NODE_A, ENTRY_B, now);
    expect(isDirectLinkUnavailable(NODE_A, ENTRY_B, now + DIRECT_LINK_NEGATIVE_TTL_MS + 1)).toBe(
      false
    );
  });
});

describe('watchDirectNegotiation', () => {
  test('协商端点被入口代答的 401：记负缓存并回调宿主', async () => {
    let stopped = 0;
    const client = watchDirectNegotiation(
      NODE_A,
      clientReturning(
        () =>
          new Response(JSON.stringify({ code: 'NODE_LOGIN_REQUIRED', nodeId: ENTRY_B }), {
            status: 401,
          })
      ),
      () => {
        stopped += 1;
      }
    );
    const res = await client.fetch('/api/rtc/authorize');
    await flush();

    expect(res.status).toBe(401);
    expect(stopped).toBe(1);
    expect(isDirectLinkUnavailable(NODE_A, null)).toBe(true);
  });

  test('`/api/mesh/connection?cid=` 同样算协商端点', async () => {
    const client = watchDirectNegotiation(
      NODE_A,
      clientReturning(() => new Response(JSON.stringify({ nodeId: ENTRY_B }), { status: 401 })),
      () => undefined
    );
    await client.fetch('/api/mesh/connection?cid=abc');
    await flush();

    expect(isDirectLinkUnavailable(NODE_A, null)).toBe(true);
  });

  test('401 出自目标 node 自己：不记负缓存（那是真的要重新登录）', async () => {
    let stopped = 0;
    const client = watchDirectNegotiation(
      NODE_A,
      clientReturning(
        () =>
          new Response(JSON.stringify({ code: 'NODE_LOGIN_REQUIRED', nodeId: NODE_A }), {
            status: 401,
          })
      ),
      () => {
        stopped += 1;
      }
    );
    await client.fetch('/api/rtc/authorize');
    await flush();

    expect(stopped).toBe(0);
    expect(isDirectLinkUnavailable(NODE_A, null)).toBe(false);
  });

  test('非协商端点的 401 不进负缓存', async () => {
    const client = watchDirectNegotiation(
      NODE_A,
      clientReturning(() => new Response(JSON.stringify({ nodeId: ENTRY_B }), { status: 401 })),
      () => undefined
    );
    await client.fetch('/api/devices');
    await flush();

    expect(isDirectLinkUnavailable(NODE_A, null)).toBe(false);
  });

  test('body 读不出结论时不封锁（宁可下次再试）', async () => {
    const client = watchDirectNegotiation(
      NODE_A,
      clientReturning(() => new Response('nope', { status: 401 })),
      () => undefined
    );
    await client.fetch('/api/rtc/authorize');
    await flush();

    expect(isDirectLinkUnavailable(NODE_A, null)).toBe(false);
  });

  test('成功的协商照常透传，body 不被消费', async () => {
    const client = watchDirectNegotiation(
      NODE_A,
      clientReturning(() => new Response(JSON.stringify({ connectionId: 'c1' }), { status: 200 })),
      () => undefined
    );
    const res = await client.fetch('/api/mesh/connection?cid=abc');
    expect(await res.json()).toEqual({ connectionId: 'c1' });
    expect(isDirectLinkUnavailable(NODE_A, null)).toBe(false);
  });
});
