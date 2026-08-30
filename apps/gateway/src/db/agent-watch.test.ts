import { Database } from 'bun:sqlite';
import { beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import {
  appendAgentMessage,
  appendAgentMessages,
  createAgentConfirmation,
  createAgentSession,
  decideAgentConfirmation,
  deleteAgentSession,
  enqueueAgentMessage,
  ensureAgentSettingsInitialized,
  getAgentConfirmationById,
  getAgentSessionById,
  getAgentSessionsByStatus,
  getAgentSettings,
  listAgentMessages,
  listPendingAgentConfirmations,
  listQueuedAgentMessages,
  updateAgentSession,
  updateAgentSettings,
} from './agent';
import { getDb as getOrmDb, getSqliteClient } from './client';
import { createDevice } from './index';
import {
  createLlmProvider,
  deleteLlmProvider,
  getAllLlmProviders,
  getLlmProviderById,
  updateLlmProvider,
} from './llm';
import { agentMessages } from './schema';
import {
  createWatchRule,
  deleteWatchRule,
  getAllWatchRules,
  getWatchRuleById,
  getWatchRuleState,
  listWatchRulesWithState,
  updateWatchRule,
  upsertWatchRuleState,
} from './watch';

const testDeviceId = crypto.randomUUID();

beforeAll(() => {
  migrate(getOrmDb(), { migrationsFolder: resolve(import.meta.dir, '../../drizzle') });
  const now = new Date().toISOString();
  createDevice({
    id: testDeviceId,
    name: 'agent-watch-test-device',
    type: 'local',
    session: 'tmex',
    authMode: 'auto',
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
  });
});

describe('llm providers', () => {
  test('create / get / update / delete', () => {
    const provider = createLlmProvider({
      name: 'test-provider',
      protocol: 'openai-chat',
      baseUrl: 'https://api.example.com/v1',
      apiKeyEnc: 'enc:dummy',
    });

    expect(provider.enabled).toBe(true);
    expect(provider.modelsCache).toBeNull();
    expect(getLlmProviderById(provider.id)?.name).toBe('test-provider');
    expect(getAllLlmProviders().some((p) => p.id === provider.id)).toBe(true);

    const updated = updateLlmProvider(provider.id, {
      enabled: false,
      modelsCache: ['gpt-4o', 'gpt-4o-mini'],
      modelsFetchedAt: new Date().toISOString(),
    });
    expect(updated).not.toBeNull();
    expect(updated?.enabled).toBe(false);
    expect(updated?.modelsCache).toEqual(['gpt-4o', 'gpt-4o-mini']);
    expect((updated?.updatedAt ?? '') >= provider.updatedAt).toBe(true);

    deleteLlmProvider(provider.id);
    expect(getLlmProviderById(provider.id)).toBeNull();
  });

  test('rejects invalid protocol', () => {
    expect(() =>
      createLlmProvider({
        name: 'bad',
        protocol: 'grpc' as never,
        baseUrl: 'https://x',
        apiKeyEnc: 'enc:x',
      })
    ).toThrow(/CHECK constraint failed/);
  });
});

describe('agent settings', () => {
  test('ensure is idempotent and get returns singleton', () => {
    ensureAgentSettingsInitialized();
    ensureAgentSettingsInitialized();

    const settings = getAgentSettings();
    expect(settings.id).toBe(1);
    expect(settings.searchProvider).toBe('none');
    expect(settings.defaultProviderId).toBeNull();
  });

  test('update preserves untouched fields and clears default provider on delete', () => {
    const provider = createLlmProvider({
      name: 'default-provider',
      protocol: 'openai-responses',
      baseUrl: 'https://api.example.com/v1',
      apiKeyEnc: 'enc:dummy',
    });

    const updated = updateAgentSettings({
      searchProvider: 'tavily',
      tavilyApiKeyEnc: 'enc:tavily',
      defaultProviderId: provider.id,
      defaultModelId: 'gpt-4o',
    });
    expect(updated.searchProvider).toBe('tavily');
    expect(updated.defaultProviderId).toBe(provider.id);

    const partial = updateAgentSettings({ defaultModelId: 'gpt-4o-mini' });
    expect(partial.searchProvider).toBe('tavily');
    expect(partial.defaultModelId).toBe('gpt-4o-mini');

    deleteLlmProvider(provider.id);
    expect(getAgentSettings().defaultProviderId).toBeNull();
  });
});

describe('agent sessions and messages', () => {
  test('session crud and status query', () => {
    const session = createAgentSession({
      title: 'test session',
      deviceId: testDeviceId,
      paneId: '%1',
      modelId: 'gpt-4o',
    });

    expect(session.status).toBe('idle');
    expect(session.writeMode).toBe('confirm');
    expect(session.maxStepsPerTurn).toBe(25);

    updateAgentSession(session.id, { status: 'running' });
    expect(getAgentSessionsByStatus('running').some((s) => s.id === session.id)).toBe(true);

    updateAgentSession(session.id, { status: 'error', lastError: 'boom' });
    const errored = getAgentSessionById(session.id);
    expect(errored?.status).toBe('error');
    expect(errored?.lastError).toBe('boom');

    deleteAgentSession(session.id);
    expect(getAgentSessionById(session.id)).toBeNull();
  });

  test('message seq auto-increments per session', () => {
    const sessionA = createAgentSession({ title: 'a', modelId: 'm' });
    const sessionB = createAgentSession({ title: 'b', modelId: 'm' });

    const m0 = appendAgentMessage(sessionA.id, 'user', { role: 'user', content: 'hi' });
    const m1 = appendAgentMessage(sessionA.id, 'assistant', { role: 'assistant', content: 'yo' });
    const other = appendAgentMessage(sessionB.id, 'user', { role: 'user', content: 'b0' });

    expect(m0.seq).toBe(0);
    expect(m1.seq).toBe(1);
    expect(other.seq).toBe(0);

    const all = listAgentMessages(sessionA.id);
    expect(all.map((m) => m.seq)).toEqual([0, 1]);
    expect(all[0]?.content).toEqual({ role: 'user', content: 'hi' });

    const after = listAgentMessages(sessionA.id, { afterSeq: 0 });
    expect(after.map((m) => m.seq)).toEqual([1]);
  });

  test('duplicate seq violates unique constraint', () => {
    const session = createAgentSession({ title: 'dup', modelId: 'm' });
    appendAgentMessage(session.id, 'user', 'first');

    const orm = getOrmDb();
    expect(() =>
      orm
        .insert(agentMessages)
        .values({
          id: crypto.randomUUID(),
          sessionId: session.id,
          seq: 0,
          role: 'user',
          content: 'dup',
          createdAt: new Date().toISOString(),
        })
        .run()
    ).toThrow();
  });

  test('deleting session cascades messages', () => {
    const session = createAgentSession({ title: 'cascade', modelId: 'm' });
    appendAgentMessage(session.id, 'user', 'x');
    deleteAgentSession(session.id);

    const orm = getOrmDb();
    const rows = orm
      .select()
      .from(agentMessages)
      .where(eq(agentMessages.sessionId, session.id))
      .all();
    expect(rows).toEqual([]);
  });

  test('concurrent appends produce strictly increasing unique seqs', async () => {
    const session = createAgentSession({ title: 'concurrent-seq', modelId: 'm' });
    const count = 40;
    const rows = await Promise.all(
      Array.from({ length: count }, (_, i) =>
        Promise.resolve().then(() => appendAgentMessage(session.id, 'user', `m${i}`))
      )
    );

    const seqs = rows.map((row) => row.seq).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: count }, (_, i) => i));
    expect(new Set(rows.map((row) => row.id)).size).toBe(count);
    expect(listAgentMessages(session.id).map((row) => row.seq)).toEqual(seqs);
  });

  test('concurrent enqueue produces strictly increasing unique seqs', async () => {
    const session = createAgentSession({ title: 'concurrent-queue', modelId: 'm' });
    const count = 40;
    const rows = await Promise.all(
      Array.from({ length: count }, (_, i) =>
        Promise.resolve().then(() => enqueueAgentMessage(session.id, `q${i}`))
      )
    );

    const seqs = rows.map((row) => row.seq).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: count }, (_, i) => i));
    expect(listQueuedAgentMessages(session.id).map((row) => row.seq)).toEqual(seqs);
  });
});

