// `vibeterm nodes relay ls|switch|rm|readmit|unpin`

import { RELAY_RECORD_MAX_RELAYS } from '@vibeterm/shared/auth';
import { flagBool, flagString } from '../core/args';
import {
  type SubHandler,
  confirmOrYes,
  dash,
  emit,
  readSecretField,
  rejectExtra,
  requireArg,
  yn,
} from '../core/cmd';
import { NotFoundError, UsageError } from '../core/errors';
import {
  type RelayStatusJson,
  type RelayStatusRow,
  attachedRelayUrl,
  fetchRelayStatus,
} from '../core/nodes-relay';
import {
  enrollPasswordView,
  fetchEnrollPassword,
  readmitStaleMembers,
  removeRelay,
  rotateEnrollPassword,
  switchMeshRelay,
} from '../core/nodes-relay-ops';
import { formatRelayQuotaLines } from '../core/nodes-relay-quota';
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

function showAutoColumn(status: RelayStatusJson | null): boolean {
  return hasAutoSelect(status) || preferredUrlOf(status) != null;
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
    ctx.out.table(relays, relayLsColumns(showAutoColumn(status)));
    for (const line of formatRelayQuotaLines(
      status?.quota,
      relays,
      attachedRelayUrl(status) ?? '-'
    )) {
      ctx.out.line(line);
    }
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
  emit(ctx, { ok: true, unpinned: true }, () => ctx.out.line('unpinned'));
};

const ENROLL_PASSWORD_MIN_LENGTH = 8;

async function resolvePasswordUrl(
  ctx: Parameters<SubHandler>[0],
  url: string | undefined
): Promise<string> {
  if (url) return url;
  const attached = attachedRelayUrl(await fetchRelayStatus(ctx));
  if (attached) return attached;
  throw new NotFoundError('no attached relay', 'pass a url: vibeterm nodes relay password <url>');
}

function printEnrollPassword(
  ctx: Parameters<SubHandler>[0],
  view: { known: boolean; password: string | null; passwordEpoch: number | null }
): void {
  ctx.out.line(`known ${yn(view.known)}`);
  ctx.out.line(`password ${dash(view.password)}`);
  ctx.out.line(`epoch ${dash(view.passwordEpoch)}`);
}

const passwordGet: SubHandler = async (ctx, _flags, positionals) => {
  rejectExtra(positionals, 1);
  const url = await resolvePasswordUrl(ctx, positionals[0]);
  const payload = await fetchEnrollPassword(ctx, url);
  emit(ctx, payload, () => printEnrollPassword(ctx, enrollPasswordView(payload)));
};

function hasPasswordSource(flags: Parameters<SubHandler>[1]): boolean {
  return (
    Boolean(flagString(flags, 'password')) ||
    flagBool(flags, 'password-stdin') ||
    Boolean(flagString(flags, 'password-file'))
  );
}

function rotateMode(flags: Parameters<SubHandler>[1]): 'keep' | 'kick' {
  const kick = flagBool(flags, 'kick');
  const keep = flagBool(flags, 'keep');
  if (kick && keep) throw new UsageError('--kick and --keep are exclusive');
  return kick ? 'kick' : 'keep';
}

async function readNextEnrollPassword(
  ctx: Parameters<SubHandler>[0],
  flags: Parameters<SubHandler>[1],
  clear: boolean
): Promise<string | null> {
  if (clear) {
    if (hasPasswordSource(flags))
      throw new UsageError('--clear cannot be combined with --password');
    return null;
  }
  const next = await readSecretField(ctx, flags, {
    flag: 'password',
    envName: 'VIBETERM_RELAY_JOIN_PASSWORD',
    required: true,
    prompt: 'New enroll password: ',
  });
  if (next === undefined) {
    throw new UsageError('missing --password, --password-stdin, --password-file, or --clear');
  }
  if (next.length < ENROLL_PASSWORD_MIN_LENGTH) {
    throw new UsageError(
      'enroll password must be at least 8 characters (relay_password_too_short)'
    );
  }
  return next;
}

function rotateConfirmMessage(url: string, clear: boolean, mode: 'keep' | 'kick'): string | null {
  if (!clear && mode !== 'kick') return null;
  if (clear && mode === 'kick') return `clear enroll password for ${url} and kick members`;
  if (clear) return `clear enroll password for ${url}`;
  return `change enroll password for ${url} and kick members`;
}

const passwordSet: SubHandler = async (ctx, flags, positionals) => {
  const url = requireArg(positionals, 0, 'url');
  rejectExtra(positionals, 1);
  const clear = flagBool(flags, 'clear');
  const next = await readNextEnrollPassword(ctx, flags, clear);
  const current = await readSecretField(ctx, flags, {
    flag: 'current',
    required: false,
    prompt: 'Current enroll password: ',
  });
  const mode = rotateMode(flags);
  const confirm = rotateConfirmMessage(url, clear, mode);
  if (confirm) await confirmOrYes(flags, confirm);
  const result = await rotateEnrollPassword(ctx, {
    url,
    ...(current === undefined ? {} : { current }),
    next,
    mode,
  });
  emit(ctx, result, () => {
    ctx.out.line(`${clear ? 'cleared' : 'rotated'} enroll password for ${url}`);
    ctx.out.line(
      `epoch ${dash(typeof result.passwordEpoch === 'number' ? result.passwordEpoch : null)}`
    );
  });
};

const password: SubHandler = async (ctx, flags, positionals) => {
  if (positionals[0] === 'set') return passwordSet(ctx, flags, positionals.slice(1));
  return passwordGet(ctx, flags, positionals);
};

export const relay: SubHandler = async (ctx, flags, positionals) => {
  const action = requireArg(positionals, 0, 'action (ls|switch|rm|readmit|unpin|password)');
  const rest = positionals.slice(1);
  if (action === 'ls' || action === 'list') return ls(ctx, flags, rest);
  if (action === 'switch') return switchRelay(ctx, flags, rest);
  if (action === 'rm' || action === 'remove') return rm(ctx, flags, rest);
  if (action === 'readmit') return readmit(ctx, flags, rest);
  if (action === 'unpin') return unpin(ctx, flags, rest);
  if (action === 'password') return password(ctx, flags, rest);
  throw new UsageError(
    `unknown relay action: ${action}`,
    'use ls|switch|rm|readmit|unpin|password'
  );
};
