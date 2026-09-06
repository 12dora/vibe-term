import { describe, expect, test } from 'bun:test';
import { dispatchRoutes } from '../api/route';
import { X_TMEX_MESH_PEER } from '../mesh/peer-request-marker';
import { createMeshInternalPortMapRoutes, meshInternalExportPath } from './internal-routes';
import { MemoryPortMapExportStore } from './store';
import type { PortMapExportRow } from './types';

const PEER = 'a'.repeat(32);
const OTHER = 'b'.repeat(32);

function exportRow(mapId: string, fromNodeId: string): PortMapExportRow {
  return { mapId, fromNodeId, host: '127.0.0.1', port: 5432, enabled: true, createdAt: 1 };
}

async function call(
  store: MemoryPortMapExportStore,
  mapId: string,
  peer: string | null
): Promise<{ status: number; json: Record<string, unknown> }> {
  const path = meshInternalExportPath(mapId);
  const url = `http://node${path}`;
  const req = new Request(url, {
    method: 'POST',
    headers: peer ? { [X_TMEX_MESH_PEER]: peer } : {},
  });
  const res = await dispatchRoutes(
    req,
    path,
    createMeshInternalPortMapRoutes(() => store),
    {
      path,
    }
  );
  if (!res) throw new Error(`no route for ${path}`);
  const resolved = await res;
  return { status: resolved.status, json: (await resolved.json()) as Record<string, unknown> };
}

describe('portmap mesh-internal routes', () => {
  test('removes the export the calling peer owns', async () => {
    const store = new MemoryPortMapExportStore();
    store.insert(exportRow('map-00000001', PEER));
    const res = await call(store, 'map-00000001', PEER);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, removed: true });
    expect(store.get('map-00000001')).toBeNull();
  });

  test('keeps an export that belongs to another node', async () => {
    const store = new MemoryPortMapExportStore();
    store.insert(exportRow('map-00000002', OTHER));
    const res = await call(store, 'map-00000002', PEER);
    expect(res.status).toBe(403);
    expect(store.get('map-00000002')).not.toBeNull();
  });

  test('requires the peer marker and stays idempotent', async () => {
    const store = new MemoryPortMapExportStore();
    store.insert(exportRow('map-00000003', PEER));
    expect((await call(store, 'map-00000003', null)).status).toBe(403);
    expect(store.get('map-00000003')).not.toBeNull();
    expect((await call(store, 'map-00000009', PEER)).json).toEqual({ ok: true, removed: true });
  });
});
