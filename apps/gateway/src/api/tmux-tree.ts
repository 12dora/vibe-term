import type { StateSnapshotPayload, TmuxSession } from '@tmex/shared';
import { getAllDevices, getDeviceById, getDeviceTreeOrder } from '../db';
import { t } from '../i18n';
import { pushSupervisor } from '../push/supervisor';
import { getTreeOverlayBridge } from '../settings/broadcaster';
import { getDeviceSnapshot } from '../tmux/snapshot-directory';
import { applyCustomNamesOverlay, applyDeviceTreeOverlay } from '../ws/overlay-utils';

export interface DeviceTreeEntry {
  deviceId: string;
  deviceName: string;
  session: TmuxSession | null;
}

// device→session→window→pane 树快照的 REST 读端点，供脚本/CLI 等非 WS 客户端消费。
// 数据与 WS 快照同源：优先 wsServer 的 lastSnapshot（有活跃客户端时事件驱动刷新），
// 回落 pushSupervisor 的常驻连接快照；下发前套用与 WS 相同的排序/自定义名 overlay 链。
export function handleTmuxTreeApiRequest(
  req: Request,
  path: string
): Response | Promise<Response> | null {
  if (path === '/api/tmux/tree' && req.method === 'GET') {
    const deviceId = new URL(req.url).searchParams.get('deviceId');
    return handleGetTmuxTree(deviceId);
  }

  return null;
}

function resolveDeviceTree(deviceId: string, deviceName: string): DeviceTreeEntry {
  const snapshot: StateSnapshotPayload | null =
    getDeviceSnapshot(deviceId) ?? pushSupervisor.getLastSnapshot(deviceId);

  if (!snapshot) {
    return { deviceId, deviceName, session: null };
  }

  const ordered = applyDeviceTreeOverlay(snapshot, getDeviceTreeOrder(deviceId));
  const names = getTreeOverlayBridge()?.getCustomNames(deviceId) ?? { windows: {}, panes: {} };
  const named = applyCustomNamesOverlay(ordered, names);
  return { deviceId, deviceName, session: named.session };
}

async function handleGetTmuxTree(deviceId: string | null): Promise<Response> {
  if (deviceId !== null) {
    const device = getDeviceById(deviceId);
    if (!device) {
      return json({ error: t('apiError.deviceNotFound') }, 404);
    }
    return json({ devices: [resolveDeviceTree(device.id, device.name)] });
  }

  const devices = getAllDevices().map((device) => resolveDeviceTree(device.id, device.name));
  return json({ devices });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
