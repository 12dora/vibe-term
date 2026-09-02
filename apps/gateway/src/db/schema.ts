import { DEFAULT_TERMINAL_SHORTCUTS } from '@tmex/shared';
import type {
  AgentConfirmationStatus,
  AgentMessageRole,
  AgentSearchProvider,
  AgentSessionStatus,
  AgentWriteMode,
  EventType,
  LlmProviderProtocol,
  TerminalShortcutItem,
  TunnelAccessMode,
  WatchFireMode,
  WatchNoMatchBehavior,
  WatchTriggerType,
} from '@tmex/shared';
import { sql } from 'drizzle-orm';
import {
  blob,
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

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

export const siteSettings = sqliteTable(
  'site_settings',
  {
    id: integer('id').primaryKey(),
    siteName: text('site_name').notNull(),
    siteUrl: text('site_url').notNull(),
    bellThrottleSeconds: integer('bell_throttle_seconds').notNull(),
    notificationThrottleSeconds: integer('notification_throttle_seconds').notNull().default(3),
    enableBrowserNotificationToast: integer('enable_browser_notification_toast', {
      mode: 'boolean',
    })
      .notNull()
      .default(true),
    enableNotificationPush: integer('enable_notification_push', { mode: 'boolean' })
      .notNull()
      .default(true),
    enableBellPush: integer('enable_bell_push', { mode: 'boolean' }).notNull().default(true),
    enableBellSound: integer('enable_bell_sound', { mode: 'boolean' }).notNull().default(true),
    sshReconnectMaxRetries: integer('ssh_reconnect_max_retries').notNull(),
    sshReconnectDelaySeconds: integer('ssh_reconnect_delay_seconds').notNull(),
    language: text('language').notNull().default('en_US'),
    theme: text('theme').notNull().default('dark'),
    disabledNotificationChannels: text('disabled_notification_channels', { mode: 'json' })
      .$type<string[]>()
      .notNull()
      .default([]),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    check('site_settings_singleton_check', sql`${table.id} = 1`),
    check('site_settings_theme_check', sql`${table.theme} in ('dark', 'light')`),
  ]
);

// gateway 级一次性标记 / 杂项状态（如首次建库 seed 标记），普通 kv 存储。
export const gatewayKv = sqliteTable('gateway_kv', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// 终端快捷键栏配置（服务器单例，多端共享）。items 为有序快捷键列表，
// useIcons 控制是否用苹果风格符号替代 send 类按键的文字。
export const terminalShortcutSettings = sqliteTable(
  'terminal_shortcut_settings',
  {
    id: integer('id').primaryKey(),
    items: text('items', { mode: 'json' })
      .$type<TerminalShortcutItem[]>()
      .notNull()
      .default(DEFAULT_TERMINAL_SHORTCUTS),
    useIcons: integer('use_icons', { mode: 'boolean' }).notNull().default(false),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [check('terminal_shortcut_settings_singleton_check', sql`${table.id} = 1`)]
);

export const devices = sqliteTable(
  'devices',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    type: text('type').notNull(),
    host: text('host'),
    port: integer('port').default(22),
    username: text('username'),
    sshConfigRef: text('ssh_config_ref'),
    session: text('session').default('tmex'),
    authMode: text('auth_mode').notNull(),
    passwordEnc: text('password_enc'),
    privateKeyEnc: text('private_key_enc'),
    privateKeyPassphraseEnc: text('private_key_passphrase_enc'),
    defaultWorkingDir: text('default_working_dir'),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    check('devices_type_check', sql`${table.type} in ('local', 'ssh')`),
    check(
      'devices_auth_mode_check',
      sql`${table.authMode} in ('password', 'key', 'agent', 'configRef', 'auto')`
    ),
  ]
);

export const deviceRuntimeStatus = sqliteTable('device_runtime_status', {
  deviceId: text('device_id')
    .primaryKey()
    .references(() => devices.id, { onDelete: 'cascade' }),
  lastSeenAt: text('last_seen_at'),
  tmuxAvailable: integer('tmux_available', { mode: 'boolean' }).notNull().default(false),
  lastError: text('last_error'),
  lastErrorType: text('last_error_type'),
});

export const webhookEndpoints = sqliteTable('webhook_endpoints', {
  id: text('id').primaryKey(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  url: text('url').notNull(),
  secret: text('secret').notNull(),
  eventMask: text('event_mask', { mode: 'json' }).$type<EventType[]>().notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const telegramBots = sqliteTable('telegram_bots', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  tokenEnc: text('token_enc').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  allowAuthRequests: integer('allow_auth_requests', { mode: 'boolean' }).notNull().default(true),
  lastUpdateId: integer('last_update_id'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

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

// device tree 中 window / pane 的自定义显示顺序（overlay，不触碰 tmux 真实布局）
// windows: 有序 windowId 列表；panes: windowId -> 有序 paneId 列表
export const deviceTreeOrder = sqliteTable('device_tree_order', {
  deviceId: text('device_id')
    .primaryKey()
    .references(() => devices.id, { onDelete: 'cascade' }),
  windows: text('windows', { mode: 'json' }).$type<string[]>().notNull().default([]),
  panes: text('panes', { mode: 'json' }).$type<Record<string, string[]>>().notNull().default({}),
  updatedAt: text('updated_at').notNull(),
});

// 设备管理页文件夹层级：parent_id 自引用不加 FK（删除时手动上提子项）。
export const deviceFolders = sqliteTable(
  'device_folders',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    parentId: text('parent_id'),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [index('device_folders_parent_id_idx').on(table.parentId)]
);

export const deviceFolderPlacements = sqliteTable(
  'device_folder_placements',
  {
    itemKey: text('item_key').primaryKey(),
    kind: text('kind').notNull(),
    nodeId: text('node_id').notNull(),
    deviceId: text('device_id'),
    folderId: text('folder_id').references(() => deviceFolders.id, { onDelete: 'cascade' }),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    check('device_folder_placements_kind_check', sql`${table.kind} in ('node', 'device')`),
    index('device_folder_placements_folder_id_idx').on(table.folderId),
  ]
);

// Files Tab 可访问目录白名单（树根）。每个根绑定到一个设备（local 走本地 rsync，ssh 走 rsync over ssh），
// 有独立启用开关。(deviceId, path) 唯一。
export const fileRoots = sqliteTable(
  'file_roots',
  {
    id: text('id').primaryKey(),
    deviceId: text('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: text('created_at').notNull(),
  },
  (table) => [unique('file_roots_device_path_unique').on(table.deviceId, table.path)]
);

export const telegramBotChats = sqliteTable(
  'telegram_bot_chats',
  {
    id: text('id').primaryKey(),
    botId: text('bot_id')
      .notNull()
      .references(() => telegramBots.id, { onDelete: 'cascade' }),
    chatId: text('chat_id').notNull(),
    chatType: text('chat_type').notNull(),
    displayName: text('display_name').notNull(),
    status: text('status').notNull(),
    appliedAt: text('applied_at').notNull(),
    authorizedAt: text('authorized_at'),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    unique('telegram_bot_chats_bot_chat_unique').on(table.botId, table.chatId),
    check('telegram_bot_chats_status_check', sql`${table.status} in ('pending', 'authorized')`),
    check(
      'telegram_bot_chats_chat_type_check',
      sql`${table.chatType} in ('private', 'group', 'supergroup', 'channel', 'unknown')`
    ),
  ]
);

// 微信 (iLink) 账号：扫码登录后写入凭证（botTokenEnc 加密落库）。未登录时凭证列为 null。
export const weixinAccounts = sqliteTable('weixin_accounts', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  allowAuthRequests: integer('allow_auth_requests', { mode: 'boolean' }).notNull().default(true),
  // iLink 登录确认返回：账号自身标识（uin）/ bearer token / baseurl。
  weixinUin: text('weixin_uin'),
  botTokenEnc: text('bot_token_enc'),
  baseUrl: text('base_url'),
  // 长轮询游标 get_updates_buf（重启续传）。
  syncBuf: text('sync_buf'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// 微信账号的会话对象：授权状态 + 半主动推送的最佳努力 context_token 缓存。
export const weixinAccountUsers = sqliteTable(
  'weixin_account_users',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => weixinAccounts.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    displayName: text('display_name').notNull(),
    status: text('status').notNull(),
    // 最近 inbound 消息的 context_token（iLink 发送必需，失效后置 needsReactivation）。
    lastContextToken: text('last_context_token'),
    lastInboundAt: text('last_inbound_at'),
    needsReactivation: integer('needs_reactivation', { mode: 'boolean' }).notNull().default(false),
    appliedAt: text('applied_at').notNull(),
    authorizedAt: text('authorized_at'),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    unique('weixin_account_users_account_user_unique').on(table.accountId, table.userId),
    check('weixin_account_users_status_check', sql`${table.status} in ('pending', 'authorized')`),
  ]
);

export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    username: text('username').notNull(),
    rootPublicKey: blob('root_public_key', { mode: 'buffer' }).notNull(),
    rootEpoch: integer('root_epoch').notNull(),
    kdfParamsJson: text('kdf_params_json').notNull(),
    totpRecordSeq: integer('totp_record_seq'),
    keyLogHeadSeq: integer('key_log_head_seq').notNull(),
    keyLogHeadHash: blob('key_log_head_hash', { mode: 'buffer' }).notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [uniqueIndex('users_username_unique').on(table.username)]
);

export const userKeys = sqliteTable(
  'user_keys',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    credentialId: blob('credential_id', { mode: 'buffer' }).notNull(),
    publicKey: blob('public_key', { mode: 'buffer' }).notNull(),
    rpId: text('rp_id').notNull(),
    origin: text('origin').notNull(),
    counter: integer('counter').notNull(),
    transports: text('transports', { mode: 'json' }).$type<string[]>().notNull().default([]),
    name: text('name'),
    logSeq: integer('log_seq').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [uniqueIndex('user_keys_credential_id_unique').on(table.credentialId)]
);

export const userKeyLog = sqliteTable(
  'user_key_log',
  {
    seq: integer('seq').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    prevHash: blob('prev_hash', { mode: 'buffer' }).notNull(),
    hash: blob('hash', { mode: 'buffer' }).notNull(),
    rootEpoch: integer('root_epoch').notNull(),
    type: text('type').notNull(),
    recordBytes: blob('record_bytes', { mode: 'buffer' }).notNull(),
    sig: blob('sig', { mode: 'buffer' }).notNull(),
    payloadJson: text('payload_json').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.seq] }),
    uniqueIndex('user_key_log_user_id_seq_unique').on(table.userId, table.seq),
    check(
      'user_key_log_type_check',
      sql`${table.type} in ('add-passkey', 'remove-passkey', 'rotate-root', 'set-totp', 'clear-totp', 'admit-node', 'revoke-node', 'reset-root', 'admit-hub', 'retire-hub', 'rotate-root-keep')`
    ),
  ]
);

export const nodeSessions = sqliteTable(
  'node_sessions',
  {
    sid: blob('sid', { mode: 'buffer' }).primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    viaNodeId: text('via_node_id').notNull(),
    sessPublicKey: blob('sess_public_key', { mode: 'buffer' }).notNull(),
    delegationMethod: text('delegation_method').notNull(),
    credentialId: blob('credential_id', { mode: 'buffer' }),
    issuedAt: integer('issued_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    hardExpiresAt: integer('hard_expires_at').notNull(),
    renewedAt: integer('renewed_at').notNull(),
    revokedAt: integer('revoked_at'),
  },
  (table) => [
    uniqueIndex('node_sessions_sid_unique').on(table.sid),
    index('node_sessions_user_id_via_node_id_idx').on(table.userId, table.viaNodeId),
    check(
      'node_sessions_delegation_method_check',
      sql`${table.delegationMethod} in ('root', 'passkey')`
    ),
  ]
);

export const nodeCerts = sqliteTable(
  'node_certs',
  {
    nodeId: text('node_id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    admitRecordSeq: integer('admit_record_seq').notNull(),
    certificateBytes: blob('certificate_bytes', { mode: 'buffer' }).notNull(),
    certSig: blob('cert_sig', { mode: 'buffer' }).notNull(),
    authorizationBytes: blob('authorization_bytes', { mode: 'buffer' }).notNull(),
    authorizationSig: blob('authorization_sig', { mode: 'buffer' }).notNull(),
    revokedLogSeq: integer('revoked_log_seq'),
  },
  (table) => [uniqueIndex('node_certs_node_id_unique').on(table.nodeId)]
);

export const nodes = sqliteTable(
  'nodes',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    status: text('status').notNull(),
    lastSeenAt: integer('last_seen_at'),
    version: text('version'),
    directCapable: integer('direct_capable', { mode: 'boolean' }).notNull().default(false),
    inventoryJson: text('inventory_json').notNull().default('{}'),
    inventoryVersion: integer('inventory_version').notNull().default(0),
    endpointsJson: text('endpoints_json').notNull().default('[]'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('nodes_id_unique').on(table.id),
    check('nodes_status_check', sql`${table.status} in ('enrolled', 'revoked')`),
  ]
);

export const enrollmentTokens = sqliteTable(
  'enrollment_tokens',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    enrollPublicKey: blob('enroll_public_key', { mode: 'buffer' }).notNull(),
    authorizationJson: text('authorization_json').notNull(),
    authorizationSig: blob('authorization_sig', { mode: 'buffer' }).notNull(),
    expiresAt: integer('expires_at').notNull(),
    usedAt: integer('used_at'),
    nodeId: text('node_id'),
  },
  (table) => [uniqueIndex('enrollment_tokens_enroll_public_key_unique').on(table.enrollPublicKey)]
);

export const nodeIdentity = sqliteTable(
  'node_identity',
  {
    id: integer('id').primaryKey(),
    nodeId: text('node_id').notNull(),
    hubUrl: text('hub_url'),
    privateKey: text('private_key').notNull(),
    x25519PrivateKey: text('x25519_private_key').notNull(),
    certificateJson: text('certificate_json').notNull(),
    certSig: blob('cert_sig', { mode: 'buffer' }).notNull(),
    userId: text('user_id'),
  },
  (table) => [check('node_identity_singleton_check', sql`${table.id} = 1`)]
);

export const peerCache = sqliteTable(
  'peer_cache',
  {
    nodeId: text('node_id').primaryKey(),
    name: text('name').notNull(),
    endpointsJson: text('endpoints_json').notNull().default('[]'),
    inventoryJson: text('inventory_json').notNull().default('{}'),
    directCapable: integer('direct_capable', { mode: 'boolean' }).notNull().default(false),
    lastSeenAt: integer('last_seen_at'),
    listVersion: integer('list_version').notNull().default(0),
  },
  (table) => [uniqueIndex('peer_cache_node_id_unique').on(table.nodeId)]
);

export const tlsConfig = sqliteTable(
  'tls_config',
  {
    id: integer('id').primaryKey(),
    mode: text('mode').notNull().default('none'),
    tlsPort: integer('tls_port').notNull().default(9443),
    bindHost: text('bind_host').notNull().default('0.0.0.0'),
    sans: text('sans', { mode: 'json' }).$type<string[]>().notNull().default([]),
    caCertPem: text('ca_cert_pem'),
    caKeyEnc: text('ca_key_enc'),
    certPem: text('cert_pem'),
    keyEnc: text('key_enc'),
    certNotBefore: integer('cert_not_before'),
    certNotAfter: integer('cert_not_after'),
    acmeEmail: text('acme_email'),
    acmeDomain: text('acme_domain'),
    acmeChallenge: text('acme_challenge'),
    acmeStaging: integer('acme_staging', { mode: 'boolean' }).notNull().default(false),
    acmeCfTokenEnc: text('acme_cf_token_enc'),
    acmeDnsProvider: text('acme_dns_provider'),
    acmeDnsSecretEnc: text('acme_dns_secret_enc'),
    acmeAccountKeyEnc: text('acme_account_key_enc'),
    acmeAccountUrl: text('acme_account_url'),
    acmeAccountDirectory: text('acme_account_directory'),
    acmeStatus: text('acme_status').notNull().default('idle'),
    acmeLastError: text('acme_last_error'),
    acmeLastAttemptAt: integer('acme_last_attempt_at'),
    acmeNextRenewAt: integer('acme_next_renew_at'),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    check('tls_config_singleton_check', sql`${table.id} = 1`),
    check(
      'tls_config_mode_check',
      sql`${table.mode} in ('none', 'external', 'selfsigned', 'acme')`
    ),
    check(
      'tls_config_acme_challenge_check',
      sql`${table.acmeChallenge} is null or ${table.acmeChallenge} in ('http-01', 'dns-01')`
    ),
    check(
      'tls_config_acme_status_check',
      sql`${table.acmeStatus} in ('idle', 'pending', 'ok', 'error')`
    ),
    check(
      'tls_config_acme_dns_provider_check',
      sql`${table.acmeDnsProvider} is null or ${table.acmeDnsProvider} in ('cloudflare', 'dnspod')`
    ),
  ]
);

export const hubTrust = sqliteTable('hub_trust', {
  hubUrl: text('hub_url').primaryKey(),
  caPem: text('ca_pem').notNull(),
  fingerprint: text('fingerprint').notNull(),
  createdAt: integer('created_at').notNull(),
});

export const meshHubs = sqliteTable('mesh_hubs', {
  hubNodeId: text('hub_node_id').primaryKey(),
  publicUrl: text('public_url').notNull(),
  name: text('name'),
  mode: text('mode').$type<'active' | 'standby'>().notNull(),
  priority: integer('priority').notNull(),
  writerEpoch: integer('writer_epoch').notNull(),
  caFingerprint: text('ca_fingerprint'),
  online: integer('online', { mode: 'boolean' }).notNull().default(false),
  lastSeenAt: integer('last_seen_at'),
  updatedAt: integer('updated_at').notNull(),
});

export const hubRoleTransitions = sqliteTable(
  'hub_role_transitions',
  {
    operationId: text('operation_id').primaryKey(),
    targetHubId: text('target_hub_id').notNull(),
    mode: text('mode').$type<'active' | 'standby'>().notNull(),
    writerEpoch: integer('writer_epoch'),
    phase: text('phase')
      .$type<'accepted' | 'persisting' | 'restarting' | 'complete' | 'failed'>()
      .notNull(),
    error: text('error'),
    startedAt: integer('started_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    check('hub_role_transitions_mode_check', sql`${table.mode} in ('active', 'standby')`),
    check(
      'hub_role_transitions_phase_check',
      sql`${table.phase} in ('accepted', 'persisting', 'restarting', 'complete', 'failed')`
    ),
    index('hub_role_transitions_updated_at_idx').on(table.updatedAt),
  ]
);

export const userHubAuthorizations = sqliteTable(
  'user_hub_authorizations',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    hubNodeId: text('hub_node_id').notNull(),
    status: text('status').$type<'active' | 'retired'>().notNull(),
    publicUrl: text('public_url'),
    priority: integer('priority'),
    admitSeq: integer('admit_seq').notNull(),
    retireSeq: integer('retire_seq'),
    updatedSeq: integer('updated_seq').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.hubNodeId] }),
    uniqueIndex('user_hub_authorizations_user_id_hub_node_id_unique').on(
      table.userId,
      table.hubNodeId
    ),
    check('user_hub_authorizations_status_check', sql`${table.status} in ('active', 'retired')`),
  ]
);

export const tunnelConfig = sqliteTable(
  'tunnel_config',
  {
    id: text('id').primaryKey(),
    mode: text('mode').notNull().default('off'),
    hostname: text('hostname'),
    tunnelName: text('tunnel_name'),
    tunnelId: text('tunnel_id'),
    autoStart: integer('auto_start', { mode: 'boolean' }).notNull().default(false),
    externallyManaged: integer('externally_managed', { mode: 'boolean' }).notNull().default(false),
    exposureAcknowledgedAt: text('exposure_acknowledged_at'),
    accessMode: text('access_mode').$type<TunnelAccessMode | null>(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    check('tunnel_config_singleton_check', sql`${table.id} = 'default'`),
    check('tunnel_config_mode_check', sql`${table.mode} in ('off', 'quick', 'named')`),
    check(
      'tunnel_config_access_mode_check',
      sql`${table.accessMode} in ('none', 'login', 'cloudflare')`
    ),
  ]
);

export const localAuthSettings = sqliteTable(
  'local_auth_settings',
  {
    id: text('id').primaryKey(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [check('local_auth_settings_singleton_check', sql`${table.id} = 'default'`)]
);

export const tunnelAccess = sqliteTable(
  'tunnel_access',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id'),
    apiTokenEnc: text('api_token_enc'),
    teamDomain: text('team_domain'),
    appId: text('app_id'),
    aud: text('aud'),
    hostname: text('hostname'),
    rulesJson: text('rules_json').notNull().default('[]'),
    enforceJwt: integer('enforce_jwt', { mode: 'boolean' }).notNull().default(false),
    lastError: text('last_error'),
    bypassAppId: text('bypass_app_id'),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [check('tunnel_access_singleton_check', sql`${table.id} = 'default'`)]
);

export const nodeAccessPolicy = sqliteTable(
  'node_access_policy',
  {
    id: integer('id').primaryKey(),
    allowDomainAccess: integer('allow_domain_access', { mode: 'boolean' }).notNull().default(true),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [check('node_access_policy_singleton_check', sql`${table.id} = 1`)]
);

export type UserRow = typeof users.$inferSelect;
export type UserKeyRow = typeof userKeys.$inferSelect;
export type UserKeyLogRow = typeof userKeyLog.$inferSelect;
export type NodeSessionRow = typeof nodeSessions.$inferSelect;
export type NodeCertRow = typeof nodeCerts.$inferSelect;
export type NodeRow = typeof nodes.$inferSelect;
export type EnrollmentTokenRow = typeof enrollmentTokens.$inferSelect;
export type NodeIdentityRow = typeof nodeIdentity.$inferSelect;
export type PeerCacheRow = typeof peerCache.$inferSelect;
export type TlsConfigRow = typeof tlsConfig.$inferSelect;
export type HubTrustRow = typeof hubTrust.$inferSelect;
export type MeshHubRow = typeof meshHubs.$inferSelect;
export type TunnelConfigRow = typeof tunnelConfig.$inferSelect;
export type TunnelAccessRow = typeof tunnelAccess.$inferSelect;
export type LocalAuthSettingsRow = typeof localAuthSettings.$inferSelect;
export type NodeAccessPolicyRow = typeof nodeAccessPolicy.$inferSelect;
