import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { getDb } from '../../db/client';
import { runMigrations } from '../../db/migrate';
import { agentPaneGrants } from '../../db/schema';
import {
  PANE_GRANT_MAX_LIFETIME_MS,
  PANE_GRANT_TTL_MS,
  deletePaneGrant,
  deletePaneGrantsForNode,
  getPaneGrant,
  issuePaneGrant,
  listPaneGrantsForNode,
  sweepPaneGrants,
  verifyPaneGrant,
} from './store';

const NODE_X = 'a'.repeat(32);
const NODE_Z = 'c'.repeat(32);
const DEVICE = 'dev-grant';
const PANE = '%7';

beforeAll(() => {
  runMigrations();
});

beforeEach(() => {
  getDb().delete(agentPaneGrants).run();
});

function issue(
  now: number,
  overrides: { fromNodeId?: string; deviceId?: string; paneId?: string } = {}
) {
  return issuePaneGrant({
    fromNodeId: overrides.fromNodeId ?? NODE_X,
    deviceId: overrides.deviceId ?? DEVICE,
    paneId: overrides.paneId ?? PANE,
    now,
  });
}

function verify(
  grant: { grantId: string; token: string },
  now: number,
  overrides: { peerNodeId?: string; deviceId?: string; paneId?: string; token?: string } = {}
) {
  return verifyPaneGrant({
    grantId: grant.grantId,
    token: overrides.token ?? grant.token,
    peerNodeId: overrides.peerNodeId ?? NODE_X,
    deviceId: overrides.deviceId ?? DEVICE,
    paneId: overrides.paneId ?? PANE,
    now,
  });
}

describe('pane grant store', () => {
  test('签发只回明文 token，库里存哈希', () => {
    const now = 1_000_000;
    const issued = issue(now);
    expect(issued.token).toHaveLength(64);
    expect(issued.expiresAt).toBe(now + PANE_GRANT_TTL_MS);
    const row = getDb().select().from(agentPaneGrants).get();
    expect(row?.tokenHash).not.toBe(issued.token);
    expect(getPaneGrant(issued.grantId)).toMatchObject({
      fromNodeId: NODE_X,
      deviceId: DEVICE,
      paneId: PANE,
    });
  });

  test('校验通过并滑动续期，硬上限 30 天封顶', () => {
    const created = 1_000_000;
    const issued = issue(created);

    const later = created + 3 * 24 * 60 * 60 * 1000;
    const first = verify(issued, later);
    expect(first.ok).toBe(true);
    expect(getPaneGrant(issued.grantId)?.expiresAt).toBe(later + PANE_GRANT_TTL_MS);
    expect(getPaneGrant(issued.grantId)?.lastUsedAt).toBe(later);

    // 每 6 天用一次、一直续到第 27 天：续期被 30 天硬上限截断
    const day = 24 * 60 * 60 * 1000;
    for (let elapsed = 9 * day; elapsed <= 27 * day; elapsed += 6 * day) {
      expect(verify(issued, created + elapsed).ok).toBe(true);
    }
    expect(getPaneGrant(issued.grantId)?.expiresAt).toBe(created + PANE_GRANT_MAX_LIFETIME_MS);
  });

  test('过期即拒并清掉记录', () => {
    const created = 1_000_000;
    const issued = issue(created);
    const result = verify(issued, created + PANE_GRANT_TTL_MS + 1);
    expect(result).toEqual({ ok: false, code: 'PANE_GRANT_INVALID' });
    expect(getPaneGrant(issued.grantId)).toBeNull();
  });

  test('token / 源节点 / 设备 / 窗格任一不符都被拒', () => {
    const now = 1_000_000;
    const issued = issue(now);
    expect(verify(issued, now, { token: 'f'.repeat(64) }).ok).toBe(false);
    expect(verify(issued, now, { peerNodeId: NODE_Z }).ok).toBe(false);
    expect(verify(issued, now, { deviceId: 'other-device' }).ok).toBe(false);
    expect(verify(issued, now, { paneId: '%9' }).ok).toBe(false);
    expect(verify(issued, now).ok).toBe(true);
  });

  test('未知 grantId → 无效', () => {
    expect(
      verifyPaneGrant({
        grantId: 'missing',
        token: 'x',
        peerNodeId: NODE_X,
        deviceId: DEVICE,
        paneId: PANE,
      })
    ).toEqual({ ok: false, code: 'PANE_GRANT_INVALID' });
  });

  test('吊销单张 / 按节点清空', () => {
    const now = 1_000_000;
    const one = issue(now);
    const two = issue(now, { paneId: '%8' });
    const other = issue(now, { fromNodeId: NODE_Z });

    expect(deletePaneGrant(one.grantId)).toBe(true);
    expect(deletePaneGrant(one.grantId)).toBe(false);
    expect(listPaneGrantsForNode(NODE_X).map((g) => g.id)).toEqual([two.grantId]);

    deletePaneGrantsForNode(NODE_X);
    expect(listPaneGrantsForNode(NODE_X)).toEqual([]);
    expect(getPaneGrant(other.grantId)).not.toBeNull();
  });

  test('清扫只删过期的', () => {
    const now = 1_000_000;
    const stale = issue(now);
    const fresh = issue(now + PANE_GRANT_TTL_MS, { paneId: '%8' });
    sweepPaneGrants(now + PANE_GRANT_TTL_MS + 1);
    expect(getPaneGrant(stale.grantId)).toBeNull();
    expect(getPaneGrant(fresh.grantId)).not.toBeNull();
  });
});
