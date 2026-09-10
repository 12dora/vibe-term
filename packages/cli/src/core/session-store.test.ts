import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore, parseSessionFile } from './session-store';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vibeterm-cli-session-'));
  dirs.push(dir);
  return dir;
}

describe('SessionStore', () => {
  test('round-trips identity and node sessions', async () => {
    const dir = join(await tempDir(), 'config');
    const store = SessionStore.open(dir);
    store.setIdentity('http://entry:1', { uid: 'u-1', username: 'admin' });
    store.setNodeSession('http://entry:1', { nodeId: 'self', sid: 'sid-1', expiresAt: 42 });
    store.setNodeSession('http://entry:1', { nodeId: 'a'.repeat(32), sid: 'sid-2', expiresAt: 43 });
    store.save();

    const reopened = SessionStore.open(dir);
    const entry = reopened.entry('http://entry:1');
    expect(entry?.uid).toBe('u-1');
    expect(entry?.username).toBe('admin');
    expect(entry?.nodes.self).toEqual({ nodeId: 'self', sid: 'sid-1', expiresAt: 42 });
    expect(entry?.nodes['a'.repeat(32)].sid).toBe('sid-2');
    expect(reopened.lastEntry()).toBe('http://entry:1');
  });

  test('writes the file 0600 and the directory 0700', async () => {
    const dir = join(await tempDir(), 'nested', 'config');
    const store = SessionStore.open(dir);
    store.setNodeSession('http://entry:1', { nodeId: 'self', sid: 'sid', expiresAt: 0 });
    store.save();

    expect((await stat(store.path)).mode & 0o777).toBe(0o600);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });

  test('clearEntry drops the entry and the lastEntry pointer', async () => {
    const dir = await tempDir();
    const store = SessionStore.open(dir);
    store.setNodeSession('http://entry:1', { nodeId: 'self', sid: 'sid', expiresAt: 0 });
    store.clearEntry('http://entry:1');
    store.save();

    const reopened = SessionStore.open(dir);
    expect(reopened.entry('http://entry:1')).toBeNull();
    expect(reopened.lastEntry()).toBeNull();
  });

  test('a corrupt file degrades to an empty store instead of throwing', async () => {
    const dir = await tempDir();
    const store = SessionStore.open(dir);
    await writeFile(store.path, '{ not json');
    expect(store.lastEntry()).toBeNull();
    expect(store.entry('http://entry:1')).toBeNull();
  });

  test('parseSessionFile drops unknown and malformed rows', () => {
    const parsed = parseSessionFile(
      JSON.stringify({
        lastEntry: 'http://entry:1',
        junk: 1,
        entries: {
          'http://entry:1': {
            uid: 'u-1',
            nodes: { self: { nodeId: 'self', sid: 'sid' }, bad: { sid: 'no-node-id' } },
          },
          'http://entry:2': 'not-an-object',
        },
      })
    );
    expect(parsed.lastEntry).toBe('http://entry:1');
    expect(Object.keys(parsed.entries)).toEqual(['http://entry:1']);
    expect(parsed.entries['http://entry:1'].nodes.self.expiresAt).toBe(0);
    expect(parsed.entries['http://entry:1'].nodes.bad).toBeUndefined();
  });

  test('never persists secrets beyond the session id', async () => {
    const dir = await tempDir();
    const store = SessionStore.open(dir);
    store.setIdentity('http://entry:1', { uid: 'u-1', username: 'admin' });
    store.setNodeSession('http://entry:1', { nodeId: 'self', sid: 'sid', expiresAt: 1 });
    store.save();
    const text = await Bun.file(store.path).text();
    expect(text).not.toContain('password');
    expect(text).not.toContain('seed');
    expect(text).not.toContain('sessSk');
  });
});
