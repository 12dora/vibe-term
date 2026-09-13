// `vibeterm nodes relay ls|switch|rm|readmit`

import { flagBool } from '../core/args';
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
import { fetchRelayStatus } from '../core/nodes-relay';
import { readmitStaleMembers, removeRelay, switchMeshRelay } from '../core/nodes-relay-ops';

function formatTurn(turn: { url: string; probeOk: boolean | null } | null | undefined): string {
  if (!turn?.url) return '-';
  if (turn.probeOk === false) return `${turn.url} (down)`;
  if (turn.probeOk === true) return `${turn.url} (ok)`;
  return turn.url;
}

const ls: SubHandler = async (ctx, _flags, positionals) => {
  rejectExtra(positionals, 0);
  const status = await fetchRelayStatus(ctx);
  const relays = status?.relays ?? [];
  emit(ctx, status ?? { mode: 'none', relays: [] }, () => {
    ctx.out.line(`mode         ${dash(status?.mode)}`);
    ctx.out.table(relays, [
      { header: 'PRI', value: (row) => dash(row.priority) },
      { header: 'URL', value: (row) => row.url },
      { header: 'ROLE', value: (row) => dash(row.role) },
      { header: 'STATE', value: (row) => (row.online ? 'online' : 'offline') },
      { header: 'ATTACHED', value: (row) => yn(row.attached) },
      { header: 'RTT', value: (row) => dash(row.rttMs) },
      { header: 'PEERS', value: (row) => dash(row.peersOnline) },
      { header: 'TURN', value: (row) => formatTurn(row.turn) },
      { header: 'NOTE', value: (row) => (row.kicked ? 'kicked' : dash(row.lastError)) },
    ]);
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

export const relay: SubHandler = async (ctx, flags, positionals) => {
  const action = requireArg(positionals, 0, 'action (ls|switch|rm|readmit)');
  const rest = positionals.slice(1);
  if (action === 'ls' || action === 'list') return ls(ctx, flags, rest);
  if (action === 'switch') return switchRelay(ctx, flags, rest);
  if (action === 'rm' || action === 'remove') return rm(ctx, flags, rest);
  if (action === 'readmit') return readmit(ctx, flags, rest);
  throw new UsageError(`unknown relay action: ${action}`, 'use ls|switch|rm|readmit');
};
