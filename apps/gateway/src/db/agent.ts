import { and, asc, desc, eq, gt, gte, isNull, lt, max, sql } from 'drizzle-orm';
import { getDb as getOrmDb } from './client';
import {
  type AgentConfirmationStatus,
  type AgentMessageRole,
  type AgentSessionStatus,
  type AgentWriteMode,
  agentConfirmations,
  agentMessages,
  agentQueuedMessages,
  agentSessions,
  agentSettings,
} from './schema';

export type AgentSettingsRecord = typeof agentSettings.$inferSelect;
export type AgentSessionRecord = typeof agentSessions.$inferSelect;
export type AgentMessageRecord = typeof agentMessages.$inferSelect;
export type AgentQueuedMessageRecord = typeof agentQueuedMessages.$inferSelect;
export type AgentConfirmationRecord = typeof agentConfirmations.$inferSelect;

export type {
  AgentConfirmationStatus,
  AgentMessageRole,
  AgentSearchProvider,
  AgentSessionStatus,
  AgentWriteMode,
} from './schema';

export function ensureAgentSettingsInitialized(): void {
  const orm = getOrmDb();

  orm
    .insert(agentSettings)
    .values({
      id: 1,
      searchProvider: 'none',
      tavilyApiKeyEnc: null,
      braveApiKeyEnc: null,
      defaultProviderId: null,
      defaultModelId: null,
      updatedAt: new Date().toISOString(),
    })
    .onConflictDoNothing({ target: agentSettings.id })
    .run();
}

export function getAgentSettings(): AgentSettingsRecord {
  const orm = getOrmDb();
  let row = orm.select().from(agentSettings).where(eq(agentSettings.id, 1)).get();

  if (!row) {
    ensureAgentSettingsInitialized();
    row = orm.select().from(agentSettings).where(eq(agentSettings.id, 1)).get();
  }

  if (!row) {
    throw new Error('agent_settings not initialized');
  }

  return row;
}

export function updateAgentSettings(
  updates: Partial<Omit<AgentSettingsRecord, 'id' | 'updatedAt'>>
): AgentSettingsRecord {
  getAgentSettings();

  const orm = getOrmDb();
  const setValues: Partial<typeof agentSettings.$inferInsert> = {
    updatedAt: new Date().toISOString(),
  };

  if (updates.searchProvider !== undefined) {
    setValues.searchProvider = updates.searchProvider;
  }
  if (updates.tavilyApiKeyEnc !== undefined) {
    setValues.tavilyApiKeyEnc = updates.tavilyApiKeyEnc;
  }
  if (updates.braveApiKeyEnc !== undefined) {
    setValues.braveApiKeyEnc = updates.braveApiKeyEnc;
  }
  if (updates.defaultProviderId !== undefined) {
    setValues.defaultProviderId = updates.defaultProviderId;
  }
  if (updates.defaultModelId !== undefined) {
    setValues.defaultModelId = updates.defaultModelId;
  }

  orm.update(agentSettings).set(setValues).where(eq(agentSettings.id, 1)).run();
  return getAgentSettings();
}

export interface CreateAgentSessionInput {
  title: string;
  nodeId?: string | null;
  deviceId?: string | null;
  paneId?: string | null;
  providerId?: string | null;
  modelId: string;
  systemPrompt?: string | null;
  writeMode?: AgentWriteMode;
  useProviderWebSearch?: boolean;
  providerHostedTools?: string[];
  allowControlChars?: boolean;
  originPaneTitle?: string | null;
  originProcessName?: string | null;
  maxStepsPerTurn?: number;
}

