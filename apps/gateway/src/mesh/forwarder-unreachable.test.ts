import { describe, expect, test } from 'bun:test';
import type { NodeUnreachableReason } from '@tmex/shared';
import { LinkError } from '@tmex/shared/link';
import {
  classifyUnreachableReason,
  nodeUnreachableResponse,
  safeUnreachableReason,
} from './forwarder-unreachable';
import { NodeUnreachableError, PeerHandshakeError } from './types';

const OTHER = 'bb'.repeat(16);

const REASON_CASES: Array<{ err: unknown; reason: NodeUnreachableReason }> = [
  { err: new NodeUnreachableError(OTHER, 'not admitted'), reason: 'not_admitted' },
  { err: new NodeUnreachableError(OTHER, 'revoked'), reason: 'not_admitted' },
  {
    err: new PeerHandshakeError('unknown', `no node_certs for ${OTHER}`),
    reason: 'handshake_failed',
  },
  { err: new PeerHandshakeError('timeout', 'handshake timeout'), reason: 'timeout' },
  { err: new LinkError('rst', 'quota-streams'), reason: 'relay_reset:quota-streams' },
  { err: new LinkError('rst', 'self-target'), reason: 'relay_reset:self-target' },
  { err: new LinkError('rst', 'unknown-target'), reason: 'relay_reset:unknown-target' },
  { err: new LinkError('rst', 'offline'), reason: 'relay_reset:offline' },
  { err: new LinkError('rst', 'open-failed'), reason: 'relay_reset:open-failed' },
  { err: new DOMException('The operation was aborted.', 'AbortError'), reason: 'timeout' },
  { err: new Error('https://evil.example/token=secret'), reason: 'no_link' },
];

describe('safeUnreachableReason', () => {
  test('按错误类别映射，不泄漏原文', () => {
    for (const { err, reason } of REASON_CASES) {
      expect(safeUnreachableReason(err)).toBe(reason);
    }
  });

  test('TimeoutError / handshake-timeout token / 未知输入', () => {
    expect(safeUnreachableReason(new DOMException('timed out', 'TimeoutError'))).toBe('timeout');
    expect(safeUnreachableReason(new Error('connect-timeout'))).toBe('timeout');
    expect(safeUnreachableReason(new Error('handshake-timeout'))).toBe('timeout');
    expect(safeUnreachableReason(new Error('handshake-failed'))).toBe('handshake_failed');
    expect(safeUnreachableReason(new Error('not_admitted'))).toBe('not_admitted');
    expect(safeUnreachableReason('not an error')).toBe('no_link');
    expect(safeUnreachableReason(undefined)).toBe('no_link');
  });
});

describe('classifyUnreachableReason', () => {
  test('abort 优先于 lastError，一律 timeout', () => {
    expect(classifyUnreachableReason(true, new Error('link lost'))).toBe('timeout');
    expect(classifyUnreachableReason(true, undefined)).toBe('timeout');
  });

  test('未 abort 时走 lastError，否则 no_link', () => {
    expect(classifyUnreachableReason(false, new NodeUnreachableError(OTHER, 'revoked'))).toBe(
      'not_admitted'
    );
    expect(classifyUnreachableReason(false, undefined)).toBe('no_link');
  });
});

describe('nodeUnreachableResponse', () => {
  test('503 NODE_UNREACHABLE，reason 由 classify 决定', async () => {
    const res = nodeUnreachableResponse(OTHER, true, new Error('link lost'));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      code: 'NODE_UNREACHABLE',
      nodeId: OTHER,
      reason: 'timeout',
    });
  });

  test('可附带 extra 字段', async () => {
    const res = nodeUnreachableResponse(OTHER, false, new Error('boom'), { error: 'boom' });
    expect(await res.json()).toEqual({
      code: 'NODE_UNREACHABLE',
      nodeId: OTHER,
      reason: 'no_link',
      error: 'boom',
    });
  });
});
