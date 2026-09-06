// 汇聚机侧入口：接收其它节点转发来的通知事件，用**本机**的通知渠道发出去。
//
// 安全约束：只走对端链路（`requirePeerMarker` 由 mesh-internal 总入口统一把关），
// body 里的 `origin.nodeId` 必须与对端标记一致且是本机认识的 mesh 节点；
// 本机开关没打开时一律 404（对方据此丢弃，不再重试）。

import type { DeviceType, EventType, WebhookEvent } from '@tmex/shared';
import { MESH_INTERNAL_NOTIFICATION_ROUTE, isEventType } from '@tmex/shared';
import { json, readJsonObjectBody } from '../api/http';
import { type ApiRoute, route } from '../api/route';
import { getSiteSettings } from '../db';
import { eventNotifier } from '../events';
import { TokenBucket } from '../hub/uplink-rate-limit';
import { getMeshAgentBridge } from './mesh-agent-bridge';
import { isMeshNotificationSinkEnabled } from './notification-sink-state';
import { readMeshPeerMarker } from './peer-request-marker';

export { MESH_INTERNAL_NOTIFICATION_ROUTE };

/** 每来源节点每分钟 60 条，突发按同额度放行。 */
export const MESH_NOTIFY_INBOUND_RATE_PER_MIN = 60;
const RATE_STATE_MAX = 64;

type IncomingEvent = Omit<WebhookEvent, 'eventType' | 'timestamp'>;

export type MeshInternalNotificationDeps = {
  sinkEnabled(): boolean;
  knownNode(nodeId: string): boolean;
  notify(eventType: EventType, event: IncomingEvent): Promise<void>;
  site(): { name: string; url: string };
  now(): number;
};

const defaultDeps: MeshInternalNotificationDeps = {
  sinkEnabled: () => isMeshNotificationSinkEnabled(),
  knownNode: (nodeId) => getMeshAgentBridge()?.lookupNode(nodeId) !== 'unknown',
  notify: (eventType, event) => eventNotifier.notify(eventType, event),
  site: () => {
    const settings = getSiteSettings();
    return { name: settings.siteName, url: settings.siteUrl };
  },
  now: () => Date.now(),
};

const buckets = new Map<string, TokenBucket>();

function takeToken(nodeId: string, now: number): boolean {
  let bucket = buckets.get(nodeId);
  if (!bucket) {
    if (buckets.size >= RATE_STATE_MAX) buckets.clear();
    bucket = new TokenBucket(MESH_NOTIFY_INBOUND_RATE_PER_MIN, MESH_NOTIFY_INBOUND_RATE_PER_MIN);
    buckets.set(nodeId, bucket);
  }
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
  originName: string;
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
  return {
    eventType: raw.eventType,
    device,
    tmux: parseTmux(eventRow.tmux),
    payload: parsePayload(eventRow.payload),
    originName: str(originRow.nodeName) ?? originNodeId,
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
  await deps.notify(parsed.eventType, {
    site: deps.site(),
    device: parsed.device,
    ...(parsed.tmux ? { tmux: parsed.tmux } : {}),
    payload: { ...parsed.payload, nodeId: originNodeId, nodeName: parsed.originName },
  });
  return json({ ok: true });
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
