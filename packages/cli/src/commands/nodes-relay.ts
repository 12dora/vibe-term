// `vibeterm nodes relay ls|switch|rm|readmit|unpin`

import { RELAY_RECORD_MAX_RELAYS } from '@vibeterm/shared/auth';
import {
  type SubHandler,
  confirmOrYes,
  dash,
  emit,
  rejectExtra,
  requireArg,
  yn,
} from '../core/cmd';
import { UsageError } from '../core/errors';
import { type RelayStatusJson, type RelayStatusRow, fetchRelayStatus } from '../core/nodes-relay';
import { readmitStaleMembers, removeRelay, switchMeshRelay } from '../core/nodes-relay-ops';
import type { Column } from '../core/output';

function formatTurn(turn: { url: string; probeOk: boolean | null } | null | undefined): string {
  if (!turn?.url) return '-';
  if (turn.probeOk === false) return `${turn.url} (down)`;
  if (turn.probeOk === true) return `${turn.url} (ok)`;
  return turn.url;
}

function hasAutoSelect(status: RelayStatusJson | null): boolean {
  const view = (status as { autoSelect?: unknown } | null)?.autoSelect;
  return Boolean(view && typeof view === 'object');
}

function autoCell(row: RelayStatusRow): string {
  if (row.pinned) return 'pinned';
  if (row.autoSelected) return 'auto';
  return '-';
}

function relayLsColumns(showAuto: boolean): Column<RelayStatusRow>[] {
  const columns: Column<RelayStatusRow>[] = [
    { header: 'PRI', value: (row) => dash(row.priority) },
    { header: 'URL', value: (row) => row.url },
    { header: 'ROLE', value: (row) => dash(row.role) },
  ];
  if (showAuto) columns.push({ header: 'AUTO', value: autoCell });
  columns.push(
    { header: 'STATE', value: (row) => (row.online ? 'online' : 'offline') },
    { header: 'ATTACHED', value: (row) => yn(row.attached) },
    { header: 'RTT', value: (row) => dash(row.rttMs) }
  );
  if (showAuto) columns.push({ header: 'SCORE', value: (row) => dash(row.score) });
  columns.push(
    { header: 'PEERS', value: (row) => dash(row.peersOnline) },
    { header: 'TURN', value: (row) => formatTurn(row.turn) },
    { header: 'NOTE', value: (row) => (row.kicked ? 'kicked' : dash(row.lastError)) }
  );
  return columns;
}

const ls: SubHandler = async (ctx, _flags, positionals) => {
  rejectExtra(positionals, 0);
  const status = await fetchRelayStatus(ctx);
  const relays: RelayStatusRow[] = status?.relays ?? [];
  if (relays.length >= RELAY_RECORD_MAX_RELAYS) {
    ctx.out.warn(
      `this node already lists ${relays.length} relays (limit ${RELAY_RECORD_MAX_RELAYS}); enroll appends`
    );
  }
  emit(ctx, status ?? { mode: 'none', relays: [] }, () => {
    ctx.out.line(`mode         ${dash(status?.mode)}`);
    ctx.out.table(relays, relayLsColumns(hasAutoSelect(status)));
  });
};

const switchRelay: SubHandler = async (ctx, _flags, positionals) => {
  const url = requireArg(positionals, 0, 'url');
  rejectExtra(positionals, 1);
  const result = await switchMeshRelay(ctx, url);
  emit(ctx, result, () => ctx.out.line(`switched relay to ${url}`));
};

const rm: SubHandler = async (ctx, flags, positionals) => {
  const url = requireArg(positionals, 0, 'url');
  rejectExtra(positionals, 1);
  await confirmOrYes(flags, `remove relay ${url}`);
  const result = await removeRelay(ctx, url);
  emit(ctx, result, () => ctx.out.line(`removed relay ${url}`));
};

const readmit: SubHandler = async (ctx, flags, positionals) => {
  rejectExtra(positionals, 0);
  await confirmOrYes(flags, 're-sign stale member records (readmit-node)');
  const result = await readmitStaleMembers(ctx);
  emit(ctx, result, () => {
    if (result.total === 0) ctx.out.line('no stale members to readmit');
    else ctx.out.line(`readmitted ${result.signed}/${result.total} members`);
  });
};

function preferredUrlOf(status: unknown): string | null {
  if (!status || typeof status !== 'object') return null;
  const url = (status as { preferredUrl?: unknown }).preferredUrl;
  return typeof url === 'string' && url ? url : null;
}

const unpin: SubHandler = async (ctx, _flags, positionals) => {
  rejectExtra(positionals, 0);
  const nodeId = await ctx.targetNodeId();
  const statusResponse = await ctx.http.fetch(nodeId, '/api/mesh/relay/status');
  if (statusResponse.status === 404) {
    emit(ctx, { ok: true, unpinned: false }, () => ctx.out.line('nothing pinned'));
    return;
  }
  await ctx.http.assertOk(nodeId, statusResponse, '/api/mesh/relay/status');
  const status: unknown = await statusResponse.json();
  if (!preferredUrlOf(status)) {
    emit(ctx, { ok: true, unpinned: false }, () => ctx.out.line('nothing pinned'));
    return;
  }
  const unpinResponse = await ctx.http.fetch(nodeId, '/api/mesh/relay/unpin', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  if (unpinResponse.status === 404) {
    emit(ctx, { ok: true, unpinned: false }, () => ctx.out.line('nothing pinned'));
    return;
  }
  await ctx.http.assertOk(nodeId, unpinResponse, '/api/mesh/relay/unpin');
  const result =
    unpinResponse.status === 204 ? { ok: true } : ((await unpinResponse.json()) as unknown);
  emit(ctx, result, () => ctx.out.line('unpinned'));
};

export const relay: SubHandler = async (ctx, flags, positionals) => {
  const action = requireArg(positionals, 0, 'action (ls|switch|rm|readmit|unpin)');
  const rest = positionals.slice(1);
  if (action === 'ls' || action === 'list') return ls(ctx, flags, rest);
  if (action === 'switch') return switchRelay(ctx, flags, rest);
  if (action === 'rm' || action === 'remove') return rm(ctx, flags, rest);
  if (action === 'readmit') return readmit(ctx, flags, rest);
  if (action === 'unpin') return unpin(ctx, flags, rest);
  throw new UsageError(`unknown relay action: ${action}`, 'use ls|switch|rm|readmit|unpin');
};
