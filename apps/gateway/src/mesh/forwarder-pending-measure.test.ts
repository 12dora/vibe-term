import { describe, expect, test } from 'bun:test';
import { LinkError, type LinkSession } from '@vibeterm/shared/link';
import { Forwarder } from './forwarder';
import type { PeerLinkProvider, StreamOpener } from './mesh-deps';

const OTHER = 'bb'.repeat(16);
const NODE_ID = 'aa'.repeat(16);
const dummyLink = {} as LinkSession;
const dummyServer = { upgrade: () => true };

function forwarderWith(open: () => Response): Forwarder {
  const peers: PeerLinkProvider = {
    async getLink() {
      return dummyLink;
    },
    listReach: () => new Map(),
    onNodeEvent: () => () => {},
  };
  const streams: StreamOpener = {
    async openHttpStream() {
      return open();
    },
    async openWsStream() {
      throw new Error('ws not used');
    },
  };
  return new Forwarder({
    nodeId: NODE_ID,
    peers,
    streams,
    sleep: async () => {},
  });
}

function authorize(): Request {
  const body = JSON.stringify({ rtcSession: 'sess' });
  return new Request(`http://localhost/n/${OTHER}/api/rtc/authorize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': String(body.length) },
    body,
  });
}

function streamingAuthorize(): Request {
  return new Request(`http://localhost/n/${OTHER}/api/rtc/authorize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"rtcSession":"sess"}'));
        controller.close();
      },
    }),
  });
}

describe('HTTP pending-measure', () => {
  test('forwardAuthorizedHttp 的 JSON POST 遇到 pending-measure 也只重试一次', async () => {
    let opens = 0;
    const forwarder = forwarderWith(() => {
      opens += 1;
      if (opens === 1) throw new LinkError('rst', 'pending-measure');
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const res = await forwarder.forwardAuthorizedHttp(
      new Request('http://localhost/api/x', {
        headers: { cookie: `vibeterm_s_${OTHER}=remote-sid` },
      }),
      { nodeId: OTHER, method: 'POST', path: '/api/rtc/authorize', body: { rtcSession: 'sess' } }
    );
    expect(opens).toBe(2);
    expect(res.status).toBe(200);
  });

  test('POST 在开流即被 pending-measure 时换传输再试一次', async () => {
    let opens = 0;
    const forwarder = forwarderWith(() => {
      opens += 1;
      if (opens === 1) throw new LinkError('rst', 'pending-measure');
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const res = await forwarder.handle(authorize(), dummyServer);
    if (!(res instanceof Response)) throw new Error('expected response');
    expect(opens).toBe(2);
    expect(res.status).toBe(200);
  });

  test('普通 POST 失败仍然不重试', async () => {
    let opens = 0;
    const forwarder = forwarderWith(() => {
      opens += 1;
      throw new Error('post failed');
    });
    const res = await forwarder.handle(authorize(), dummyServer);
    if (!(res instanceof Response)) throw new Error('expected response');
    expect(opens).toBe(1);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ reason: 'no_link' });
  });

  test('pending-measure 连拒两次后 503 的原因是 link_lost', async () => {
    let opens = 0;
    const forwarder = forwarderWith(() => {
      opens += 1;
      throw new LinkError('rst', 'pending-measure');
    });
    const res = await forwarder.handle(authorize(), dummyServer);
    if (!(res instanceof Response)) throw new Error('expected response');
    expect(opens).toBe(2);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      code: 'NODE_UNREACHABLE',
      reason: 'link_lost',
    });
  });

  test('没有 content-length 的流式请求体不缓冲，也不重放', async () => {
    let opens = 0;
    const forwarder = forwarderWith(() => {
      opens += 1;
      throw new LinkError('rst', 'pending-measure');
    });
    const res = await forwarder.handle(streamingAuthorize(), dummyServer);
    expect(opens).toBe(1);
    expect(res?.status).toBe(503);
  });
});