describe('appendAgentMessages', () => {
  test('empty batch is a no-op', () => {
    const session = createAgentSession({ title: 'batch-empty', modelId: 'm' });
    expect(appendAgentMessages(session.id, [])).toEqual([]);
    expect(listAgentMessages(session.id)).toEqual([]);
  });

  test('assigns consecutive seqs and preserves input order', () => {
    const session = createAgentSession({ title: 'batch-seq', modelId: 'm' });
    const rows = appendAgentMessages(session.id, [
      { role: 'assistant', content: { role: 'assistant', content: 'a' } },
      { role: 'tool', content: { role: 'tool', content: 't' } },
      { role: 'assistant', content: { role: 'assistant', content: 'b' } },
    ]);

    expect(rows.map((row) => row.seq)).toEqual([0, 1, 2]);
    expect(rows.map((row) => row.role)).toEqual(['assistant', 'tool', 'assistant']);
    expect(listAgentMessages(session.id).map((row) => row.seq)).toEqual([0, 1, 2]);
    expect(listAgentMessages(session.id).map((row) => row.content)).toEqual([
      { role: 'assistant', content: 'a' },
      { role: 'tool', content: 't' },
      { role: 'assistant', content: 'b' },
    ]);
  });

  test('interleaves with single appends on the same session', () => {
    const session = createAgentSession({ title: 'batch-interleave', modelId: 'm' });
    const first = appendAgentMessage(session.id, 'user', { role: 'user', content: 'q' });
    const batch = appendAgentMessages(session.id, [
      { role: 'assistant', content: { role: 'assistant', content: 'a1' } },
      { role: 'tool', content: { role: 'tool', content: 't1' } },
    ]);
    const last = appendAgentMessage(session.id, 'assistant', {
      role: 'assistant',
      content: 'done',
    });

    expect(first.seq).toBe(0);
    expect(batch.map((row) => row.seq)).toEqual([1, 2]);
    expect(last.seq).toBe(3);
    expect(listAgentMessages(session.id).map((row) => row.seq)).toEqual([0, 1, 2, 3]);
  });

  test('seq allocation is independent across sessions', () => {
    const sessionA = createAgentSession({ title: 'batch-a', modelId: 'm' });
    const sessionB = createAgentSession({ title: 'batch-b', modelId: 'm' });
    appendAgentMessage(sessionB.id, 'user', { role: 'user', content: 'b0' });
    const batchA = appendAgentMessages(sessionA.id, [
      { role: 'user', content: { role: 'user', content: 'a0' } },
      { role: 'assistant', content: { role: 'assistant', content: 'a1' } },
    ]);
    const nextB = appendAgentMessage(sessionB.id, 'assistant', {
      role: 'assistant',
      content: 'b1',
    });

    expect(batchA.map((row) => row.seq)).toEqual([0, 1]);
    expect(nextB.seq).toBe(1);
  });
});

