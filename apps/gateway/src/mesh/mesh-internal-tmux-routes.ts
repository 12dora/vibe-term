import { findPaneInSnapshot } from '../agent/tools/pane-info';
import { json, readJsonObjectBody } from '../api/http';
import { type ApiRoute, dispatchRoutes, route } from '../api/route';
import { tmuxRuntimeRegistry } from '../tmux-client/registry';
import { readMeshPeerMarker } from './peer-request-marker';
import { jsonError } from './session-middleware';

export const MESH_INTERNAL_TMUX_PREFIX = '/api/mesh-internal/tmux';

function requirePeerMarker(req: Request): Response | null {
  if (readMeshPeerMarker(req)) {
    return null;
  }
  return jsonError('FORBIDDEN', 403);
}

function readRequiredIds(
  raw: Record<string, unknown>
): { deviceId: string; paneId: string } | Response {
  const deviceId = typeof raw.deviceId === 'string' ? raw.deviceId.trim() : '';
  const paneId = typeof raw.paneId === 'string' ? raw.paneId.trim() : '';
  if (!deviceId || !paneId) {
    return json({ error: 'invalid_request' }, 400);
  }
  return { deviceId, paneId };
}

async function withDeviceRuntime<T>(
  deviceId: string,
  fn: (runtime: Awaited<ReturnType<typeof tmuxRuntimeRegistry.acquire>>) => Promise<T>
): Promise<T> {
  const runtime = await tmuxRuntimeRegistry.acquire(deviceId);
  try {
    return await fn(runtime);
  } finally {
    await tmuxRuntimeRegistry.release(deviceId, runtime);
  }
}

async function handlePaneInfo(req: Request): Promise<Response> {
  const raw = await readJsonObjectBody(req);
  if (!raw) {
    return json({ error: 'invalid_request' }, 400);
  }
  const ids = readRequiredIds(raw);
  if (ids instanceof Response) {
    return ids;
  }
  try {
    const info = await withDeviceRuntime(ids.deviceId, (runtime) =>
      runtime.getPaneInfo(ids.paneId)
    );
    const snapshot = findPaneInSnapshot(ids.deviceId, ids.paneId);
    return json({
      info,
      snapshot: snapshot.found ? snapshot.context : null,
      snapshotExists: snapshot.found || snapshot.snapshotExists,
    });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'pane_info_failed' }, 502);
  }
}

async function handleCapture(req: Request): Promise<Response> {
  const raw = await readJsonObjectBody(req);
  if (!raw) {
    return json({ error: 'invalid_request' }, 400);
  }
  const ids = readRequiredIds(raw);
  if (ids instanceof Response) {
    return ids;
  }
  const historyLines =
    typeof raw.historyLines === 'number' && Number.isFinite(raw.historyLines)
      ? raw.historyLines
      : undefined;
  try {
    const text = await withDeviceRuntime(ids.deviceId, (runtime) =>
      runtime.capturePaneText(ids.paneId, historyLines === undefined ? undefined : { historyLines })
    );
    return json({ text });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'capture_failed' }, 502);
  }
}

async function handleSendInput(req: Request): Promise<Response> {
  const raw = await readJsonObjectBody(req);
  if (!raw) {
    return json({ error: 'invalid_request' }, 400);
  }
  const ids = readRequiredIds(raw);
  if (ids instanceof Response) {
    return ids;
  }
  if (typeof raw.data !== 'string') {
    return json({ error: 'invalid_request' }, 400);
  }
  try {
    await withDeviceRuntime(ids.deviceId, async (runtime) => {
      await runtime.sendInput(ids.paneId, raw.data as string);
    });
    return json({ ok: true });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'send_input_failed' }, 502);
  }
}

export function createMeshInternalTmuxRoutes(): ApiRoute[] {
  return [
    route({
      method: 'POST',
      path: `${MESH_INTERNAL_TMUX_PREFIX}/pane-info`,
      handler: (req) => handlePaneInfo(req),
    }),
    route({
      method: 'POST',
      path: `${MESH_INTERNAL_TMUX_PREFIX}/capture`,
      handler: (req) => handleCapture(req),
    }),
    route({
      method: 'POST',
      path: `${MESH_INTERNAL_TMUX_PREFIX}/send-input`,
      handler: (req) => handleSendInput(req),
    }),
  ];
}

const meshInternalTmuxRoutes = createMeshInternalTmuxRoutes();

export async function handleMeshInternalTmuxRequest(req: Request): Promise<Response> {
  const denied = requirePeerMarker(req);
  if (denied) {
    return denied;
  }
  const path = new URL(req.url).pathname;
  const matched = dispatchRoutes(req, path, meshInternalTmuxRoutes, { path });
  if (matched) {
    return matched;
  }
  return jsonError('NOT_FOUND', 404);
}

export function isMeshInternalPath(path: string): boolean {
  return path === '/api/mesh-internal' || path.startsWith('/api/mesh-internal/');
}
