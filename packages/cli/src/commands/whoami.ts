// `vibeterm whoami`：当前 entry、账号，以及每个 node 的会话状态。

import { SELF_NODE_ID } from '@vibeterm/api-client/node-url';
import { parseArgv } from '../core/args';
import { fetchAuthMode, fetchMeshNodes, requiresLogin } from '../core/auth';
import type { CliContext } from '../core/context';
import { AuthError, EXIT_AUTH } from '../core/errors';
import type { Command } from './types';

interface NodeStatus {
  node: string;
  name: string;
  /** 服务端视角：该 node 是否认这份会话。 */
  loggedIn: boolean;
  online: boolean;
  /** loggedIn && online：现在能不能打这个 node。 */
  ready: boolean;
  /** 本地会话 cookie 的到期时刻（epoch 毫秒）；没有为 null。 */
  expiresAt: number | null;
}

function localExpiry(ctx: CliContext, nodeId: string): number | null {
  const session = ctx.http.jar.get(nodeId);
  if (!session) return null;
  return session.expiresAt || null;
}

function formatExpiry(value: number | null): string {
  if (!value) return '-';
  return new Date(value).toISOString();
}

function asNodeStatus(
  node: string,
  name: string,
  loggedIn: boolean,
  online: boolean,
  expiresAt: number | null
): NodeStatus {
  return { node, name, loggedIn, online, ready: loggedIn && online, expiresAt };
}

function displayUser(
  username: string | null | undefined,
  uid: string | null | undefined,
  fallback: string
): string {
  return username ?? uid ?? fallback;
}

function printWhoamiTable(ctx: CliContext, statuses: NodeStatus[]): void {
  ctx.out.table(statuses, [
    { header: 'NODE', value: (row) => row.node },
    { header: 'NAME', value: (row) => row.name },
    { header: 'SESSION', value: (row) => (row.loggedIn ? 'yes' : 'no') },
    { header: 'ONLINE', value: (row) => (row.online ? 'yes' : 'no') },
    { header: 'READY', value: (row) => (row.ready ? 'yes' : 'no') },
    { header: 'EXPIRES', value: (row) => formatExpiry(row.expiresAt) },
  ]);
  const hint = statuses.find((row) => !row.loggedIn && row.online);
  if (!hint) return;
  const cmd = hint.node === SELF_NODE_ID ? 'vibeterm login' : `vibeterm login --node ${hint.name}`;
  ctx.out.info(cmd);
}

function emitLoggedOut(ctx: CliContext, entry: string): number {
  if (ctx.globals.json) {
    ctx.out.data({ loggedIn: false, entry, hint: 'vibeterm login' });
    return EXIT_AUTH;
  }
  throw new AuthError(`not logged in to ${entry}`, 'run: vibeterm login');
}

async function run(ctx: CliContext, argv: string[]): Promise<number | undefined> {
  parseArgv(argv, {});
  const entry = ctx.globals.entry;
  const mode = await fetchAuthMode(ctx.http, SELF_NODE_ID);

  if (!mode || !requiresLogin(mode)) {
    const payload = { entry, auth: 'open' as const, user: null, nodes: [] as NodeStatus[] };
    if (ctx.globals.json) ctx.out.data(payload);
    else ctx.out.line(`entry ${entry}: open standalone instance, no login required`);
    return;
  }

  const selfSession = ctx.http.jar.get(SELF_NODE_ID);
  if (!selfSession) return emitLoggedOut(ctx, entry);

  const mesh = await fetchMeshNodes(ctx.http);
  if (!mesh.ok) return emitLoggedOut(ctx, entry);

  const stored = ctx.sessions.entry(entry);
  const statuses: NodeStatus[] = [
    asNodeStatus(
      SELF_NODE_ID,
      `${displayUser(mode.username, mode.uid, 'unknown')} @ ${mode.nodeId}`,
      true,
      true,
      localExpiry(ctx, SELF_NODE_ID)
    ),
    ...mesh.nodes
      .filter((node) => node.id !== mode.nodeId)
      .map((node) =>
        asNodeStatus(node.id, node.name, node.loggedIn, node.online, localExpiry(ctx, node.id))
      ),
  ];

  if (ctx.globals.json) {
    ctx.out.data({
      entry,
      auth: 'mesh',
      user: { uid: mode.uid, username: mode.username ?? stored?.username ?? null },
      entryNodeId: mode.nodeId,
      loggedIn: true,
      nodes: statuses,
      sessionFile: ctx.sessions.path,
    });
  } else {
    ctx.out.line(`entry     ${entry}`);
    ctx.out.line(
      `user      ${displayUser(mode.username ?? stored?.username, mode.uid, '(unknown)')} (${mode.uid ?? '-'})`
    );
    ctx.out.line(`sessions  ${ctx.sessions.path}`);
    ctx.out.line('');
    printWhoamiTable(ctx, statuses);
  }
}

export const command: Command = {
  name: 'whoami',
  summary: 'show the current entry, account and per-node session status',
  usage: [
    'Usage: vibeterm whoami [--entry <url>] [--json]',
    '',
    'READY = SESSION yes and ONLINE yes. SESSION=no ONLINE=yes means the node is',
    'reachable but this CLI has no cookie — run: vibeterm login --node <name>',
    '',
    'Not logged in (no session, or GET /api/mesh/nodes → 401): stdout is empty,',
    'stderr is `not logged in to <entry>` plus `run: vibeterm login`, exit 3.',
    '--json then prints { loggedIn: false, entry, hint: "vibeterm login" } on stdout',
    '(no sessionFile, no user) and still exits 3. sessionFile is only included when',
    'logged in. Override the jar with VIBETERM_SESSION_FILE (mode 0600; the file is',
    'a full session capability, protect it).',
  ].join('\n'),
  run,
};
