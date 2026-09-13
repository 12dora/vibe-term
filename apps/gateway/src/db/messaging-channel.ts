// 消息通道 parent+child CRUD：表与列由 descriptor 注入，不改表结构。

import { and, count, desc as descOrder, eq } from 'drizzle-orm';
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';
import { getDb as getOrmDb } from './client';
import { aggregateByParent } from './stats';

export interface MessagingStatusCounters {
  pending: number;
  authorized: number;
}

export type MessagingChildStatsRow = {
  parentId: unknown;
  status: unknown;
} & Record<string, unknown>;

export function emptyStatusCounters(): MessagingStatusCounters {
  return { pending: 0, authorized: 0 };
}

export function foldStatusCounters(current: MessagingStatusCounters, status: unknown): void {
  if (status === 'pending') current.pending += 1;
  if (status === 'authorized') current.authorized += 1;
}

export interface MessagingChannelTables {
  parent: SQLiteTable;
  child: SQLiteTable;
  parentId: SQLiteColumn;
  parentCreatedAt: SQLiteColumn;
  childId: SQLiteColumn;
  childParentId: SQLiteColumn;
  childExternalId: SQLiteColumn;
  childStatus: SQLiteColumn;
  childAppliedAt: SQLiteColumn;
  childAuthorizedAt: SQLiteColumn;
}

export interface MessagingChannelDesc<
  TParentRow,
  TParent extends { id: string },
  TChildRow,
  TChild extends { id: string },
  TCounters extends MessagingStatusCounters,
  TStats,
> {
  tables: MessagingChannelTables;
  toParent: (row: TParentRow) => TParent;
  toChild: (row: TChildRow) => TChild;
  emptyCounters: () => TCounters;
  foldChild: (acc: TCounters, row: MessagingChildStatsRow) => void;
  toStats: (parent: TParent, counters: TCounters) => TStats;
  extraStatsColumns?: Record<string, SQLiteColumn>;
  updateKeys: readonly string[];
}

export interface MessagingChannelStore<TParent, TChild, TStats> {
  create(values: object): void;
  getById(id: string): TParent | null;
  list(): TParent[];
  listWithStats(): TStats[];
  update(id: string, patch: object): TParent | null;
  remove(id: string): void;
  countChildren(parentId: string): number;
  getChild(parentId: string, externalId: string): TChild | null;
  listChildren(parentId: string): TChild[];
  listAuthorized(parentId: string): TChild[];
  approveChild(parentId: string, externalId: string): TChild | null;
  deleteChild(parentId: string, externalId: string): void;
}

interface InternalSpec {
  tables: MessagingChannelTables;
  toParent: (row: unknown) => { id: string };
  toChild: (row: unknown) => { id: string };
  emptyCounters: () => MessagingStatusCounters;
  foldChild: (acc: MessagingStatusCounters, row: MessagingChildStatsRow) => void;
  toStats: (parent: { id: string }, counters: MessagingStatusCounters) => unknown;
  extraStatsColumns?: Record<string, SQLiteColumn>;
  updateKeys: readonly string[];
}

function insertParent(tables: MessagingChannelTables, values: Record<string, unknown>): void {
  getOrmDb()
    .insert(tables.parent)
    .values(values as never)
    .run();
}

function mapParent(spec: InternalSpec, id: string): { id: string } | null {
  const row = getOrmDb()
    .select()
    .from(spec.tables.parent)
    .where(eq(spec.tables.parentId, id))
    .get();
  if (!row) return null;
  return spec.toParent(row);
}

function listParents(spec: InternalSpec): { id: string }[] {
  return getOrmDb()
    .select()
    .from(spec.tables.parent)
    .orderBy(descOrder(spec.tables.parentCreatedAt))
    .all()
    .map((row) => spec.toParent(row));
}

function listParentsWithStats(spec: InternalSpec): unknown[] {
  const orm = getOrmDb();
  const parents = orm
    .select()
    .from(spec.tables.parent)
    .orderBy(descOrder(spec.tables.parentCreatedAt))
    .all();
  const childRows = orm
    .select({
      parentId: spec.tables.childParentId,
      status: spec.tables.childStatus,
      ...(spec.extraStatsColumns ?? {}),
    })
    .from(spec.tables.child)
    .all();
  const counters = aggregateByParent(
    childRows,
    (row) => String(row.parentId),
    spec.emptyCounters,
    (acc, row) => spec.foldChild(acc, row)
  );
  return parents.map((row) => {
    const parent = spec.toParent(row);
    return spec.toStats(parent, counters.get(parent.id) ?? spec.emptyCounters());
  });
}

