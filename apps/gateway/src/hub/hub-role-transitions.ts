import type { HubRoleMode, HubRoleTransition, HubRoleTransitionPhase } from '@tmex/shared';
import { desc, eq } from 'drizzle-orm';
import type { AuthDb } from '../auth/types';
import { hubRoleTransitions } from '../db/schema';

export type HubRoleTransitionRow = HubRoleTransition;

const IN_FLIGHT: ReadonlySet<HubRoleTransitionPhase> = new Set([
  'accepted',
  'persisting',
  'restarting',
]);

export function isHubRoleInFlight(phase: HubRoleTransitionPhase): boolean {
  return IN_FLIGHT.has(phase);
}

function toTransition(row: {
  operationId: string;
  targetHubId: string;
  mode: string;
  writerEpoch: number | null;
  phase: string;
  error: string | null;
  startedAt: number;
  updatedAt: number;
}): HubRoleTransition {
  return {
    operationId: row.operationId,
    targetHubId: row.targetHubId,
    mode: row.mode === 'standby' ? 'standby' : 'active',
    writerEpoch: row.writerEpoch,
    phase: row.phase as HubRoleTransitionPhase,
    error: row.error,
    startedAt: row.startedAt,
    updatedAt: row.updatedAt,
  };
}

export class HubRoleTransitionStore {
  constructor(private readonly db: AuthDb) {}

  get(operationId: string): HubRoleTransition | null {
    const row = this.db
      .select()
      .from(hubRoleTransitions)
      .where(eq(hubRoleTransitions.operationId, operationId))
      .get();
    return row ? toTransition(row) : null;
  }

  latest(): HubRoleTransition | null {
    const row = this.db
      .select()
      .from(hubRoleTransitions)
      .orderBy(desc(hubRoleTransitions.updatedAt), desc(hubRoleTransitions.startedAt))
      .limit(1)
      .get();
    return row ? toTransition(row) : null;
  }

  inFlight(): HubRoleTransition[] {
    return this.db
      .select()
      .from(hubRoleTransitions)
      .all()
      .map(toTransition)
      .filter((row) => isHubRoleInFlight(row.phase));
  }

  insert(row: HubRoleTransition): void {
    this.db
      .insert(hubRoleTransitions)
      .values({
        operationId: row.operationId,
        targetHubId: row.targetHubId,
        mode: row.mode,
        writerEpoch: row.writerEpoch,
        phase: row.phase,
        error: row.error,
        startedAt: row.startedAt,
        updatedAt: row.updatedAt,
      })
      .run();
  }

  update(
    operationId: string,
    patch: { phase: HubRoleTransitionPhase; error?: string | null },
    now: number
  ): void {
    const set: {
      phase: HubRoleTransitionPhase;
      updatedAt: number;
      error?: string | null;
    } = {
      phase: patch.phase,
      updatedAt: now,
    };
    if (patch.error !== undefined) set.error = patch.error;
    this.db
      .update(hubRoleTransitions)
      .set(set)
      .where(eq(hubRoleTransitions.operationId, operationId))
      .run();
  }
}

export function envMatchesRoleTransition(
  row: HubRoleTransition,
  env: { mode: HubRoleMode; writerEpoch: number }
): boolean {
  if (row.mode !== env.mode) return false;
  if (row.mode === 'active' && row.writerEpoch != null) return row.writerEpoch === env.writerEpoch;
  return true;
}

export function reconcileHubRoleTransition(
  store: HubRoleTransitionStore,
  env: { mode: HubRoleMode; writerEpoch: number },
  now: number
): HubRoleTransition | null {
  const latest = store.latest();
  if (!latest || !isHubRoleInFlight(latest.phase)) return latest;
  if (envMatchesRoleTransition(latest, env)) {
    store.update(latest.operationId, { phase: 'complete', error: null }, now);
  } else {
    const reason =
      latest.phase === 'restarting'
        ? `env mismatch: mode=${env.mode} epoch=${env.writerEpoch}`
        : `interrupted at ${latest.phase}`;
    store.update(latest.operationId, { phase: 'failed', error: reason }, now);
  }
  return store.get(latest.operationId);
}
