import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import type * as schema from '../db/schema';

export type AuthDb = BunSQLiteDatabase<typeof schema>;

export type ChallengeKind = 'login' | 'passkey-register' | 'passkey-login' | 'rtc-authorize';

export type DelegationMethod = 'root' | 'passkey';

export type NodeStatus = 'enrolled' | 'revoked';
