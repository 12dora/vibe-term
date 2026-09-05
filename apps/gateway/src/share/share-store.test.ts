import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createMigratedAuthDb } from '../auth/test-db';
import { type ShareRow, ShareStore, hashSharePassword, verifySharePassword } from './share-store';

let harness: ReturnType<typeof createMigratedAuthDb>;
let store: ShareStore;

function row(overrides: Partial<ShareRow> = {}): ShareRow {
  return {
    id: 'share-1',
    name: 'demo',
    deviceId: 'dev-1',
    windowId: '@1',
    windowName: 'win',
    state: 'active',
    endReason: null,
    origin: 'https://a.example.com',
    url: 'https://a.example.com/s/share-1',
    recordLog: true,
    logBytes: 0,
    logTruncated: false,
    logSeq: 0,
    logPurgedAt: null,
    createdAt: 1_000,
    expiresAt: null,
    endedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  harness = createMigratedAuthDb();
  store = new ShareStore(harness.db);
});

afterEach(() => {
  harness.close();
});

describe('ShareStore 记录 CRUD', () => {
  test('insert / get / list 按创建时间倒序，过滤 device+window', () => {
    store.insert({ ...row({ id: 'a', createdAt: 1 }), passwordHash: 'h' });
    store.insert({
      ...row({ id: 'b', createdAt: 2, deviceId: 'dev-2', windowId: '@9' }),
      passwordHash: 'h',
    });
    expect(store.get('a')?.id).toBe('a');
    expect(store.get('missing')).toBeNull();
    expect(store.list().map((item) => item.id)).toEqual(['b', 'a']);
    expect(store.list({ deviceId: 'dev-2' }).map((item) => item.id)).toEqual(['b']);
    expect(store.list({ deviceId: 'dev-1', windowId: '@1' }).map((item) => item.id)).toEqual(['a']);
  });

  test('end 标记结束、清空访问凭证；重复 end 不改写原因', () => {
    store.insert({ ...row(), passwordHash: 'h' });
    store.createAccessToken({
      id: 't1',
      shareId: 'share-1',
      tokenHash: 'hash1',
      clientIp: null,
      createdAt: 1,
      expiresAt: 10_000,
    });
    const ended = store.end('share-1', 'revoked', 5_000);
    expect(ended?.state).toBe('ended');
    expect(ended?.endReason).toBe('revoked');
    expect(ended?.endedAt).toBe(5_000);
    expect(store.findAccessToken('hash1')).toBeNull();
    store.end('share-1', 'expired', 6_000);
    expect(store.get('share-1')?.endReason).toBe('revoked');
  });

  test('remove 只删已结束的分享，并连日志一起删', () => {
    store.insert({ ...row(), passwordHash: 'h' });
    store.appendLogEntries(
      'share-1',
      [{ at: 1, kind: 'out', paneId: '%1', data: new Uint8Array([1, 2]) }],
      1_000
    );
    expect(store.remove('share-1')).toBe(false);
    store.end('share-1', 'revoked', 2);
    expect(store.remove('share-1')).toBe(true);
    expect(store.get('share-1')).toBeNull();
    expect(store.countLog('share-1')).toBe(0);
  });

  test('listActive 只返回进行中', () => {
    store.insert({ ...row({ id: 'a' }), passwordHash: 'h' });
    store.insert({ ...row({ id: 'b' }), passwordHash: 'h' });
    store.end('b', 'revoked', 2);
    expect(store.listActive().map((item) => item.id)).toEqual(['a']);
  });
});

