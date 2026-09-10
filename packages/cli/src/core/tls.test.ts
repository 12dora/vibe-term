import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UsageError } from './errors';
import {
  CA_FINGERPRINT_PINNING_SUPPORTED,
  DEFAULT_TLS,
  fetchTlsInit,
  isTlsCustomized,
  loadTlsSettings,
  prepareProcessTls,
  wsTlsOptions,
} from './tls';

const dirs: string[] = [];
const PEM = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n';

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function pemFile(content = PEM): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vibeterm-cli-tls-'));
  dirs.push(dir);
  const path = join(dir, 'ca.pem');
  await writeFile(path, content);
  return path;
}

describe('loadTlsSettings', () => {
  test('defaults verify against the system trust store', () => {
    expect(loadTlsSettings(undefined, false)).toEqual(DEFAULT_TLS);
    expect(isTlsCustomized(DEFAULT_TLS)).toBe(false);
  });

  test('--ca reads the PEM bundle', async () => {
    const settings = loadTlsSettings(await pemFile(), false);
    expect(settings.ca).toContain('BEGIN CERTIFICATE');
    expect(settings.insecure).toBe(false);
    expect(isTlsCustomized(settings)).toBe(true);
  });

  test('--ca rejects a missing file and a non-PEM file', async () => {
    const junk = await pemFile('not a certificate');
    expect(() => loadTlsSettings('/definitely/not/here.pem', false)).toThrow(UsageError);
    expect(() => loadTlsSettings(junk, false)).toThrow(UsageError);
  });

  test('--insecure alone needs no file', () => {
    expect(loadTlsSettings(undefined, true)).toEqual({ ca: null, insecure: true });
  });
});

describe('transport options', () => {
  test('ws gets ca and rejectUnauthorized straight through to tls.connect', async () => {
    const settings = loadTlsSettings(await pemFile(), true);
    expect(wsTlsOptions(settings)).toEqual({
      ca: settings.ca as string,
      rejectUnauthorized: false,
    });
  });

  test('the default settings add nothing to either transport', () => {
    expect(wsTlsOptions(DEFAULT_TLS)).toEqual({});
    expect(fetchTlsInit(DEFAULT_TLS)).toEqual({});
  });

  test('fetch carries the same options for the runtimes that honour them', async () => {
    const settings = loadTlsSettings(await pemFile(), false);
    expect(fetchTlsInit(settings)).toEqual({ tls: { ca: settings.ca as string } });
  });
});

describe('prepareProcessTls', () => {
  test('is a no-op for http entries (nothing to verify)', async () => {
    await prepareProcessTls('http://entry.example:9883', { ca: PEM, insecure: true });
  });

  test('is a no-op when no TLS flag was given', async () => {
    await prepareProcessTls('https://entry.example', DEFAULT_TLS);
  });
});

test('caFingerprint pinning is deliberately not implemented', () => {
  expect(CA_FINGERPRINT_PINNING_SUPPORTED).toBe(false);
});
