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
});
