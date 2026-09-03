import type {
  AgentConfirmationStatus,
  AgentMessageRole,
  AgentSearchProvider,
  AgentSessionStatus,
  AgentWriteMode,
  LlmProviderProtocol,
  WatchFireMode,
  WatchNoMatchBehavior,
  WatchTriggerType,
} from '@tmex/shared';
import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core';
import { devices } from './devices';

export type {
  AgentConfirmationStatus,
  AgentMessageRole,
  AgentSearchProvider,
  AgentSessionStatus,
  AgentWriteMode,
  LlmProviderProtocol,
  WatchFireMode,
  WatchNoMatchBehavior,
  WatchTriggerType,
} from '@tmex/shared';

export const llmProviders = sqliteTable(
  'llm_providers',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    protocol: text('protocol').$type<LlmProviderProtocol>().notNull(),
    baseUrl: text('base_url').notNull(),
    apiKeyEnc: text('api_key_enc').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    modelsCache: text('models_cache', { mode: 'json' }).$type<string[]>(),
    modelsFetchedAt: text('models_fetched_at'),
    // 用户手动添加的模型 id（不会被刷新覆盖）
    manualModels: text('manual_models', { mode: 'json' }).$type<string[]>().notNull().default([]),
    // 被用户禁用的模型 id（来自 modelsCache 或 manualModels），从可选列表中剔除
    disabledModels: text('disabled_models', { mode: 'json' })
      .$type<string[]>()
      .notNull()
      .default([]),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    check(
      'llm_providers_protocol_check',
      sql`${table.protocol} in ('openai-chat', 'openai-responses')`
    ),
  ]
);

export const agentSettings = sqliteTable(
  'agent_settings',
  {
    id: integer('id').primaryKey(),
    searchProvider: text('search_provider').$type<AgentSearchProvider>().notNull().default('none'),
    tavilyApiKeyEnc: text('tavily_api_key_enc'),
    braveApiKeyEnc: text('brave_api_key_enc'),
    defaultProviderId: text('default_provider_id').references(() => llmProviders.id, {
      onDelete: 'set null',
    }),
    defaultModelId: text('default_model_id'),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [check('agent_settings_singleton_check', sql`${table.id} = 1`)]
);

export const agentSessions = sqliteTable(
  'agent_sessions',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    /** 绑定 pane 所在 mesh node；null 表示本 gateway（self） */
    nodeId: text('node_id'),
    // 无 FK：远端 node 的 deviceId 不在本机 devices 表
    deviceId: text('device_id'),
    paneId: text('pane_id'),
    providerId: text('provider_id').references(() => llmProviders.id, { onDelete: 'set null' }),
    modelId: text('model_id').notNull(),
    systemPrompt: text('system_prompt'),
    writeMode: text('write_mode').$type<AgentWriteMode>().notNull().default('confirm'),
    useProviderWebSearch: integer('use_provider_web_search', { mode: 'boolean' })
      .notNull()
      .default(false),
    // 启用的 provider 原生 hosted 工具 key 列表（如 image_generation；仅 openai-responses 生效）
    providerHostedTools: text('provider_hosted_tools', { mode: 'json' })
      .$type<string[]>()
      .notNull()
      .default([]),
    // 允许 send_input 写入原始控制字符（rawControlChars）；默认关闭（安全）
    allowControlChars: integer('allow_control_chars', { mode: 'boolean' }).notNull().default(false),
    // 起源元数据：创建会话时绑定 pane 的终端标题与进程名（旧记录为 null，前端不显示）
    originPaneTitle: text('origin_pane_title'),
    originProcessName: text('origin_process_name'),
    status: text('status').$type<AgentSessionStatus>().notNull().default('idle'),
    lastError: text('last_error'),
    maxStepsPerTurn: integer('max_steps_per_turn').notNull().default(25),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    check('agent_sessions_write_mode_check', sql`${table.writeMode} in ('confirm', 'auto')`),
    check(
      'agent_sessions_status_check',
      sql`${table.status} in ('idle', 'running', 'waiting_confirmation', 'stopped', 'error')`
    ),
    index('agent_sessions_node_id_idx').on(table.nodeId),
  ]
);

