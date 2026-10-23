import { describe, expect, test } from 'bun:test';
import { type LinkStream, createInMemoryLinkPair } from '@vibeterm/shared/link';
import {
  noteHttpResponseHead,
  releaseLiveHttpStream,
  trackLiveHttpStream,
} from './live-http-migratable';
import type { LivePeer } from './peer-reconnect-wake';
import { claimSession } from './session-binding';

function fakeStream(): LinkStream {
  return { id: Math.random() } as LinkStream;
}

function livePeer(patch: Partial<LivePeer> = {}): LivePeer {
  return {
    session: createInMemoryLinkPair()[0],
    peerNodeId: 'aa'.repeat(16),
    streams: 0,
    nonMigratable: 0,
    retiring: false,
    finishRetired: false,
    ...patch,
  } as LivePeer;
}

const ARCHIVE = { 'content-type': 'application/zip' };
const RESUMABLE = {
  'content-length': '10',
  'accept-ranges': 'bytes',
  etag: '"v1"',
};

describe('live HTTP migratable accounting', () => {
  test('入口收头与远端写头共用谓词：不可续传才加计数', () => {
    const entry = livePeer();
    const remote = livePeer();
    const entryStream = fakeStream();
    const remoteStream = fakeStream();
    trackLiveHttpStream(entry, entryStream, 1);
    trackLiveHttpStream(remote, remoteStream, 1);
    noteHttpResponseHead(entryStream, 'GET', 200, ARCHIVE);
    noteHttpResponseHead(remoteStream, 'GET', 200, ARCHIVE);
    expect(entry.nonMigratable).toBe(1);
    expect(remote.nonMigratable).toBe(1);
    expect(entry.streams).toBe(1);
    expect(remote.streams).toBe(1);
  });

  test('可 Range 续传的 GET 200 不加 nonMigratable', () => {
    const live = livePeer();
    const stream = fakeStream();
    trackLiveHttpStream(live, stream, 1);
    noteHttpResponseHead(stream, 'GET', 200, RESUMABLE);
    expect(live.nonMigratable).toBe(0);
    expect(live.streams).toBe(1);
  });

  test('流关闭即减计数，即使响应体从未被读', () => {
    const live = livePeer();
    const stream = fakeStream();
    const finished: Array<{ live: LivePeer; reason: string }> = [];
    trackLiveHttpStream(live, stream, 1);
    noteHttpResponseHead(stream, 'POST', 200, { 'content-type': 'application/json' });
    expect(live.nonMigratable).toBe(1);
    const leftover = releaseLiveHttpStream(live, stream, 2, (row, reason) =>
      finished.push({ live: row, reason })
    );
    expect(leftover).toBe(0);
    expect(live.streams).toBe(0);
    expect(live.nonMigratable).toBe(0);
    expect(finished).toHaveLength(0);
  });

  test('不可迁移归零且仍有可迁移流时立刻 retired', () => {
    const live = livePeer({ retiring: true, pendingOptimisationRetire: true });
    const archive = fakeStream();
    const other = fakeStream();
    const finished: Array<{ live: LivePeer; reason: string }> = [];
    trackLiveHttpStream(live, archive, 1);
    trackLiveHttpStream(live, other, 1);
    noteHttpResponseHead(archive, 'GET', 200, ARCHIVE);
    expect(live.nonMigratable).toBe(1);
    releaseLiveHttpStream(live, archive, 2, (row, reason) => finished.push({ live: row, reason }));
    expect(live.nonMigratable).toBe(0);
    expect(live.streams).toBe(1);
    expect(live.pendingOptimisationRetire).toBeFalsy();
    expect(finished).toEqual([{ live, reason: 'retired' }]);
  });

  test('未 track 的流不记账，即使 session 已绑到 LivePeer', () => {
    const live = livePeer();
    claimSession(live.session, {
      role: 'live',
      peerId: live.peerNodeId,
      owner: live,
    });
    const stream = fakeStream();
    noteHttpResponseHead(stream, 'GET', 200, ARCHIVE);
    expect(live.nonMigratable).toBe(0);
    expect(live.streams).toBe(0);
  });

  test('已 release 的晚到 head 不再加计数', () => {
    const live = livePeer();
    const stream = fakeStream();
    trackLiveHttpStream(live, stream, 1);
    releaseLiveHttpStream(live, stream, 2, () => {});
    noteHttpResponseHead(stream, 'GET', 200, ARCHIVE);
    expect(live.streams).toBe(0);
    expect(live.nonMigratable).toBe(0);
  });
});