export function createAgentSession(input: CreateAgentSessionInput): AgentSessionRecord {
  const orm = getOrmDb();
  const now = new Date().toISOString();
  const row: typeof agentSessions.$inferInsert = {
    id: crypto.randomUUID(),
    title: input.title,
    nodeId: input.nodeId ?? null,
    deviceId: input.deviceId ?? null,
    paneId: input.paneId ?? null,
    providerId: input.providerId ?? null,
    modelId: input.modelId,
    systemPrompt: input.systemPrompt ?? null,
    writeMode: input.writeMode ?? 'confirm',
    useProviderWebSearch: input.useProviderWebSearch ?? false,
    providerHostedTools: input.providerHostedTools ?? [],
    allowControlChars: input.allowControlChars ?? false,
    originPaneTitle: input.originPaneTitle ?? null,
    originProcessName: input.originProcessName ?? null,
    status: 'idle',
    lastError: null,
    maxStepsPerTurn: input.maxStepsPerTurn ?? 25,
    createdAt: now,
    updatedAt: now,
  };

  orm.insert(agentSessions).values(row).run();
  const created = getAgentSessionById(row.id);
  if (!created) {
    throw new Error('failed to create agent session');
  }
  return created;
}

export function getAgentSessionById(id: string): AgentSessionRecord | null {
  const orm = getOrmDb();
  return orm.select().from(agentSessions).where(eq(agentSessions.id, id)).get() ?? null;
}

export function getAllAgentSessions(filter: { nodeId?: string } = {}): AgentSessionRecord[] {
  const orm = getOrmDb();
  const query = orm.select().from(agentSessions);
  if (filter.nodeId === 'self') {
    return query.where(isNull(agentSessions.nodeId)).orderBy(desc(agentSessions.updatedAt)).all();
  }
  if (filter.nodeId) {
    return query
      .where(eq(agentSessions.nodeId, filter.nodeId))
      .orderBy(desc(agentSessions.updatedAt))
      .all();
  }
  return query.orderBy(desc(agentSessions.updatedAt)).all();
}

export function getAgentSessionsByStatus(status: AgentSessionStatus): AgentSessionRecord[] {
  const orm = getOrmDb();
  return orm
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.status, status))
    .orderBy(desc(agentSessions.updatedAt))
    .all();
}

export function updateAgentSession(
  id: string,
  updates: Partial<Omit<AgentSessionRecord, 'id' | 'createdAt' | 'updatedAt'>>
): AgentSessionRecord | null {
  const orm = getOrmDb();
  const setValues: Partial<typeof agentSessions.$inferInsert> = {
    updatedAt: new Date().toISOString(),
  };

  for (const key of [
    'title',
    'nodeId',
    'deviceId',
    'paneId',
    'providerId',
    'modelId',
    'systemPrompt',
    'writeMode',
    'useProviderWebSearch',
    'providerHostedTools',
    'allowControlChars',
    'status',
    'lastError',
    'maxStepsPerTurn',
  ] as const) {
    if (updates[key] !== undefined) {
      (setValues as Record<string, unknown>)[key] = updates[key];
    }
  }

  orm.update(agentSessions).set(setValues).where(eq(agentSessions.id, id)).run();
  return getAgentSessionById(id);
}

export function deleteAgentSession(id: string): void {
  const orm = getOrmDb();
  orm.delete(agentSessions).where(eq(agentSessions.id, id)).run();
}

function nextSessionSeqSql(
  table: typeof agentMessages | typeof agentQueuedMessages,
  sessionId: string
) {
  return sql`(select coalesce(max(${table.seq}), -1) + 1 from ${table} where ${table.sessionId} = ${sessionId})`;
}

export function appendAgentMessage(
  sessionId: string,
  role: AgentMessageRole,
  content: unknown
): AgentMessageRecord {
  const orm = getOrmDb();
  const created = orm
    .insert(agentMessages)
    .values({
      id: crypto.randomUUID(),
      sessionId,
      seq: nextSessionSeqSql(agentMessages, sessionId),
      role,
      content,
      createdAt: new Date().toISOString(),
    })
    .returning()
    .get();
  if (!created) {
    throw new Error('failed to append agent message');
  }
  return created;
}