export const agentMessages = sqliteTable(
  'agent_messages',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => agentSessions.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    role: text('role').$type<AgentMessageRole>().notNull(),
    content: text('content', { mode: 'json' }).$type<unknown>().notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [unique('agent_messages_session_seq_unique').on(table.sessionId, table.seq)]
);

// 运行中排队的用户消息（step 边界注入 / 手动 steer）；可编辑/撤回；落库保证多端同步 + 重启不丢
export const agentQueuedMessages = sqliteTable(
  'agent_queued_messages',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => agentSessions.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    text: text('text').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [index('agent_queued_messages_session_seq_idx').on(table.sessionId, table.seq)]
);

export const agentConfirmations = sqliteTable(
  'agent_confirmations',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => agentSessions.id, { onDelete: 'cascade' }),
    toolName: text('tool_name').notNull(),
    toolCallId: text('tool_call_id').notNull(),
    inputJson: text('input_json', { mode: 'json' }).$type<unknown>().notNull(),
    status: text('status').$type<AgentConfirmationStatus>().notNull().default('pending'),
    reason: text('reason'),
    decidedAt: text('decided_at'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    check(
      'agent_confirmations_status_check',
      sql`${table.status} in ('pending', 'approved', 'denied', 'cancelled')`
    ),
    index('agent_confirmations_session_status_created_at_idx').on(
      table.sessionId,
      table.status,
      table.createdAt
    ),
  ]
);

export const watchRules = sqliteTable(
  'watch_rules',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    deviceId: text('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    paneId: text('pane_id').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    triggerType: text('trigger_type').$type<WatchTriggerType>().notNull(),
    pattern: text('pattern'),
    patternFlags: text('pattern_flags').notNull().default(''),
    extractGroup: integer('extract_group').notNull().default(0),
    conditionPrompt: text('condition_prompt'),
    providerId: text('provider_id').references(() => llmProviders.id, { onDelete: 'set null' }),
    modelId: text('model_id'),
    confirmWithLlm: integer('confirm_with_llm', { mode: 'boolean' }).notNull().default(false),
    summarizeWithLlm: integer('summarize_with_llm', { mode: 'boolean' }).notNull().default(false),
    intervalSeconds: integer('interval_seconds').notNull().default(30),
    unchangedMinutes: integer('unchanged_minutes'),
    noMatchBehavior: text('no_match_behavior')
      .$type<WatchNoMatchBehavior>()
      .notNull()
      .default('reset'),
    fireMode: text('fire_mode').$type<WatchFireMode>().notNull().default('once'),
    cooldownSeconds: integer('cooldown_seconds').notNull().default(600),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    check(
      'watch_rules_trigger_type_check',
      sql`${table.triggerType} in ('match', 'unchanged', 'llm')`
    ),
    check(
      'watch_rules_no_match_behavior_check',
      sql`${table.noMatchBehavior} in ('reset', 'ignore')`
    ),
    check('watch_rules_fire_mode_check', sql`${table.fireMode} in ('once', 'repeat')`),
  ]
);

export const watchRuleState = sqliteTable('watch_rule_state', {
  ruleId: text('rule_id')
    .primaryKey()
    .references(() => watchRules.id, { onDelete: 'cascade' }),
  lastSampledAt: text('last_sampled_at'),
  lastValue: text('last_value'),
  lastValueChangedAt: text('last_value_changed_at'),
  triggeredSinceChange: integer('triggered_since_change', { mode: 'boolean' })
    .notNull()
    .default(false),
  lastTriggeredAt: text('last_triggered_at'),
  consecutiveErrors: integer('consecutive_errors').notNull().default(0),
  lastError: text('last_error'),
  modelUnavailableNotified: integer('model_unavailable_notified', { mode: 'boolean' })
    .notNull()
    .default(false),
});
