import { afterEach, describe, expect, test } from 'bun:test';
import { symlinkSync } from 'node:fs';
import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type CliError, UsageError } from './errors';
import {
  type StoredToken,
  TokenStore,
  isLiveToken,
  parseTokenFile,
  tokenFilePrivacyError,
} from './token-store';

const ENTRY = 'http://entry:1';
const NODE = 'a'.repeat(32);
const SECRET = `vtk_${'s'.repeat(43)}`;
const OTHER_SECRET = `vtk_${'o'.repeat(43)}`;
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vibeterm-cli-tokens-'));
  dirs.push(dir);
  return dir;
}

function token(overrides: Partial<StoredToken> = {}): StoredToken {
  return {
    tokenId: 'tok-1',
    nodeId: '',
    nodeName: '',
    secret: SECRET,
    name: 'ci',
    scopes: ['exec'],
    expiresAt: null,
    createdAt: 1,
    ...overrides,
  };
}

function thrown(run: () => unknown): CliError | null {
  try {
    run();
    return null;
  } catch (error) {
    return error as CliError;
  }
}

describe('isLiveToken', () => {
  test('null expiry never expires; past expiry is dead; empty secret is dead', () => {
    const now = 1_700_000_000_000;
    expect(isLiveToken(null)).toBe(false);
    expect(isLiveToken(token({ expiresAt: null }), now)).toBe(true);
    expect(isLiveToken(token({ expiresAt: now + 1 }), now)).toBe(true);
    expect(isLiveToken(token({ expiresAt: now }), now)).toBe(false);
    expect(isLiveToken(token({ secret: '' }), now)).toBe(false);
    expect(isLiveToken(token({ secret: 'vtk_short' }), now)).toBe(false);
    expect(isLiveToken(token({ secret: `${SECRET};x=1` }), now)).toBe(false);
  });
});

