// `vibeterm nodes`：mesh 节点查看与管理。

import type { MeshNode } from '@vibeterm/api-client/auth/types';
import { SELF_NODE_ID } from '@vibeterm/api-client/node-url';
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
import {
  fetchHubs,
  findAdminNode,
  findMeshNode,
  listListedNodes,
  listMeshNodesFull,
  passwordJoinCommand,
  reachOf,
  resolveHubNodeId,
  roleOf,
} from '../core/nodes-hub';
import { admitPendingNode, createSignedEnrollment, revokeNode } from '../core/nodes-keylog';
import {
  fetchUpgradeLatest,
  hasCliNodeSession,
  isBatchEligible,
  runUpgradeBatch,
  uninstallPath,
  upgradeExitCode,
} from '../core/nodes-upgrade';
import type { Command } from './types';

const FLAGS = {
  ttl: 'string',
  password: 'boolean',
  version: 'string',
  wait: 'boolean',
  all: 'boolean',
  yes: 'boolean',
  reason: 'string',
  name: 'string',
} as const;

const USAGE = [
  'Usage: vibeterm nodes <subcommand>',
  '',
  'Subcommands:',
  '  ls                         list mesh nodes',
  '  show <node>                full projection (directFailure, dcBreaker, endpoints)',
  '  hubs                       GET /api/mesh/hubs',
  '  rename <node> <name>       POST /n/<hub>/api/hub/nodes/:id/rename',
  '  allow <node>               admit a pending hub node, else enable public-domain access',
  '  disallow <node>            disable public-domain access on the node',
  '  revoke <node> [--reason] [--yes]   signed key-log revoke-node (needs VIBETERM_PASSWORD)',
  '  enroll [--ttl 10m] [--password] [--name]',
  '  upgrade <node>|--all [--version] [--wait]',
  '  uninstall <node> [--yes]   POST …/uninstall then signed revoke-node',
  '  rtc-config                 GET /api/mesh/rtc-config (includes probes)',
  '',
  '--json shapes:',
  '  ls          { nodes: (MeshNode & { status: "admitted"|"pending" })[] }',
  '  show        MeshNode',
  '  hubs        MeshHubsResponse',
  '  rename      { ok, id, name }',
  '  allow       { node, action: "admit"|"domain-access", result }',
  '  revoke      { node, result }',
  '  enroll      { id, expiresAt, joinToken, joinCommand, publicUrl }',
  '  upgrade     { latest, outcomes: UpgradeOutcome[] }  outcome: done|failed|timeout|alreadyLatest|cancelled|unconfirmed',
  '  uninstall   { node, scheduled: true, revoked: true }',
  '  rtc-config  { stun, turn, probes? }',
].join('\n');

function rtt(node: MeshNode): string {
  return typeof node.rttMs === 'number' ? String(Math.round(node.rttMs)) : '-';
}

const ls: SubHandler = async (ctx, _flags, positionals) => {
  rejectExtra(positionals, 0);
  const nodes = await listListedNodes(ctx);
  emit(ctx, { nodes }, () => {
    ctx.out.table(nodes, [
      { header: 'NAME', value: (row) => row.name },
      { header: 'ID', value: (row) => shortId(row.id) },
      { header: 'ROLE', value: roleOf },
      { header: 'STATUS', value: (row) => row.status },
      { header: 'REACH', value: reachOf },
      { header: 'VERSION', value: (row) => dash(row.version) },
      { header: 'ONLINE', value: (row) => yn(row.online) },
      { header: 'RTT', value: rtt },
    ]);
  });
};

const show: SubHandler = async (ctx, _flags, positionals) => {
  const ref = requireArg(positionals, 0, 'node');
  rejectExtra(positionals, 1);
  const node = await findMeshNode(ctx, ref);
  emit(ctx, node, () => {
    ctx.out.line(`name           ${node.name}`);
    ctx.out.line(`id             ${node.id}`);
    ctx.out.line(`role           ${roleOf(node)}`);
    ctx.out.line(`online         ${yn(node.online)}`);
    ctx.out.line(`loggedIn       ${yn(node.loggedIn)}`);
    ctx.out.line(`reach          ${reachOf(node)}`);
    ctx.out.line(`version        ${dash(node.version)}`);
    ctx.out.line(`rttMs          ${dash(node.rttMs)}`);
    ctx.out.line(`peerAddress    ${dash(node.peerAddress)}`);
    ctx.out.line(`directCapable  ${yn(node.direct_capable)}`);
    ctx.out.line(`endpoints      ${(node.endpoints ?? []).join(', ') || '-'}`);
    ctx.out.data({ directFailure: node.directFailure ?? null, dcBreaker: node.dcBreaker ?? null });
  });
};

const hubs: SubHandler = async (ctx, _flags, positionals) => {
  rejectExtra(positionals, 0);
  const payload = await fetchHubs(ctx);
  emit(ctx, payload, () => {
    ctx.out.line(`writerHubId  ${dash(payload.writerHubId)}`);
    ctx.out.line(
      `attached     ${payload.attached ? `${payload.attached.publicUrl} (${dash(payload.attached.mode)})` : '-'}`
    );
    ctx.out.table(payload.hubs, [
      { header: 'NODE', value: (row) => dash(row.nodeId) },
      { header: 'URL', value: (row) => row.publicUrl },
      { header: 'MODE', value: (row) => dash(row.mode) },
      { header: 'AUTH', value: (row) => dash(row.authorization) },
    ]);
  });
};

