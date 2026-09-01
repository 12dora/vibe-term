import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { getDb } from '../db/client';
import { getGatewayKv } from '../db/kv';
import {
  NODE_OPERATION_TTL_MS,
  clearNodeOperation,
  readNodeOperation,
  resetNodeOperationsForTests,
  sweepStaleNodeOperations,
  updateNodeOperation,
  writeNodeOperation,
} from './node-operations';

beforeAll(() => {
  migrate(getDb(), { migrationsFolder: resolve(import.meta.dir, '../../drizzle') });
});

afterEach(() => {
  resetNodeOperationsForTests();
});

const NODE_A = '11'.repeat(16);
const NODE_B = '22'.repeat(16);

describe('node-operations store', () => {
  test('writes, reads and clears a record', () => {
    const now = 1_700_000_000_000;
    writeNodeOperation(NODE_A, {
      kind: 'uninstall',
      phase: 'requested',
      startedAt: now,
      updatedAt: now,
      error: null,
    });
    expect(readNodeOperation(NODE_A, now)).toEqual({
      kind: 'uninstall',
      phase: 'requested',
      startedAt: now,
      updatedAt: now,
      error: null,
    });
    expect(getGatewayKv(`mesh.node-op.${NODE_A}`)).toBeTruthy();
    clearNodeOperation(NODE_A);
    expect(readNodeOperation(NODE_A, now)).toBeNull();
    expect(getGatewayKv(`mesh.node-op.${NODE_A}`)).toBeNull();
  });

  test('drops records whose updatedAt is older than 30 minutes', () => {
    const now = 1_700_000_000_000;
    writeNodeOperation(NODE_A, {
      kind: 'uninstall',
      phase: 'uninstalling',
      startedAt: now - NODE_OPERATION_TTL_MS - 1,
      updatedAt: now - NODE_OPERATION_TTL_MS - 1,
      error: null,
    });
    expect(readNodeOperation(NODE_A, now)).toBeNull();
    expect(getGatewayKv(`mesh.node-op.${NODE_A}`)).toBeNull();
  });

  test('updateNodeOperation advances phase and updatedAt', () => {
    const t0 = 1_700_000_000_000;
    writeNodeOperation(NODE_A, {
      kind: 'uninstall',
      phase: 'requested',
      startedAt: t0,
      updatedAt: t0,
      error: null,
    });
    const next = updateNodeOperation(NODE_A, { phase: 'uninstalling' }, t0 + 50);
    expect(next?.phase).toBe('uninstalling');
    expect(next?.startedAt).toBe(t0);
    expect(next?.updatedAt).toBe(t0 + 50);
  });

  test('lazy sweep drops records for nodes no longer listed', () => {
    const now = 1_700_000_000_000;
    writeNodeOperation(NODE_A, {
      kind: 'uninstall',
      phase: 'uninstalling',
      startedAt: now,
      updatedAt: now,
      error: null,
    });
    writeNodeOperation(NODE_B, {
      kind: 'uninstall',
      phase: 'failed',
      startedAt: now,
      updatedAt: now,
      error: 'NODE_UNREACHABLE',
    });
    sweepStaleNodeOperations(new Set([NODE_A]), now);
    expect(readNodeOperation(NODE_A, now)?.phase).toBe('uninstalling');
    expect(readNodeOperation(NODE_B, now)).toBeNull();
  });
});
