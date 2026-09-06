import {
  PaneGenerationError,
  type PaneGrantVerifier,
  assertPaneGeneration,
  defaultPaneGrantVerifier,
  guardPaneGrant,
  paneGrantDenied,
  readPaneGrantRef,
  toServerEpochHex,
} from '../agent/pane-grant/rpc-guard';
import { findPaneInSnapshot } from '../agent/tools/pane-info';
import { json, readJsonObjectBody } from '../api/http';
import { type ApiRoute, dispatchRoutes, route } from '../api/route';
import { getDeviceById } from '../db';
import { createMeshInternalPortMapRoutes } from '../portmap/internal-routes';
import type { PaneInfo } from '../tmux-client/capture-history';
import { tmuxRuntimeRegistry } from '../tmux-client/registry';
import { isTmuxPaneId } from '../tmux-client/snapshot-format';
import { createMeshInternalTransferRoutes } from '../transfer/mesh-routes';
import { createMeshInternalNotificationRoutes } from './mesh-internal-notifications-routes';
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
  /** tmux server 世代（`@vibeterm-server-epoch`）；连上之后才有值。 */
  getServerEpoch?(): Uint8Array | null;
};

export type MeshInternalTmuxDeps = {
  acquire(deviceId: string): Promise<MeshInternalTmuxRuntime>;
  release(deviceId: string, runtime: MeshInternalTmuxRuntime): Promise<void>;
  deviceExists(deviceId: string): boolean;
  verifyGrant: PaneGrantVerifier;
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
  verifyGrant: defaultPaneGrantVerifier,
};

function requirePeerMarker(req: Request): Response | null {
  if (readMeshPeerMarker(req)) {
    return null;
  }
  return jsonError('FORBIDDEN', 403);
}

type GrantedPane = {
  deviceId: string;
  paneId: string;
  granted: { grantId: string | null; serverEpoch: string | null };
};

/** 顺序固定：先校验入参与设备，再验授权——授权失败的回应不该泄漏别的窗格是否存在。 */
function readRequiredIds(
  req: Request,
  raw: Record<string, unknown>,
  deps: MeshInternalTmuxDeps
): GrantedPane | Response {
  const deviceId = typeof raw.deviceId === 'string' ? raw.deviceId.trim() : '';
  const paneId = typeof raw.paneId === 'string' ? raw.paneId : '';
  if (!deviceId || !isTmuxPaneId(paneId)) {
    return json({ error: 'invalid_request' }, 400);
  }
  if (!deps.deviceExists(deviceId)) {
    return json({ error: 'device_not_found' }, 404);
  }
  const guarded = guardPaneGrant(
    {
      grant: readPaneGrantRef(raw.grant),
      peerNodeId: readMeshPeerMarker(req) ?? '',
      deviceId,
      paneId,
    },
    deps.verifyGrant
  );
  if (!guarded.ok) {
    return guarded.denied;
  }
  return { deviceId, paneId, granted: guarded };
}

/** RPC 失败的统一出口：世代对不上是授权问题（403），其余当目标侧故障（502）。 */
function rpcFailure(error: unknown, fallback: string): Response {
  if (error instanceof PaneGenerationError) {
    return paneGrantDenied('PANE_GRANT_INVALID');
  }
  return json({ error: error instanceof Error ? error.message : fallback }, 502);
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

async function withGrantedPane<T>(
  ids: GrantedPane,
  deps: MeshInternalTmuxDeps,
  fn: (runtime: MeshInternalTmuxRuntime) => Promise<T>
): Promise<T> {
  const runtime = await deps.acquire(ids.deviceId);
  try {
    if (!runtime.isConnected()) {
      await runtime.connect();
    }
    if (!runtime.isConnected()) {
      throw new Error('runtime not connected');
    }
    assertPaneGeneration(ids.granted, toServerEpochHex(runtime.getServerEpoch?.()));
    return await fn(runtime);
  } finally {
    await deps.release(ids.deviceId, runtime);
  }
}

async function handlePaneInfo(req: Request, deps: MeshInternalTmuxDeps): Promise<Response> {
  const raw = await readJsonObjectBody(req);
  if (!raw) {
    return json({ error: 'invalid_request' }, 400);
  }
  const ids = readRequiredIds(req, raw, deps);
  if (ids instanceof Response) {
    return ids;
  }
  try {
    const info = await withGrantedPane(ids, deps, (runtime) => runtime.getPaneInfo(ids.paneId));
    const snapshot = findPaneInSnapshot(ids.deviceId, ids.paneId);
    return json({
      info,
      snapshot: snapshot.found ? snapshot.context : null,
      snapshotExists: snapshot.found || snapshot.snapshotExists,
    });
  } catch (error) {
    return rpcFailure(error, 'pane_info_failed');
  }
}

async function handleCapture(req: Request, deps: MeshInternalTmuxDeps): Promise<Response> {
  const raw = await readJsonObjectBody(req);
  if (!raw) {
    return json({ error: 'invalid_request' }, 400);
  }
  const ids = readRequiredIds(req, raw, deps);
  if (ids instanceof Response) {
    return ids;
  }
  const historyLines = readHistoryLines(raw.historyLines);
  if (!historyLines.ok) {
    return json({ error: 'invalid_request' }, 400);
  }
  try {
    const text = await withGrantedPane(ids, deps, (runtime) =>
      runtime.capturePaneText(
        ids.paneId,
        historyLines.value === undefined ? undefined : { historyLines: historyLines.value }
      )
    );
    return json({ text });
  } catch (error) {
    return rpcFailure(error, 'capture_failed');
  }
}

async function handleSendInput(req: Request, deps: MeshInternalTmuxDeps): Promise<Response> {
  const raw = await readJsonObjectBody(req);
  if (!raw) {
    return json({ error: 'invalid_request' }, 400);
  }
  const ids = readRequiredIds(req, raw, deps);
  if (ids instanceof Response) {
    return ids;
  }
  if (typeof raw.data !== 'string') {
    return json({ error: 'invalid_request' }, 400);
  }
  try {
    await withGrantedPane(ids, deps, async (runtime) => {
      await runtime.sendInputAndWait(ids.paneId, raw.data as string);
    });
    return json({ ok: true });
  } catch (error) {
    return rpcFailure(error, 'send_input_failed');
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
  const routes = [
    ...createMeshInternalTmuxRoutes(deps),
    ...createMeshInternalNotificationRoutes(),
    ...createMeshInternalTransferRoutes(),
    ...createMeshInternalPortMapRoutes(),
  ];
  const matched = dispatchRoutes(req, path, routes, { path });
  if (matched) {
    return matched;
  }
  return jsonError('NOT_FOUND', 404);
}

export function isMeshInternalPath(path: string): boolean {
  return path === '/api/mesh-internal' || path.startsWith('/api/mesh-internal/');
}
