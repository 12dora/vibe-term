import { describe, expect, test } from 'bun:test';
import { HUB_NOT_WRITER, type HubWriteForwardMessage } from '@tmex/shared/uplink';
import {
  WRITER_FORWARD_HEADER,
  WRITER_FORWARD_TIMEOUT_MS,
  WRITE_FORWARD_OVERSIZED_ERROR,
  WriteForwardAckAssembler,
  WriteForwardIdempotencyCache,
  ackToHttpResponse,
  buildWriteForwardRequest,
  chunkWriteForwardAck,
  collectWriteForwardHeaders,
  forwardWriteToWriter,
  notWriterResponse,
  requestAlreadyForwarded,
  writeForwardDigest,
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
  test('未知 writer 或无活 uplink 返回 null（由调用方发 409）', async () => {
    const req = new Request('http://standby/api/hub/enrollments', { method: 'POST', body: '{}' });
    expect(
      await forwardWriteToWriter(req, {
        selfHubId: SELF,
        target: target({ writerHubId: null, writerPublicUrl: null }),
        isLive: () => true,
        send: () => {},
        waitAck: async () => null,
      })
    ).toBeNull();
    expect(
      await forwardWriteToWriter(req, {
        selfHubId: SELF,
        target: target(),
        isLive: () => false,
        send: () => {},
        waitAck: async () => null,
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
    let sent = 0;
    const res = await forwardWriteToWriter(req, {
      selfHubId: SELF,
      target: target(),
      isLive: () => true,
      send: () => {
        sent += 1;
      },
      waitAck: async () => null,
    });
    expect(res).toBeNull();
    expect(sent).toBe(0);
  });

  test('帧只带 content-type / force-keylog 与 uid，绝不带 cookie/authorization', async () => {
    const req = new Request('http://standby/api/hub/nodes/n1/rename', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: 'tmex_s_self=sess-1',
        authorization: 'Bearer secret',
        'X-Tmex-Force-Keylog': '1',
      },
      body: JSON.stringify({ name: 'x' }),
    });
    const headers = collectWriteForwardHeaders(req);
    expect(headers).toEqual({
      'content-type': 'application/json',
      'x-tmex-force-keylog': '1',
    });
    const msg = await buildWriteForwardRequest(req, { id: 'fwd-1', uid: 'user-1' });
    expect(msg).toMatchObject({
      t: 'hub.write-forward',
      id: 'fwd-1',
      method: 'POST',
      path: '/api/hub/nodes/n1/rename',
      uid: 'user-1',
      body: JSON.stringify({ name: 'x' }),
    });
    expect(JSON.stringify(msg)).not.toContain('cookie');
    expect(JSON.stringify(msg)).not.toContain('sess-1');
    expect(JSON.stringify(msg)).not.toContain('Bearer');
    expect(JSON.stringify(msg)).not.toContain('authorization');
  });

  test('经 uplink send/ack 回写者 status/body，响应带头，不含 cookie', async () => {
    const routes = [
      '/api/hub/enrollments',
      '/api/hub/enrollments/redeem',
      '/api/hub/nodes/n1/rename',
      '/api/hub/nodes/n1/revoke',
      '/api/auth/keylog?hub=sync',
    ];
    for (const path of routes) {
      const sent: HubWriteForwardMessage[] = [];
      const req = new Request(`http://standby${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: 'tmex_s_self=sess-1' },
        body: JSON.stringify({ name: 'x' }),
      });
      const res = await forwardWriteToWriter(req, {
        selfHubId: SELF,
        uid: 'user-1',
        target: target(),
        isLive: () => true,
        send: (msg) => {
          sent.push(msg);
        },
        waitAck: async (id) => ({
          t: 'hub.write-forward',
          id,
          ack: true,
          status: 201,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ok: true, path }),
        }),
      });
      expect(res).not.toBeNull();
      expect(res?.status).toBe(201);
      expect(res?.headers.get(WRITER_FORWARD_HEADER)).toBe(SELF);
      expect(await res?.json()).toEqual({ ok: true, path });
      expect(sent).toHaveLength(1);
      expect(sent[0]?.path).toBe(path);
      expect(JSON.stringify(sent[0])).not.toContain('cookie');
      expect(JSON.stringify(sent[0])).not.toContain('sess-1');
      expect(sent[0]?.uid).toBe('user-1');
    }
  });

  test('send 失败或 ack 超时回退为 null', async () => {
    expect(
      await forwardWriteToWriter(
        new Request('http://standby/api/hub/enrollments', { method: 'POST', body: '{}' }),
        {
          selfHubId: SELF,
          target: target(),
          isLive: () => true,
          send: () => {
            throw new Error('offline');
          },
          waitAck: async () => null,
        }
      )
    ).toBeNull();

    const timed = await forwardWriteToWriter(
      new Request('http://standby/api/hub/enrollments', { method: 'POST', body: '{}' }),
      {
        selfHubId: SELF,
        target: target(),
        timeoutMs: 20,
        isLive: () => true,
        send: () => {},
        waitAck: () => new Promise(() => {}),
      }
    );
    expect(timed).toBeNull();
    expect(WRITER_FORWARD_TIMEOUT_MS).toBe(10_000);
  });

  test('ackToHttpResponse 不拷贝未允许的头', async () => {
    const res = ackToHttpResponse(
      {
        t: 'hub.write-forward',
        id: 'x',
        ack: true,
        status: 200,
        headers: { 'content-type': 'text/plain' },
        body: 'ok',
      },
      SELF
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain');
    expect(res.headers.get(WRITER_FORWARD_HEADER)).toBe(SELF);
    expect(await res.text()).toBe('ok');
  });

  test('请求带上 writerHubId/writerEpoch；超限 body 返回 413 且不 send', async () => {
    const req = new Request('http://standby/api/hub/enrollments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    });
    const sent: HubWriteForwardMessage[] = [];
    await forwardWriteToWriter(req, {
      selfHubId: SELF,
      target: target(),
      isLive: () => true,
      send: (msg) => {
        sent.push(msg);
      },
      waitAck: async (id) => ({
        t: 'hub.write-forward',
        id,
        ack: true,
        status: 200,
        body: '{}',
      }),
    });
    expect(sent[0]?.writerHubId).toBe(WRITER);
    expect(sent[0]?.writerEpoch).toBe(4);

    let sendCount = 0;
    const huge = new Request('http://standby/api/hub/enrollments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'x'.repeat(80 * 1024),
    });
    const oversized = await forwardWriteToWriter(huge, {
      selfHubId: SELF,
      target: target(),
      isLive: () => true,
      send: () => {
        sendCount += 1;
      },
      waitAck: async () => null,
    });
    expect(oversized?.status).toBe(413);
    expect(await oversized?.json()).toEqual({ error: WRITE_FORWARD_OVERSIZED_ERROR });
    expect(sendCount).toBe(0);
  });

  test('超大 ACK 分片后重组得到完整 body', () => {
    const body = JSON.stringify({ log: 'k'.repeat(60 * 1024), certs: ['a', 'b'] });
    const ack: HubWriteForwardMessage = {
      t: 'hub.write-forward',
      id: 'big',
      ack: true,
      status: 200,
      headers: { 'content-type': 'application/json' },
      body,
    };
    const parts = chunkWriteForwardAck(ack);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.at(-1)?.final).toBe(true);
    const assembler = new WriteForwardAckAssembler();
    let done: HubWriteForwardMessage | null = null;
    for (const part of parts) {
      done = assembler.push(part);
    }
    expect(done?.body).toBe(body);
    expect(done?.status).toBe(200);
  });

  test('幂等缓存：同 digest 重放，不同 digest 冲突', () => {
    const cache = new WriteForwardIdempotencyCache(2);
    const ack: HubWriteForwardMessage = {
      t: 'hub.write-forward',
      id: 'id-1',
      ack: true,
      status: 201,
      body: '{"ok":true}',
    };
    const msg: HubWriteForwardMessage = {
      t: 'hub.write-forward',
      id: 'id-1',
      method: 'POST',
      path: '/api/hub/enrollments',
      body: '{"a":1}',
    };
    const digest = writeForwardDigest(msg);
    cache.set(SELF, 'id-1', digest, ack);
    expect(cache.get(SELF, 'id-1')?.digest).toBe(digest);
    const other: HubWriteForwardMessage = { ...msg, body: '{"a":2}' };
    expect(writeForwardDigest(other)).not.toBe(digest);
  });
});
