import { describe, expect, test } from 'bun:test';
import { ApiError } from '@vibeterm/api-client';
import type { LoginRecord } from '@vibeterm/shared';
import {
  type LoginHistoryIo,
  appendPages,
  applyLoginHistoryRetention,
  clearLoginHistory,
  cursorsOf,
  fetchLoginHistory,
  loginHistoryWatermark,
  mergeFailedNodes,
  mergeLoginHistoryRows,
  readLoginHistoryRetention,
} from './login-history-data';
import type { LoginHistoryNode } from './login-history-nodes';

const SELF: LoginHistoryNode = { id: 'self', meshId: 'a'.repeat(32), name: '本机', isSelf: true };
const B: LoginHistoryNode = {
  id: 'b'.repeat(32),
  meshId: 'b'.repeat(32),
  name: 'beta',
  isSelf: false,
};
const C: LoginHistoryNode = {
  id: 'c'.repeat(32),
  meshId: 'c'.repeat(32),
  name: 'gamma',
  isSelf: false,
};

function record(id: string, at: number): LoginRecord {
  return {
    id,
    at,
    outcome: 'success',
    uid: 'u1',
    username: 'alice',
    method: 'root',
    second: 'none',
    client: 'web',
    kind: 'interactive',
    viaNodeId: null,
    targetNodeId: null,
    ip: '10.0.0.2',
    userAgent: null,
    origin: null,
    code: null,
  } as LoginRecord;
}

function fakeIo(overrides: Partial<LoginHistoryIo> = {}): LoginHistoryIo & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    list: async (node, query, before) => {
      calls.push(`list:${node.name}:${query.outcome}:${before ?? '-'}`);
      if (node.id === C.id) throw new ApiError(503, 'x', { code: 'NODE_UNREACHABLE' });
      return node.isSelf
        ? { records: [record('s1', 300), record('s2', 100)], nextBefore: { at: 100, id: 's2' } }
        : { records: [record('b1', 200)], nextBefore: null };
    },
    clear: async (node) => {
      calls.push(`clear:${node.name}`);
      if (node.id === C.id) throw new ApiError(404, 'route_not_found');
      return { deleted: node.isSelf ? 5 : 2 };
    },
    getSettings: async (node) => ({ retentionDays: node.isSelf ? 90 : 30 }),
    putSettings: async (node, settings) => {
      calls.push(`put:${node.name}:${settings.retentionDays}`);
      return settings;
    },
    ...overrides,
  };
}

describe('fetchLoginHistory', () => {
  test('collects pages per node and classifies failures', async () => {
    const io = fakeIo();
    const out = await fetchLoginHistory(
      [SELF, B, C],
      { outcome: 'success', includeBackground: false },
      io
    );
    expect([...out.pages.keys()]).toEqual(['self', B.id]);
    expect(out.failed).toEqual([{ node: C, reason: 'offline' }]);

    const rows = mergeLoginHistoryRows([SELF, B, C], out.pages);
    expect(rows.map((row) => [row.rowKey, row.node.name])).toEqual([
      ['self:s1', '本机'],
      [`${B.id}:b1`, 'beta'],
      ['self:s2', '本机'],
    ]);
  });

  test('load more only asks nodes that still have a cursor', async () => {
    const io = fakeIo();
    const first = await fetchLoginHistory(
      [SELF, B],
      { outcome: 'failed', includeBackground: true },
      io
    );
    const cursors = cursorsOf(first.pages);
    expect([...cursors]).toEqual([['self', { at: 100, id: 's2' }]]);
    io.list = async () => ({ records: [record('s3', 50)], nextBefore: null });
    const more = await fetchLoginHistory(
      [SELF, B],
      { outcome: 'failed', includeBackground: true },
      io,
      {
        cursors,
      }
    );
    const merged = appendPages(first.pages, more.pages);
    expect(merged.get('self')?.records.map((item) => item.id)).toEqual(['s1', 's2', 's3']);
    expect(cursorsOf(merged).size).toBe(0);
  });
});

