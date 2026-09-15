import { getGatewayKv, setGatewayKv } from '../db/kv';
import type { WindowOomMarkStore } from './types';

export const WINDOW_MEMORY_OOM_MARKS_KV_KEY = 'windowMemory.oomMarks';

export type WindowOomMarkKv = {
  get(key: string): string | null;
  set(key: string, value: string): void;
};

export type WindowOomMarkRecord = {
  deviceId: string;
  windowId: string;
  scope: string;
  oomKills: number;
  firstAt: number;
  lastAt: number;
};

type StoredMark = {
  scope: string;
  oomKills: number;
  firstAt: number;
  lastAt: number;
};

export type WindowOomMarkStoreImpl = WindowOomMarkStore & {
  list(): WindowOomMarkRecord[];
};

function markKey(deviceId: string, windowId: string): string {
  return `${deviceId}/${windowId}`;
}

function parseKey(key: string): { deviceId: string; windowId: string } | null {
  const split = key.indexOf('/');
  if (split <= 0 || split === key.length - 1) return null;
  return { deviceId: key.slice(0, split), windowId: key.slice(split + 1) };
}

function isStoredMark(value: unknown): value is StoredMark {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.scope === 'string' &&
    typeof row.oomKills === 'number' &&
    Number.isFinite(row.oomKills) &&
    typeof row.firstAt === 'number' &&
    Number.isFinite(row.firstAt) &&
    typeof row.lastAt === 'number' &&
    Number.isFinite(row.lastAt)
  );
}

function loadMap(kv: WindowOomMarkKv): Map<string, StoredMark> {
  const map = new Map<string, StoredMark>();
  let raw: string | null = null;
  try {
    raw = kv.get(WINDOW_MEMORY_OOM_MARKS_KV_KEY);
  } catch {
    return map;
  }
  if (!raw) return map;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return map;
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (parseKey(key) && isStoredMark(value)) map.set(key, value);
    }
  } catch {
    return map;
  }
  return map;
}

export function createWindowOomMarkStore(
  kv: WindowOomMarkKv,
  now: () => number = () => Date.now()
): WindowOomMarkStoreImpl {
  const marks = loadMap(kv);

  function persist(): void {
    kv.set(WINDOW_MEMORY_OOM_MARKS_KV_KEY, JSON.stringify(Object.fromEntries(marks)));
  }

  return {
    has(deviceId, windowId) {
      return marks.has(markKey(deviceId, windowId));
    },
    mark(deviceId, windowId, scope, oomKills) {
      const key = markKey(deviceId, windowId);
      const prev = marks.get(key);
      const at = now();
      marks.set(key, {
        scope,
        oomKills,
        firstAt: prev?.firstAt ?? at,
        lastAt: at,
      });
      persist();
    },
    clear(deviceId, windowId) {
      if (!marks.delete(markKey(deviceId, windowId))) return;
      persist();
    },
    list() {
      const rows: WindowOomMarkRecord[] = [];
      for (const [key, mark] of marks) {
        const parsed = parseKey(key);
        if (!parsed) continue;
        rows.push({ ...parsed, ...mark });
      }
      return rows;
    },
  };
}

let singleton: WindowOomMarkStoreImpl | null = null;

export function getWindowOomMarkStore(): WindowOomMarkStoreImpl {
  singleton ??= createWindowOomMarkStore({
    get: getGatewayKv,
    set: setGatewayKv,
  });
  return singleton;
}

export function resetWindowOomMarkStoreForTests(): void {
  singleton = null;
}