describe('agent confirmations', () => {
  test('create / list pending / decide', () => {
    const session = createAgentSession({ title: 'confirm', modelId: 'm' });
    const confirmation = createAgentConfirmation({
      sessionId: session.id,
      toolName: 'write_terminal',
      toolCallId: 'call_1',
      inputJson: { keys: 'ls -la\n' },
    });

    expect(confirmation.status).toBe('pending');
    expect(listPendingAgentConfirmations(session.id).map((c) => c.id)).toEqual([confirmation.id]);

    const decided = decideAgentConfirmation(confirmation.id, {
      status: 'approved',
    });
    expect(decided?.status).toBe('approved');
    expect(decided?.decidedAt).not.toBeNull();
    expect(listPendingAgentConfirmations(session.id)).toEqual([]);
  });

  test('decide on already decided confirmation returns null and keeps state', () => {
    const session = createAgentSession({ title: 'confirm-cas', modelId: 'm' });
    const confirmation = createAgentConfirmation({
      sessionId: session.id,
      toolName: 'write_terminal',
      toolCallId: 'call_2',
      inputJson: { keys: 'rm -rf /tmp/x\n' },
    });

    const approved = decideAgentConfirmation(confirmation.id, { status: 'approved' });
    expect(approved?.status).toBe('approved');

    const denied = decideAgentConfirmation(confirmation.id, {
      status: 'denied',
      reason: 'too late',
    });
    expect(denied).toBeNull();

    const current = getAgentConfirmationById(confirmation.id);
    expect(current?.status).toBe('approved');
    expect(current?.reason).toBeNull();
    expect(current?.decidedAt).toBe(approved?.decidedAt ?? '');
  });
});

