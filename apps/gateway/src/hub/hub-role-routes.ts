import type { HubRoleError, HubRoleTransition } from '@tmex/shared';
import type { HubMode } from '@tmex/shared/uplink';
import { json, readJsonObjectBody } from '../api/http';
import type { MeshHubStore } from '../auth/mesh-hub-store';
import type { AuthDb } from '../auth/types';
import { HubRoleTransitionStore, reconcileHubRoleTransition } from './hub-role-transitions';

export const HUB_ROLE_RESTART_DELAY_MS = 1_000;

const OPERATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PatchHubRoleEnv = (patch: Record<string, string>) => Promise<void>;
export type ScheduleHubRoleRestart = (delayMs: number) => void;

export type HubRoleUplink = {
  hubNodeId(): string | undefined;
  mode(): HubMode;
  writerEpoch(): number;
  isAuthorizedHub(id: string): boolean;
  applyLocalRole(mode: HubMode, writerEpoch?: number): void;
};

export type HubRoleRouteContext = {
  db: AuthDb;
  uplink: HubRoleUplink;
  meshHubs: MeshHubStore;
  now: () => number;
  patchHostEnv?: PatchHubRoleEnv | null;
  scheduleRestart?: ScheduleHubRoleRestart;
  hubRoleInstalled: boolean;
  configMode: HubMode;
  configWriterEpoch: number;
};

function errorJson(code: HubRoleError['code'], message: string, status: number): Response {
  const body: HubRoleError = { code, message };
  return json(body, status);
}

function knownMaxWriterEpoch(ctx: HubRoleRouteContext): number {
  let max = Math.max(ctx.configWriterEpoch, ctx.uplink.writerEpoch());
  for (const row of ctx.meshHubs.list()) {
    if (row.writerEpoch > max) max = row.writerEpoch;
  }
  return max;
}

export function reconcileHubRoleOnStart(ctx: HubRoleRouteContext): void {
  try {
    reconcileHubRoleTransition(
      new HubRoleTransitionStore(ctx.db),
      { mode: ctx.configMode, writerEpoch: ctx.configWriterEpoch },
      ctx.now()
    );
  } catch {
    /* 旧库尚未迁移时忽略 */
  }
}

export async function handlePostHubRole(req: Request, ctx: HubRoleRouteContext): Promise<Response> {
  if (!ctx.hubRoleInstalled) {
    return errorJson('HUB_NOT_HUB', 'TMEX_ROLES does not include hub', 409);
  }
  if (!ctx.patchHostEnv) {
    return errorJson(
      'HUB_ROLE_UNSUPPORTED',
      'host env patcher is not available in this process',
      409
    );
  }

  const body = await readJsonObjectBody(req);
  if (!body) return errorJson('INVALID_REQUEST', 'JSON object body required', 400);

  const operationId = body.operationId;
  if (typeof operationId !== 'string' || !OPERATION_ID_RE.test(operationId)) {
    return errorJson('INVALID_REQUEST', 'operationId must be a UUID', 400);
  }

  const store = new HubRoleTransitionStore(ctx.db);
  const existing = store.get(operationId);
  if (existing) return json(existing, 200);

  if (store.inFlight().length > 0) {
    return errorJson('HUB_ROLE_BUSY', 'a hub role transition is already in progress', 409);
  }

  const mode = body.mode;
  if (mode !== 'active' && mode !== 'standby') {
    return errorJson('INVALID_REQUEST', 'mode must be active or standby', 400);
  }

  const self = ctx.uplink.hubNodeId();
  if (!self) return errorJson('HUB_NOT_HUB', 'hub node id is not configured', 409);
  if (!ctx.uplink.isAuthorizedHub(self)) {
    return errorJson('HUB_NOT_AUTHORIZED', 'this hub is not authorized (retired)', 409);
  }

  let writerEpoch: number | null;
  if (mode === 'active') {
    const raw = body.writerEpoch;
    if (raw === undefined || raw === null) {
      const allocated = knownMaxWriterEpoch(ctx) + 1;
      console.info(
        `[hub] allocated writerEpoch=${allocated} (maxKnown=${allocated - 1}) for mode=active`
      );
      writerEpoch = allocated;
    } else {
      if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
        return errorJson('INVALID_REQUEST', 'writerEpoch must be a positive integer', 400);
      }
      if (raw <= knownMaxWriterEpoch(ctx)) {
        return errorJson(
          'HUB_EPOCH_STALE',
          'writerEpoch must be greater than all known hub epochs',
          409
        );
      }
      writerEpoch = raw;
    }
  } else {
    writerEpoch = ctx.uplink.writerEpoch();
  }

  const now = ctx.now();
  const accepted: HubRoleTransition = {
    operationId,
    targetHubId: self,
    mode,
    writerEpoch,
    phase: 'accepted',
    error: null,
    startedAt: now,
    updatedAt: now,
  };
  store.insert(accepted);

  try {
    store.update(operationId, { phase: 'persisting' }, ctx.now());
    const patch: Record<string, string> = { TMEX_HUB_MODE: mode };
    if (mode === 'active' && writerEpoch != null) {
      patch.TMEX_HUB_WRITER_EPOCH = String(writerEpoch);
    }
    await ctx.patchHostEnv(patch);
    if (mode === 'active' && writerEpoch != null) {
      ctx.uplink.applyLocalRole(mode, writerEpoch);
    } else {
      ctx.uplink.applyLocalRole(mode);
    }
    store.update(operationId, { phase: 'restarting' }, ctx.now());
    ctx.scheduleRestart?.(HUB_ROLE_RESTART_DELAY_MS);
    return json(store.get(operationId), 202);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    store.update(operationId, { phase: 'failed', error: message }, ctx.now());
    const failed = store.get(operationId);
    return json(failed ?? { code: 'INVALID_REQUEST', message }, 500);
  }
}

export function handleGetHubRoleStatus(req: Request, ctx: HubRoleRouteContext): Response {
  if (!ctx.hubRoleInstalled) {
    return errorJson('HUB_NOT_HUB', 'TMEX_ROLES does not include hub', 409);
  }
  const store = new HubRoleTransitionStore(ctx.db);
  const operationId = new URL(req.url).searchParams.get('operationId');
  const row = operationId ? store.get(operationId) : store.latest();
  if (!row) return json({ error: 'not_found' }, 404);
  return json(row);
}
