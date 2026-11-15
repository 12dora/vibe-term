import { afterEach, describe, expect, test } from 'bun:test';
import { symlinkSync } from 'node:fs';
import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decodeBase64url,
  encodeBase64url,
  generateEd25519KeyPair,
  popTargetFromUrl,
  verifyPop,
} from '@vibeterm/shared/auth';
import { type CliError, UsageError } from './errors';
import { signSessionPop } from './session-pop';
import {
  SESSION_FILE_VERSION,
  SessionStore,
  isLiveNodeSession,
  parseSessionFile,
  sessionFilePrivacyError,
} from './session-store';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vibeterm-cli-session-'));
  dirs.push(dir);
  return dir;
}

describe('isLiveNodeSession', () => {
  test('missing or empty sid is not live', () => {
    expect(isLiveNodeSession(null)).toBe(false);
    expect(isLiveNodeSession({ nodeId: 'self', sid: '', expiresAt: 0 })).toBe(false);
  });

  test('expiresAt 0 is live; past is not; future is', () => {
    const now = 1_700_000_000_000;
    expect(isLiveNodeSession({ nodeId: 'self', sid: 'sid', expiresAt: 0 }, now)).toBe(true);
    expect(isLiveNodeSession({ nodeId: 'self', sid: 'sid', expiresAt: now - 1 }, now)).toBe(false);
    expect(isLiveNodeSession({ nodeId: 'self', sid: 'sid', expiresAt: now + 1 }, now)).toBe(true);
  });
});

