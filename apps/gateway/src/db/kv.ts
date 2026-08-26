import { eq } from 'drizzle-orm';
import { getDb as getOrmDb } from './client';
import { gatewayKv } from './schema';

export function getGatewayKv(key: string): string | null {
  const orm = getOrmDb();
  const row = orm.select().from(gatewayKv).where(eq(gatewayKv.key, key)).get();
  return row?.value ?? null;
}

export function setGatewayKv(key: string, value: string): void {
  const orm = getOrmDb();
  const now = new Date().toISOString();
  orm
    .insert(gatewayKv)
    .values({ key, value, updatedAt: now })
    .onConflictDoUpdate({ target: gatewayKv.key, set: { value, updatedAt: now } })
    .run();
}