export function appendAgentMessages(
  sessionId: string,
  messages: ReadonlyArray<{ role: AgentMessageRole; content: unknown }>
): AgentMessageRecord[] {
  if (messages.length === 0) {
    return [];
  }
  const first = messages[0];
  if (messages.length === 1 && first) {
    return [appendAgentMessage(sessionId, first.role, first.content)];
  }

  const orm = getOrmDb();
  return orm.transaction((tx) => {
    const maxRow = tx
      .select({ maxSeq: max(agentMessages.seq) })
      .from(agentMessages)
      .where(eq(agentMessages.sessionId, sessionId))
      .get();
    let nextSeq = (maxRow?.maxSeq ?? -1) + 1;
    const createdAt = new Date().toISOString();
    const rows = messages.map((message) => ({
      id: crypto.randomUUID(),
      sessionId,
      seq: nextSeq++,
      role: message.role,
      content: message.content,
      createdAt,
    }));
    const created = tx.insert(agentMessages).values(rows).returning().all();
    if (created.length !== rows.length) {
      throw new Error('failed to append agent messages');
    }
    // SQLite RETURNING 不保证行序，调用方按数组顺序广播
    created.sort((a, b) => a.seq - b.seq);
    return created;
  });
}

export function listAgentMessages(
  sessionId: string,
  options: { afterSeq?: number } = {}
): AgentMessageRecord[] {
  const orm = getOrmDb();
  const conditions =
    options.afterSeq !== undefined
      ? and(eq(agentMessages.sessionId, sessionId), gt(agentMessages.seq, options.afterSeq))
      : eq(agentMessages.sessionId, sessionId);

  return orm.select().from(agentMessages).where(conditions).orderBy(asc(agentMessages.seq)).all();
}

export const AGENT_MESSAGE_WINDOW_PAGE_SIZE = 200;

export function listAgentMessagesForWindow(
  sessionId: string,
  charBudget: number,
  options: { pageSize?: number; lengthMargin?: number } = {}
): AgentMessageRecord[] {
  const pageSize = Math.max(1, options.pageSize ?? AGENT_MESSAGE_WINDOW_PAGE_SIZE);
  const lengthMargin = options.lengthMargin ?? Math.max(1024, Math.ceil(charBudget * 0.1));
  const orm = getOrmDb();
  // SQL length 从新到旧累加到预算+余量，并继续到一条 user，避免 suffix 从 tool 对中间起头。
  let remaining = charBudget + lengthMargin;
  let seenUser = false;
  let oldestSeq: number | null = null;
  let cursorSeq: number | undefined;

  while (true) {
    const conditions =
      cursorSeq === undefined
        ? eq(agentMessages.sessionId, sessionId)
        : and(eq(agentMessages.sessionId, sessionId), lt(agentMessages.seq, cursorSeq));
    const page = orm
      .select({
        seq: agentMessages.seq,
        role: agentMessages.role,
        contentLen: sql<number>`length(${agentMessages.content})`.mapWith(Number),
      })
      .from(agentMessages)
      .where(conditions)
      .orderBy(desc(agentMessages.seq))
      .limit(pageSize)
      .all();
    if (page.length === 0) {
      break;
    }

    let stop = false;
    for (const row of page) {
      remaining -= row.contentLen;
      if (row.role === 'user') {
        seenUser = true;
      }
      oldestSeq = row.seq;
      cursorSeq = row.seq;
      if (remaining <= 0 && seenUser) {
        stop = true;
        break;
      }
    }
    if (stop || page.length < pageSize) {
      break;
    }
  }

  if (oldestSeq === null) {
    return [];
  }

  return orm
    .select()
    .from(agentMessages)
    .where(and(eq(agentMessages.sessionId, sessionId), gte(agentMessages.seq, oldestSeq)))
    .orderBy(asc(agentMessages.seq))
    .all();
}

export function getFirstAgentUserMessage(sessionId: string): AgentMessageRecord | null {
  const orm = getOrmDb();
  return (
    orm
      .select()
      .from(agentMessages)
      .where(and(eq(agentMessages.sessionId, sessionId), eq(agentMessages.role, 'user')))
      .orderBy(asc(agentMessages.seq))
      .limit(1)
      .get() ?? null
  );
}

export function getMaxAgentMessageSeq(sessionId: string): number {
  const orm = getOrmDb();
  const row = orm
    .select({ maxSeq: max(agentMessages.seq) })
    .from(agentMessages)
    .where(eq(agentMessages.sessionId, sessionId))
    .get();
  return row?.maxSeq ?? -1;
}

