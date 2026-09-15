// `vibeterm nodes`：mesh 节点查看与管理。

import { SELF_NODE_ID } from '@vibeterm/api-client/node-url';
import type { MeshNode } from '@vibeterm/shared';
import { flagBool, flagString } from '../core/args';
import { fetchAuthMode } from '../core/auth';
import {
  type SubHandler,
  confirmOrYes,
  dash,
  emit,
  parseDurationMs,
  rejectExtra,
  requireArg,
  runSubs,
  shortId,
  yn,
} from '../core/cmd';
import type { CliContext } from '../core/context';
import { CliError, NotFoundError, UsageError } from '../core/errors';
import { renameNodeViaKeyLog, revokeNode } from '../core/nodes-keylog';
import { printPortsTable } from '../core/nodes-ports';
import {
  appendRelayMetaKey,
  attachedRelayUrl,
  createRelayEnrollment,
  detectRelayUplink,
  fetchRelayStatus,
  findRelayAllowTarget,
  isRelayUplink,
  resolveExcludeNodeIds,
  resolveNodeHexId,
  rewriteBarePasswordFlag,
} from '../core/nodes-relay';
import {
  findAdminNode,
  findMeshNode,
  isTrustedPublicUrl,
  listListedNodes,
  listMeshNodesDetailed,
  listedOnline,
  nodeAddressOf,
  passwordJoinCommand,
  reachOf,
  roleOf,
} from '../core/nodes-roster';
import {
  fetchUpgradeLatest,
  parseUpgradeInvocation,
  runUpgradeBatch,
  selectUpgradeTargets,
  uninstallPath,
  upgradeExitCode,
} from '../core/nodes-upgrade';
import { op, upgradeCancel } from './nodes-ops';
import { ports } from './nodes-ports';
import { relay } from './nodes-relay';
import type { Command } from './types';

const FLAGS = {
  ttl: 'string',
  password: 'string',
  'password-stdin': 'boolean',
  'password-file': 'string',
  current: 'string',
  'current-stdin': 'boolean',
  clear: 'boolean',
  kick: 'boolean',
  keep: 'boolean',
  version: 'string',
  wait: 'boolean',
  all: 'boolean',
  ids: 'string',
  yes: 'boolean',
  reason: 'string',
  name: 'string',
  exclude: 'strings',
  probe: 'boolean',
  force: 'boolean',
} as const;

