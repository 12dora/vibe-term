import { eq } from 'drizzle-orm';
import type { AuthDb } from '../auth/types';
import { portMapExports, portMaps } from '../db/schema';
import type { PortMapExportRow, PortMapRow } from './types';

export type PortMapPatch = {
  name?: string;
  paused?: boolean;
  updatedAt: number;
};

export interface PortMapStoreLike {
  list(): PortMapRow[];
  get(id: string): PortMapRow | null;
  insert(row: PortMapRow): void;
  update(id: string, patch: PortMapPatch): void;
  remove(id: string): void;
}

export interface PortMapExportStoreLike {
  list(): PortMapExportRow[];
  get(mapId: string): PortMapExportRow | null;
  insert(row: PortMapExportRow): void;
  remove(mapId: string): void;
}

type PortMapDbRow = typeof portMaps.$inferSelect;
type PortMapExportDbRow = typeof portMapExports.$inferSelect;

function toRow(row: PortMapDbRow): PortMapRow {
  return {
    id: row.id,
    name: row.name,
    listenHost: row.listenHost,
    listenPort: row.listenPort,
    targetNodeId: row.targetNodeId,
    targetHost: row.targetHost,
    targetPort: row.targetPort,
    paused: Boolean(row.paused),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toExportRow(row: PortMapExportDbRow): PortMapExportRow {
  return {
    mapId: row.mapId,
    fromNodeId: row.fromNodeId,
    host: row.host,
    port: row.port,
    enabled: Boolean(row.enabled),
    createdAt: row.createdAt,
  };
}

export class PortMapStore implements PortMapStoreLike {
  constructor(private readonly db: AuthDb) {}

  list(): PortMapRow[] {
    return this.db.select().from(portMaps).all().map(toRow);
  }

  get(id: string): PortMapRow | null {
    const row = this.db.select().from(portMaps).where(eq(portMaps.id, id)).get();
    return row ? toRow(row) : null;
  }

  insert(row: PortMapRow): void {
    this.db.insert(portMaps).values(row).run();
  }

  update(id: string, patch: PortMapPatch): void {
    const values: Partial<PortMapDbRow> = { updatedAt: patch.updatedAt };
    if (patch.name !== undefined) values.name = patch.name;
    if (patch.paused !== undefined) values.paused = patch.paused;
    this.db.update(portMaps).set(values).where(eq(portMaps.id, id)).run();
  }

  remove(id: string): void {
    this.db.delete(portMaps).where(eq(portMaps.id, id)).run();
  }
}

export class PortMapExportStore implements PortMapExportStoreLike {
  constructor(private readonly db: AuthDb) {}

  list(): PortMapExportRow[] {
    return this.db.select().from(portMapExports).all().map(toExportRow);
  }

  get(mapId: string): PortMapExportRow | null {
    const row = this.db.select().from(portMapExports).where(eq(portMapExports.mapId, mapId)).get();
    return row ? toExportRow(row) : null;
  }

  insert(row: PortMapExportRow): void {
    this.db
      .insert(portMapExports)
      .values(row)
      .onConflictDoUpdate({
        target: portMapExports.mapId,
        set: {
          fromNodeId: row.fromNodeId,
          host: row.host,
          port: row.port,
          enabled: row.enabled,
          createdAt: row.createdAt,
        },
      })
      .run();
  }

  remove(mapId: string): void {
    this.db.delete(portMapExports).where(eq(portMapExports.mapId, mapId)).run();
  }
}

export class MemoryPortMapStore implements PortMapStoreLike {
  private readonly rows = new Map<string, PortMapRow>();

  list(): PortMapRow[] {
    return [...this.rows.values()].map((row) => ({ ...row }));
  }

  get(id: string): PortMapRow | null {
    const row = this.rows.get(id);
    return row ? { ...row } : null;
  }

  insert(row: PortMapRow): void {
    this.rows.set(row.id, { ...row });
  }

  update(id: string, patch: PortMapPatch): void {
    const row = this.rows.get(id);
    if (!row) return;
    this.rows.set(id, {
      ...row,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.paused !== undefined ? { paused: patch.paused } : {}),
      updatedAt: patch.updatedAt,
    });
  }

  remove(id: string): void {
    this.rows.delete(id);
  }
}

export class MemoryPortMapExportStore implements PortMapExportStoreLike {
  private readonly rows = new Map<string, PortMapExportRow>();

  list(): PortMapExportRow[] {
    return [...this.rows.values()].map((row) => ({ ...row }));
  }

  get(mapId: string): PortMapExportRow | null {
    const row = this.rows.get(mapId);
    return row ? { ...row } : null;
  }

  insert(row: PortMapExportRow): void {
    this.rows.set(row.mapId, { ...row });
  }

  remove(mapId: string): void {
    this.rows.delete(mapId);
  }
}
