import { describe, expect, test } from 'bun:test';
import type { RtcSignalMessage } from '../mesh-deps';
import { MeshRtcSignalRouter } from './signaling';

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
});
