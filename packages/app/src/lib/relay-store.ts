import {
  MeshRelayStore,
  RELAY_LOG_KEY_EPOCH,
} from '../../../../apps/gateway/src/auth/mesh-relay-store';
import { t } from '../i18n';
import type { LocalAuthContext } from './local-auth';

export type RelayTargetRow = {
  url: string;
  tenantId: string;
  token: Uint8Array;
  priority: number;
};

export function sameRelay(
  a: { url: string; tenantId: string },
  b: { url: string; tenantId: string }
): boolean {
  return a.url === b.url && a.tenantId.toLowerCase() === b.tenantId.toLowerCase();
}

/** 按 priority 排序，同一 url 只留第一行（`mesh_relays.url` 是主键）；priority 原样保留。 */
function rankedTable(table: readonly RelayTargetRow[]): RelayTargetRow[] {
  const seen = new Set<string>();
  return [...table]
    .sort((a, b) => a.priority - b.priority)
    .filter((row) => !seen.has(row.url) && seen.add(row.url));
}

/**
 * 令牌加入落库的中继表：r3 的令牌来自铸造节点的 `mesh_relays`（本身是 `set-relays` 的投影），
 * 且兑换到的密钥日志必含 r3 锚点，所以日志里的 `set-relays` 不会比 r3 旧——有表就原样落表
 * （与网关 `reconcile()` 写入的一致）。只有日志里没有 `set-relays`（旧日志/夹具）时才用 r3 的中继表。
 */
export function relaysForTokenJoin(
  table: readonly RelayTargetRow[] | undefined,
  entries: readonly Omit<RelayTargetRow, 'priority'>[]
): RelayTargetRow[] {
  if (table && table.length > 0) return rankedTable(table);
  return rankedTable(entries.map((entry, priority) => ({ ...entry, priority })));
}

/**
 * 密码加入落库的中继表：以 `set-relays` 表为底，封存包里新签发的令牌覆盖同一台中继的旧令牌。
 * 该中继不在表中返回 null（调用方按未授权处理）。
 */
export function overlayRelayToken(
  table: readonly RelayTargetRow[] | undefined,
  joined: Omit<RelayTargetRow, 'priority'>
): RelayTargetRow[] | null {
  const rows = rankedTable(table ?? []);
  if (!rows.some((row) => sameRelay(row, joined))) return null;
  return rows.map((row) => (sameRelay(row, joined) ? { ...row, token: joined.token } : row));
}

/**
 * `relay join` 走 r3 串时的节点侧落库：整表替换 `mesh_relays`、写入 K_log、把上级切成 relay。
 * K_meta 要等承认本节点的那条 `meta-key` 记录到达才有，这里不写。
 */
export async function persistRelayUplink(
  ctx: LocalAuthContext,
  input: {
    relays: readonly RelayTargetRow[];
    logKey: Uint8Array;
    metaKey?: { epoch: number; key: Uint8Array };
    name?: string | null;
    now?: number;
  }
): Promise<string[]> {
  if (input.relays.length === 0) {
    throw new Error('relay join produced no relay targets');
  }
  const store = new MeshRelayStore(ctx.db);
  const now = input.now ?? Date.now();
  await store.replaceRelays(input.relays, now);
  await store.putSecret('log', RELAY_LOG_KEY_EPOCH, input.logKey, now);
  if (input.metaKey) {
    await store.putSecret('meta', input.metaKey.epoch, input.metaKey.key, now);
  }
  store.setUplinkKind('relay');
  if (input.name) {
    store.setLocalName(input.name);
  }
  return input.relays.map((row) => row.url);
}

/** 仅用于换发令牌的路径：那里不重写 `mesh_relays`，只能回读。 */
export function persistedRelayUrls(ctx: LocalAuthContext): string[] {
  return new MeshRelayStore(ctx.db).listRelayRows().map((row) => row.url);
}

/** 加入后除实际使用的那台外还配置了哪些中继；只有一台时没有这一行。 */
export function alsoConfiguredLine(usedUrl: string, relayUrls: readonly string[]): string | null {
  const others = relayUrls.filter((url) => url !== usedUrl);
  return others.length > 0 ? t('relay.join.alsoConfigured', { urls: others.join(', ') }) : null;
}

export function readRelayUplink(ctx: LocalAuthContext): {
  kind: 'relay' | 'none';
  relays: ReturnType<MeshRelayStore['listRelayRows']>;
  name: string | null;
} {
  const store = new MeshRelayStore(ctx.db);
  return {
    kind: store.uplinkKind(),
    relays: store.listRelayRows(),
    name: store.localName(),
  };
}
