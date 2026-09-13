import { describe, expect, test } from 'bun:test';
import type { MeshHubsResponse, MeshNode } from '@vibeterm/api-client/auth/types';
import { NODE, meshNode } from '../commands/cli-test-harness';
import { UsageError } from './errors';
import { pickSuccessorHub, planHubRole } from './nodes-hub-role';

const SPARE = 'b'.repeat(32);

function hub(
  id: string,
  extra: Partial<MeshHubsResponse['hubs'][number]> = {}
): MeshHubsResponse['hubs'][number] {
  return {
    nodeId: id,
    publicUrl: `https://${id.slice(0, 8)}.example`,
    mode: extra.mode ?? 'standby',
    priority: extra.priority ?? 1,
    writerEpoch: extra.writerEpoch ?? 0,
    online: extra.online ?? true,
    authorization: extra.authorization ?? 'signed',
    ...extra,
  };
}

function hubsOf(rows: MeshHubsResponse['hubs'], writerHubId: string | null): MeshHubsResponse {
  return { hubs: rows, attached: null, writerHubId, candidates: [] };
}

function row(partial: Record<string, unknown> = {}): MeshNode {
  return meshNode(partial) as MeshNode;
}

describe('planHubRole', () => {
  test('promote of a signed standby targets that hub and demotes the writer', () => {
    const plan = planHubRole({
      verb: 'promote',
      node: row({ id: SPARE, name: 'spare', isHub: true }),
      hubs: hubsOf([hub(NODE, { mode: 'active', priority: 0, writerEpoch: 2 }), hub(SPARE)], NODE),
    });
    expect(plan.target?.nodeId).toBe(SPARE);
    expect(plan.from?.nodeId).toBe(NODE);
    expect(plan.needsAdmit).toBe(false);
    expect(plan.leavesNoWriter).toBe(false);
  });

  test('promote of an env-authorized hub needs admit-hub', () => {
    const plan = planHubRole({
      verb: 'promote',
      node: row({ id: SPARE, name: 'spare', isHub: true }),
      hubs: hubsOf(
        [
          hub(NODE, { mode: 'active', priority: 0, writerEpoch: 2 }),
          hub(SPARE, { authorization: 'env' }),
        ],
        NODE
      ),
    });
    expect(plan.needsAdmit).toBe(true);
  });

  test('demote of the writer picks a signed successor', () => {
    const plan = planHubRole({
      verb: 'demote',
      node: row({ isHub: true, hubMode: 'active' }),
      hubs: hubsOf(
        [hub(NODE, { mode: 'active', priority: 0, writerEpoch: 2 }), hub(SPARE, { priority: 3 })],
        NODE
      ),
    });
    expect(plan.target?.nodeId).toBe(SPARE);
    expect(plan.leavesNoWriter).toBe(false);
  });

  test('demote with no successor leaves no writer', () => {
    const plan = planHubRole({
      verb: 'demote',
      node: row({ isHub: true }),
      hubs: hubsOf([hub(NODE, { mode: 'active', priority: 0, writerEpoch: 1 })], NODE),
    });
    expect(plan.target).toBeNull();
    expect(plan.leavesNoWriter).toBe(true);
  });

  test('promote of the current writer is a usage error', () => {
    expect(() =>
      planHubRole({
        verb: 'promote',
        node: row({ isHub: true }),
        hubs: hubsOf([hub(NODE, { mode: 'active' })], NODE),
      })
    ).toThrow(UsageError);
  });
});

describe('pickSuccessorHub', () => {
  test('prefers signed authorization then lower priority', () => {
    const env = hub('c'.repeat(32), { authorization: 'env', priority: 0 });
    const signed = hub(SPARE, { authorization: 'signed', priority: 5 });
    expect(pickSuccessorHub([env, signed, hub(NODE)], NODE)?.nodeId).toBe(SPARE);
  });
});
