import type { TunnelMode } from '@tmex/shared';
import { eq } from 'drizzle-orm';
import type { AuthDb } from '../auth/types';
import { tunnelConfig } from '../db/schema';

export const TUNNEL_CONFIG_ID = 'default';

export type TunnelPersisted = {
  mode: TunnelMode;
  hostname: string | null;
  tunnelName: string | null;
  tunnelId: string | null;
  autoStart: boolean;
  updatedAt: string;
};

export const DEFAULT_TUNNEL_CONFIG: TunnelPersisted = {
  mode: 'off',
  hostname: null,
  tunnelName: null,
  tunnelId: null,
  autoStart: false,
  updatedAt: '',
};

export interface TunnelConfigStoreLike {
  get(): TunnelPersisted;
  save(patch: Partial<Omit<TunnelPersisted, 'updatedAt'>>): TunnelPersisted;
}

function asMode(value: string | null | undefined): TunnelMode {
  if (value === 'quick' || value === 'named' || value === 'off') return value;
  return 'off';
}

export class MemoryTunnelConfigStore implements TunnelConfigStoreLike {
  private row: TunnelPersisted = { ...DEFAULT_TUNNEL_CONFIG };

  get(): TunnelPersisted {
    return { ...this.row };
  }

  save(patch: Partial<Omit<TunnelPersisted, 'updatedAt'>>): TunnelPersisted {
    this.row = {
      ...this.row,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    return this.get();
  }
}

export class TunnelConfigStore implements TunnelConfigStoreLike {
  constructor(private readonly db: AuthDb) {}

  get(): TunnelPersisted {
    try {
      const row = this.db
        .select()
        .from(tunnelConfig)
        .where(eq(tunnelConfig.id, TUNNEL_CONFIG_ID))
        .get();
      if (!row) return { ...DEFAULT_TUNNEL_CONFIG };
      return {
        mode: asMode(row.mode),
        hostname: row.hostname ?? null,
        tunnelName: row.tunnelName ?? null,
        tunnelId: row.tunnelId ?? null,
        autoStart: Boolean(row.autoStart),
        updatedAt: row.updatedAt,
      };
    } catch {
      return { ...DEFAULT_TUNNEL_CONFIG };
    }
  }

  save(patch: Partial<Omit<TunnelPersisted, 'updatedAt'>>): TunnelPersisted {
    const current = this.get();
    const next: TunnelPersisted = {
      mode: patch.mode ?? current.mode,
      hostname: patch.hostname !== undefined ? patch.hostname : current.hostname,
      tunnelName: patch.tunnelName !== undefined ? patch.tunnelName : current.tunnelName,
      tunnelId: patch.tunnelId !== undefined ? patch.tunnelId : current.tunnelId,
      autoStart: patch.autoStart ?? current.autoStart,
      updatedAt: new Date().toISOString(),
    };
    const values = {
      id: TUNNEL_CONFIG_ID,
      mode: next.mode,
      hostname: next.hostname,
      tunnelName: next.tunnelName,
      tunnelId: next.tunnelId,
      autoStart: next.autoStart,
      updatedAt: next.updatedAt,
    };
    this.db
      .insert(tunnelConfig)
      .values(values)
      .onConflictDoUpdate({
        target: tunnelConfig.id,
        set: {
          mode: values.mode,
          hostname: values.hostname,
          tunnelName: values.tunnelName,
          tunnelId: values.tunnelId,
          autoStart: values.autoStart,
          updatedAt: values.updatedAt,
        },
      })
      .run();
    return next;
  }
}