describe('SessionStore', () => {
  test('round-trips identity and node sessions', async () => {
    const dir = join(await tempDir(), 'config');
    const store = SessionStore.open(dir, {});
    store.setIdentity('http://entry:1', { uid: 'u-1', username: 'admin' });
    store.setNodeSession('http://entry:1', { nodeId: 'self', sid: 'sid-1', expiresAt: 42 });
    store.setNodeSession('http://entry:1', { nodeId: 'a'.repeat(32), sid: 'sid-2', expiresAt: 43 });
    store.save();

    const reopened = SessionStore.open(dir, {});
    const entry = reopened.entry('http://entry:1');
    expect(entry?.uid).toBe('u-1');
    expect(entry?.username).toBe('admin');
    expect(entry?.nodes.self).toEqual({ nodeId: 'self', sid: 'sid-1', expiresAt: 42 });
    expect(entry?.nodes['a'.repeat(32)].sid).toBe('sid-2');
    expect(reopened.lastEntry()).toBe('http://entry:1');
  });

  test('writes the file 0600 and the directory 0700', async () => {
    const dir = join(await tempDir(), 'nested', 'config');
    const store = SessionStore.open(dir, {});
    store.setNodeSession('http://entry:1', { nodeId: 'self', sid: 'sid', expiresAt: 0 });
    store.save();

    expect((await stat(store.path)).mode & 0o777).toBe(0o600);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });

  test('clearEntry drops the entry and the lastEntry pointer', async () => {
    const dir = await tempDir();
    const store = SessionStore.open(dir, {});
    store.setNodeSession('http://entry:1', { nodeId: 'self', sid: 'sid', expiresAt: 0 });
    store.clearEntry('http://entry:1');
    store.save();

    const reopened = SessionStore.open(dir, {});
    expect(reopened.entry('http://entry:1')).toBeNull();
    expect(reopened.lastEntry()).toBeNull();
  });

  test('a corrupt file degrades to an empty store instead of throwing', async () => {
    const dir = await tempDir();
    const store = SessionStore.open(dir, {});
    await writeFile(store.path, '{ not json', { mode: 0o600 });
    await chmod(store.path, 0o600);
    expect(store.lastEntry()).toBeNull();
    expect(store.entry('http://entry:1')).toBeNull();
  });

  test('VIBETERM_SESSION_FILE overrides the default path and keeps 0600', async () => {
    const dir = await tempDir();
    const file = join(dir, 'agent', 'session.json');
    const store = SessionStore.open(dir, { VIBETERM_SESSION_FILE: file });
    expect(store.path).toBe(file);
    store.setNodeSession('http://entry:1', { nodeId: 'self', sid: 'sid', expiresAt: 0 });
    store.save();

    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, 'agent'))).mode & 0o777).toBe(0o700);
    const reopened = SessionStore.open(dir, { VIBETERM_SESSION_FILE: file });
    expect(reopened.entry('http://entry:1')?.nodes.self.sid).toBe('sid');
  });

  test('refuses a group/world readable session file', async () => {
    const dir = await tempDir();
    const store = SessionStore.open(dir, {});
    store.setNodeSession('http://entry:1', { nodeId: 'self', sid: 'sid', expiresAt: 0 });
    store.save();
    await chmod(store.path, 0o644);

    const reopened = SessionStore.open(dir, {});
    const error = (() => {
      try {
        reopened.lastEntry();
        return null;
      } catch (err) {
        return err as CliError;
      }
    })();
    expect(error).toBeInstanceOf(UsageError);
    expect(error?.exitCode).toBe(2);
    expect(error?.message).toContain('group/world readable');
    expect(error?.message).toContain('session private key');
  });

  test('does not chmod a pre-existing user-specified parent directory', async () => {
    const parent = await tempDir();
    await chmod(parent, 0o755);
    const file = join(parent, 'agent.json');
    const store = SessionStore.open(join(parent, 'unused-config'), { VIBETERM_SESSION_FILE: file });
    store.setNodeSession('http://entry:1', { nodeId: 'self', sid: 'sid', expiresAt: 0 });
    store.save();

    expect((await stat(parent)).mode & 0o777).toBe(0o755);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  test('still chmods the default config dir even if it already existed', async () => {
    const dir = await tempDir();
    await chmod(dir, 0o755);
    const store = SessionStore.open(dir, {});
    store.setNodeSession('http://entry:1', { nodeId: 'self', sid: 'sid', expiresAt: 0 });
    store.save();
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });

  test('refuses a session file that is a symlink', async () => {
    const dir = await tempDir();
    const real = join(dir, 'real.json');
    await writeFile(real, '{}\n', { mode: 0o600 });
    await chmod(real, 0o600);
    const link = join(dir, 'session.json');
    symlinkSync(real, link);
    const store = SessionStore.open(dir, { VIBETERM_SESSION_FILE: link });
    const error = (() => {
      try {
        store.lastEntry();
        return null;
      } catch (err) {
        return err as UsageError;
      }
    })();
    expect(error).toBeInstanceOf(UsageError);
    expect(error?.exitCode).toBe(2);
    expect(error?.message).toContain('symlink');
  });

  test('sessionFilePrivacyError skips the mode check on win32', () => {
    const info = { isSymbolicLink: () => false, mode: 0o666 };
    expect(sessionFilePrivacyError('/x', info, 'linux')).toBeInstanceOf(UsageError);
    expect(sessionFilePrivacyError('/x', info, 'win32')).toBeNull();
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

  test('never persists password or seed; v1 writes have no sessSk', async () => {
    const dir = await tempDir();
    const store = SessionStore.open(dir, {});
    store.setIdentity('http://entry:1', { uid: 'u-1', username: 'admin' });
    store.setNodeSession('http://entry:1', { nodeId: 'self', sid: 'sid', expiresAt: 1 });
    store.save();
    const text = await Bun.file(store.path).text();
    expect(text).not.toContain('password');
    expect(text).not.toContain('seed');
    expect(text).not.toContain('sessSk');
  });

  test('reads a v1 file without keys and writes v2 per-node keys at 0600', async () => {
    const dir = await tempDir();
    const path = join(dir, 'session.json');
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        lastEntry: 'http://entry:1',
        entries: {
          'http://entry:1': {
            entry: 'http://entry:1',
            uid: 'u-1',
            nodes: { self: { nodeId: 'self', sid: 'sid-v1', expiresAt: 9 } },
          },
        },
      }),
      { mode: 0o600 }
    );
    await chmod(path, 0o600);

    const store = SessionStore.open(dir, {});
    const loaded = store.entry('http://entry:1');
    expect(loaded?.nodes.self.sid).toBe('sid-v1');
    expect(loaded?.nodes.self.sessSk).toBeUndefined();
    expect(store.popKey('http://entry:1', 'self')).toBeNull();

    const pair = generateEd25519KeyPair();
    store.setPopKey('http://entry:1', 'self', { sessSk: pair.secretKey, sessPk: pair.publicKey });
    store.save();

    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const raw = JSON.parse(await Bun.file(path).text()) as {
      version: number;
      entries: Record<
        string,
        { sessSk?: string; nodes: Record<string, { sessSk?: string; sessPk?: string }> }
      >;
    };
    expect(raw.version).toBe(SESSION_FILE_VERSION);
    expect(raw.version).toBe(2);
    expect(raw.entries['http://entry:1'].sessSk).toBeUndefined();
    const saved = raw.entries['http://entry:1'].nodes.self;
    expect(decodeBase64url(saved.sessSk ?? '')).toEqual(pair.secretKey);
    expect(decodeBase64url(saved.sessPk ?? '')).toEqual(pair.publicKey);

    const reopened = SessionStore.open(dir, {});
    const key = reopened.popKey('http://entry:1', 'self');
    expect(key?.sessPk).toEqual(pair.publicKey);
    expect(reopened.entry('http://entry:1')?.nodes.self.sid).toBe('sid-v1');
  });

  test('copies an entry-level v2 key onto every node on read', async () => {
    const dir = await tempDir();
    const path = join(dir, 'session.json');
    const pair = generateEd25519KeyPair();
    const sessSk = encodeBase64url(pair.secretKey);
    const sessPk = encodeBase64url(pair.publicKey);
    const other = 'b'.repeat(32);
    await writeFile(
      path,
      JSON.stringify({
        version: 2,
        lastEntry: 'http://entry:1',
        entries: {
          'http://entry:1': {
            sessSk,
            sessPk,
            nodes: {
              self: { nodeId: 'self', sid: 'sid-self', expiresAt: 1 },
              [other]: { nodeId: other, sid: 'sid-b', expiresAt: 2 },
            },
          },
        },
      }),
      { mode: 0o600 }
    );
    await chmod(path, 0o600);

    const store = SessionStore.open(dir, {});
    const entry = store.entry('http://entry:1');
    expect((entry as { sessSk?: string } | null)?.sessSk).toBeUndefined();
    expect(entry?.nodes.self.sessSk).toBe(sessSk);
    expect(entry?.nodes[other].sessSk).toBe(sessSk);
    expect(store.popKey('http://entry:1', 'self')?.sessPk).toEqual(pair.publicKey);
    expect(store.popKey('http://entry:1', other)?.sessPk).toEqual(pair.publicKey);
  });

  test('replacing node B’s key keeps node A’s key', async () => {
    const dir = await tempDir();
    const store = SessionStore.open(dir, {});
    const keyA = generateEd25519KeyPair();
    const keyB = generateEd25519KeyPair();
    const keyB2 = generateEd25519KeyPair();
    const nodeA = 'a'.repeat(32);
    const nodeB = 'b'.repeat(32);
    store.setNodeSession('http://entry:1', { nodeId: nodeA, sid: 'sid-a', expiresAt: 0 });
    store.setNodeSession('http://entry:1', { nodeId: nodeB, sid: 'sid-b', expiresAt: 0 });
    store.setPopKey('http://entry:1', nodeA, { sessSk: keyA.secretKey, sessPk: keyA.publicKey });
    store.setPopKey('http://entry:1', nodeB, { sessSk: keyB.secretKey, sessPk: keyB.publicKey });
    store.setPopKey('http://entry:1', nodeB, { sessSk: keyB2.secretKey, sessPk: keyB2.publicKey });
    store.save();

    expect(store.popKey('http://entry:1', nodeA)?.sessPk).toEqual(keyA.publicKey);
    expect(store.popKey('http://entry:1', nodeB)?.sessPk).toEqual(keyB2.publicKey);
    expect(store.entry('http://entry:1')?.nodes[nodeA].sid).toBe('sid-a');

    const storedA = store.popKey('http://entry:1', nodeA);
    const url = 'http://entry:1/api/devices';
    const proof = await signSessionPop(storedA?.sessSk ?? new Uint8Array(), 'GET', url);
    expect(
      verifyPop(storedA?.sessPk ?? new Uint8Array(), proof, popTargetFromUrl('GET', url)).ok
    ).toBe(true);
    expect(verifyPop(keyB2.publicKey, proof, popTargetFromUrl('GET', url)).ok).toBe(false);
  });

  test('clearEntry wipes the stored session key with the sids', async () => {
    const dir = await tempDir();
    const store = SessionStore.open(dir, {});
    const pair = generateEd25519KeyPair();
    store.setNodeSession('http://entry:1', { nodeId: 'self', sid: 'sid', expiresAt: 0 });
    store.setPopKey('http://entry:1', 'self', { sessSk: pair.secretKey, sessPk: pair.publicKey });
    store.clearEntry('http://entry:1');
    store.save();
    expect(store.entry('http://entry:1')).toBeNull();
    expect(store.popKey('http://entry:1', 'self')).toBeNull();
    expect(await Bun.file(store.path).text()).not.toContain(encodeBase64url(pair.secretKey));
  });

  test('parseSessionFile keeps v1 entries and drops malformed keys', () => {
    const parsed = parseSessionFile(
      JSON.stringify({
        version: 1,
        lastEntry: 'http://entry:1',
        entries: {
          'http://entry:1': {
            uid: 'u-1',
            sessSk: 'not-a-key',
            sessPk: 'also-bad',
            nodes: { self: { nodeId: 'self', sid: 'sid' } },
          },
        },
      })
    );
    expect(parsed.entries['http://entry:1'].nodes.self.sid).toBe('sid');
    expect(parsed.entries['http://entry:1'].nodes.self.sessSk).toBeUndefined();
  });
});