describe('merged rows across nodes', () => {
  const H = 3_600_000;
  const now = 1_000 * H;

  test('a busy node with more pages holds back older rows of quiet nodes until its next page arrives', () => {
    const aRows = Array.from({ length: 200 }, (_, i) => record(`a${i}`, now - i * 3 * 60_000));
    const bRows = [record('b0', now - 720 * H), record('b1', now - 721 * H)];
    const pages = new Map([
      ['self', { records: aRows, nextBefore: aRows[199]?.at ?? null, nextBeforeId: 'a199' }],
      [B.id, { records: bRows, nextBefore: null }],
    ]);
    const rows = mergeLoginHistoryRows([SELF, B], pages);
    expect(rows).toHaveLength(200);
    expect(rows.every((row) => row.node.id === 'self')).toBe(true);

    const drained = appendPages(pages, new Map([['self', { records: [], nextBefore: null }]]));
    const all = mergeLoginHistoryRows([SELF, B], drained);
    expect(all).toHaveLength(202);
    expect(all.at(-1)?.rowKey).toBe(`${B.id}:b1`);
  });

  test('the newest pending cursor sets the watermark', () => {
    const pages = new Map([
      [
        'self',
        { records: [record('s1', 500), record('s2', 400)], nextBefore: 400, nextBeforeId: 's2' },
      ],
      [
        B.id,
        { records: [record('b1', 450), record('b2', 100)], nextBefore: 100, nextBeforeId: 'b2' },
      ],
      [C.id, { records: [record('c1', 390)], nextBefore: null }],
    ]);
    expect(mergeLoginHistoryRows([SELF, B, C], pages).map((row) => row.id)).toEqual([
      's1',
      'b1',
      's2',
    ]);
  });

  test('watermark and load-more read the same cursor: a time without an id holds nothing back', () => {
    const pages = new Map([
      [
        'self',
        { records: [record('s1', 500), record('s2', 400)], nextBefore: 400, nextBeforeId: '' },
      ],
      [
        B.id,
        { records: [record('b1', 450), record('b2', 100)], nextBefore: 100, nextBeforeId: 'b2' },
      ],
    ]);
    expect(cursorsOf(pages).has('self')).toBe(false);
    expect(loginHistoryWatermark(pages)).toBe(100);
    expect(mergeLoginHistoryRows([SELF, B], pages).map((row) => row.id)).toEqual([
      's1',
      'b1',
      's2',
      'b2',
    ]);
    expect(loginHistoryWatermark(new Map([['self', { records: [], nextBefore: 400 }]]))).toBe(
      Number.NEGATIVE_INFINITY
    );
  });

  test('a node whose next page failed loses its cursor and is reported once', async () => {
    const io = fakeIo();
    const first = await fetchLoginHistory(
      [SELF, B],
      { outcome: 'failed', includeBackground: true },
      io
    );
    io.list = async () => {
      throw new ApiError(503, 'x', { code: 'NODE_UNREACHABLE' });
    };
    const more = await fetchLoginHistory(
      [SELF, B],
      { outcome: 'failed', includeBackground: true },
      io,
      { cursors: cursorsOf(first.pages) }
    );
    expect(more.failed).toEqual([{ node: SELF, reason: 'offline' }]);
    const merged = appendPages(first.pages, more.pages, more.failed);
    expect(cursorsOf(merged).size).toBe(0);
    expect(merged.get('self')?.records.map((item) => item.id)).toEqual(['s1', 's2']);
    const failed = mergeFailedNodes(mergeFailedNodes([], more.failed), more.failed);
    expect(failed).toEqual([{ node: SELF, reason: 'offline' }]);
    const rows = mergeLoginHistoryRows([SELF, B], merged);
    expect(new Set(rows.map((row) => row.rowKey)).size).toBe(rows.length);
  });
});

describe('batch operations', () => {
  test('clear sums deleted rows and reports skipped nodes', async () => {
    const out = await clearLoginHistory([SELF, B, C], fakeIo());
    expect(out.deleted).toBe(7);
    expect(out.done.map((node) => node.name)).toEqual(['本机', 'beta']);
    expect(out.failed).toEqual([{ node: C, reason: 'tooOld' }]);
  });

  test('retention writes the same value everywhere', async () => {
    const io = fakeIo();
    const out = await applyLoginHistoryRetention([SELF, B], 30, io);
    expect(io.calls).toEqual(['put:本机:30', 'put:beta:30']);
    expect(out.failed).toEqual([]);
  });

  test('retention reads as a single value only when every node agrees', async () => {
    expect(await readLoginHistoryRetention([SELF, B], fakeIo())).toBeNull();
    expect(await readLoginHistoryRetention([B], fakeIo())).toBe(30);
    expect(await readLoginHistoryRetention([], fakeIo())).toBeNull();
  });
});