const QUEUED_SESSION_SEQ_INDEX = 'agent_queued_messages_session_seq_idx';
const CONFIRMATION_SESSION_STATUS_CREATED_INDEX =
  'agent_confirmations_session_status_created_at_idx';
const MIGRATIONS_FOLDER = resolve(import.meta.dir, '../../drizzle');

interface QueryPlanRow {
  detail: string;
}

interface SqliteMasterNameRow {
  name: string;
}

function usesIndex(details: string[], indexName: string): boolean {
  return details.some((detail) => detail.includes(`USING INDEX ${indexName}`));
}

function indexExistsOn(db: Database, name: string): boolean {
  const row = db
    .query(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`)
    .get(name) as SqliteMasterNameRow | null;
  return row?.name === name;
}

function explainOn(db: Database, sql: string, params: string[]): string[] {
  const rows = db.query(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as QueryPlanRow[];
  return rows.map((row) => row.detail);
}

function migratedMemoryDb(): Database {
  const db = new Database(':memory:');
  db.run('PRAGMA foreign_keys = ON');
  migrate(drizzle(db), { migrationsFolder: MIGRATIONS_FOLDER });
  return db;
}

function insertPlanSession(db: Database): string {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO agent_sessions (
      id, title, model_id, write_mode, use_provider_web_search, provider_hosted_tools,
      allow_control_chars, status, max_steps_per_turn, created_at, updated_at
    ) VALUES (?, 'plan', 'm', 'confirm', 0, '[]', 0, 'idle', 25, ?, ?)`,
    [id, now, now]
  );
  return id;
}

function assertIndexPlan(options: {
  indexName: string;
  createSql: string;
  querySql: string;
  seed: (db: Database, sessionId: string) => void;
}): void {
  const db = migratedMemoryDb();
  try {
    expect(indexExistsOn(db, options.indexName)).toBe(true);
    const sessionId = insertPlanSession(db);
    options.seed(db, sessionId);

    db.run(`DROP INDEX IF EXISTS "${options.indexName}"`);
    const before = explainOn(db, options.querySql, [sessionId]);
    expect(usesIndex(before, options.indexName)).toBe(false);

    db.run(options.createSql);
    const after = explainOn(db, options.querySql, [sessionId]);
    expect(usesIndex(after, options.indexName)).toBe(true);
  } finally {
    db.close();
  }
}

describe('agent query indexes', () => {
  test('migrated test db has queued and confirmation indexes', () => {
    const sqlite = getSqliteClient();
    expect(indexExistsOn(sqlite, QUEUED_SESSION_SEQ_INDEX)).toBe(true);
    expect(indexExistsOn(sqlite, CONFIRMATION_SESSION_STATUS_CREATED_INDEX)).toBe(true);
  });

  test('list queued messages uses (session_id, seq) index', () => {
    assertIndexPlan({
      indexName: QUEUED_SESSION_SEQ_INDEX,
      createSql: `CREATE INDEX ${QUEUED_SESSION_SEQ_INDEX} ON agent_queued_messages (session_id, seq)`,
      querySql: 'SELECT * FROM agent_queued_messages WHERE session_id = ? ORDER BY seq ASC',
      seed: (db, sessionId) => {
        const now = new Date().toISOString();
        db.run(
          `INSERT INTO agent_queued_messages (id, session_id, seq, text, created_at) VALUES (?, ?, 0, 'first', ?)`,
          [crypto.randomUUID(), sessionId, now]
        );
        db.run(
          `INSERT INTO agent_queued_messages (id, session_id, seq, text, created_at) VALUES (?, ?, 1, 'second', ?)`,
          [crypto.randomUUID(), sessionId, now]
        );
      },
    });
  });

  test('list pending confirmations uses (session_id, status, created_at) index', () => {
    assertIndexPlan({
      indexName: CONFIRMATION_SESSION_STATUS_CREATED_INDEX,
      createSql: `CREATE INDEX ${CONFIRMATION_SESSION_STATUS_CREATED_INDEX} ON agent_confirmations (session_id, status, created_at)`,
      querySql:
        "SELECT * FROM agent_confirmations WHERE session_id = ? AND status = 'pending' ORDER BY created_at ASC",
      seed: (db, sessionId) => {
        db.run(
          `INSERT INTO agent_confirmations (
            id, session_id, tool_name, tool_call_id, input_json, status, created_at
          ) VALUES (?, ?, 'write_terminal', 'call_plan', '{}', 'pending', ?)`,
          [crypto.randomUUID(), sessionId, new Date().toISOString()]
        );
      },
    });
  });
});