function updateParent(
  spec: InternalSpec,
  id: string,
  patch: Record<string, unknown>
): { id: string } | null {
  const setValues: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  for (const key of spec.updateKeys) {
    if (patch[key] !== undefined) setValues[key] = patch[key];
  }
  getOrmDb()
    .update(spec.tables.parent)
    .set(setValues as never)
    .where(eq(spec.tables.parentId, id))
    .run();
  return mapParent(spec, id);
}

function deleteParent(tables: MessagingChannelTables, id: string): void {
  getOrmDb().delete(tables.parent).where(eq(tables.parentId, id)).run();
}

function countChildRows(tables: MessagingChannelTables, parentId: string): number {
  const row = getOrmDb()
    .select({ total: count() })
    .from(tables.child)
    .where(eq(tables.childParentId, parentId))
    .get();
  return Number(row?.total ?? 0);
}

function loadChildRow(
  tables: MessagingChannelTables,
  parentId: string,
  externalId: string
): unknown {
  return getOrmDb()
    .select()
    .from(tables.child)
    .where(and(eq(tables.childParentId, parentId), eq(tables.childExternalId, externalId)))
    .get();
}

function mapChild(spec: InternalSpec, parentId: string, externalId: string): { id: string } | null {
  const row = loadChildRow(spec.tables, parentId, externalId);
  if (!row) return null;
  return spec.toChild(row);
}

function listChildRows(
  spec: InternalSpec,
  parentId: string,
  authorizedOnly: boolean
): { id: string }[] {
  const { tables } = spec;
  const parentEq = eq(tables.childParentId, parentId);
  const where = authorizedOnly ? and(parentEq, eq(tables.childStatus, 'authorized')) : parentEq;
  const orderCol = authorizedOnly ? tables.childAuthorizedAt : tables.childAppliedAt;
  return getOrmDb()
    .select()
    .from(tables.child)
    .where(where)
    .orderBy(descOrder(orderCol))
    .all()
    .map((row) => spec.toChild(row));
}

function approveChildRow(
  spec: InternalSpec,
  parentId: string,
  externalId: string
): { id: string } | null {
  const existing = mapChild(spec, parentId, externalId);
  if (!existing) return null;
  const now = new Date().toISOString();
  getOrmDb()
    .update(spec.tables.child)
    .set({ status: 'authorized', authorizedAt: now, updatedAt: now } as never)
    .where(eq(spec.tables.childId, existing.id))
    .run();
  return mapChild(spec, parentId, externalId);
}

function deleteChildRow(
  tables: MessagingChannelTables,
  parentId: string,
  externalId: string
): void {
  getOrmDb()
    .delete(tables.child)
    .where(and(eq(tables.childParentId, parentId), eq(tables.childExternalId, externalId)))
    .run();
}

export function createMessagingChannelStore<
  TParentRow,
  TParent extends { id: string },
  TChildRow,
  TChild extends { id: string },
  TCounters extends MessagingStatusCounters,
  TStats,
>(
  spec: MessagingChannelDesc<TParentRow, TParent, TChildRow, TChild, TCounters, TStats>
): MessagingChannelStore<TParent, TChild, TStats> {
  const inner = spec as unknown as InternalSpec;
  return {
    create: (values) => insertParent(inner.tables, values as Record<string, unknown>),
    getById: (id) => mapParent(inner, id) as TParent | null,
    list: () => listParents(inner) as TParent[],
    listWithStats: () => listParentsWithStats(inner) as TStats[],
    update: (id, patch) =>
      updateParent(inner, id, patch as Record<string, unknown>) as TParent | null,
    remove: (id) => deleteParent(inner.tables, id),
    countChildren: (parentId) => countChildRows(inner.tables, parentId),
    getChild: (parentId, externalId) => mapChild(inner, parentId, externalId) as TChild | null,
    listChildren: (parentId) => listChildRows(inner, parentId, false) as TChild[],
    listAuthorized: (parentId) => listChildRows(inner, parentId, true) as TChild[],
    approveChild: (parentId, externalId) =>
      approveChildRow(inner, parentId, externalId) as TChild | null,
    deleteChild: (parentId, externalId) => deleteChildRow(inner.tables, parentId, externalId),
  };
}