// ========== 排队消息（运行中入队 / steer / 编辑撤回） ==========

export function enqueueAgentMessage(sessionId: string, text: string): AgentQueuedMessageRecord {
  const orm = getOrmDb();
  const created = orm
    .insert(agentQueuedMessages)
    .values({
      id: crypto.randomUUID(),
      sessionId,
      seq: nextSessionSeqSql(agentQueuedMessages, sessionId),
      text,
      createdAt: new Date().toISOString(),
    })
    .returning()
    .get();
  if (!created) {
    throw new Error('failed to enqueue agent message');
  }
  return created;
}

export function listQueuedAgentMessages(sessionId: string): AgentQueuedMessageRecord[] {
  const orm = getOrmDb();
  return orm
    .select()
    .from(agentQueuedMessages)
    .where(eq(agentQueuedMessages.sessionId, sessionId))
    .orderBy(asc(agentQueuedMessages.seq))
    .all();
}

export function getQueuedAgentMessageById(id: string): AgentQueuedMessageRecord | null {
  const orm = getOrmDb();
  return orm.select().from(agentQueuedMessages).where(eq(agentQueuedMessages.id, id)).get() ?? null;
}

export function updateQueuedAgentMessage(
  id: string,
  text: string
): AgentQueuedMessageRecord | null {
  const orm = getOrmDb();
  orm.update(agentQueuedMessages).set({ text }).where(eq(agentQueuedMessages.id, id)).run();
  return getQueuedAgentMessageById(id);
}

export function deleteQueuedAgentMessage(id: string): void {
  const orm = getOrmDb();
  orm.delete(agentQueuedMessages).where(eq(agentQueuedMessages.id, id)).run();
}

export function deleteAllQueuedAgentMessages(sessionId: string): void {
  const orm = getOrmDb();
  orm.delete(agentQueuedMessages).where(eq(agentQueuedMessages.sessionId, sessionId)).run();
}

export interface CreateAgentConfirmationInput {
  /** 缺省时自动生成；agent runtime 传 AI SDK 的 approvalId 以便续跑时回填 tool-approval-response */
  id?: string;
  sessionId: string;
  toolName: string;
  toolCallId: string;
  inputJson: unknown;
}

export function createAgentConfirmation(
  input: CreateAgentConfirmationInput
): AgentConfirmationRecord {
  const orm = getOrmDb();
  const row: typeof agentConfirmations.$inferInsert = {
    id: input.id ?? crypto.randomUUID(),
    sessionId: input.sessionId,
    toolName: input.toolName,
    toolCallId: input.toolCallId,
    inputJson: input.inputJson,
    status: 'pending',
    reason: null,
    decidedAt: null,
    createdAt: new Date().toISOString(),
  };

  orm.insert(agentConfirmations).values(row).run();
  const created = getAgentConfirmationById(row.id);
  if (!created) {
    throw new Error('failed to create agent confirmation');
  }
  return created;
}

export function getAgentConfirmationById(id: string): AgentConfirmationRecord | null {
  const orm = getOrmDb();
  return orm.select().from(agentConfirmations).where(eq(agentConfirmations.id, id)).get() ?? null;
}

export function listPendingAgentConfirmations(sessionId: string): AgentConfirmationRecord[] {
  const orm = getOrmDb();
  return orm
    .select()
    .from(agentConfirmations)
    .where(
      and(eq(agentConfirmations.sessionId, sessionId), eq(agentConfirmations.status, 'pending'))
    )
    .orderBy(asc(agentConfirmations.createdAt))
    .all();
}

export function decideAgentConfirmation(
  id: string,
  decision: { status: Exclude<AgentConfirmationStatus, 'pending'>; reason?: string | null }
): AgentConfirmationRecord | null {
  const orm = getOrmDb();
  const updated = orm
    .update(agentConfirmations)
    .set({
      status: decision.status,
      reason: decision.reason ?? null,
      decidedAt: new Date().toISOString(),
    })
    .where(and(eq(agentConfirmations.id, id), eq(agentConfirmations.status, 'pending')))
    .returning()
    .get();

  return updated ?? null;
}
