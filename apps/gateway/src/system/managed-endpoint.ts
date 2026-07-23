import { randomUUID } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';

export const MANAGED_ENDPOINT_MAX_BYTES = 1024;
export const MANAGED_ENDPOINT_MAX_NONCE_BYTES = 256;

const MANAGED_ENDPOINT_FIELDS = [
  'host',
  'nonce',
  'pid',
  'port',
  'schemaVersion',
  'transport',
] as const;

export interface ManagedEndpointReady {
  schemaVersion: 1;
  nonce: string;
  pid: number;
  transport: 'tcp';
  host: '127.0.0.1' | '::1';
  port: number;
}

export interface ManagedEndpointPublication {
  path: string;
  nonce: string;
}

export function resolveManagedEndpointHost(host: string): ManagedEndpointReady['host'] {
  if (host !== '127.0.0.1' && host !== '::1') {
    throw new Error('managed endpoint host must be a numeric loopback address');
  }
  return host;
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function validateNonce(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    utf8Length(value) > MANAGED_ENDPOINT_MAX_NONCE_BYTES
  ) {
    throw new Error(
      `managed endpoint nonce must contain 1..${MANAGED_ENDPOINT_MAX_NONCE_BYTES} UTF-8 bytes`
    );
  }
  return value;
}

function validateManagedEndpoint(value: unknown): ManagedEndpointReady {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('managed endpoint payload must be an object');
  }

  const record = value as Record<string, unknown>;
  const fields = Object.keys(record).sort();
  if (
    fields.length !== MANAGED_ENDPOINT_FIELDS.length ||
    fields.some((field, index) => field !== MANAGED_ENDPOINT_FIELDS[index])
  ) {
    throw new Error('managed endpoint payload has unexpected fields');
  }
  if (record.schemaVersion !== 1) {
    throw new Error('managed endpoint schemaVersion must be 1');
  }
  const nonce = validateNonce(record.nonce);
  if (!Number.isSafeInteger(record.pid) || (record.pid as number) <= 0) {
    throw new Error('managed endpoint pid must be a positive safe integer');
  }
  if (record.transport !== 'tcp') {
    throw new Error('managed endpoint transport must be tcp');
  }
  const host = resolveManagedEndpointHost(record.host as string);
  if (
    !Number.isInteger(record.port) ||
    (record.port as number) < 1 ||
    (record.port as number) > 65535
  ) {
    throw new Error('managed endpoint port must be an integer in 1..65535');
  }

  return {
    schemaVersion: 1,
    nonce,
    pid: record.pid as number,
    transport: 'tcp',
    host,
    port: record.port as number,
  };
}

export function parseManagedEndpointPayload(payload: string): ManagedEndpointReady {
  if (utf8Length(payload) > MANAGED_ENDPOINT_MAX_BYTES) {
    throw new Error(
      `managed endpoint payload is too large (max ${MANAGED_ENDPOINT_MAX_BYTES} bytes)`
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    throw new Error('managed endpoint payload is not valid JSON');
  }
  return validateManagedEndpoint(value);
}

export function resolveManagedEndpointPublication(
  env: NodeJS.ProcessEnv = process.env
): ManagedEndpointPublication {
  const path = env.TMEX_MANAGED_ENDPOINT_PATH;
  if (!path || !path.trim()) {
    throw new Error('TMEX_MANAGED_ENDPOINT_PATH is required for the managed Gateway');
  }
  if (!isAbsolute(path) || !basename(path) || dirname(path) === path) {
    throw new Error('TMEX_MANAGED_ENDPOINT_PATH must be an absolute file path');
  }

  const nonce = env.TMEX_MANAGED_ENDPOINT_NONCE;
  if (nonce === undefined || nonce.length === 0) {
    throw new Error('TMEX_MANAGED_ENDPOINT_NONCE is required for the managed Gateway');
  }
  try {
    validateNonce(nonce);
  } catch {
    throw new Error(
      `TMEX_MANAGED_ENDPOINT_NONCE must contain 1..${MANAGED_ENDPOINT_MAX_NONCE_BYTES} UTF-8 bytes`
    );
  }
  return { path, nonce };
}

export function consumeManagedEndpointPublication(
  env: NodeJS.ProcessEnv = process.env
): ManagedEndpointPublication {
  const publication = resolveManagedEndpointPublication(env);
  Reflect.deleteProperty(env, 'TMEX_MANAGED_ENDPOINT_PATH');
  Reflect.deleteProperty(env, 'TMEX_MANAGED_ENDPOINT_NONCE');
  return publication;
}

export async function publishManagedEndpoint(
  publication: ManagedEndpointPublication,
  endpoint: { host: string; port: number; pid?: number }
): Promise<ManagedEndpointReady> {
  const ready = validateManagedEndpoint({
    schemaVersion: 1,
    nonce: publication.nonce,
    pid: endpoint.pid ?? process.pid,
    transport: 'tcp',
    host: endpoint.host,
    port: endpoint.port,
  });
  const payload = JSON.stringify(ready);
  parseManagedEndpointPayload(payload);

  const temporaryPath = join(
    dirname(publication.path),
    `.tmex-managed-endpoint-${process.pid}-${randomUUID()}.tmp`
  );
  try {
    await writeFile(temporaryPath, payload, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    await rename(temporaryPath, publication.path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
  return ready;
}