const USAGE = [
  'Usage: vibeterm nodes <subcommand>',
  '',
  'Subcommands:',
  '  ls                         list mesh nodes',
  '  show <node>                full projection (directFailure, dcBreaker, endpoints, ports)',
  '  rename <node> <name>       signed keylog rename-node (needs a relay uplink)',
  '  relay ls                   GET /api/mesh/relay/status (quota lines in human output)',
  '  relay switch <url>         POST /api/mesh/relay/switch (honours --node)',
  '  relay unpin                POST /api/mesh/relay/unpin (honours --node)',
  '  relay rm <url> [--yes]     remove/prepare + keylog set-relays',
  '  relay readmit [--yes]      GET …/readmit/prepare + keylog readmit-node',
  '  relay password [<url>]     GET /api/mesh/relay/password (default url = attached relay)',
  '  relay password set <url> (--password <v> | --password-stdin | --password-file <p> | --clear)',
  '                             [--current <v>|--current-stdin] [--kick|--keep] [--yes]',
  '                             POST /api/mesh/relay/password; --clear sends next:null; default mode keep',
  '  ports <node> [--probe]     print MeshNode.ports; --probe POST …/ports/probe first',
  '  allow <node>               wrap K_meta for a pending member, else enable public-domain access',
  '  disallow <node>            disable public-domain access on the node',
  '  revoke <node> [--reason] [--yes]   signed key-log revoke-node (needs VIBETERM_PASSWORD)',
  '  enroll [--ttl 10m] [--password] [--name]',
  '                             r3. join token via /api/mesh/relay/* (needs a relay uplink);',
  '                             enroll [--password] still works as a switch',
  '  meta-key admit <node>      wrap current K_meta for a node (relay; VIBETERM_PASSWORD or TTY)',
  '  meta-key rotate [--exclude <node>...]',
  '                             rotate K_meta, excluding nodes (relay)',
  '  upgrade <node>|--all|--ids a,b [--version <ver>] [--wait]',
  '  upgrade cancel <node> [--yes]  DELETE …/upgrade',
  '  op clear <node>            DELETE …/operation',
  '  uninstall <node> [--yes]   POST …/uninstall then signed revoke-node',
  '  pause <node>               POST …/pause (entry local; skips user traffic)',
  '  resume <node>              POST …/resume',
  '  rtc-config                 GET /api/mesh/rtc-config (includes probes)',
  '--json shapes:',
  '  ls          { nodes: (MeshNode & { status: "admitted"|"pending"; address: string })[] }',
  '  show        MeshNode & { address: string }',
  '  rename      { ok, id, name }',
  '  relay ls    RelayTenantStatus',
  '  relay password  { known, password, passwordEpoch }',
  '  relay password set  { ok, passwordEpoch }',
  '  relay switch|rm|readmit|unpin  result',
  '  ports       { node, ports: MeshPortReach[] }',
  '  op clear    { ok, node }',
  '  allow       { node, action: "admit"|"domain-access"|"meta-key", result }',
  '  revoke      { node, result }',
  '  enroll      { id, expiresAt, joinToken, joinCommand, publicUrl, caFingerprint }',
  '  meta-key    { op: "admit"|"rotate", epoch, seq }',
  '  upgrade     { latest, outcomes: UpgradeOutcome[] }  outcome: done|failed|timeout|alreadyLatest|cancelled|unconfirmed',
  '  upgrade cancel { node, cancelled: true }',
  '  uninstall   { node, scheduled: true, revoked: true }',
  '  pause       { ok, node }',
  '  resume      { ok, node }',
  '  rtc-config  { stun, turn, probes? }',
].join('\n');

function rtt(node: MeshNode): string {
  return typeof node.rttMs === 'number' ? String(Math.round(node.rttMs)) : '-';
}

const NODE_NOT_ON_RELAY = 'NODE_NOT_ON_RELAY';
const RELAY_JOIN_HINT =
  'run: vibeterm relay join <url> --token <r3> or vibeterm relay join <url> --tenant <id> --password';

function requireRelayUplink(isRelay: boolean): void {
  if (isRelay) return;
  throw new CliError(
    `this node is not attached to a relay (${NODE_NOT_ON_RELAY})`,
    1,
    RELAY_JOIN_HINT,
    NODE_NOT_ON_RELAY
  );
}

const ls: SubHandler = async (ctx, _flags, positionals) => {
  rejectExtra(positionals, 0);
  const nodes = (await listListedNodes(ctx)).map((row) => ({
    ...row,
    address: nodeAddressOf(row),
  }));
  emit(ctx, { nodes }, () => {
    ctx.out.table(nodes, [
      { header: 'NAME', value: (row) => row.name },
      { header: 'ID', value: (row) => shortId(row.id) },
      { header: 'ROLE', value: roleOf },
      { header: 'STATUS', value: (row) => row.status },
      { header: 'REACH', value: reachOf },
      { header: 'VERSION', value: (row) => dash(row.version) },
      { header: 'ADDRESS', value: (row) => row.address },
      { header: 'ONLINE', value: (row) => listedOnline(row) },
      { header: 'PAUSED', value: (row) => yn(row.paused) },
      { header: 'RTT', value: rtt },
    ]);
  });
};

