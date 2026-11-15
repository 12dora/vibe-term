import { afterEach, describe, expect, test } from 'bun:test';
import { setWsUrlSigner } from '@vibeterm/ws-client/socket-pop';
import { openMeshSocket } from './mesh-events';

const globalWs = globalThis as { WebSocket?: unknown };
const originalWs = globalWs.WebSocket;
const urls: string[] = [];

class FakeWebSocket {
  binaryType = 'blob';
  readyState = 0;
  onopen = null;
  onclose = null;
  onerror = null;
  onmessage = null;
  constructor(readonly url: string) {
    urls.push(url);
    sockets.push(this);
  }
  send(): void {}
  close(): void {}
}
const sockets: FakeWebSocket[] = [];

afterEach(() => {
  setWsUrlSigner(null);
  globalWs.WebSocket = originalWs;
  urls.length = 0;
  sockets.length = 0;
});

describe('openMeshSocket', () => {
  test('没有 PoP 会话：同步直开原 URL，binaryType 为 arraybuffer', () => {
    globalWs.WebSocket = FakeWebSocket;
    const socket = openMeshSocket('ws://gw.example/mesh/ws');
    expect(urls).toEqual(['ws://gw.example/mesh/ws']);
    expect(socket.binaryType).toBe('arraybuffer');
  });

  test('PoP 会话：签完才开带 pop 的 URL，且打开后 binaryType 已是 arraybuffer', async () => {
    globalWs.WebSocket = FakeWebSocket;
    setWsUrlSigner((url) => Promise.resolve(`${url}?pop=proof`));
    const socket = openMeshSocket('ws://gw.example/mesh/ws');
    expect(urls).toEqual([]);
    expect(socket.binaryType).toBe('arraybuffer');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(urls).toEqual(['ws://gw.example/mesh/ws?pop=proof']);
    expect(sockets[0].binaryType).toBe('arraybuffer');
  });
});