const rename: SubHandler = async (ctx, _flags, positionals) => {
  const ref = requireArg(positionals, 0, 'node');
  const name = requireArg(positionals, 1, 'name');
  rejectExtra(positionals, 2);
  const node = await findMeshNode(ctx, ref);
  const hubId = await resolveHubNodeId(ctx);
  const result = await ctx.http.json(
    hubId,
    'POST',
    `/api/hub/nodes/${encodeURIComponent(node.id)}/rename`,
    { name }
  );
  emit(ctx, result, () => ctx.out.line(`renamed ${node.id} → ${name}`));
};

async function setDomainAccess(
  ctx: CliContext,
  nodeId: string,
  allowed: boolean
): Promise<unknown> {
  return ctx.http.json(nodeId, 'PATCH', '/api/system/domain-access', { allowed });
}

const allow: SubHandler = async (ctx, _flags, positionals) => {
  const ref = requireArg(positionals, 0, 'node');
  rejectExtra(positionals, 1);
  const target = await findAdminNode(ctx, ref);
  if (target.hub?.admission_status === 'pending') {
    const result = await admitPendingNode(ctx, target.hub);
    emit(ctx, { node: target.id, action: 'admit', result }, () =>
      ctx.out.line(`admitted pending node ${target.name} (${target.id})`)
    );
    return;
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

const enroll: SubHandler = async (ctx, flags, positionals) => {
  rejectExtra(positionals, 0);
  const ttl = parseDurationMs(flagString(flags, 'ttl') ?? '10m');
  const mode = await fetchAuthMode(ctx.http, SELF_NODE_ID);
  const publicUrl = mode?.hubPublicUrl ?? null;
  if (flagBool(flags, 'password')) {
    if (!publicUrl)
      throw new CliError('hub public url is unknown; cannot print a password join command');
    const command = passwordJoinCommand(publicUrl);
    emit(ctx, { mode: 'password', joinCommand: command, publicUrl }, () => ctx.out.line(command));
    return;
  }
  const created = await createSignedEnrollment(ctx, {
    ttlMs: ttl,
    name: flagString(flags, 'name'),
    hubPublicUrl: publicUrl,
  });
  emit(ctx, created, () => {
    ctx.out.line(`enrollment ${created.id}`);
    ctx.out.line(`expires    ${new Date(created.expiresAt).toISOString()}`);
    if (created.joinCommand) ctx.out.line(created.joinCommand);
    else ctx.out.line(`token      ${created.joinToken}`);
  });
};

const upgrade: SubHandler = async (ctx, flags, positionals) => {
  const all = flagBool(flags, 'all');
  const wait = all || flagBool(flags, 'wait');
  const version = flagString(flags, 'version');
  if (all && positionals[0]) throw new UsageError('--all does not take a node argument');
  if (!all && !positionals[0]) throw new UsageError('missing node (or pass --all)');
  rejectExtra(positionals, all ? 0 : 1);
  const latest = await fetchUpgradeLatest(ctx).catch(() => null);
  const roster = await listMeshNodesFull(ctx);
  const mode = await fetchAuthMode(ctx.http, SELF_NODE_ID);
  const latestVersion = latest?.latestVersion ?? null;
  const targets = all
    ? roster.filter((node) =>
        isBatchEligible(node, latestVersion, mode?.nodeId, (id) =>
          hasCliNodeSession(ctx.http.jar, id)
        )
      )
    : [await findMeshNode(ctx, positionals[0])];
  if (all && targets.length === 0) {
    ctx.out.info('no eligible nodes (online, logged in, version < latest)');
  }
  const outcomes = await runUpgradeBatch(ctx, targets, latestVersion, version, wait, mode?.nodeId);
  emit(ctx, { latest, outcomes }, () => {
    ctx.out.table(outcomes, [
      { header: 'NODE', value: (row) => shortId(row.node) },
      { header: 'NAME', value: (row) => row.name },
      { header: 'OUTCOME', value: (row) => row.outcome },
      { header: 'ERROR', value: (row) => dash(row.error) },
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

const rtcConfig: SubHandler = async (ctx, _flags, positionals) => {
  rejectExtra(positionals, 0);
  const payload = await ctx.http.json(SELF_NODE_ID, 'GET', '/api/mesh/rtc-config');
  emit(ctx, payload, () => ctx.out.data(payload));
};

const HANDLERS: Record<string, SubHandler> = {
  ls,
  show,
  hubs,
  rename,
  allow,
  disallow,
  revoke,
  enroll,
  upgrade,
  uninstall,
  'rtc-config': rtcConfig,
};

export const command: Command = {
  name: 'nodes',
  summary: 'inspect and manage mesh nodes',
  usage: USAGE,
  flags: FLAGS,
  run: (ctx, argv) => runSubs(ctx, argv, FLAGS, HANDLERS, 'run: vibeterm nodes --help'),
};
