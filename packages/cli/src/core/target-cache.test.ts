import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  TARGETS_FILE_NAME,
  TARGET_CACHE_TTL_MS,
  TargetCache,
  bareKey,
  nodeKey,
} from './target-cache';

const dirs: string[] = [];
const ENTRY = 'http://entry.example:9883';

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vt-targets-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('TargetCache', () => {
  test('stores rows in targets.json with mode 0600 and survives a reopen', async () => {
    const dir = await tempDir();
    TargetCache.open(dir, ENTRY).set(nodeKey('office'), { nodeId: 'n1', name: 'office' });
    const mode = (await stat(join(dir, TARGETS_FILE_NAME))).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(TargetCache.open(dir, ENTRY).get(nodeKey('office'))).toEqual({
      nodeId: 'n1',
      name: 'office',
    });
  });

  test('node and bare keys are separate rows', async () => {
    const dir = await tempDir();
    const cache = TargetCache.open(dir, ENTRY);
    cache.set(nodeKey('lab'), { nodeId: 'n1', name: 'lab' });
    expect(cache.get(bareKey('lab'))).toBeNull();
  });

  test('rows expire after 24 h', async () => {
    const dir = await tempDir();
    let now = 1_000_000;
    const cache = TargetCache.open(dir, ENTRY, () => now);
    cache.set(bareKey('lab'), { nodeId: 'n1', name: 'lab' });
    now += TARGET_CACHE_TTL_MS - 1;
    expect(cache.get(bareKey('lab'))).not.toBeNull();
    now += 1;
    expect(cache.get(bareKey('lab'))).toBeNull();
  });

  test('expired rows are pruned when the file is next written', async () => {
    const dir = await tempDir();
    let now = 5_000_000;
    const cache = TargetCache.open(dir, ENTRY, () => now);
    cache.set(bareKey('old'), { nodeId: 'n1', name: 'old' });
    now += TARGET_CACHE_TTL_MS + 1;
    cache.set(bareKey('new'), { nodeId: 'n2', name: 'new' });
    const raw = JSON.parse(await readFile(join(dir, TARGETS_FILE_NAME), 'utf8')) as {
      entries: Record<string, Record<string, unknown>>;
    };
    expect(Object.keys(raw.entries[ENTRY] ?? {})).toEqual([bareKey('new')]);
  });

  test('drop removes one row only', async () => {
    const dir = await tempDir();
    const cache = TargetCache.open(dir, ENTRY);
    cache.set(bareKey('a'), { nodeId: 'n1', name: 'a' });
    cache.set(bareKey('b'), { nodeId: 'n2', name: 'b' });
    cache.drop(bareKey('a'));
    const fresh = TargetCache.open(dir, ENTRY);
    expect(fresh.get(bareKey('a'))).toBeNull();
    expect(fresh.get(bareKey('b'))?.nodeId).toBe('n2');
  });

  test('entries are isolated per gateway entry', async () => {
    const dir = await tempDir();
    TargetCache.open(dir, ENTRY).set(bareKey('a'), { nodeId: 'n1', name: 'a' });
    expect(TargetCache.open(dir, 'http://other.example:9883').get(bareKey('a'))).toBeNull();
  });

  test('a corrupt or foreign file is a miss, never an error', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, TARGETS_FILE_NAME), '{not json');
    const cache = TargetCache.open(dir, ENTRY);
    expect(cache.get(bareKey('a'))).toBeNull();
    cache.set(bareKey('a'), { nodeId: 'n1', name: 'a' });
    expect(TargetCache.open(dir, ENTRY).get(bareKey('a'))?.nodeId).toBe('n1');
  });

  test('an unwritable location is swallowed', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'blocker'), 'x');
    const cache = TargetCache.open(join(dir, 'blocker', 'nested'), ENTRY);
    expect(() => cache.set(bareKey('a'), { nodeId: 'n1', name: 'a' })).not.toThrow();
    expect(cache.get(bareKey('a'))?.nodeId).toBe('n1');
  });
});
