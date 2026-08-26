import type { WebhookEndpoint } from '@tmex/shared';
import { desc, eq } from 'drizzle-orm';
import { getDb as getOrmDb } from './client';
import { toWebhookEndpoint } from './mappers';
import { webhookEndpoints } from './schema';

export function createWebhookEndpoint(endpoint: WebhookEndpoint): void {
  const orm = getOrmDb();
  orm
    .insert(webhookEndpoints)
    .values({
      id: endpoint.id,
      enabled: endpoint.enabled,
      url: endpoint.url,
      secret: endpoint.secret,
      eventMask: endpoint.eventMask,
      createdAt: endpoint.createdAt,
      updatedAt: endpoint.updatedAt,
    })
    .run();
}

export function getAllWebhookEndpoints(): WebhookEndpoint[] {
  const orm = getOrmDb();
  return orm
    .select()
    .from(webhookEndpoints)
    .orderBy(desc(webhookEndpoints.createdAt))
    .all()
    .map(toWebhookEndpoint);
}

export function deleteWebhookEndpoint(id: string): void {
  const orm = getOrmDb();
  orm.delete(webhookEndpoints).where(eq(webhookEndpoints.id, id)).run();
}
