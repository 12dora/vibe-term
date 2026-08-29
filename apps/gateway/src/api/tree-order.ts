import { getDeviceById, getDeviceTreeOrder } from '../db';
import { t } from '../i18n';
import { getTreeOverlayBridge } from '../settings/broadcaster';
import { isTmuxPaneId } from '../tmux-client/snapshot-format';
import { type ConfigFieldSpec, applyConfigFields, parseStringArrayField } from './config-field';
import { json } from './http';
import { type ApiRoute, route } from './route';

// window/pane 排序与自定义名的 REST 入口，与 WS 同源：写路径经 settings/broadcaster
// 注册的桥复用 wsServer 的落库/内存 overlay 逻辑（含快照重广播与 'tree-order' 变更事件）。

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isPaneOrderMap(value: unknown): value is Record<string, string[]> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(isStringArray)
  );
}

type TreeOrderPatch = {
  windows?: string[];
  panes?: Record<string, string[]>;
};

const TREE_ORDER_FIELDS: ConfigFieldSpec<unknown>[] = [
  {
    name: 'windows',
    parse: (raw) => parseStringArrayField(raw, t('apiError.invalidRequest')),
  },
  {
    name: 'panes',
    parse: (raw) =>
      isPaneOrderMap(raw)
        ? { ok: true, value: raw }
        : { ok: false, error: t('apiError.invalidRequest') },
  },
];

function parseTreeOrderPatch(
  body: unknown
): { ok: true; fields: TreeOrderPatch } | { ok: false; error: string } {
  const parsed = applyConfigFields<TreeOrderPatch>(
    body as Record<string, unknown>,
    TREE_ORDER_FIELDS,
    undefined
  );
  if (!parsed.ok) return parsed;
  if (parsed.fields.windows === undefined && parsed.fields.panes === undefined) {
    return { ok: false, error: t('apiError.invalidRequest') };
  }
  return { ok: true, fields: parsed.fields };
}

async function handleGetTreeOrder(deviceId: string): Promise<Response> {
  if (!getDeviceById(deviceId)) {
    return json({ error: t('apiError.deviceNotFound') }, 404);
  }

  const order = getDeviceTreeOrder(deviceId);
  const names = getTreeOverlayBridge()?.getCustomNames(deviceId) ?? { windows: {}, panes: {} };
  return json({
    deviceId,
    windows: order.windows,
    panes: order.panes,
    windowNames: names.windows,
    paneNames: names.panes,
  });
}

async function handlePutTreeOrder(req: Request, deviceId: string): Promise<Response> {
  if (!getDeviceById(deviceId)) {
    return json({ error: t('apiError.deviceNotFound') }, 404);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: t('apiError.invalidRequest') }, 400);
  }

  const parsed = parseTreeOrderPatch(body);
  if (!parsed.ok) return json({ error: parsed.error }, 400);

  const bridge = getTreeOverlayBridge();
  if (!bridge) {
    return json({ error: 'settings service not ready' }, 503);
  }

  if (parsed.fields.windows !== undefined) {
    bridge.reorderWindows(deviceId, parsed.fields.windows);
  }
  if (parsed.fields.panes !== undefined) {
    for (const [windowId, paneIds] of Object.entries(parsed.fields.panes)) {
      bridge.reorderPanes(deviceId, windowId, paneIds);
    }
  }

  const order = getDeviceTreeOrder(deviceId);
  return json({ deviceId, windows: order.windows, panes: order.panes });
}

async function handlePatchWindowName(
  req: Request,
  deviceId: string,
  windowId: string
): Promise<Response> {
  if (!getDeviceById(deviceId)) {
    return json({ error: t('apiError.deviceNotFound') }, 404);
  }

  const name = await readNameBody(req);
  if (name === null) {
    return json({ error: t('apiError.invalidRequest') }, 400);
  }

  const bridge = getTreeOverlayBridge();
  if (!bridge) {
    return json({ error: 'settings service not ready' }, 503);
  }

  bridge.renameWindow(deviceId, windowId, name);
  return json({ deviceId, windowId, name: name.trim().slice(0, 64) });
}

async function handlePatchPaneName(
  req: Request,
  deviceId: string,
  paneId: string
): Promise<Response> {
  if (!getDeviceById(deviceId)) {
    return json({ error: t('apiError.deviceNotFound') }, 404);
  }
  if (!isTmuxPaneId(paneId)) {
    return json({ error: t('apiError.invalidRequest') }, 400);
  }

  const name = await readNameBody(req);
  if (name === null) {
    return json({ error: t('apiError.invalidRequest') }, 400);
  }

  const bridge = getTreeOverlayBridge();
  if (!bridge) {
    return json({ error: 'settings service not ready' }, 503);
  }

  bridge.renamePane(deviceId, paneId, name);
  return json({ deviceId, paneId, name: name.trim().slice(0, 64) });
}

async function readNameBody(req: Request): Promise<string | null> {
  try {
    const body = (await req.json()) as { name?: unknown };
    return typeof body.name === 'string' ? body.name : null;
  } catch {
    return null;
  }
}

export const treeOrderRoutes: ApiRoute[] = [
  route({
    method: 'GET',
    path: '/api/devices/:id/tree-order',
    handler: (_req, params) => handleGetTreeOrder(decodeURIComponent(params.id)),
  }),
  route({
    method: 'PUT',
    path: '/api/devices/:id/tree-order',
    handler: (req, params) => handlePutTreeOrder(req, decodeURIComponent(params.id)),
  }),
  route({
    method: 'PATCH',
    path: '/api/devices/:id/windows/:windowId/name',
    handler: (req, params) =>
      handlePatchWindowName(
        req,
        decodeURIComponent(params.id),
        decodeURIComponent(params.windowId)
      ),
  }),
  route({
    method: 'PATCH',
    path: '/api/devices/:id/panes/:paneId/name',
    handler: (req, params) =>
      handlePatchPaneName(req, decodeURIComponent(params.id), decodeURIComponent(params.paneId)),
  }),
];
