import { describe, expect, test } from 'bun:test';
import type { RtcSignalMessage } from '../mesh-deps';
import {
  MeshRtcSignalRouter,
  RTC_HUB_ROUTE_MAX_ENTRIES,
  RTC_HUB_ROUTE_TTL_MS,
  RtcHubRouteTable,
} from './signaling';

describe('MeshRtcSignalRouter', () => {
  test('forwards browser signals to the registered target node', () => {
    const sent: Array<{ nodeId: string; msg: RtcSignalMessage }> = [];
    const router = new MeshRtcSignalRouter({
      selfNodeId: 'aa',
      sendCtl: (nodeId, msg) => sent.push({ nodeId, msg }),
    });
    router.register('sess-1', { browserSessionId: 'b1', targetNodeId: 'BB' });
    router.send({
      rtcSession: 'sess-1',
      from: 'browser',
      to: 'bb',
      sdp: 'offer',
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.nodeId).toBe('bb');
  });

  test('drops signals for unknown sessions or wrong target', () => {
    const sent: string[] = [];
    const router = new MeshRtcSignalRouter({
      selfNodeId: 'aa',
      sendCtl: (nodeId) => sent.push(nodeId),
    });
    router.send({ rtcSession: 'missing', from: 'browser', to: 'bb' });
    router.register('sess-1', { browserSessionId: 'b1', targetNodeId: 'bb' });
    router.send({ rtcSession: 'sess-1', from: 'browser', to: 'cc' });
    router.send({ rtcSession: 'sess-1', from: 'browser', to: 'bb' }, { uid: 'u', sid: 'other' });
    expect(sent).toEqual([]);
  });

  test('delivers local target signals to onLocal and node replies to subscribers', () => {
    const router = new MeshRtcSignalRouter({
      selfNodeId: 'aa',
      sendCtl: () => {
        throw new Error('should not sendCtl for self');
      },
    });
    router.register('sess-1', { browserSessionId: 'b1', targetNodeId: 'aa' });
    const local: RtcSignalMessage[] = [];
    const browser: RtcSignalMessage[] = [];
    router.onLocal('sess-1', (msg) => local.push(msg));
    router.subscribe((msg) => browser.push(msg));
    router.send({ rtcSession: 'sess-1', from: 'browser', to: 'aa', sdp: 'offer' });
    expect(local[0]?.sdp).toBe('offer');
    router.send({ rtcSession: 'sess-1', from: 'node', to: 'aa', sdp: 'answer' });
    expect(browser[0]?.sdp).toBe('answer');
  });

  test('receiveFromNode only accepts the registered target node', () => {
    const router = new MeshRtcSignalRouter({ selfNodeId: 'aa', sendCtl: () => {} });
    router.register('sess-1', { browserSessionId: 'b1', targetNodeId: 'bb' });
    const browser: RtcSignalMessage[] = [];
    router.subscribe((msg) => browser.push(msg));
    router.receiveFromNode('cc', {
      rtcSession: 'sess-1',
      from: 'node',
      to: 'bb',
      candidate: 'x',
    });
    expect(browser).toEqual([]);
    router.receiveFromNode('bb', {
      rtcSession: 'sess-1',
      from: 'node',
      to: 'bb',
      candidate: 'x',
    });
    expect(browser[0]?.candidate).toBe('x');
  });

  test('deliverLocal buffers until onLocal and then live-delivers', () => {
    const router = new MeshRtcSignalRouter({
      selfNodeId: 'aa',
      sendCtl: () => {
        throw new Error('should not sendCtl for local');
      },
    });
    router.register('sess-1', { browserSessionId: 'b1', targetNodeId: 'aa' });
    router.deliverLocal({ rtcSession: 'sess-1', from: 'browser', to: 'aa', sdp: 'offer' });
    const local: string[] = [];
    router.onLocal('sess-1', (msg) => local.push(msg.sdp ?? ''));
    expect(local).toEqual(['offer']);
    router.deliverLocal({ rtcSession: 'sess-1', from: 'browser', to: 'aa', sdp: 'more' });
    expect(local).toEqual(['offer', 'more']);
  });

  test('does not cache local signals without an owner or when target is not self', () => {
    const router = new MeshRtcSignalRouter({
      selfNodeId: 'aa',
      sendCtl: () => {},
    });
    router.deliverLocal({ rtcSession: 'ghost', from: 'browser', to: 'aa', sdp: 'x' });
    expect(router.inboxSessionCount()).toBe(0);
    router.register('sess-1', { browserSessionId: 'b1', targetNodeId: 'aa' });
    router.deliverLocal({ rtcSession: 'sess-1', from: 'browser', to: 'bb', sdp: 'x' });
    expect(router.inboxSessionCount()).toBe(0);
  });

  test('shouldCacheLocal and hard caps stop a hostile-node flood', () => {
    const authorized = new Set(['ok']);
    const router = new MeshRtcSignalRouter({
      selfNodeId: 'aa',
      sendCtl: () => {},
      shouldCacheLocal: (signal, source) =>
        authorized.has(signal.rtcSession) && signal.to === 'aa' && source === 'entry',
      maxInboxSessions: 2,
      maxInboxMessages: 3,
    });
    for (let i = 0; i < 50; i++) {
      router.deliverLocal(
        { rtcSession: `flood-${i}`, from: 'browser', to: 'aa', sdp: 'x' },
        'hostile'
      );
    }
    expect(router.inboxSessionCount()).toBe(0);
    router.deliverLocal({ rtcSession: 'ok', from: 'browser', to: 'aa', sdp: 'a' }, 'entry');
    router.deliverLocal({ rtcSession: 'ok', from: 'browser', to: 'aa', sdp: 'b' }, 'entry');
    router.deliverLocal({ rtcSession: 'ok', from: 'browser', to: 'aa', sdp: 'c' }, 'entry');
    router.deliverLocal({ rtcSession: 'ok', from: 'browser', to: 'aa', sdp: 'd' }, 'entry');
    expect(router.inboxSize()).toBe(3);
    authorized.add('ok-2');
    authorized.add('ok-3');
    router.deliverLocal({ rtcSession: 'ok-2', from: 'browser', to: 'aa', sdp: 'e' }, 'entry');
    router.deliverLocal({ rtcSession: 'ok-3', from: 'browser', to: 'aa', sdp: 'f' }, 'entry');
    expect(router.inboxSessionCount()).toBe(2);
    router.unregister('ok');
    expect(router.inboxSessionCount()).toBe(1);
  });

  test('authorization checks run before listener lookup so foreign signals are dropped', () => {
    const delivered: string[] = [];
    const router = new MeshRtcSignalRouter({
      selfNodeId: 'aa',
      sendCtl: () => {},
      shouldCacheLocal: (signal, source) =>
        signal.rtcSession === 'ok' && signal.to === 'aa' && source === 'entry',
    });
    router.onLocal('ok', (msg) => delivered.push(msg.sdp ?? ''));
    router.deliverLocal({ rtcSession: 'ok', from: 'node', to: 'aa', sdp: 'hostile' }, 'hostile');
    router.deliverLocal({ rtcSession: 'ok', from: 'node', to: 'bb', sdp: 'wrong-to' }, 'entry');
    router.deliverLocal(
      { rtcSession: 'other', from: 'node', to: 'aa', sdp: 'wrong-sess' },
      'entry'
    );
    expect(delivered).toEqual([]);
    router.deliverLocal({ rtcSession: 'ok', from: 'node', to: 'aa', sdp: 'good' }, 'entry');
    expect(delivered).toEqual(['good']);
  });
});

describe('RtcHubRouteTable', () => {
  test('记录 / 查找 / 10 分钟 TTL 过期', () => {
    let now = 1_000;
    const table = new RtcHubRouteTable({ now: () => now });
    table.remember('sess', 'AA'.repeat(16));
    expect(table.lookup('sess')).toBe('aa'.repeat(16));
    now = 1_000 + RTC_HUB_ROUTE_TTL_MS - 1;
    expect(table.lookup('sess')).toBe('aa'.repeat(16));
    now = 1_000 + RTC_HUB_ROUTE_TTL_MS + 1;
    expect(table.lookup('sess')).toBeUndefined();
  });

  test('条目上限 LRU 驱逐最旧', () => {
    const table = new RtcHubRouteTable({ maxEntries: 2 });
    table.remember('a', 'aa'.repeat(16));
    table.remember('b', 'bb'.repeat(16));
    table.remember('c', 'cc'.repeat(16));
    expect(table.size).toBe(2);
    expect(table.lookup('a')).toBeUndefined();
    expect(table.lookup('b')).toBe('bb'.repeat(16));
    expect(RTC_HUB_ROUTE_MAX_ENTRIES).toBe(1024);
  });
});
