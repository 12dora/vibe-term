import { desc, eq } from 'drizzle-orm';
import { getDb as getOrmDb } from './client';
import {
  type WatchFireMode,
  type WatchNoMatchBehavior,
  type WatchTriggerType,
  watchRuleState,
  watchRules,
} from './schema';

export type WatchRuleRecord = typeof watchRules.$inferSelect;
export type WatchRuleStateRecord = typeof watchRuleState.$inferSelect;

export type { WatchFireMode, WatchNoMatchBehavior, WatchTriggerType } from './schema';

export interface CreateWatchRuleInput {
  name: string;
  deviceId: string;
  paneId: string;
  enabled?: boolean;
  triggerType: WatchTriggerType;
  pattern?: string | null;
  patternFlags?: string;
  extractGroup?: number;
  conditionPrompt?: string | null;
  providerId?: string | null;
  modelId?: string | null;
  confirmWithLlm?: boolean;
  summarizeWithLlm?: boolean;
  intervalSeconds?: number;
  unchangedMinutes?: number | null;
  noMatchBehavior?: WatchNoMatchBehavior;
  fireMode?: WatchFireMode;
  cooldownSeconds?: number;
}

const WATCH_RULE_CREATE_DEFAULTS = {
  enabled: true,
  pattern: null,
  patternFlags: '',
  extractGroup: 0,
  conditionPrompt: null,
  providerId: null,
  modelId: null,
  confirmWithLlm: false,
  summarizeWithLlm: false,
  intervalSeconds: 30,
  unchangedMinutes: null,
  noMatchBehavior: 'reset',
  fireMode: 'once',
  cooldownSeconds: 600,
} as const;

type WatchRuleDefaultKey = keyof typeof WATCH_RULE_CREATE_DEFAULTS;

export type WatchRuleCreateDefaults = {
  name: string;
  deviceId: string;
  paneId: string;
  triggerType: WatchTriggerType;
} & {
  [K in WatchRuleDefaultKey]: Exclude<CreateWatchRuleInput[K], undefined>;
};

export function applyWatchRuleCreateDefaults(input: CreateWatchRuleInput): WatchRuleCreateDefaults {
  const optional = { ...WATCH_RULE_CREATE_DEFAULTS } as Pick<
    WatchRuleCreateDefaults,
    WatchRuleDefaultKey
  >;
  for (const key of Object.keys(WATCH_RULE_CREATE_DEFAULTS) as WatchRuleDefaultKey[]) {
    const value = input[key];
    if (value !== undefined) {
      (optional as Record<string, unknown>)[key] = value;
    }
  }
  return {
    name: input.name,
    deviceId: input.deviceId,
    paneId: input.paneId,
    triggerType: input.triggerType,
    ...optional,
  };
}

export function createWatchRule(input: CreateWatchRuleInput): WatchRuleRecord {
  const orm = getOrmDb();
  const now = new Date().toISOString();
  const row: typeof watchRules.$inferInsert = {
    id: crypto.randomUUID(),
    ...applyWatchRuleCreateDefaults(input),
    createdAt: now,
    updatedAt: now,
  };

  orm.insert(watchRules).values(row).run();
  const created = getWatchRuleById(row.id);
  if (!created) {
    throw new Error('failed to create watch rule');
  }
  return created;
}

export function getWatchRuleById(id: string): WatchRuleRecord | null {
  const orm = getOrmDb();
  return orm.select().from(watchRules).where(eq(watchRules.id, id)).get() ?? null;
}

export function getAllWatchRules(): WatchRuleRecord[] {
  const orm = getOrmDb();
  return orm.select().from(watchRules).orderBy(desc(watchRules.createdAt)).all();
}

export function getEnabledWatchRules(): WatchRuleRecord[] {
  const orm = getOrmDb();
  return orm
    .select()
    .from(watchRules)
    .where(eq(watchRules.enabled, true))
    .orderBy(desc(watchRules.createdAt))
    .all();
}

export interface WatchRuleWithState {
  rule: WatchRuleRecord;
  state: WatchRuleStateRecord | null;
}

export function listWatchRulesWithState(): WatchRuleWithState[] {
  const orm = getOrmDb();
  return orm
    .select({
      rule: watchRules,
      state: watchRuleState,
    })
    .from(watchRules)
    .leftJoin(watchRuleState, eq(watchRuleState.ruleId, watchRules.id))
    .orderBy(desc(watchRules.createdAt))
    .all();
}

export function updateWatchRule(
  id: string,
  updates: Partial<Omit<WatchRuleRecord, 'id' | 'createdAt' | 'updatedAt'>>
): WatchRuleRecord | null {
  const orm = getOrmDb();
  const setValues: Partial<typeof watchRules.$inferInsert> = {
    updatedAt: new Date().toISOString(),
  };

  for (const key of [
    'name',
    'deviceId',
    'paneId',
    'enabled',
    'triggerType',
    'pattern',
    'patternFlags',
    'extractGroup',
    'conditionPrompt',
    'providerId',
    'modelId',
    'confirmWithLlm',
    'summarizeWithLlm',
    'intervalSeconds',
    'unchangedMinutes',
    'noMatchBehavior',
    'fireMode',
    'cooldownSeconds',
  ] as const) {
    if (updates[key] !== undefined) {
      (setValues as Record<string, unknown>)[key] = updates[key];
    }
  }

  orm.update(watchRules).set(setValues).where(eq(watchRules.id, id)).run();
  return getWatchRuleById(id);
}

export function deleteWatchRule(id: string): void {
  const orm = getOrmDb();
  orm.delete(watchRules).where(eq(watchRules.id, id)).run();
}

export function getWatchRuleState(ruleId: string): WatchRuleStateRecord | null {
  const orm = getOrmDb();
  return orm.select().from(watchRuleState).where(eq(watchRuleState.ruleId, ruleId)).get() ?? null;
}

export function writeWatchRuleState(
  ruleId: string,
  updates: Partial<Omit<WatchRuleStateRecord, 'ruleId'>>
): void {
  const orm = getOrmDb();
  const setValues: Partial<typeof watchRuleState.$inferInsert> = {};

  for (const key of [
    'lastSampledAt',
    'lastValue',
    'lastValueChangedAt',
    'triggeredSinceChange',
    'lastTriggeredAt',
    'consecutiveErrors',
    'lastError',
    'modelUnavailableNotified',
  ] as const) {
    if (updates[key] !== undefined) {
      (setValues as Record<string, unknown>)[key] = updates[key];
    }
  }

  if (Object.keys(setValues).length === 0) {
    orm
      .insert(watchRuleState)
      .values({ ruleId })
      .onConflictDoNothing({ target: watchRuleState.ruleId })
      .run();
    return;
  }

  orm
    .insert(watchRuleState)
    .values({ ruleId, ...setValues })
    .onConflictDoUpdate({ target: watchRuleState.ruleId, set: setValues })
    .run();
}

export function upsertWatchRuleState(
  ruleId: string,
  updates: Partial<Omit<WatchRuleStateRecord, 'ruleId'>>
): WatchRuleStateRecord {
  writeWatchRuleState(ruleId, updates);
  const state = getWatchRuleState(ruleId);
  if (!state) {
    throw new Error('failed to upsert watch rule state');
  }
  return state;
}
