import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** 本节点（A）持有的端口映射：监听本机端口，把连接经 mesh 送到目标节点 B。 */
export const portMaps = sqliteTable(
  'port_maps',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    listenHost: text('listen_host').notNull().default('127.0.0.1'),
    listenPort: integer('listen_port').notNull(),
    targetNodeId: text('target_node_id').notNull(),
    targetHost: text('target_host').notNull().default('127.0.0.1'),
    targetPort: integer('target_port').notNull(),
    paused: integer('paused', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [index('port_maps_listen_idx').on(table.listenHost, table.listenPort)]
);

/** 本节点（B）对外放行的目标：只有 mapId 与来源节点都匹配的 tcp 流才允许拨号。 */
export const portMapExports = sqliteTable('port_map_exports', {
  mapId: text('map_id').primaryKey(),
  fromNodeId: text('from_node_id').notNull(),
  host: text('host').notNull().default('127.0.0.1'),
  port: integer('port').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at').notNull(),
});
