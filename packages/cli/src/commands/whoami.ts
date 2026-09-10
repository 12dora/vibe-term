// `vibeterm whoami`：当前 entry、账号，以及每个 node 的会话状态。

import { SELF_NODE_ID } from '@vibeterm/api-client/node-url';
import { parseArgv } from '../core/args';
import { fetchAuthMode, listMeshNodes, requiresLogin } from '../core/auth';
import type { CliContext } from '../core/context';
import { AuthError } from '../core/errors';
import type { Command } from './types';

interface NodeStatus {
  node: string;
  name: string;
  /** 服务端视角：该 node 是否认这份会话。 */
  loggedIn: boolean;
  online: boolean;
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
  const stored = ctx.sessions.entry(entry);
  const nodes = selfSession ? await listMeshNodes(ctx.http) : [];
  const statuses: NodeStatus[] = [
    {
      node: SELF_NODE_ID,
      name: `${mode.username ?? mode.uid ?? 'unknown'} @ ${mode.nodeId}`,
      loggedIn: Boolean(selfSession),
      online: true,
      expiresAt: localExpiry(ctx, SELF_NODE_ID),
    },
    ...nodes
      .filter((node) => node.id !== mode.nodeId)
      .map((node) => ({
        node: node.id,
        name: node.name,
        loggedIn: node.loggedIn,
        online: node.online,
        expiresAt: localExpiry(ctx, node.id),
      })),
  ];

  if (ctx.globals.json) {
    ctx.out.data({
      entry,
      auth: 'mesh',
      user: { uid: mode.uid, username: mode.username ?? stored?.username ?? null },
      entryNodeId: mode.nodeId,
      loggedIn: Boolean(selfSession),
      nodes: statuses,
      sessionFile: ctx.sessions.path,
    });
  } else {
    ctx.out.line(`entry     ${entry}`);
    ctx.out.line(
      `user      ${mode.username ?? stored?.username ?? '(unknown)'} (${mode.uid ?? '-'})`
    );
    ctx.out.line(`sessions  ${ctx.sessions.path}`);
    ctx.out.line('');
    ctx.out.table(statuses, [
      { header: 'NODE', value: (row) => row.node },
      { header: 'NAME', value: (row) => row.name },
      { header: 'SESSION', value: (row) => (row.loggedIn ? 'yes' : 'no') },
      { header: 'ONLINE', value: (row) => (row.online ? 'yes' : 'no') },
      { header: 'EXPIRES', value: (row) => formatExpiry(row.expiresAt) },
    ]);
  }

  if (!selfSession) {
    throw new AuthError(`not logged in to ${entry}`, 'run: vibeterm login');
  }
}

export const command: Command = {
  name: 'whoami',
  summary: 'show the current entry, account and per-node session status',
  usage: [
    'Usage: vibeterm whoami [--entry <url>] [--json]',
    '',
    'Exit code 3 when the entry requires a login and no session is stored.',
  ].join('\n'),
  run,
};
