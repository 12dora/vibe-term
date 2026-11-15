import { afterEach, describe, expect, test } from 'bun:test';
import type { WebSocketLike } from './client-socket';
import {
  WS_POP_RETRY_WINDOW_MS,
  createPopCloseGate,
  isPopClose,
  openSignedSocket,
  setWsPopRecovery,
  setWsUrlSigner,
} from './socket-pop';

class FakeSocket implements WebSocketLike {
  readyState = 0;
  binaryType: 'blob' | 'arraybuffer' = 'blob';
  onopen: WebSocketLike['onopen'] = null;
  onmessage: WebSocketLike['onmessage'] = null;
  onclose: WebSocketLike['onclose'] = null;
  onerror: WebSocketLike['onerror'] = null;
  sent: unknown[] = [];
  closed: Array<number | undefined> = [];
  constructor(readonly url: string) {}
  send(data: unknown): void {
    this.sent.push(data);
  }
  close(code?: number): void {
    this.closed.push(code);
  }
}

function opener() {
  const sockets: FakeSocket[] = [];
  const open = (url: string): WebSocketLike => {
    const socket = new FakeSocket(url);
    sockets.push(socket);
    return socket;
  };
  return { sockets, open };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  setWsUrlSigner(null);
  setWsPopRecovery(null);
});

describe('createPopCloseGate', () => {
  test('只认 4401 + POP_REQUIRED / POP_INVALID', () => {
    expect(isPopClose(4401, 'POP_REQUIRED')).toBe(true);
    expect(isPopClose(4401, 'POP_INVALID')).toBe(true);
    expect(isPopClose(4401, '')).toBe(false);
    expect(isPopClose(1006, 'POP_INVALID')).toBe(false);
  });

  test('没有注册恢复函数或签不了：不吸收', () => {
    const gate = createPopCloseGate();
    expect(gate(4401, 'POP_INVALID', 'ws://h/ws')).toBe(false);
    setWsPopRecovery(() => false);
    expect(gate(4401, 'POP_INVALID', 'ws://h/ws')).toBe(false);
  });

  test('首次吸收（重连重签），窗口内第二次放行，窗口外重新计', () => {
    setWsPopRecovery(() => true);
    let now = 0;
    const gate = createPopCloseGate(() => now);
    expect(gate(4401, 'POP_INVALID', 'ws://h/ws')).toBe(true);
    now += 1_000;
    expect(gate(4401, 'POP_INVALID', 'ws://h/ws')).toBe(false);
    now += 1_000;
    expect(gate(4401, 'POP_INVALID', 'ws://h/ws')).toBe(true);
    now += WS_POP_RETRY_WINDOW_MS + 1;
    expect(gate(4401, 'POP_REQUIRED', 'ws://h/ws')).toBe(true);
  });

  test('把 URL 交给恢复函数判断', () => {
    const seen: string[] = [];
    setWsPopRecovery((url) => {
      seen.push(url);
      return true;
    });
    createPopCloseGate()(4401, 'POP_INVALID', 'ws://h/n/x/ws');
    expect(seen).toEqual(['ws://h/n/x/ws']);
  });
});

describe('openSignedSocket', () => {
  test('没有签名器：同步按原 URL 直开', () => {
    const { sockets, open } = opener();
    const socket = openSignedSocket('ws://gw.example/ws?cid=1', open);
    expect(sockets).toHaveLength(1);
    expect(sockets[0].url).toBe('ws://gw.example/ws?cid=1');
    expect(socket).toBe(sockets[0]);
  });

  test('签名器返回 null（该 node 无 PoP 会话）：同步直开', () => {
    setWsUrlSigner(() => null);
    const { sockets, open } = opener();
    openSignedSocket('ws://gw.example/ws', open);
    expect(sockets[0].url).toBe('ws://gw.example/ws');
  });

  test('签完才 new WebSocket，URL 为带 pop 的那条，句柄先转发', async () => {
    setWsUrlSigner((url) => Promise.resolve(`${url}&pop=proof`));
    const { sockets, open } = opener();
    const seen: string[] = [];
    const shim = openSignedSocket('ws://gw.example/ws?cid=1', open);
    shim.binaryType = 'arraybuffer';
    shim.onopen = () => seen.push('open');
    shim.onmessage = (event) => seen.push(String(event.data));
    expect(sockets).toHaveLength(0);
    expect(shim.readyState).toBe(0);

    await tick();
    expect(sockets).toHaveLength(1);
    expect(sockets[0].url).toBe('ws://gw.example/ws?cid=1&pop=proof');
    expect(sockets[0].binaryType).toBe('arraybuffer');

    sockets[0].readyState = 1;
    sockets[0].onopen?.();
    sockets[0].onmessage?.({ data: 'hi' });
    expect(seen).toEqual(['open', 'hi']);
    expect(shim.readyState).toBe(1);
    shim.send('x');
    expect(sockets[0].sent).toEqual(['x']);
  });

  test('每次建 socket（含重连）都重新签', async () => {
    let n = 0;
    setWsUrlSigner((url) => Promise.resolve(`${url}?pop=${++n}`));
    const { sockets, open } = opener();
    openSignedSocket('ws://gw.example/ws', open);
    openSignedSocket('ws://gw.example/ws', open);
    await tick();
    expect(sockets.map((socket) => socket.url)).toEqual([
      'ws://gw.example/ws?pop=1',
      'ws://gw.example/ws?pop=2',
    ]);
  });

  test('签名完成前 close：不再真正打开，并回调 onclose', async () => {
    setWsUrlSigner((url) => Promise.resolve(`${url}?pop=1`));
    const { sockets, open } = opener();
    const closes: unknown[] = [];
    const shim = openSignedSocket('ws://gw.example/ws', open);
    shim.onclose = (event) => closes.push(event);
    shim.close();
    await tick();
    expect(sockets).toHaveLength(0);
    expect(shim.readyState).toBe(3);
    expect(closes).toEqual([{ code: 1000, reason: '' }]);
  });

  test('签名失败：按异常关闭回调 onerror + onclose，不抛', async () => {
    setWsUrlSigner(() => Promise.reject(new Error('no key')));
    const { sockets, open } = opener();
    const events: string[] = [];
    const shim = openSignedSocket('ws://gw.example/ws', open);
    shim.onerror = () => events.push('error');
    shim.onclose = (event) => events.push(`close:${(event as { code: number }).code}`);
    await tick();
    expect(sockets).toHaveLength(0);
    expect(events).toEqual(['error', 'close:1006']);
  });
});