describe('ShareStore 日志', () => {
  beforeEach(() => {
    store.insert({ ...row(), passwordHash: 'h' });
  });

  test('appendLogEntries 顺序递增 seq 并累计字节', () => {
    const result = store.appendLogEntries(
      'share-1',
      [
        { at: 1, kind: 'checkpoint', paneId: '%1', data: new Uint8Array(3), cols: 80, rows: 24 },
        { at: 2, kind: 'out', paneId: '%1', data: new Uint8Array(5) },
      ],
      1_000
    );
    expect(result).toEqual({ logSeq: 2, logBytes: 8, truncated: false });
    const share = store.get('share-1');
    expect(share?.logSeq).toBe(2);
    expect(share?.logBytes).toBe(8);
    expect(share?.logTruncated).toBe(false);
  });

  test('超过上限即截断并停止后续写入', () => {
    const first = store.appendLogEntries(
      'share-1',
      [
        { at: 1, kind: 'out', paneId: '%1', data: new Uint8Array(6) },
        { at: 2, kind: 'out', paneId: '%1', data: new Uint8Array(6) },
      ],
      10
    );
    expect(first).toEqual({ logSeq: 1, logBytes: 6, truncated: true });
    const second = store.appendLogEntries(
      'share-1',
      [{ at: 3, kind: 'out', paneId: '%1', data: new Uint8Array(1) }],
      10
    );
    expect(second).toBeNull();
    expect(store.countLog('share-1')).toBe(1);
  });

  test('readLog 分页返回 base64 与 nextAfter', () => {
    store.appendLogEntries(
      'share-1',
      [
        { at: 1, kind: 'out', paneId: '%1', data: new TextEncoder().encode('ab') },
        { at: 2, kind: 'in', paneId: '%1', data: new TextEncoder().encode('cd') },
        { at: 3, kind: 'resize', paneId: '%1', data: new Uint8Array(0), cols: 100, rows: 40 },
      ],
      1_000
    );
    const page = store.readLog('share-1', { limit: 2 });
    expect(page.entries).toHaveLength(2);
    expect(page.entries[0]).toMatchObject({ seq: 1, kind: 'out', paneId: '%1', data: 'YWI=' });
    expect(page.entries[0]?.cols).toBeUndefined();
    expect(page.nextAfter).toBe(2);
    expect(page.total).toBe(3);
    expect(page.truncated).toBe(false);

    const rest = store.readLog('share-1', { after: 2, limit: 2 });
    expect(rest.entries).toHaveLength(1);
    expect(rest.entries[0]).toMatchObject({ seq: 3, kind: 'resize', cols: 100, rows: 40 });
    expect(rest.nextAfter).toBeNull();
  });

  test('purgeLogsBefore 只删过期日志行并保留记录', () => {
    store.appendLogEntries(
      'share-1',
      [
        { at: 100, kind: 'out', paneId: '%1', data: new Uint8Array(2) },
        { at: 500, kind: 'out', paneId: '%1', data: new Uint8Array(2) },
      ],
      1_000
    );
    expect(store.purgeLogsBefore(400, 900)).toBe(1);
    expect(store.countLog('share-1')).toBe(1);
    expect(store.get('share-1')?.logPurgedAt).toBe(900);
    expect(store.purgeLogsBefore(1, 950)).toBe(0);
  });
});

describe('ShareStore 访问凭证与设置', () => {
  test('凭证按 hash 查找、续期、删除、过期清扫', () => {
    store.insert({ ...row(), passwordHash: 'h' });
    store.createAccessToken({
      id: 't1',
      shareId: 'share-1',
      tokenHash: 'hash1',
      clientIp: '203.0.113.1',
      createdAt: 1,
      expiresAt: 100,
    });
    expect(store.findAccessToken('hash1')).toMatchObject({ id: 't1', shareId: 'share-1' });
    store.renewAccessToken('t1', 500, 50);
    expect(store.findAccessToken('hash1')?.expiresAt).toBe(500);
    store.sweepAccessTokens(400);
    expect(store.findAccessToken('hash1')).not.toBeNull();
    store.sweepAccessTokens(600);
    expect(store.findAccessToken('hash1')).toBeNull();
  });

  test('设置默认值与持久化', () => {
    expect(store.getSettings()).toEqual({
      recordLogs: true,
      logRetentionDays: 30,
      logMaxBytes: 52_428_800,
      defaultOrigin: null,
    });
    const saved = store.saveSettings(
      {
        recordLogs: false,
        logRetentionDays: 7,
        logMaxBytes: 1024,
        defaultOrigin: 'https://a.example.com',
      },
      42
    );
    expect(saved.recordLogs).toBe(false);
    expect(store.getSettings()).toEqual(saved);
    store.saveSettings({ ...saved, logRetentionDays: 3 }, 43);
    expect(store.getSettings().logRetentionDays).toBe(3);
  });
});

describe('分享口令哈希', () => {
  test('argon2id 自描述哈希可校验，错误口令不通过', async () => {
    const hash = await hashSharePassword('correct-horse');
    expect(hash).toContain('argon2id');
    expect(await verifySharePassword(hash, 'correct-horse')).toBe(true);
    expect(await verifySharePassword(hash, 'wrong')).toBe(false);
    expect(await verifySharePassword('not-json', 'correct-horse')).toBe(false);
  }, 20_000);
});
