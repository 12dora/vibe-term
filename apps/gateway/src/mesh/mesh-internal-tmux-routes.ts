import { findPaneInSnapshot } from '../agent/tools/pane-info';
import { json, readJsonObjectBody } from '../api/http';
import { type ApiRoute, dispatchRoutes, route } from '../api/route';
import { getDeviceById } from '../db';
import type { PaneInfo } from '../tmux-client/capture-history';
import { tmuxRuntimeRegistry } from '../tmux-client/registry';
import { isTmuxPaneId } from '../tmux-client/snapshot-format';
import { readMeshPeerMarker } from './peer-request-marker';
import { jsonError } from './session-middleware';

export const MESH_INTERNAL_TMUX_PREFIX = '/api/mesh-internal/tmux';
const HISTORY_LINES_MAX = 2000;

export type MeshInternalTmuxRuntime = {
  connect(): Promise<void>;
  isConnected(): boolean;
  sendInputAndWait(paneId: string, data: string): Promise<void>;
  capturePaneText(paneId: string, opts?: { historyLines?: number }): Promise<string>;
  getPaneInfo(paneId: string): Promise<PaneInfo>;
};

export type MeshInternalTmuxDeps = {
  acquire(deviceId: string): Promise<MeshInternalTmuxRuntime>;
  release(deviceId: string, runtime: MeshInternalTmuxRuntime): Promise<void>;
  deviceExists(deviceId: string): boolean;
};

const defaultMeshInternalTmuxDeps: MeshInternalTmuxDeps = {
  acquire: (deviceId) => tmuxRuntimeRegistry.acquire(deviceId),
  release: (deviceId, runtime) => tmuxRuntimeRegistry.release(deviceId, runtime),
  deviceExists: (deviceId) => {
    try {
      return getDeviceById(deviceId) != null;
    } catch {
      return false;
    }
  },
};

function requirePeerMarker(req: Request): Response | null {
  if (readMeshPeerMarker(req)) {
    return null;
  }
  return jsonError('FORBIDDEN', 403);
}

function readRequiredIds(
  raw: Record<string, unknown>,
  deps: MeshInternalTmuxDeps
): { deviceId: string; paneId: string } | Response {
  const deviceId = typeof raw.deviceId === 'string' ? raw.deviceId.trim() : '';
  const paneId = typeof raw.paneId === 'string' ? raw.paneId : '';
  if (!deviceId || !isTmuxPaneId(paneId)) {
    return json({ error: 'invalid_request' }, 400);
  }
  if (!deps.deviceExists(deviceId)) {
    return json({ error: 'device_not_found' }, 404);
  }
  return { deviceId, paneId };
}

function readHistoryLines(raw: unknown): { ok: true; value?: number } | { ok: false } {
  if (raw === undefined) {
    return { ok: true };
  }
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw > HISTORY_LINES_MAX) {
    return { ok: false };
  }
  return { ok: true, value: raw };
}

async function withDeviceRuntime<T>(
  deviceId: string,
  deps: MeshInternalTmuxDeps,
  fn: (runtime: MeshInternalTmuxRuntime) => Promise<T>
): Promise<T> {
  const runtime = await deps.acquire(deviceId);
  try {
    if (!runtime.isConnected()) {
      await runtime.connect();
    }
    if (!runtime.isConnected()) {
      throw new Error('runtime not connected');
    }
    return await fn(runtime);
  } finally {
    await deps.release(deviceId, runtime);
  }
}

async function handlePaneInfo(req: Request, deps: MeshInternalTmuxDeps): Promise<Response> {
  const raw = await readJsonObjectBody(req);
  if (!raw) {
    return json({ error: 'invalid_request' }, 400);
  }
  const ids = readRequiredIds(raw, deps);
  if (ids instanceof Response) {
    return ids;
  }
  try {
    const info = await withDeviceRuntime(ids.deviceId, deps, (runtime) =>
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

async function handleCapture(req: Request, deps: MeshInternalTmuxDeps): Promise<Response> {
  const raw = await readJsonObjectBody(req);
  if (!raw) {
    return json({ error: 'invalid_request' }, 400);
  }
  const ids = readRequiredIds(raw, deps);
  if (ids instanceof Response) {
    return ids;
  }
  const historyLines = readHistoryLines(raw.historyLines);
  if (!historyLines.ok) {
    return json({ error: 'invalid_request' }, 400);
  }
  try {
    const text = await withDeviceRuntime(ids.deviceId, deps, (runtime) =>
      runtime.capturePaneText(
        ids.paneId,
        historyLines.value === undefined ? undefined : { historyLines: historyLines.value }
      )
    );
    return json({ text });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'capture_failed' }, 502);
  }
}

async function handleSendInput(req: Request, deps: MeshInternalTmuxDeps): Promise<Response> {
  const raw = await readJsonObjectBody(req);
  if (!raw) {
    return json({ error: 'invalid_request' }, 400);
  }
  const ids = readRequiredIds(raw, deps);
  if (ids instanceof Response) {
    return ids;
  }
  if (typeof raw.data !== 'string') {
    return json({ error: 'invalid_request' }, 400);
  }
  try {
    await withDeviceRuntime(ids.deviceId, deps, async (runtime) => {
      await runtime.sendInputAndWait(ids.paneId, raw.data as string);
    });
    return json({ ok: true });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'send_input_failed' }, 502);
  }
}

export function createMeshInternalTmuxRoutes(
  deps: MeshInternalTmuxDeps = defaultMeshInternalTmuxDeps
): ApiRoute[] {
  return [
    route({
      method: 'POST',
      path: `${MESH_INTERNAL_TMUX_PREFIX}/pane-info`,
      handler: (req) => handlePaneInfo(req, deps),
    }),
    route({
      method: 'POST',
      path: `${MESH_INTERNAL_TMUX_PREFIX}/capture`,
      handler: (req) => handleCapture(req, deps),
    }),
    route({
      method: 'POST',
      path: `${MESH_INTERNAL_TMUX_PREFIX}/send-input`,
      handler: (req) => handleSendInput(req, deps),
    }),
  ];
}

export async function handleMeshInternalTmuxRequest(
  req: Request,
  deps: MeshInternalTmuxDeps = defaultMeshInternalTmuxDeps
): Promise<Response> {
  const denied = requirePeerMarker(req);
  if (denied) {
    return denied;
  }
  const path = new URL(req.url).pathname;
  const matched = dispatchRoutes(req, path, createMeshInternalTmuxRoutes(deps), { path });
  if (matched) {
    return matched;
  }
  return jsonError('NOT_FOUND', 404);
}

export function isMeshInternalPath(path: string): boolean {
  return path === '/api/mesh-internal' || path.startsWith('/api/mesh-internal/');
}
