import { describe, expect, test } from 'bun:test';
import type { HubRoleTransition } from '@tmex/shared';
import { MeshHubStore } from '../auth/mesh-hub-store';
import { createMigratedAuthDb } from '../auth/test-db';
import { HUB_ROLE_RESTART_DELAY_MS } from './hub-role-routes';
import { HubRoleTransitionStore } from './hub-role-transitions';
import { HubRuntime } from './hub-runtime';
import { createHubTestStack, seedAdmittedNode, seedUser } from './hub-test-helpers';

const dummyServer = { upgrade: () => true };
const OP_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OP_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PEER = 'cc'.repeat(16);

function jsonRequest(
  url: string,
  method: string,
  body?: unknown,
  headers?: Record<string, string>
): Request {
  return new Request(url, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function openRoleHub(opts?: {
  authenticate?: boolean;
  hubRoleInstalled?: boolean;
  patchHostEnv?: ((patch: Record<string, string>) => Promise<void>) | null;
  scheduleRestart?: (delayMs: number) => void;
  mode?: 'active' | 'standby';
  writerEpoch?: number;
  extraHubs?: Array<{ hubNodeId: string; mode: 'active' | 'standby'; writerEpoch: number }>;
  retireSelf?: boolean;
  now?: () => number;
}) {
  const { db, sqlite, close } = createMigratedAuthDb();
  const { userStore, keyLogSource } = createHubTestStack(db);
  const user = seedUser(userStore, { now: 1_000 });
  const entry = seedAdmittedNode(userStore, user.id, { name: 'hub-self', now: 1_000 });
  const env: Record<string, string> = {
    TMEX_HUB_MODE: opts?.mode ?? 'active',
    TMEX_HUB_WRITER_EPOCH: String(opts?.writerEpoch ?? 1),
  };
  const restarts: number[] = [];
  const meshHubs = new MeshHubStore(db);
  if (opts?.extraHubs) {
    for (const row of opts.extraHubs) {
      meshHubs.upsert(
        {
          hubNodeId: row.hubNodeId,
          publicUrl: `https://${row.hubNodeId.slice(0, 8)}.example`,
          name: row.hubNodeId.slice(0, 8),
          mode: row.mode,
          priority: 100,
          writerEpoch: row.writerEpoch,
          caFingerprint: null,
          online: true,
          lastSeenAt: 1,
        },
        1
      );
    }
  }
  if (opts?.retireSelf) {
    userStore.upsertHubAuthorization({
      userId: user.id,
      hubNodeId: entry.nodeId,
      status: 'retired',
      admitSeq: 1,
      retireSeq: 2,
      updatedSeq: 2,
    });
  }
  const patchHostEnv =
    opts?.patchHostEnv === undefined
      ? async (patch: Record<string, string>) => {
          Object.assign(env, patch);
        }
      : opts.patchHostEnv;
  const hub = new HubRuntime({
    db,
    userStore,
    keyLogSource,
    meshHubs,
    config: {
      publicUrl: 'https://hub.example',
      stun: [],
      nodeId: entry.nodeId,
      hubNodeId: entry.nodeId,
      mode: opts?.mode ?? 'active',
      writerEpoch: opts?.writerEpoch ?? 1,
    },
    authenticate:
      opts?.authenticate === false
        ? () => null
        : () => ({ userId: user.id, entryNodeId: entry.nodeId, sid: 'sid-1' }),
    now: opts?.now ?? (() => 1_700_000_000_000),
    hubRoleInstalled: opts?.hubRoleInstalled,
    patchHostEnv,
    scheduleRestart:
      opts?.scheduleRestart ??
      ((delayMs) => {
        restarts.push(delayMs);
      }),
  });
  return { db, sqlite, close, hub, user, entry, env, restarts, meshHubs };
}

async function postRole(
  hub: HubRuntime,
  body: unknown
): Promise<{ status: number; json: unknown }> {
  const res = await hub.handleRequest(
    jsonRequest('http://hub/api/hub/role', 'POST', body),
    dummyServer
  );
  return { status: res?.status ?? 0, json: res ? await res.json() : null };
}

async function getStatus(
  hub: HubRuntime,
  operationId?: string
): Promise<{ status: number; json: unknown }> {
  const url =
    operationId === undefined
      ? 'http://hub/api/hub/role/status'
      : `http://hub/api/hub/role/status?operationId=${operationId}`;
  const res = await hub.handleRequest(new Request(url), dummyServer);
  return { status: res?.status ?? 0, json: res ? await res.json() : null };
}

describe('hub_role_transitions migration', () => {
  test('createMigratedAuthDb 含 hub_role_transitions 表', () => {
    const { sqlite, close } = createMigratedAuthDb();
    try {
      const row = sqlite
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get('hub_role_transitions') as { name: string } | null;
      expect(row?.name).toBe('hub_role_transitions');
    } finally {
      close();
    }
  });
});

describe('POST /api/hub/role', () => {
  test('未鉴权返回 401', async () => {
    const { hub, close } = await openRoleHub({ authenticate: false });
    try {
      const res = await postRole(hub, { mode: 'standby', operationId: OP_A });
      expect(res.status).toBe(401);
    } finally {
      await hub.stop();
      close();
    }
  });

  test('非 hub 安装返回 409 HUB_NOT_HUB', async () => {
    const { hub, close } = await openRoleHub({ hubRoleInstalled: false });
    try {
      const res = await postRole(hub, { mode: 'standby', operationId: OP_A });
      expect(res.status).toBe(409);
      expect(res.json).toMatchObject({ code: 'HUB_NOT_HUB' });
    } finally {
      await hub.stop();
      close();
    }
  });

  test('无 patchHostEnv 返回 409 HUB_ROLE_UNSUPPORTED', async () => {
    const { hub, close } = await openRoleHub({ patchHostEnv: null });
    try {
      const res = await postRole(hub, { mode: 'standby', operationId: OP_A });
      expect(res.status).toBe(409);
      expect(res.json).toMatchObject({ code: 'HUB_ROLE_UNSUPPORTED' });
    } finally {
      await hub.stop();
      close();
    }
  });

  test('operationId 非法返回 400 INVALID_REQUEST', async () => {
    const { hub, close } = await openRoleHub();
    try {
      for (const operationId of ['', 'not-a-uuid', 1, undefined]) {
        const res = await postRole(hub, { mode: 'standby', operationId });
        expect(res.status).toBe(400);
        expect(res.json).toMatchObject({ code: 'INVALID_REQUEST' });
      }
    } finally {
      await hub.stop();
      close();
    }
  });

  test('mode 非法或 active 缺 epoch 返回 400', async () => {
    const { hub, close } = await openRoleHub();
    try {
      expect((await postRole(hub, { mode: 'primary', operationId: OP_A })).status).toBe(400);
      const missing = await postRole(hub, { mode: 'active', operationId: OP_A });
      expect(missing.status).toBe(400);
      expect(missing.json).toMatchObject({ code: 'INVALID_REQUEST' });
      const frac = await postRole(hub, { mode: 'active', writerEpoch: 1.5, operationId: OP_A });
      expect(frac.status).toBe(400);
    } finally {
      await hub.stop();
      close();
    }
  });

  test('self 被 retire-hub 返回 409 HUB_NOT_AUTHORIZED', async () => {
    const { hub, close } = await openRoleHub({ retireSelf: true });
    try {
      const res = await postRole(hub, { mode: 'standby', operationId: OP_A });
      expect(res.status).toBe(409);
      expect(res.json).toMatchObject({ code: 'HUB_NOT_AUTHORIZED' });
    } finally {
      await hub.stop();
      close();
    }
  });

  test('active 的 writerEpoch 不大于已知最大值返回 409 HUB_EPOCH_STALE', async () => {
    const { hub, close } = await openRoleHub({
      writerEpoch: 3,
      extraHubs: [{ hubNodeId: PEER, mode: 'active', writerEpoch: 7 }],
    });
    try {
      const staleEnv = await postRole(hub, { mode: 'active', writerEpoch: 3, operationId: OP_A });
      expect(staleEnv.status).toBe(409);
      expect(staleEnv.json).toMatchObject({ code: 'HUB_EPOCH_STALE' });
      const stalePeer = await postRole(hub, { mode: 'active', writerEpoch: 7, operationId: OP_B });
      expect(stalePeer.status).toBe(409);
      expect(stalePeer.json).toMatchObject({ code: 'HUB_EPOCH_STALE' });
    } finally {
      await hub.stop();
      close();
    }
  });

  test('demote 写 env、更新 mesh_hubs、立刻 standby，并安排 1s 后重启', async () => {
    const { hub, close, env, restarts, meshHubs, entry } = await openRoleHub({ writerEpoch: 4 });
    try {
      const res = await postRole(hub, { mode: 'standby', operationId: OP_A });
      expect(res.status).toBe(202);
      const body = res.json as HubRoleTransition;
      expect(body).toMatchObject({
        operationId: OP_A,
        targetHubId: entry.nodeId,
        mode: 'standby',
        writerEpoch: 4,
        phase: 'restarting',
        error: null,
      });
      expect(typeof body.startedAt).toBe('number');
      expect(typeof body.updatedAt).toBe('number');
      expect(env.TMEX_HUB_MODE).toBe('standby');
      expect(env.TMEX_HUB_WRITER_EPOCH).toBe('4');
      expect(hub.mode()).toBe('standby');
      expect(hub.writerEpoch()).toBe(4);
      expect(meshHubs.get(entry.nodeId)?.mode).toBe('standby');
      expect(restarts).toEqual([HUB_ROLE_RESTART_DELAY_MS]);
    } finally {
      await hub.stop();
      close();
    }
  });

  test('promote 校验 epoch、写 TMEX_HUB_WRITER_EPOCH 并立刻提升内存 epoch', async () => {
    const { hub, close, env, restarts, meshHubs, entry } = await openRoleHub({
      mode: 'standby',
      writerEpoch: 2,
      extraHubs: [{ hubNodeId: PEER, mode: 'active', writerEpoch: 5 }],
    });
    try {
      const res = await postRole(hub, { mode: 'active', writerEpoch: 6, operationId: OP_A });
      expect(res.status).toBe(202);
      expect(res.json).toMatchObject({
        operationId: OP_A,
        mode: 'active',
        writerEpoch: 6,
        phase: 'restarting',
      });
      expect(env.TMEX_HUB_MODE).toBe('active');
      expect(env.TMEX_HUB_WRITER_EPOCH).toBe('6');
      expect(hub.mode()).toBe('active');
      expect(hub.writerEpoch()).toBe(6);
      expect(meshHubs.get(entry.nodeId)).toMatchObject({ mode: 'active', writerEpoch: 6 });
      expect(restarts).toEqual([HUB_ROLE_RESTART_DELAY_MS]);
    } finally {
      await hub.stop();
      close();
    }
  });

  test('同一 operationId 幂等返回既有记录 200', async () => {
    const { hub, close } = await openRoleHub();
    try {
      const first = await postRole(hub, { mode: 'standby', operationId: OP_A });
      expect(first.status).toBe(202);
      const second = await postRole(hub, { mode: 'standby', operationId: OP_A });
      expect(second.status).toBe(200);
      expect(second.json).toEqual(first.json);
    } finally {
      await hub.stop();
      close();
    }
  });

  test('已有 in-flight 过渡时另一 operationId 返回 409 HUB_ROLE_BUSY', async () => {
    const { hub, close } = await openRoleHub();
    try {
      expect((await postRole(hub, { mode: 'standby', operationId: OP_A })).status).toBe(202);
      const busy = await postRole(hub, { mode: 'standby', operationId: OP_B });
      expect(busy.status).toBe(409);
      expect(busy.json).toMatchObject({ code: 'HUB_ROLE_BUSY' });
    } finally {
      await hub.stop();
      close();
    }
  });
});

describe('GET /api/hub/role/status', () => {
  test('按 operationId 回读；无 id 返回最新；缺失 404', async () => {
    const { hub, close } = await openRoleHub();
    try {
      expect((await getStatus(hub)).status).toBe(404);
      expect((await getStatus(hub, OP_A)).status).toBe(404);
      const posted = await postRole(hub, { mode: 'standby', operationId: OP_A });
      expect(posted.status).toBe(202);
      const byId = await getStatus(hub, OP_A);
      expect(byId.status).toBe(200);
      expect(byId.json).toEqual(posted.json);
      const latest = await getStatus(hub);
      expect(latest.status).toBe(200);
      expect(latest.json).toEqual(posted.json);
    } finally {
      await hub.stop();
      close();
    }
  });

  test('无 patchHostEnv 仍可回读状态', async () => {
    const { hub, close, db, entry } = await openRoleHub({ patchHostEnv: null });
    try {
      const store = new HubRoleTransitionStore(db);
      store.insert({
        operationId: OP_A,
        targetHubId: entry.nodeId,
        mode: 'standby',
        writerEpoch: 1,
        phase: 'restarting',
        error: null,
        startedAt: 10,
        updatedAt: 10,
      });
      const res = await getStatus(hub, OP_A);
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({ operationId: OP_A, phase: 'restarting' });
    } finally {
      await hub.stop();
      close();
    }
  });
});

describe('hub role transition startup reconcile', () => {
  test('restarting 且 env 匹配则标 complete', async () => {
    const { db, close: closeDb } = createMigratedAuthDb();
    const { userStore, keyLogSource } = createHubTestStack(db);
    const user = seedUser(userStore, { now: 1 });
    const entry = seedAdmittedNode(userStore, user.id, { name: 'self', now: 1 });
    const store = new HubRoleTransitionStore(db);
    store.insert({
      operationId: OP_A,
      targetHubId: entry.nodeId,
      mode: 'standby',
      writerEpoch: 2,
      phase: 'restarting',
      error: null,
      startedAt: 1,
      updatedAt: 1,
    });
    const hub = new HubRuntime({
      db,
      userStore,
      keyLogSource,
      config: {
        publicUrl: 'https://hub.example',
        stun: [],
        nodeId: entry.nodeId,
        hubNodeId: entry.nodeId,
        mode: 'standby',
        writerEpoch: 2,
      },
      authenticate: () => ({ userId: user.id, entryNodeId: entry.nodeId, sid: 's' }),
      now: () => 99,
      patchHostEnv: async () => {},
      scheduleRestart: () => {},
    });
    try {
      const res = await getStatus(hub, OP_A);
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({ phase: 'complete', error: null, updatedAt: 99 });
    } finally {
      await hub.stop();
      closeDb();
    }
  });

  test('restarting 但 env 不匹配则标 failed', async () => {
    const { db, close: closeDb } = createMigratedAuthDb();
    const { userStore, keyLogSource } = createHubTestStack(db);
    const user = seedUser(userStore, { now: 1 });
    const entry = seedAdmittedNode(userStore, user.id, { name: 'self', now: 1 });
    const store = new HubRoleTransitionStore(db);
    store.insert({
      operationId: OP_A,
      targetHubId: entry.nodeId,
      mode: 'active',
      writerEpoch: 9,
      phase: 'restarting',
      error: null,
      startedAt: 1,
      updatedAt: 1,
    });
    const hub = new HubRuntime({
      db,
      userStore,
      keyLogSource,
      config: {
        publicUrl: 'https://hub.example',
        stun: [],
        nodeId: entry.nodeId,
        hubNodeId: entry.nodeId,
        mode: 'standby',
        writerEpoch: 1,
      },
      authenticate: () => ({ userId: user.id, entryNodeId: entry.nodeId, sid: 's' }),
      now: () => 50,
      patchHostEnv: async () => {},
      scheduleRestart: () => {},
    });
    try {
      const res = await getStatus(hub, OP_A);
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({ phase: 'failed' });
      expect((res.json as HubRoleTransition).error).toBeTruthy();
    } finally {
      await hub.stop();
      closeDb();
    }
  });
});
