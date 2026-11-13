import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rootKeyFromSeed } from '../../packages/shared/src/auth/root-key';
import {
  signReleaseSums,
  verifyReleaseSums,
} from '../../packages/shared/src/release/release-signing';
import {
  loadEmbeddedSigningKeys,
  signReleaseSumsWebCrypto,
  signSumsFile,
  verifyReleaseSumsWebCrypto,
} from './sign-sums';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function randomSeed(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

describe('sign-sums WebCrypto', () => {
  test('round-trips with noble and rejects a swapped sums file', async () => {
    const seed = randomSeed();
    const publicKey = btoa(String.fromCharCode(...rootKeyFromSeed(seed).publicKey));
    const keys = [{ id: 't1', publicKey }];
    const sums = new TextEncoder().encode('abc  vibeterm-cli-9.9.9.tgz\n');

    const webLine = await signReleaseSumsWebCrypto(seed, sums, keys);
    const nobleLine = signReleaseSums(seed, sums, keys);
    expect(webLine).toBe(nobleLine);
    expect(await verifyReleaseSumsWebCrypto(sums, webLine, keys)).toEqual({
      ok: true,
      keyId: 't1',
    });
    expect(verifyReleaseSums(sums, webLine, keys)).toMatchObject({ ok: true, keyId: 't1' });
    expect(
      (await verifyReleaseSumsWebCrypto(new TextEncoder().encode('tampered\n'), webLine, keys)).ok
    ).toBe(false);
  });

  test('refuses a seed whose public key is not in the table', async () => {
    const keys = [{ id: 't1', publicKey: btoa(String.fromCharCode(...new Uint8Array(32))) }];
    await expect(signReleaseSumsWebCrypto(randomSeed(), new Uint8Array([1]), keys)).rejects.toThrow(
      /RELEASE_SIGNING_KEYS/
    );
  });

  test('parses RELEASE_SIGNING_KEYS from the tagged source and writes SHA256SUMS.sig', async () => {
    const source = `export const RELEASE_SIGNING_KEYS = [
  { id: 'r1', publicKey: 'x3aihYJPAJ6OafKJ/W5QHGX1IA4n61WD650sQaMl3OY=' },
];`;
    expect(loadEmbeddedSigningKeys(source)).toEqual([
      { id: 'r1', publicKey: 'x3aihYJPAJ6OafKJ/W5QHGX1IA4n61WD650sQaMl3OY=' },
    ]);

    const seed = randomSeed();
    const publicKey = btoa(String.fromCharCode(...rootKeyFromSeed(seed).publicKey));
    const dir = await mkdtemp(join(tmpdir(), 'vibeterm-sign-sums-'));
    tempDirs.push(dir);
    const sumsPath = join(dir, 'SHA256SUMS');
    await writeFile(sumsPath, 'deadbeef  vibeterm-cli-9.9.9.tgz\n');
    const { sigPath, keyId } = await signSumsFile(sumsPath, btoa(String.fromCharCode(...seed)), [
      { id: 't1', publicKey },
    ]);
    expect(keyId).toBe('t1');
    expect(await readFile(sigPath, 'utf8')).toMatch(/^tmex-release-sig v1 t1 /);
  });
});
