import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MANAGED_ENDPOINT_MAX_BYTES,
  consumeManagedEndpointPublication,
  parseManagedEndpointPayload,
  publishManagedEndpoint,
  resolveManagedEndpointPublication,
} from './managed-endpoint';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function validEndpoint() {
  return {
    schemaVersion: 1 as const,
    nonce: 'launch-nonce',
    pid: 12345,
    transport: 'tcp' as const,
    host: '127.0.0.1' as const,
    port: 49152,
  };
}

describe('managed endpoint protocol', () => {
  test('accepts the versioned loopback TCP schema', () => {
    expect(parseManagedEndpointPayload(JSON.stringify(validEndpoint()))).toEqual(validEndpoint());
    expect(
      parseManagedEndpointPayload(JSON.stringify({ ...validEndpoint(), host: '::1' }))
    ).toEqual({ ...validEndpoint(), host: '::1' });
  });

  test('rejects empty nonce', () => {
    expect(() =>
      parseManagedEndpointPayload(JSON.stringify({ ...validEndpoint(), nonce: '' }))
    ).toThrow('nonce');
  });

  test('rejects non-loopback hosts', () => {
    for (const host of ['0.0.0.0', 'localhost', '192.0.2.1']) {
      expect(() =>
        parseManagedEndpointPayload(JSON.stringify({ ...validEndpoint(), host }))
      ).toThrow('loopback');
    }
  });

  test('rejects zero, fractional, and out-of-range ports', () => {
    for (const port of [0, 1.5, 65536]) {
      expect(() =>
        parseManagedEndpointPayload(JSON.stringify({ ...validEndpoint(), port }))
      ).toThrow('port');
    }
  });

  test('rejects unknown fields and oversized payloads', () => {
    expect(() =>
      parseManagedEndpointPayload(JSON.stringify({ ...validEndpoint(), extra: 'unexpected' }))
    ).toThrow('fields');

    const payload = JSON.stringify({
      ...validEndpoint(),
      extra: 'x'.repeat(MANAGED_ENDPOINT_MAX_BYTES),
    });
    expect(() => parseManagedEndpointPayload(payload)).toThrow('too large');
  });
});

describe('managed endpoint publication', () => {
  test('requires an absolute path and a non-empty nonce', () => {
    expect(() => resolveManagedEndpointPublication({})).toThrow('TMEX_MANAGED_ENDPOINT_PATH');
    expect(() =>
      resolveManagedEndpointPublication({
        TMEX_MANAGED_ENDPOINT_PATH: 'relative/ready.json',
        TMEX_MANAGED_ENDPOINT_NONCE: 'nonce',
      })
    ).toThrow('absolute');
    expect(() =>
      resolveManagedEndpointPublication({
        TMEX_MANAGED_ENDPOINT_PATH: join(tmpdir(), 'ready.json'),
        TMEX_MANAGED_ENDPOINT_NONCE: '',
      })
    ).toThrow('TMEX_MANAGED_ENDPOINT_NONCE');
  });

  test('consumes one-time endpoint environment before the runtime starts', () => {
    const env = {
      TMEX_MANAGED_ENDPOINT_PATH: join(tmpdir(), 'ready.json'),
      TMEX_MANAGED_ENDPOINT_NONCE: 'launch-nonce',
      UNRELATED: 'preserved',
    };

    expect(consumeManagedEndpointPublication(env)).toEqual({
      path: join(tmpdir(), 'ready.json'),
      nonce: 'launch-nonce',
    });
    expect(env).toEqual({ UNRELATED: 'preserved' });
  });

  test('atomically publishes one complete final file', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'tmex-managed-endpoint-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'ready.json');
    const publication = { path, nonce: 'launch-nonce' };

    const published = await publishManagedEndpoint(publication, {
      host: '127.0.0.1',
      port: 49152,
      pid: 12345,
    });

    expect(readdirSync(directory)).toEqual(['ready.json']);
    const payload = readFileSync(path, 'utf8');
    expect(new TextEncoder().encode(payload).byteLength).toBeLessThanOrEqual(
      MANAGED_ENDPOINT_MAX_BYTES
    );
    expect(parseManagedEndpointPayload(payload)).toEqual(published);
  });
});