const show: SubHandler = async (ctx, _flags, positionals) => {
  const ref = requireArg(positionals, 0, 'node');
  rejectExtra(positionals, 1);
  const node = await findMeshNode(ctx, ref);
  const address = nodeAddressOf(node);
  emit(ctx, { ...node, address }, () => {
    ctx.out.line(`name           ${node.name}`);
    ctx.out.line(`id             ${node.id}`);
    ctx.out.line(`role           ${roleOf(node)}`);
    ctx.out.line(`online         ${yn(node.online)}`);
    ctx.out.line(`loggedIn       ${yn(node.loggedIn)}`);
    ctx.out.line(`reach          ${reachOf(node)}`);
    ctx.out.line(`version        ${dash(node.version)}`);
    ctx.out.line(`address        ${address}`);
    ctx.out.line(`lastSeenAt     ${dash(node.lastSeenAt)}`);
    ctx.out.line(`rttMs          ${dash(node.rttMs)}`);
    ctx.out.line(`peerAddress    ${dash(node.peerAddress)}`);
    ctx.out.line(`directCapable  ${yn(node.direct_capable)}`);
    ctx.out.line(`endpoints      ${(node.endpoints ?? []).join(', ') || '-'}`);
    printPortsTable(ctx, node.ports ?? []);
    ctx.out.data({ directFailure: node.directFailure ?? null, dcBreaker: node.dcBreaker ?? null });
  });
};

const rename: SubHandler = async (ctx, _flags, positionals) => {
  const ref = requireArg(positionals, 0, 'node');
  const name = requireArg(positionals, 1, 'name');
  rejectExtra(positionals, 2);
  requireRelayUplink(await detectRelayUplink(ctx));
  const node = await findMeshNode(ctx, ref);
  const result = await renameNodeViaKeyLog(ctx, node.id, name);
  emit(ctx, { ok: true, id: node.id, name, result }, () =>
    ctx.out.line(`renamed ${node.id} → ${name}`)
  );
};

async function setDomainAccess(
  ctx: CliContext,
  nodeId: string,
  allowed: boolean
): Promise<unknown> {
  return ctx.http.json(nodeId, 'PATCH', '/api/system/domain-access', { allowed });
}

async function allowRelayMetaKey(ctx: CliContext, targetId: string, name: string): Promise<void> {
  const result = await appendRelayMetaKey(ctx, { op: 'admit', node_id: targetId });
  emit(ctx, { node: targetId, action: 'meta-key', result }, () =>
    ctx.out.line(`wrapped K_meta for ${name} (${targetId}) epoch ${result.epoch}`)
  );
}

const allow: SubHandler = async (ctx, _flags, positionals) => {
  const ref = requireArg(positionals, 0, 'node');
  rejectExtra(positionals, 1);
  const relay = await detectRelayUplink(ctx);
  const target = await findRelayAllowTarget(ctx, ref, relay);
  if (relay) {
    const pending = new Set((await listMeshNodesDetailed(ctx)).pendingMemberIds);
    if (pending.has(target.id) || !target.mesh) {
      await allowRelayMetaKey(ctx, target.id, target.name);
      return;
    }
  }
  if (!target.mesh) {
    throw new NotFoundError(`unknown node: ${ref}`, 'run: vibeterm nodes ls');
  }
  const result = await setDomainAccess(ctx, target.id, true);
  emit(ctx, { node: target.id, action: 'domain-access', result }, () =>
    ctx.out.line(`allowed public-domain access on ${target.name}`)
  );
};

const disallow: SubHandler = async (ctx, _flags, positionals) => {
  const ref = requireArg(positionals, 0, 'node');
  rejectExtra(positionals, 1);
  const node = await findMeshNode(ctx, ref);
  const result = await setDomainAccess(ctx, node.id, false);
  emit(ctx, { node: node.id, action: 'domain-access', result }, () =>
    ctx.out.line(`disallowed public-domain access on ${node.name}`)
  );
};