describe('TokenStore', () => {
  test('round-trips tokens per entry and node key', async () => {
    const dir = join(await tempDir(), 'config');
    const store = TokenStore.open(dir, {});
    store.put(ENTRY, ['self', NODE], token());
    store.save();

    const reopened = TokenStore.open(dir, {});
    expect(reopened.get(ENTRY, 'self')).toEqual(token());
    expect(reopened.get(ENTRY, NODE)?.secret).toBe(SECRET);
    expect(reopened.get(ENTRY, 'b'.repeat(32))).toBeNull();
    expect(reopened.get('http://other:1', 'self')).toBeNull();
    expect(reopened.source(ENTRY).get('self')?.secret).toBe(SECRET);
  });

  test('expired tokens are ignored by get and the token source', async () => {
    const dir = await tempDir();
    const store = TokenStore.open(dir, {});
    const now = 1_700_000_000_000;
    store.put(ENTRY, ['self'], token({ expiresAt: now - 1 }));
    expect(store.get(ENTRY, 'self', now)).toBeNull();
    expect(store.source(ENTRY).get('self')).toBeNull();
    expect(Object.keys(store.nodes(ENTRY))).toEqual(['self']);
  });

  test('removeById clears every addressing key of that token only', async () => {
    const dir = await tempDir();
    const store = TokenStore.open(dir, {});
    store.put(ENTRY, ['self', NODE], token({ tokenId: 'tok-1' }));
    store.put(ENTRY, ['c'.repeat(32)], token({ tokenId: 'tok-2', secret: OTHER_SECRET }));
    expect(store.removeById(ENTRY, 'tok-1')).toBe(2);
    expect(store.get(ENTRY, 'self')).toBeNull();
    expect(store.get(ENTRY, NODE)).toBeNull();
    expect(store.get(ENTRY, 'c'.repeat(32))?.secret).toBe(OTHER_SECRET);
    expect(store.removeById(ENTRY, '')).toBe(0);
    expect(store.removeById('http://other:1', 'tok-2')).toBe(0);
  });

  test('nodeByName finds a live token by saved name, case-insensitively', async () => {
    const store = TokenStore.open(await tempDir(), {});
    store.put(ENTRY, [NODE], token({ nodeId: NODE, nodeName: 'Office' }));
    expect(store.nodeByName(ENTRY, 'office')).toEqual({ id: NODE, name: 'Office' });
    expect(store.source(ENTRY).nodeByName?.('OFFICE')?.id).toBe(NODE);
    expect(store.nodeByName(ENTRY, 'nope')).toBeNull();
    expect(store.nodeByName(ENTRY, '')).toBeNull();
    expect(store.nodeByName('http://other:1', 'office')).toBeNull();
  });

  test('nodeByName prefers self for the entry node and ignores expired or ambiguous names', async () => {
    const store = TokenStore.open(await tempDir(), {});
    const now = 1_700_000_000_000;
    store.put(ENTRY, ['self', NODE], token({ nodeId: NODE, nodeName: 'hub' }));
    expect(store.nodeByName(ENTRY, 'hub')?.id).toBe('self');
    store.put(
      ENTRY,
      ['d'.repeat(32)],
      token({ nodeId: 'd'.repeat(32), nodeName: 'dup', expiresAt: now - 1 })
    );
    expect(store.nodeByName(ENTRY, 'dup', now)).toBeNull();
    store.put(ENTRY, ['e'.repeat(32)], token({ nodeId: 'e'.repeat(32), nodeName: 'twin' }));
    store.put(ENTRY, ['f'.repeat(32)], token({ nodeId: 'f'.repeat(32), nodeName: 'twin' }));
    expect(store.nodeByName(ENTRY, 'twin')).toBeNull();
  });

  test('removeKeys drops the given addressing keys regardless of server id', async () => {
    const store = TokenStore.open(await tempDir(), {});
    store.put(ENTRY, ['self', NODE], token({ tokenId: '' }));
    store.put(ENTRY, ['c'.repeat(32)], token({ tokenId: '', secret: OTHER_SECRET }));
    expect(store.removeKeys(ENTRY, ['self', NODE, 'z'.repeat(32)])).toBe(2);
    expect(store.get(ENTRY, 'c'.repeat(32))?.secret).toBe(OTHER_SECRET);
    expect(store.removeKeys('http://other:1', ['self'])).toBe(0);
  });

  test('writes the file 0600 and the directory 0700', async () => {
    const dir = join(await tempDir(), 'nested', 'config');
    const store = TokenStore.open(dir, {});
    store.put(ENTRY, ['self'], token());
    store.save();
    expect(store.path).toBe(join(dir, 'tokens.json'));
    expect((await stat(store.path)).mode & 0o777).toBe(0o600);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });

  test('VIBETERM_TOKENS_FILE overrides the default path and keeps 0600', async () => {
    const dir = await tempDir();
    const file = join(dir, 'agent', 'tokens.json');
    const env = { VIBETERM_TOKENS_FILE: file };
    const store = TokenStore.open(dir, env);
    expect(store.path).toBe(file);
    store.put(ENTRY, ['self'], token());
    store.save();
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, 'agent'))).mode & 0o777).toBe(0o700);
    expect(TokenStore.open(dir, env).get(ENTRY, 'self')?.secret).toBe(SECRET);
  });

  test('refuses a group/world readable token file', async () => {
    const dir = await tempDir();
    const store = TokenStore.open(dir, {});
    store.put(ENTRY, ['self'], token());
    store.save();
    await chmod(store.path, 0o644);

    const error = thrown(() => TokenStore.open(dir, {}).get(ENTRY, 'self'));
    expect(error).toBeInstanceOf(UsageError);
    expect(error?.exitCode).toBe(2);
    expect(error?.message).toContain('group/world readable');
  });

  test('refuses a token file that is a symlink', async () => {
    const dir = await tempDir();
    const real = join(dir, 'real.json');
    await writeFile(real, '{}\n', { mode: 0o600 });
    await chmod(real, 0o600);
    const link = join(dir, 'tokens.json');
    symlinkSync(real, link);

    const store = TokenStore.open(dir, { VIBETERM_TOKENS_FILE: link });
    const error = thrown(() => store.get(ENTRY, 'self'));
    expect(error).toBeInstanceOf(UsageError);
    expect(error?.message).toContain('symlink');
  });

  test('does not chmod a pre-existing user-specified parent directory', async () => {
    const parent = await tempDir();
    await chmod(parent, 0o755);
    const file = join(parent, 'agent.json');
    const store = TokenStore.open(join(parent, 'unused'), { VIBETERM_TOKENS_FILE: file });
    store.put(ENTRY, ['self'], token());
    store.save();
    expect((await stat(parent)).mode & 0o777).toBe(0o755);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  test('a corrupt file degrades to an empty store', async () => {
    const dir = await tempDir();
    const file = join(dir, 'tokens.json');
    await writeFile(file, '{not json', { mode: 0o600 });
    await chmod(file, 0o600);
    expect(TokenStore.open(dir, {}).get(ENTRY, 'self')).toBeNull();
  });

  test('tokenFilePrivacyError skips the mode check on win32', () => {
    const info = { isSymbolicLink: () => false, mode: 0o666 };
    expect(tokenFilePrivacyError('x', info, 'win32')).toBeNull();
    expect(tokenFilePrivacyError('x', info, 'linux')).toBeInstanceOf(UsageError);
  });

  test('parseTokenFile drops malformed rows and keeps good ones', () => {
    const file = parseTokenFile(
      JSON.stringify({
        version: 1,
        entries: {
          [ENTRY]: {
            nodes: {
              self: {
                tokenId: 't',
                secret: SECRET,
                name: 'n',
                scopes: ['exec', 3],
                expiresAt: 9,
                createdAt: 2,
              },
              bad: { tokenId: 't' },
              badSecret: { tokenId: 't', secret: 'vtk_short' },
              worse: 'nope',
            },
          },
          broken: 'x',
        },
      })
    );
    expect(Object.keys(file.entries)).toEqual([ENTRY]);
    expect(file.entries[ENTRY].nodes.self).toEqual({
      tokenId: 't',
      nodeId: '',
      nodeName: '',
      secret: SECRET,
      name: 'n',
      scopes: ['exec'],
      expiresAt: 9,
      createdAt: 2,
    });
    expect(Object.keys(file.entries[ENTRY].nodes)).toEqual(['self']);
  });
});
