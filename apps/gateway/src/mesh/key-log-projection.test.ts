// 吊销记录提交后必须就地断链：key log 同步（含中继模式补日志）走的也是这条投影，
// 光靠「节点事件」是等不到的。

import { describe, expect, test } from 'bun:test';
import type { KeyLogRecord } from '@vibeterm/shared/auth';
import {
  encodeRenameNodePayload,
  encodeRevokeNodePayload,
  hexToBytes,
} from '@vibeterm/shared/auth';
import type { AppliedKeyLogStep } from '../auth/user-key-persistence';
import { type KeyLogProjectionDeps, bindKeyLogProjection } from './key-log-projection';

const SELF = 'a'.repeat(32);
const PEER = 'b'.repeat(32);

function step(type: KeyLogRecord['type'], payload: Uint8Array): AppliedKeyLogStep {
  return {
    input: { bytes: new Uint8Array(), sig: new Uint8Array() },
    record: {
      seq: 1n,
      prev_hash: new Uint8Array(32),
      root_epoch: 1,
      uid: 'u1',
      type,
      payload,
      signer: 'root',
      credential_id: null,
    } as unknown as KeyLogRecord,
    hash: new Uint8Array(32),
    next: {} as AppliedKeyLogStep['next'],
    effects: [],
  };
}

function deps(revoked: string[]): KeyLogProjectionDeps {
  return {
    hubStore: {
      remove: () => {},
      upsert: () => {},
      get: () => null,
      list: () => [],
    } as unknown as KeyLogProjectionDeps['hubStore'],
    hub: null,
    relay: { notifyIfRelayRecord: () => {} } as unknown as KeyLogProjectionDeps['relay'],
    selfId: SELF,
    userStore: {} as KeyLogProjectionDeps['userStore'],
    state: {} as KeyLogProjectionDeps['state'],
    peerHolder: {} as KeyLogProjectionDeps['peerHolder'],
    emitListNodeEvent: () => {},
    userIdOf: () => 'u1',
    onNodeRevoked: (nodeId) => revoked.push(nodeId),
  };
}

describe('key log 投影：吊销', () => {
  test('revoke-node 落库后触发断链', () => {
    const revoked: string[] = [];
    const apply = bindKeyLogProjection(deps(revoked));
    apply(
      'u1',
      step('revoke-node', encodeRevokeNodePayload({ node_id: hexToBytes(PEER), reason: 'test' }))
    );
    expect(revoked).toEqual([PEER]);
  });

  test('吊销的是自己不触发断链；别的记录类型也不触发', () => {
    const revoked: string[] = [];
    const apply = bindKeyLogProjection(deps(revoked));
    apply(
      'u1',
      step('revoke-node', encodeRevokeNodePayload({ node_id: hexToBytes(SELF), reason: 'test' }))
    );
    apply(
      'u1',
      step('rename-node', encodeRenameNodePayload({ node_id: hexToBytes(PEER), name: 'x' }))
    );
    expect(revoked).toEqual([]);
  });
});
