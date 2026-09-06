// 汇聚机侧入口：接收其它节点转发来的通知事件，用**本机**的通知渠道发出去。
//
// 安全约束：只走对端链路（`requirePeerMarker` 由 mesh-internal 总入口统一把关），
// body 里的 `origin.nodeId` 必须与对端标记一致且是本机认识的 mesh 节点；
// 用户没签过本机的 `notification-sink` 声明、或本机开关没打开，一律 404
// （对方据此丢弃，不再重试）。

import type { DeviceType, EventType, WebhookEvent } from '@vibeterm/shared';
import { MESH_INTERNAL_NOTIFICATION_ROUTE, isEventType } from '@vibeterm/shared';
import { json, readJsonObjectBody } from '../api/http';
import { type ApiRoute, route } from '../api/route';
import { getSiteSettings } from '../db';
import { eventNotifier } from '../events';
import { IdleLruMap, TokenBucket } from '../hub/uplink-rate-limit';
import { getMeshAgentBridge } from './mesh-agent-bridge';
import { getMeshNotificationBridge } from './notification-mesh-bridge';
import { resolveMeshNodeDisplayName } from './notification-origin-name';
import { readMeshPeerMarker } from './peer-request-marker';

export { MESH_INTERNAL_NOTIFICATION_ROUTE };

/** 每来源节点每分钟 60 条，突发按同额度放行。 */
export const MESH_NOTIFY_INBOUND_RATE_PER_MIN = 60;
/** 桶表容量与空闲回收阈值：闲置满一个补充窗口的桶本来就已满额，回收它不放宽任何限流。 */
const RATE_STATE_MAX = 1024;
const RATE_STATE_IDLE_TTL_MS = 60_000;

type IncomingEvent = Omit<WebhookEvent, 'eventType' | 'timestamp'>;

export type MeshInternalNotificationDeps = {
  sinkEnabled(): boolean;
  knownNode(nodeId: string): boolean;
  /** 来源节点的显示名：只查本机元数据，不看 body。 */
  nodeName(nodeId: string): string | null;
  notify(eventType: EventType, event: IncomingEvent): Promise<void>;
  site(): { name: string; url: string };
  now(): number;
  log?(line: string): void;
};

const defaultDeps: MeshInternalNotificationDeps = {
  // 签名声明 + 本机开关：任一不成立都不收（桥不在 = 没有 mesh，同样不收）。
  sinkEnabled: () => getMeshNotificationBridge()?.selfSinkEnabled() === true,
  knownNode: (nodeId) => getMeshAgentBridge()?.lookupNode(nodeId) !== 'unknown',
  nodeName: (nodeId) => resolveMeshNodeDisplayName(nodeId),
  notify: (eventType, event) => eventNotifier.notify(eventType, event),
  site: () => {
    const settings = getSiteSettings();
    return { name: settings.siteName, url: settings.siteUrl };
  },
  now: () => Date.now(),
};

// 空闲回收 + LRU 淘汰：新来源不再 clear() 整张表，否则一台机器换 64 个来源就能把
// 已经打满的来源重新放行。
const buckets = new IdleLruMap<TokenBucket>(RATE_STATE_MAX, RATE_STATE_IDLE_TTL_MS);

function takeToken(nodeId: string, now: number): boolean {
  const existing = buckets.touch(nodeId, now);
  const bucket =
    existing ??
    buckets.set(
      nodeId,
      new TokenBucket(MESH_NOTIFY_INBOUND_RATE_PER_MIN, MESH_NOTIFY_INBOUND_RATE_PER_MIN),
      now
    );
  return bucket.take(now);
}

export function resetMeshNotificationRateLimit(): void {
  buckets.clear();
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parseDevice(raw: unknown): WebhookEvent['device'] | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const id = str(row.id);
  const name = str(row.name);
  const type = row.type === 'ssh' || row.type === 'local' ? (row.type as DeviceType) : null;
  if (!id || !name || !type) return null;
  const host = str(row.host);
  return { id, name, type, ...(host ? { host } : {}) };
}

function parseTmux(raw: unknown): WebhookEvent['tmux'] | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const row = raw as Record<string, unknown>;
  const out: NonNullable<WebhookEvent['tmux']> = {};
  const texts = [
    'sessionName',
    'windowId',
    'paneId',
    'paneUrl',
    'paneTitle',
    'paneCurrentCommand',
  ] as const;
  for (const key of texts) {
    const value = str(row[key]);
    if (value !== undefined) out[key] = value;
  }
  for (const key of ['windowIndex', 'paneIndex'] as const) {
    const value = num(row[key]);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function parsePayload(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? { ...(raw as Record<string, unknown>) }
    : {};
}

type ParsedBody = {
  eventType: EventType;
  device: WebhookEvent['device'];
  tmux: WebhookEvent['tmux'];
  payload: Record<string, unknown>;
};

/** body 形状校验：来源已由对端标记认证，这里只保证字段类型不脏进通知模板。 */
export function parseForwardBody(
  raw: Record<string, unknown>,
  originNodeId: string
): ParsedBody | null {
  if (!isEventType(raw.eventType)) return null;
  const origin = raw.origin;
  if (!origin || typeof origin !== 'object') return null;
  const originRow = origin as Record<string, unknown>;
  if (originRow.nodeId !== originNodeId) return null;
  const event = raw.event;
  if (!event || typeof event !== 'object') return null;
  const eventRow = event as Record<string, unknown>;
  const device = parseDevice(eventRow.device);
  if (!device) return null;
  // origin.nodeName 由发送方控制，一律忽略：显示名在汇聚机侧按标记 id 自己查。
  return {
    eventType: raw.eventType,
    device,
    tmux: parseTmux(eventRow.tmux),
    payload: parsePayload(eventRow.payload),
  };
}

async function handleForward(req: Request, deps: MeshInternalNotificationDeps): Promise<Response> {
  if (!deps.sinkEnabled()) return json({ error: 'not_found' }, 404);
  const originNodeId = readMeshPeerMarker(req);
  if (!originNodeId || !deps.knownNode(originNodeId)) return json({ error: 'forbidden' }, 403);
  if (!takeToken(originNodeId, deps.now())) return json({ error: 'rate_limited' }, 429);
  const raw = await readJsonObjectBody(req);
  if (!raw) return json({ error: 'invalid_request' }, 400);
  const parsed = parseForwardBody(raw, originNodeId);
  if (!parsed) return json({ error: 'invalid_request' }, 400);
  const originName = deps.nodeName(originNodeId) ?? originNodeId;
  // 不等本机渠道扇出完成：webhook 慢一秒就会把发送方那条队列卡住，这里只负责收下。
  void deps
    .notify(parsed.eventType, {
      site: deps.site(),
      device: parsed.device,
      ...(parsed.tmux ? { tmux: parsed.tmux } : {}),
      payload: { ...parsed.payload, nodeId: originNodeId, nodeName: originName },
    })
    .catch((err: unknown) => {
      const log = deps.log ?? ((line: string) => console.warn(line));
      log(`[notify] mesh forward notify failed origin=${originNodeId} err=${String(err)}`);
    });
  return json({ ok: true }, 202);
}

export function createMeshInternalNotificationRoutes(
  deps: MeshInternalNotificationDeps = defaultDeps
): ApiRoute[] {
  return [
    route({
      method: 'POST',
      path: MESH_INTERNAL_NOTIFICATION_ROUTE,
      handler: (req) => handleForward(req, deps),
    }),
  ];
}
