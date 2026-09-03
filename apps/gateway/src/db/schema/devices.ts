import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core';

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
