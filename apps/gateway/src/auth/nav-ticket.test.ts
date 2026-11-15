import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { gatewayKv } from '../db/schema';
import {
  NAV_KEY_KV,
  NAV_TICKET_TTL_MS,
  issueNavTicket,
  loadOrCreateNavKey,
  parseSetNavHeader,
  verifyNavTicket,
} from './nav-ticket';
import { NodeSessionStore } from './node-session-store';
import { createMigratedAuthDb } from './test-db';

const KEY = new Uint8Array(32).fill(3);
const NOW = 1_800_000_000_000;

describe('nav ticket', () => {
  test('is bound to the sid, the key and the 10 minute window', () => {
    const { ticket, expiresAt } = issueNavTicket(KEY, 'sid-a', NOW);
    expect(expiresAt).toBe(NOW + NAV_TICKET_TTL_MS);
    expect(verifyNavTicket(KEY, 'sid-a', ticket, NOW)).toBe(true);
    expect(verifyNavTicket(KEY, 'sid-a', ticket, NOW + NAV_TICKET_TTL_MS - 1)).toBe(true);
    expect(verifyNavTicket(KEY, 'sid-a', ticket, NOW + NAV_TICKET_TTL_MS)).toBe(false);
    expect(verifyNavTicket(KEY, 'sid-b', ticket, NOW)).toBe(false);
    expect(verifyNavTicket(new Uint8Array(32).fill(4), 'sid-a', ticket, NOW)).toBe(false);
  });

  test('rejects tampered, malformed and far-future tickets', () => {
    const { ticket } = issueNavTicket(KEY, 'sid-a', NOW);
    const raw = Buffer.from(ticket, 'base64url');
    raw[raw.length - 1] = (raw[raw.length - 1] ?? 0) ^ 1;
    expect(verifyNavTicket(KEY, 'sid-a', raw.toString('base64url'), NOW)).toBe(false);
    expect(verifyNavTicket(KEY, 'sid-a', '', NOW)).toBe(false);
    expect(verifyNavTicket(KEY, 'sid-a', 'a.b', NOW)).toBe(false);
    expect(verifyNavTicket(KEY, 'sid-a', ticket.slice(2), NOW)).toBe(false);
    const future = issueNavTicket(KEY, 'sid-a', NOW + 60_000).ticket;
    expect(verifyNavTicket(KEY, 'sid-a', future, NOW)).toBe(false);
  });

  test('the key is generated once per node and survives a new store', () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const first = new NodeSessionStore(db).navKey();
      expect(first.byteLength).toBe(32);
      expect(new NodeSessionStore(db).navKey()).toEqual(first);
      expect(loadOrCreateNavKey(db)).toEqual(first);
      expect(db.select().from(gatewayKv).where(eq(gatewayKv.key, NAV_KEY_KV)).get()).toBeTruthy();
    } finally {
      close();
    }
  });

  test('parses the internal set-nav header', () => {
    expect(parseSetNavHeader('abc;600')).toEqual({ ticket: 'abc', maxAgeSec: 600 });
    expect(parseSetNavHeader(';0')).toEqual({ ticket: '', maxAgeSec: 0 });
    expect(parseSetNavHeader('abc')).toBeNull();
    expect(parseSetNavHeader('a b;1')).toBeNull();
    expect(parseSetNavHeader('abc;-1')).toBeNull();
    expect(parseSetNavHeader(null)).toBeNull();
  });
});