const revoke: SubHandler = async (ctx, flags, positionals) => {
  const ref = requireArg(positionals, 0, 'node');
  rejectExtra(positionals, 1);
  const target = await findAdminNode(ctx, ref);
  await confirmOrYes(flags, `revoke ${target.name} (${target.id})`);
  const reason = flagString(flags, 'reason') ?? '';
  const result = await revokeNode(ctx, target.id, reason);
  emit(ctx, { node: target.id, result }, () =>
    ctx.out.line(`revoked ${target.name} (${target.id})`)
  );
};

function printEnrollment(
  ctx: CliContext,
  created: {
    id: string;
    expiresAt: number;
    joinToken: string;
    joinCommand: string | null;
  }
): void {
  emit(ctx, created, () => {
    ctx.out.line(`enrollment ${created.id}`);
    ctx.out.line(`expires    ${new Date(created.expiresAt).toISOString()}`);
    if (created.joinCommand) ctx.out.line(created.joinCommand);
    else ctx.out.line(`token      ${created.joinToken}`);
  });
}

const enroll: SubHandler = async (ctx, flags, positionals) => {
  rejectExtra(positionals, 0);
  const ttl = parseDurationMs(flagString(flags, 'ttl') ?? '10m');
  const status = await fetchRelayStatus(ctx);
  requireRelayUplink(isRelayUplink(status));
  const relayUrl = attachedRelayUrl(status);
  const publicUrl = relayUrl && isTrustedPublicUrl(relayUrl) ? relayUrl : null;
  if (flags.password !== undefined) {
    if (!publicUrl)
      throw new CliError(
        'relay public url is unknown or not https; cannot print a password join command'
      );
    const tenantId = status?.tenantId?.trim() ?? '';
    if (!tenantId) {
      throw new CliError('relay tenant id is unknown; cannot print a password join command');
    }
    const command = passwordJoinCommand(publicUrl, tenantId);
    emit(ctx, { mode: 'password', joinCommand: command, publicUrl }, () => ctx.out.line(command));
    return;
  }
  printEnrollment(
    ctx,
    await createRelayEnrollment(ctx, { ttlMs: ttl, name: flagString(flags, 'name') })
  );
};

function printMetaKey(
  ctx: CliContext,
  result: { op: 'admit' | 'rotate'; epoch: number; seq: number | string }
): void {
  emit(ctx, result, () =>
    ctx.out.line(`meta-key ${result.op} epoch ${result.epoch} seq ${result.seq}`)
  );
}

const metaKey: SubHandler = async (ctx, flags, positionals) => {
  const op = requireArg(positionals, 0, 'op (rotate|admit)');
  if (op === 'rotate') {
    rejectExtra(positionals, 1);
    const exclude = await resolveExcludeNodeIds(ctx, flags);
    printMetaKey(
      ctx,
      await appendRelayMetaKey(
        ctx,
        exclude.length > 0 ? { op: 'rotate', exclude } : { op: 'rotate' }
      )
    );
    return;
  }
  if (op === 'admit') {
    const ref = requireArg(positionals, 1, 'node');
    rejectExtra(positionals, 2);
    const nodeId = await resolveNodeHexId(ctx, ref);
    printMetaKey(ctx, await appendRelayMetaKey(ctx, { op: 'admit', node_id: nodeId }));
    return;
  }
  throw new UsageError(`unknown meta-key op: ${op}`, 'use admit|rotate');
};