describe('watch rules and state', () => {
  test('rule crud with defaults', () => {
    const rule = createWatchRule({
      name: 'cpu watch',
      deviceId: testDeviceId,
      paneId: '%2',
      triggerType: 'match',
      pattern: 'error: (.+)',
      extractGroup: 1,
    });

    expect(rule.enabled).toBe(true);
    expect(rule.patternFlags).toBe('');
    expect(rule.intervalSeconds).toBe(30);
    expect(rule.noMatchBehavior).toBe('reset');
    expect(rule.fireMode).toBe('once');
    expect(rule.cooldownSeconds).toBe(600);

    expect(getAllWatchRules().some((r) => r.id === rule.id)).toBe(true);

    const updated = updateWatchRule(rule.id, {
      enabled: false,
      triggerType: 'llm',
      conditionPrompt: '当输出表示构建失败时触发',
      fireMode: 'repeat',
    });
    expect(updated?.enabled).toBe(false);
    expect(updated?.triggerType).toBe('llm');
    expect(updated?.conditionPrompt).toBe('当输出表示构建失败时触发');

    deleteWatchRule(rule.id);
    expect(getWatchRuleById(rule.id)).toBeNull();
  });

  test('state upsert creates then updates, cascades on rule delete', () => {
    const rule = createWatchRule({
      name: 'state watch',
      deviceId: testDeviceId,
      paneId: '%3',
      triggerType: 'unchanged',
      unchangedMinutes: 5,
    });

    expect(getWatchRuleState(rule.id)).toBeNull();

    const created = upsertWatchRuleState(rule.id, {
      lastSampledAt: new Date().toISOString(),
      lastValue: '42%',
    });
    expect(created.lastValue).toBe('42%');
    expect(created.consecutiveErrors).toBe(0);
    expect(created.triggeredSinceChange).toBe(false);

    const updated = upsertWatchRuleState(rule.id, {
      triggeredSinceChange: true,
      consecutiveErrors: 2,
      lastError: 'pane gone',
    });
    expect(updated.lastValue).toBe('42%');
    expect(updated.triggeredSinceChange).toBe(true);
    expect(updated.consecutiveErrors).toBe(2);

    deleteWatchRule(rule.id);
    expect(getWatchRuleState(rule.id)).toBeNull();
  });

  test('listWatchRulesWithState left-joins state in one query', () => {
    const withState = createWatchRule({
      name: 'join with state',
      deviceId: testDeviceId,
      paneId: '%4',
      triggerType: 'match',
      pattern: 'ok',
    });
    const withoutState = createWatchRule({
      name: 'join without state',
      deviceId: testDeviceId,
      paneId: '%5',
      triggerType: 'match',
      pattern: 'ok',
    });
    upsertWatchRuleState(withState.id, { lastValue: 'joined' });

    const rows = listWatchRulesWithState();
    const joined = rows.find((row) => row.rule.id === withState.id);
    const missing = rows.find((row) => row.rule.id === withoutState.id);

    expect(joined?.state?.lastValue).toBe('joined');
    expect(missing?.state).toBeNull();

    deleteWatchRule(withState.id);
    deleteWatchRule(withoutState.id);
  });
});
