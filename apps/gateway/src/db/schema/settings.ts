import { DEFAULT_TERMINAL_SHORTCUTS } from '@tmex/shared';
import type { TerminalShortcutItem, TunnelAccessMode } from '@tmex/shared';
import { sql } from 'drizzle-orm';
import { check, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

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

export type TlsConfigRow = typeof tlsConfig.$inferSelect;
export type TunnelConfigRow = typeof tunnelConfig.$inferSelect;
export type TunnelAccessRow = typeof tunnelAccess.$inferSelect;
export type LocalAuthSettingsRow = typeof localAuthSettings.$inferSelect;
export type NodeAccessPolicyRow = typeof nodeAccessPolicy.$inferSelect;