const upgrade: SubHandler = async (ctx, flags, positionals) => {
  if (positionals[0] === 'cancel') return upgradeCancel(ctx, flags, positionals.slice(1));
  const sel = parseUpgradeInvocation(flags, positionals);
  const latest = await fetchUpgradeLatest(ctx).catch(() => null);
  const mode = await fetchAuthMode(ctx.http, SELF_NODE_ID);
  const latestVersion = latest?.latestVersion ?? null;
  const targets = await selectUpgradeTargets(ctx, {
    all: sel.all,
    ids: sel.ids,
    nodeRef: sel.nodeRef,
    latestVersion,
    selfId: mode?.nodeId,
  });
  if ((sel.all || sel.ids.length > 0) && targets.length === 0) {
    ctx.out.info('no eligible nodes (online, logged in, version < latest)');
  }
  const outcomes = await runUpgradeBatch(
    ctx,
    targets,
    latestVersion,
    sel.version,
    sel.wait,
    mode?.nodeId
  );
  emit(ctx, { latest, outcomes }, () => {
    ctx.out.table(outcomes, [
      { header: 'NODE', value: (row) => shortId(row.node) },
      { header: 'NAME', value: (row) => row.name },
      { header: 'OUTCOME', value: (row) => row.outcome },
      { header: 'ERROR', value: (row) => dash(row.error) },
      { header: 'HINT', value: (row) => dash(row.hint) },
    ]);
  });
  return upgradeExitCode(outcomes);
};

const uninstall: SubHandler = async (ctx, flags, positionals) => {
  const ref = requireArg(positionals, 0, 'node');
  rejectExtra(positionals, 1);
  const node = await findMeshNode(ctx, ref);
  await confirmOrYes(flags, `uninstall VibeTerm on ${node.name} (${node.id})`);
  await ctx.http.json(
    SELF_NODE_ID,
    'POST',
    uninstallPath(node.id),
    {},
    {
      withNodeCookies: [node.id],
    }
  );
  const result = await revokeNode(ctx, node.id, flagString(flags, 'reason') ?? 'uninstall');
  emit(ctx, { node: node.id, scheduled: true, revoked: true, result }, () =>
    ctx.out.line(`uninstall scheduled and revoked ${node.name}`)
  );
};

const PAUSE_ERROR_TEXT: Record<string, string> = {
  CANNOT_PAUSE_SELF: 'cannot pause this machine',
};

function rethrowPauseError(error: unknown): never {
  const text = error instanceof Error ? error.message : String(error);
  for (const [code, message] of Object.entries(PAUSE_ERROR_TEXT)) {
    if (text.includes(code)) throw new CliError(`${message} (${code})`);
  }
  throw error;
}

async function postPauseResume(
  ctx: CliContext,
  action: 'pause' | 'resume',
  positionals: string[]
): Promise<void> {
  const ref = requireArg(positionals, 0, 'node');
  rejectExtra(positionals, 1);
  const node = await findMeshNode(ctx, ref);
  try {
    const result = await ctx.http.json(
      SELF_NODE_ID,
      'POST',
      `/api/mesh/nodes/${encodeURIComponent(node.id)}/${action}`
    );
    emit(ctx, result, () => ctx.out.line(`${action}d ${node.name} (${node.id})`));
  } catch (error) {
    rethrowPauseError(error);
  }
}

const pause: SubHandler = async (ctx, _flags, positionals) => {
  await postPauseResume(ctx, 'pause', positionals);
};

const resume: SubHandler = async (ctx, _flags, positionals) => {
  await postPauseResume(ctx, 'resume', positionals);
};

const rtcConfig: SubHandler = async (ctx, _flags, positionals) => {
  rejectExtra(positionals, 0);
  const payload = await ctx.http.json(SELF_NODE_ID, 'GET', '/api/mesh/rtc-config');
  emit(ctx, payload, () => ctx.out.data(payload));
};

const HANDLERS: Record<string, SubHandler> = {
  ls,
  show,
  rename,
  allow,
  disallow,
  revoke,
  enroll,
  'meta-key': metaKey,
  upgrade,
  uninstall,
  pause,
  resume,
  'rtc-config': rtcConfig,
  relay,
  ports,
  op,
};

export const command: Command = {
  name: 'nodes',
  summary: 'inspect and manage mesh nodes',
  usage: USAGE,
  flags: FLAGS,
  preprocessArgv: rewriteBarePasswordFlag,
  run: (ctx, argv) =>
    runSubs(ctx, rewriteBarePasswordFlag(argv), FLAGS, HANDLERS, 'run: vibeterm nodes --help'),
};
