import { getDeviceById, getDeviceTreeOrder } from '../db';
import { t } from '../i18n';
import { getTreeOverlayBridge } from '../settings/broadcaster';
import { isTmuxPaneId } from '../tmux-client/snapshot-format';

// window/pane 排序与自定义名的 REST 入口，与 WS 同源：写路径经 settings/broadcaster
// 注册的桥复用 wsServer 的落库/内存 overlay 逻辑（含快照重广播与 'tree-order' 变更事件）。
export function handleTreeOrderApiRequest(
  req: Request,
  path: string
): Response | Promise<Response> | null {
  const treeOrderMatch = path.match(/^\/api\/devices\/([^/]+)\/tree-order$/);
  if (treeOrderMatch && req.method === 'GET') {
    return handleGetTreeOrder(decodeURIComponent(treeOrderMatch[1]));
  }
  if (treeOrderMatch && req.method === 'PUT') {
    return handlePutTreeOrder(req, decodeURIComponent(treeOrderMatch[1]));
  }

  const windowNameMatch = path.match(/^\/api\/devices\/([^/]+)\/windows\/([^/]+)\/name$/);
  if (windowNameMatch && req.method === 'PATCH') {
    return handlePatchWindowName(
      req,
      decodeURIComponent(windowNameMatch[1]),
      decodeURIComponent(windowNameMatch[2])
    );
  }

  const paneNameMatch = path.match(/^\/api\/devices\/([^/]+)\/panes\/([^/]+)\/name$/);
  if (paneNameMatch && req.method === 'PATCH') {
    return handlePatchPaneName(
      req,
      decodeURIComponent(paneNameMatch[1]),
      decodeURIComponent(paneNameMatch[2])
    );
  }

  return null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
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

  let body: { windows?: unknown; panes?: unknown };
  try {
    body = (await req.json()) as { windows?: unknown; panes?: unknown };
  } catch {
    return json({ error: t('apiError.invalidRequest') }, 400);
  }

  const hasWindows = body.windows !== undefined;
  const hasPanes = body.panes !== undefined;
  if (!hasWindows && !hasPanes) {
    return json({ error: t('apiError.invalidRequest') }, 400);
  }
  if (hasWindows && !isStringArray(body.windows)) {
    return json({ error: t('apiError.invalidRequest') }, 400);
  }
  if (
    hasPanes &&
    (typeof body.panes !== 'object' ||
      body.panes === null ||
      Array.isArray(body.panes) ||
      !Object.values(body.panes).every(isStringArray))
  ) {
    return json({ error: t('apiError.invalidRequest') }, 400);
  }

  const bridge = getTreeOverlayBridge();
  if (!bridge) {
    return json({ error: 'settings service not ready' }, 503);
  }

  if (hasWindows) {
    bridge.reorderWindows(deviceId, body.windows as string[]);
  }
  if (hasPanes) {
    for (const [windowId, paneIds] of Object.entries(body.panes as Record<string, string[]>)) {
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

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
