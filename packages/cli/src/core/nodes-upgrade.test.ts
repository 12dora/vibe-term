import { describe, expect, test } from 'bun:test';
import type { MeshNode } from '@vibeterm/api-client/auth/types';
import { NODE, meshNode } from '../commands/cli-test-harness';
import { isBatchEligible, orderUpgradeGroups, upgradeExitCode } from './nodes-upgrade';

function row(partial: Record<string, unknown> = {}): MeshNode {
  return meshNode(partial) as MeshNode;
}

describe('nodes-upgrade batch policy', () => {
  test('isBatchEligible matches GUI: online, logged in, version < latest', () => {
    const latest = '2.0.9';
    expect(isBatchEligible(row({ version: '2.0.8' }), latest, NODE)).toBe(true);
    expect(isBatchEligible(row({ version: '2.0.9' }), latest, NODE)).toBe(false);
    expect(isBatchEligible(row({ online: false, version: '2.0.8' }), latest, NODE)).toBe(false);
    expect(
      isBatchEligible(row({ id: 'b'.repeat(32), loggedIn: false, version: '2.0.8' }), latest, NODE)
    ).toBe(false);
    expect(isBatchEligible(row({ loggedIn: false, version: '2.0.8' }), latest, NODE)).toBe(true);
    expect(isBatchEligible(row({ version: '1.0.9' }), latest, NODE)).toBe(false);
    expect(isBatchEligible(row({ version: '2.0.8' }), null, NODE)).toBe(false);
  });

  test('orderUpgradeGroups is others → hub → self', () => {
    const self = row({ id: NODE, name: 'self' });
    const hub = row({ id: 'c'.repeat(32), name: 'hub', isHub: true });
    const other = row({ id: 'b'.repeat(32), name: 'peer' });
    const groups = orderUpgradeGroups([self, hub, other], NODE);
    expect(groups.map((group) => group.map((row) => row.name))).toEqual([
      ['peer'],
      ['hub'],
      ['self'],
    ]);
  });

  test('upgradeExitCode is 1 for failed/timeout/unconfirmed', () => {
    expect(upgradeExitCode([{ node: NODE, name: 'n', outcome: 'done' }])).toBe(0);
    expect(upgradeExitCode([{ node: NODE, name: 'n', outcome: 'alreadyLatest' }])).toBe(0);
    expect(upgradeExitCode([{ node: NODE, name: 'n', outcome: 'unconfirmed' }])).toBe(1);
    expect(upgradeExitCode([{ node: NODE, name: 'n', outcome: 'timeout' }])).toBe(1);
    expect(upgradeExitCode([{ node: NODE, name: 'n', outcome: 'failed' }])).toBe(1);
  });
});
